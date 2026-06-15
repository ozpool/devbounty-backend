/**
 * Integration tests for the hunter profile and leaderboard endpoints.
 * Each leaderboard case uses a distinct `lang` so the 30s in-memory cache
 * (keyed by window:lang) never bleeds results across tests.
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
const { HunterModel, ReputationEventModel } = await import('../shared/models/index.js');

const A = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const B = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';

async function seedHunter(address: string, overrides: Record<string, unknown> = {}): Promise<void> {
  await HunterModel.create({
    address,
    githubLogin: 'octocat',
    totalEarnedUsdc: '0',
    payoutCount: 0,
    reposContributed: 0,
    languages: [],
    ...overrides,
  });
}

async function seedPayout(
  hunterAddress: string,
  amountUsdc: string,
  language = 'typescript',
): Promise<void> {
  await ReputationEventModel.create({
    hunterAddress,
    bountyId: `0x${randomBytes(32).toString('hex')}`,
    type: 'payout',
    amountUsdc,
    repoFullName: 'o/n',
    language,
    blockNumber: 1,
    txHash: `0x${randomBytes(32).toString('hex')}`,
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
  await Promise.all([HunterModel.deleteMany({}), ReputationEventModel.deleteMany({})]);
});

describe('hunter profile', () => {
  it('returns 400 for an invalid address', async () => {
    const res = await request(createApp()).get('/hunters/not-an-address');
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown hunter', async () => {
    const res = await request(createApp()).get(`/hunters/${A}`);
    expect(res.status).toBe(404);
  });

  it('returns the profile with recent payouts', async () => {
    await seedHunter(A, { totalEarnedUsdc: '300', payoutCount: 2 });
    await seedPayout(A, '100');
    await seedPayout(A, '200');
    const res = await request(createApp()).get(`/hunters/${A}`);
    expect(res.status).toBe(200);
    expect(res.body.address).toBe(A);
    expect(res.body.totalEarnedUsdc).toBe('300');
    expect(res.body.recentPayouts).toHaveLength(2);
  });
});

describe('leaderboard', () => {
  it('is empty when there are no payouts', async () => {
    const res = await request(createApp()).get('/leaderboard?lang=zzz');
    expect(res.status).toBe(200);
    expect(res.body.items).toEqual([]);
  });

  it('ranks hunters by total USDC earned', async () => {
    await seedPayout(A, '100', 'go');
    await seedPayout(A, '200', 'go');
    await seedPayout(B, '250', 'go');
    const res = await request(createApp()).get('/leaderboard?lang=go');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].address).toBe(A);
    expect(res.body.items[0].rank).toBe(1);
    expect(res.body.items[0].totalEarnedUsdc).toBe('300');
    expect(res.body.items[1].address).toBe(B);
    expect(res.body.items[1].rank).toBe(2);
  });

  it('filters by language', async () => {
    await seedPayout(A, '100', 'rust');
    await seedPayout(B, '500', 'typescript');
    const res = await request(createApp()).get('/leaderboard?lang=rust');
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0].address).toBe(A);
  });
});
