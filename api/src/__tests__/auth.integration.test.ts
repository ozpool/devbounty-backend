/**
 * Integration tests for the SIWE login flow and the auth guards.
 * Signs real SIWE messages in-process with a viem test account.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createSiweMessage } from 'viem/siwe';
import { privateKeyToAccount } from 'viem/accounts';

process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'fatal';
process.env['CORS_ORIGIN'] = 'http://localhost:3000';
process.env['INTERNAL_HEALTH_TOKEN'] = 'test-internal-token';
process.env['API_PUBLIC_BASE_URL'] = 'http://localhost:4000';

const mongod = await MongoMemoryServer.create();
process.env['MONGO_URI'] = mongod.getUri();

const { createApp } = await import('../api/app.js');
const { requireRole } = await import('../api/middleware/auth.js');
const { errorMiddleware } = await import('../api/middleware/error.js');

const DOMAIN = 'localhost:3000';
const URI = 'http://localhost:3000';
const CHAIN_ID = 421614;
const account = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

beforeAll(async () => {
  await mongoose.connect(process.env['MONGO_URI']!);
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

type Agent = ReturnType<typeof request.agent>;

async function getNonce(agent: Agent): Promise<string> {
  const res = await agent.post('/auth/siwe/nonce').send({ address: account.address });
  expect(res.status).toBe(200);
  return res.body.nonce as string;
}

function buildMessage(nonce: string): string {
  return createSiweMessage({
    domain: DOMAIN,
    address: account.address,
    statement: 'Sign in to DevBounty',
    uri: URI,
    version: '1',
    chainId: CHAIN_ID,
    nonce,
  });
}

describe('SIWE auth flow', () => {
  it('logs in with a valid signature and authorizes /me', async () => {
    const agent = request.agent(createApp());
    const nonce = await getNonce(agent);
    const message = buildMessage(nonce);
    const signature = await account.signMessage({ message });

    const verify = await agent.post('/auth/siwe/verify').send({ message, signature });
    expect(verify.status).toBe(200);
    expect(verify.body.user.address).toBe(account.address);

    const me = await agent.get('/me');
    expect(me.status).toBe(200);
    expect(me.body.address).toBe(account.address);
    expect(me.body.role).toBe('hunter');
    expect(me.body.hasLinkedGithub).toBe(false);
  });

  it('rejects a tampered signature with 401', async () => {
    const agent = request.agent(createApp());
    const nonce = await getNonce(agent);
    const message = buildMessage(nonce);
    const signature = await account.signMessage({ message });
    // Flip the first byte of r so the signature no longer recovers to the signer.
    const body = signature.slice(2);
    const tampered = `0x${body.slice(0, 2) === 'ff' ? '00' : 'ff'}${body.slice(2)}`;

    const res = await agent.post('/auth/siwe/verify').send({ message, signature: tampered });
    expect(res.status).toBe(401);
  });

  it('rejects a nonce mismatch with 401', async () => {
    const agent = request.agent(createApp());
    await getNonce(agent);
    const message = buildMessage('mismatchednonce12345');
    const signature = await account.signMessage({ message });

    const res = await agent.post('/auth/siwe/verify').send({ message, signature });
    expect(res.status).toBe(401);
  });

  it('rejects /me without a session', async () => {
    const res = await request(createApp()).get('/me');
    expect(res.status).toBe(401);
  });

  it('rejects a replayed nonce (one-time use)', async () => {
    const app = createApp();
    const agent = request.agent(app);
    const nonceRes = await agent.post('/auth/siwe/nonce').send({ address: account.address });
    const setCookie = nonceRes.headers['set-cookie'] as unknown as string[];
    const nonceCookie = setCookie.find((c) => c.startsWith('siwe_nonce='))!;
    const message = buildMessage(nonceRes.body.nonce as string);
    const signature = await account.signMessage({ message });

    const first = await agent.post('/auth/siwe/verify').send({ message, signature });
    expect(first.status).toBe(200);

    // Replay the exact same nonce cookie + message + signature from a fresh client.
    const replay = await request(app)
      .post('/auth/siwe/verify')
      .set('Cookie', nonceCookie)
      .send({ message, signature });
    expect(replay.status).toBe(401);
  });
});

describe('requireRole', () => {
  function appWithRole(userRole: string, requiredRole: string): express.Application {
    const app = express();
    app.use((req, _res, next) => {
      req.auth = { address: '0xtest', role: userRole };
      next();
    });
    app.get('/x', requireRole(requiredRole), (_req, res) => {
      res.json({ ok: true });
    });
    app.use(errorMiddleware);
    return app;
  }

  it('allows a matching role', async () => {
    const res = await request(appWithRole('hunter', 'hunter')).get('/x');
    expect(res.status).toBe(200);
  });

  it('forbids a non-matching role with 403', async () => {
    const res = await request(appWithRole('hunter', 'admin')).get('/x');
    expect(res.status).toBe(403);
  });
});
