/**
 * Integration tests for /health and /health/internal.
 *
 * Uses mongodb-memory-server so tests are self-contained (no external Mongo needed).
 * Chain checks: RPC_URL_HTTP defaults to localhost:8545 in test env which isn't
 * running — the chain sub-check returns an error result. We assert the response
 * shape is still correct and that a missing/unreachable RPC does not crash the server.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

// Set env vars before any project imports trigger env.ts evaluation
process.env['NODE_ENV'] = 'test';
process.env['INTERNAL_HEALTH_TOKEN'] = 'test-internal-token';
process.env['CORS_ORIGIN'] = 'http://localhost:3000';
process.env['API_PUBLIC_BASE_URL'] = 'http://localhost:4000';

const { createApp } = await import('../api/app.js');

let mongod: MongoMemoryServer;

beforeAll(async () => {
  if (!process.env['MONGO_URI']) {
    mongod = await MongoMemoryServer.create();
    process.env['MONGO_URI'] = mongod.getUri();
  }

  await mongoose.connect(process.env['MONGO_URI']!);
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  if (mongod) await mongod.stop();
});

describe('GET /health (liveness)', () => {
  it('returns 200 and is dependency-free', async () => {
    const app = createApp();
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      status: 'live',
      uptime: expect.any(Number),
    });
  });
});

describe('GET /health/ready (readiness)', () => {
  it('returns 200 or 503 with correct top-level shape', async () => {
    const app = createApp();
    const res = await request(app).get('/health/ready');

    expect([200, 503]).toContain(res.status);
    expect(res.body).toMatchObject({
      ok: expect.any(Boolean),
      db: expect.objectContaining({ status: expect.any(String), latencyMs: expect.any(Number) }),
      chain: expect.objectContaining({ status: expect.any(String) }),
    });
    // indexerLag: null (indexer not yet implemented)
    expect(res.body.indexerLag).toBeNull();
  });

  it('db sub-check is ok when mongoose is connected', async () => {
    const app = createApp();
    const res = await request(app).get('/health/ready');
    expect(res.body.db.status).toBe('ok');
  });

  it('returns 503 when a dependency is down (chain RPC unreachable in test)', async () => {
    // RPC_URL_HTTP defaults to localhost:8545 in test, which isn't running, so the
    // chain sub-check fails — readiness must surface that as 503.
    const app = createApp();
    const res = await request(app).get('/health/ready');
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.chain.status).toBe('error');
  });
});

describe('GET /health/internal', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const app = createApp();
    const res = await request(app).get('/health/internal');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('returns 401 when token is wrong', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/health/internal')
      .set('Authorization', 'Bearer wrong-token');
    expect(res.status).toBe(401);
  });

  it('returns 200 with diagnostics when token is correct', async () => {
    const app = createApp();
    const res = await request(app)
      .get('/health/internal')
      .set('Authorization', 'Bearer test-internal-token');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      uptime: expect.any(Number),
      db: expect.objectContaining({
        state: expect.any(String),
        ok: expect.any(Boolean),
        latencyMs: expect.any(Number),
      }),
      chain: expect.objectContaining({
        ok: expect.any(Boolean),
      }),
    });
    // indexer is null until the indexer ships
    expect(res.body.indexer).toBeNull();
  });

  it("db.state is 'connected' when mongoose is connected", async () => {
    const app = createApp();
    const res = await request(app)
      .get('/health/internal')
      .set('Authorization', 'Bearer test-internal-token');
    expect(res.body.db.state).toBe('connected');
  });
});
