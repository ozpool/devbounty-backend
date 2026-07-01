/**
 * A bounty's release is fired detached (settleMerge.ts), so it can sit in
 * 'releasing' for a while if the indexer is behind — e.g. right after waking
 * from an idle sleep. GET /bounties/:id checks the escrow's live on-chain
 * status in that one case and reflects 'paid' immediately instead of waiting
 * on the indexer. These tests cover that override and its safe fallback.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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

let isIndexerConfiguredMock = vi.fn(() => true);
let getOnChainBountyStatusMock = vi.fn();

vi.mock('../shared/chain/clients.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../shared/chain/clients.js')>();
  return {
    ...actual,
    isIndexerConfigured: () => isIndexerConfiguredMock(),
    getOnChainBountyStatus: (id: `0x${string}`) => getOnChainBountyStatusMock(id),
  };
});

const { createApp } = await import('../api/app.js');
const { BountyModel } = await import('../shared/models/index.js');

const MAINTAINER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const BOUNTY_ID = `0x${'ab'.repeat(32)}` as const;

async function seedReleasingBounty() {
  await BountyModel.create({
    bountyId: BOUNTY_ID,
    maintainerAddress: MAINTAINER,
    repo: { owner: 'octocat', name: 'hello', fullName: 'octocat/hello', githubRepoId: 99 },
    issueNumber: 7,
    issueTitle: 'Fix the bug',
    issueUrl: 'https://github.com/octocat/hello/issues/7',
    amountUsdc: '250',
    language: 'typescript',
    onChainStatus: 'Open',
    lifecycleStatus: 'releasing',
    refundWindowSnapshot: 1_209_600,
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
  await BountyModel.deleteMany({});
  isIndexerConfiguredMock.mockReset().mockReturnValue(true);
  getOnChainBountyStatusMock.mockReset();
});

describe('GET /bounties/:id — live on-chain status override', () => {
  it('reflects paid immediately when the chain confirms release, ahead of the indexer', async () => {
    getOnChainBountyStatusMock.mockResolvedValue(2); // Status.Paid
    await seedReleasingBounty();

    const app = createApp();
    const res = await request(app).get(`/bounties/${BOUNTY_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.lifecycleStatus).toBe('paid');
    expect(res.body.onChainStatus).toBe('Paid');

    // Read-only: the stored record is untouched, so the indexer remains the
    // sole writer and still converges to the same state on its own schedule.
    const stored = await BountyModel.findOne({ bountyId: BOUNTY_ID }).lean();
    expect(stored?.lifecycleStatus).toBe('releasing');
  });

  it('leaves the stored snapshot untouched when the chain has not settled yet', async () => {
    getOnChainBountyStatusMock.mockResolvedValue(1); // Status.Open — not yet paid
    await seedReleasingBounty();

    const app = createApp();
    const res = await request(app).get(`/bounties/${BOUNTY_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.lifecycleStatus).toBe('releasing');
  });

  it('falls back to the stored snapshot without failing the request on an RPC error', async () => {
    getOnChainBountyStatusMock.mockRejectedValue(new Error('RPC timeout'));
    await seedReleasingBounty();

    const app = createApp();
    const res = await request(app).get(`/bounties/${BOUNTY_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.lifecycleStatus).toBe('releasing');
  });

  it('does not make a live chain call for bounties outside the releasing state', async () => {
    await BountyModel.create({
      bountyId: BOUNTY_ID,
      maintainerAddress: MAINTAINER,
      repo: { owner: 'octocat', name: 'hello', fullName: 'octocat/hello', githubRepoId: 99 },
      issueNumber: 7,
      issueTitle: 'Fix the bug',
      issueUrl: 'https://github.com/octocat/hello/issues/7',
      amountUsdc: '250',
      language: 'typescript',
      onChainStatus: 'Open',
      lifecycleStatus: 'open',
      refundWindowSnapshot: 1_209_600,
    });

    const app = createApp();
    const res = await request(app).get(`/bounties/${BOUNTY_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.lifecycleStatus).toBe('open');
    expect(getOnChainBountyStatusMock).not.toHaveBeenCalled();
  });
});
