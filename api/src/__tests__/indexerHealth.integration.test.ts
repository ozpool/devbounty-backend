/**
 * Tests for the indexer heartbeat/lag in health: the pure assembler
 * (buildIndexerHealth) and the wiring into /health/ready and /health/internal.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'fatal';
process.env['CORS_ORIGIN'] = 'http://localhost:3000';
process.env['API_PUBLIC_BASE_URL'] = 'http://localhost:4000';
process.env['INTERNAL_HEALTH_TOKEN'] = 'test-internal-token';

const mongod = await MongoMemoryServer.create();
process.env['MONGO_URI'] = mongod.getUri();

const { createApp } = await import('../api/app.js');
const { buildIndexerHealth } = await import('../shared/utils/healthChecks.js');
const { IndexerStateModel } = await import('../shared/models/index.js');

const TOKEN = 'Bearer test-internal-token';
const STALE_AFTER = 60_000;

describe('buildIndexerHealth (pure)', () => {
  it('is null when the indexer has no checkpoint', () => {
    expect(buildIndexerHealth(null, 200n, STALE_AFTER, 1_000_000)).toBeNull();
  });

  it('computes lag from the chain head and is fresh within the window', () => {
    const now = 1_000_000;
    const h = buildIndexerHealth(
      { lastBlock: 150, updatedAt: new Date(now - 5_000) },
      200n,
      STALE_AFTER,
      now,
    );
    expect(h?.lagBlocks).toBe(50);
    expect(h?.heartbeatAgeMs).toBe(5_000);
    expect(h?.stale).toBe(false);
  });

  it('is stale once the heartbeat is older than the threshold', () => {
    const now = 1_000_000;
    const h = buildIndexerHealth(
      { lastBlock: 150, updatedAt: new Date(now - 120_000) },
      200n,
      STALE_AFTER,
      now,
    );
    expect(h?.stale).toBe(true);
  });

  it('reports null lag when the chain head is unknown', () => {
    const now = 1_000_000;
    const h = buildIndexerHealth(
      { lastBlock: 150, updatedAt: new Date(now) },
      null,
      STALE_AFTER,
      now,
    );
    expect(h?.lagBlocks).toBeNull();
  });

  it('is stale when the checkpoint has never advanced (no updatedAt)', () => {
    const h = buildIndexerHealth({ lastBlock: 0 }, 200n, STALE_AFTER, 1_000_000);
    expect(h?.heartbeatAgeMs).toBeNull();
    expect(h?.stale).toBe(true);
  });
});

beforeAll(async () => {
  await mongoose.connect(mongod.getUri());
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await IndexerStateModel.deleteMany({});
});

describe('health wiring', () => {
  it('reports indexerLag as null when no checkpoint exists', async () => {
    const res = await request(createApp()).get('/health/ready');
    expect(res.body.indexerLag).toBeNull();
  });

  it('reports a fresh checkpoint in /health/ready', async () => {
    // A mongoose create stamps updatedAt = now, so the heartbeat is fresh.
    await IndexerStateModel.create({ _id: 'singleton', lastBlock: 100 });

    const res = await request(createApp()).get('/health/ready');
    expect(res.body.indexerLag).not.toBeNull();
    expect(res.body.indexerLag.lastBlock).toBe(100);
    expect(res.body.indexerLag.stale).toBe(false);
    // The chain RPC is unreachable in test, so the head — and thus lag — is unknown.
    expect(res.body.indexerLag.lagBlocks).toBeNull();
  });

  it('marks a long-idle checkpoint stale in /health/internal', async () => {
    // Insert through the raw driver to bypass mongoose timestamps and force an old
    // updatedAt that is well past the staleness threshold.
    await IndexerStateModel.collection.insertOne({
      _id: 'singleton',
      lastBlock: 100,
      updatedAt: new Date(Date.now() - 10 * 60_000),
    } as never);

    const res = await request(createApp()).get('/health/internal').set('Authorization', TOKEN);
    expect(res.status).toBe(200);
    expect(res.body.indexer.lastBlock).toBe(100);
    expect(res.body.indexer.stale).toBe(true);
  });
});
