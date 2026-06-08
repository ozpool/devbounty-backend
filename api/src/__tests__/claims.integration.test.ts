/**
 * Integration tests for the claim & submission flow.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { randomBytes } from 'crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'fatal';
process.env['CORS_ORIGIN'] = 'http://localhost:3000';
process.env['API_PUBLIC_BASE_URL'] = 'http://localhost:4000';
process.env['INTERNAL_HEALTH_TOKEN'] = 'test-internal-token';

const mongod = await MongoMemoryServer.create();
process.env['MONGO_URI'] = mongod.getUri();

const { createApp } = await import('../api/app.js');
const { signSession } = await import('../shared/auth/jwt.js');
const { BountyModel, ClaimModel, HunterModel } = await import('../shared/models/index.js');

const HUNTER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const HUNTER2 = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const COOKIE = `devbounty_jwt=${signSession({ sub: HUNTER, role: 'hunter' })}`;
const COOKIE2 = `devbounty_jwt=${signSession({ sub: HUNTER2, role: 'hunter' })}`;

async function makeBounty(): Promise<string> {
  const bountyId = `0x${randomBytes(32).toString('hex')}`;
  await BountyModel.create({
    bountyId,
    maintainerAddress: '0xmaintainer',
    repo: { owner: 'o', name: 'n', fullName: 'o/n', githubRepoId: 1 },
    issueNumber: 1,
    issueTitle: 'fix it',
    issueUrl: 'https://github.com/o/n/issues/1',
    amountUsdc: '100',
    language: 'typescript',
    onChainStatus: 'None',
    lifecycleStatus: 'open',
    refundWindowSnapshot: 1_209_600,
  });
  return bountyId;
}

async function linkGithub(address: string, login = 'octocat'): Promise<void> {
  await HunterModel.create({
    address,
    githubLogin: login,
    totalEarnedUsdc: '0',
    payoutCount: 0,
    reposContributed: 0,
    languages: [],
  });
}

beforeAll(async () => {
  await mongoose.connect(mongod.getUri());
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  await Promise.all([
    BountyModel.deleteMany({}),
    ClaimModel.deleteMany({}),
    HunterModel.deleteMany({}),
  ]);
});

describe('claims', () => {
  it('requires a linked GitHub account to claim', async () => {
    const bountyId = await makeBounty();
    await HunterModel.create({
      address: HUNTER,
      totalEarnedUsdc: '0',
      payoutCount: 0,
      reposContributed: 0,
      languages: [],
    });
    const res = await request(createApp())
      .post(`/bounties/${bountyId}/claim`)
      .set('Cookie', COOKIE);
    expect(res.status).toBe(403);
  });

  it('refuses to claim an unfunded (pending_deposit) bounty', async () => {
    const bountyId = await makeBounty();
    await BountyModel.updateOne({ bountyId }, { $set: { lifecycleStatus: 'pending_deposit' } });
    await linkGithub(HUNTER);
    const res = await request(createApp())
      .post(`/bounties/${bountyId}/claim`)
      .set('Cookie', COOKIE);
    expect(res.status).toBe(409);
  });

  it('claims a bounty when GitHub-linked', async () => {
    const bountyId = await makeBounty();
    await linkGithub(HUNTER);
    const res = await request(createApp())
      .post(`/bounties/${bountyId}/claim`)
      .set('Cookie', COOKIE);
    expect(res.status).toBe(201);
    expect(res.body.expiresAt).toBeDefined();
    const bounty = await BountyModel.findOne({ bountyId }).lean();
    expect(bounty?.lifecycleStatus).toBe('claimed');
  });

  it('rejects a second active claim on the same bounty', async () => {
    const app = createApp();
    const bountyId = await makeBounty();
    await linkGithub(HUNTER);
    await linkGithub(HUNTER2);
    await request(app).post(`/bounties/${bountyId}/claim`).set('Cookie', COOKIE);
    const res = await request(app).post(`/bounties/${bountyId}/claim`).set('Cookie', COOKIE2);
    expect(res.status).toBe(409);
  });

  it('submits a PR to the active claim and rejects a duplicate PR', async () => {
    const app = createApp();
    const bountyId = await makeBounty();
    await linkGithub(HUNTER);
    await request(app).post(`/bounties/${bountyId}/claim`).set('Cookie', COOKIE);

    const prUrl = 'https://github.com/o/n/pull/42';
    const submit = await request(app)
      .post(`/bounties/${bountyId}/submit`)
      .set('Cookie', COOKIE)
      .send({ prUrl });
    expect(submit.status).toBe(200);
    expect(submit.body.prNumber).toBe(42);
    const bounty = await BountyModel.findOne({ bountyId }).lean();
    expect(bounty?.lifecycleStatus).toBe('submitted');

    // First claim is now 'submitted' (not active), so a second hunter can claim;
    // submitting the same PR must be rejected by the composite-unique index.
    await linkGithub(HUNTER2);
    await request(app).post(`/bounties/${bountyId}/claim`).set('Cookie', COOKIE2);
    const dup = await request(app)
      .post(`/bounties/${bountyId}/submit`)
      .set('Cookie', COOKIE2)
      .send({ prUrl });
    expect(dup.status).toBe(409);
  });

  it('releases early, then enforces the re-claim cooldown', async () => {
    const app = createApp();
    const bountyId = await makeBounty();
    await linkGithub(HUNTER);
    await request(app).post(`/bounties/${bountyId}/claim`).set('Cookie', COOKIE);

    const del = await request(app).delete(`/bounties/${bountyId}/claim`).set('Cookie', COOKIE);
    expect(del.status).toBe(200);
    const bounty = await BountyModel.findOne({ bountyId }).lean();
    expect(bounty?.lifecycleStatus).toBe('open');

    const reclaim = await request(app).post(`/bounties/${bountyId}/claim`).set('Cookie', COOKIE);
    expect(reclaim.status).toBe(409);
  });

  it('enforces the per-wallet active-claim cap', async () => {
    const app = createApp();
    await linkGithub(HUNTER);
    for (let i = 0; i < 3; i++) {
      const bountyId = await makeBounty();
      const ok = await request(app).post(`/bounties/${bountyId}/claim`).set('Cookie', COOKIE);
      expect(ok.status).toBe(201);
    }
    const fourth = await makeBounty();
    const capped = await request(app).post(`/bounties/${fourth}/claim`).set('Cookie', COOKIE);
    expect(capped.status).toBe(409);
  });
});
