/**
 * Unit tests for the chain-indexer event handlers. They run against an in-memory
 * Mongo with hand-built decoded events, so they cover the off-chain bookkeeping
 * (settlement, reputation, hunter recompute, idempotency) without a live chain.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import mongoose from 'mongoose';
import { type Address, type Hex } from 'viem';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'fatal';
process.env['CORS_ORIGIN'] = 'http://localhost:3000';
process.env['API_PUBLIC_BASE_URL'] = 'http://localhost:4000';
process.env['INTERNAL_HEALTH_TOKEN'] = 'test-internal-token';

const mongod = await MongoMemoryServer.create();
process.env['MONGO_URI'] = mongod.getUri();

const { BountyModel, ClaimModel, HunterModel, ReputationEventModel } =
  await import('../shared/models/index.js');
const { handleBountyCreated, handleBountyReleased, handleBountyRefunded, recomputeHunter } =
  await import('../indexer/handlers.js');

const ID = `0x${'ab'.repeat(32)}` as Hex;
const HUNTER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as Address;
const MAINTAINER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as Address;
const TX1 = `0x${'11'.repeat(32)}` as Hex;
const SHA = `0x${'cd'.repeat(32)}` as Hex;
const AMOUNT = 500n * 10n ** 6n; // 500 USDC (6 decimals)

async function seedBounty(lifecycleStatus = 'submitted'): Promise<void> {
  await BountyModel.create({
    bountyId: ID,
    maintainerAddress: MAINTAINER,
    repo: { owner: 'octo', name: 'repo', fullName: 'octo/repo', githubRepoId: 1 },
    issueNumber: 1,
    issueTitle: 'Fix it',
    issueUrl: 'https://github.com/octo/repo/issues/1',
    amountUsdc: '500',
    language: 'typescript',
    refundWindowSnapshot: 1209600,
    lifecycleStatus,
  });
}

const releasedEvent = (txHash = TX1) => ({
  id: ID,
  hunter: HUNTER,
  amount: AMOUNT,
  prCommitSha: SHA,
  txHash,
  blockNumber: 100n,
});

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
    ReputationEventModel.deleteMany({}),
  ]);
});

describe('handleBountyCreated', () => {
  it('confirms the deposit: marks the escrow Open and the bounty open', async () => {
    await seedBounty('pending_deposit');
    await handleBountyCreated({
      id: ID,
      maintainer: MAINTAINER,
      amount: AMOUNT,
      refundWindow: 1209600n,
      txHash: TX1,
      blockNumber: 10n,
    });
    const bounty = await BountyModel.findOne({ bountyId: ID }).lean();
    expect(bounty?.onChainStatus).toBe('Open');
    expect(bounty?.lifecycleStatus).toBe('open');
    expect(bounty?.txCreate).toBe(TX1);
  });
});

describe('handleBountyReleased', () => {
  it('settles the bounty and claim and records the payout', async () => {
    await seedBounty('submitted');
    await ClaimModel.create({
      bountyId: ID,
      hunterAddress: HUNTER,
      status: 'submitted',
      expiresAt: new Date(Date.now() + 1_000_000),
      prNumber: 7,
      repoIdAtSubmit: 1,
    });

    await handleBountyReleased(releasedEvent());

    const bounty = await BountyModel.findOne({ bountyId: ID }).lean();
    expect(bounty?.onChainStatus).toBe('Paid');
    expect(bounty?.lifecycleStatus).toBe('paid');
    expect(bounty?.hunterAddress).toBe(HUNTER);
    expect(bounty?.releasedPrCommitSha).toBe(SHA);

    const claim = await ClaimModel.findOne({ bountyId: ID }).lean();
    expect(claim?.status).toBe('paid');

    const events = await ReputationEventModel.find({ hunterAddress: HUNTER }).lean();
    expect(events).toHaveLength(1);
    expect(events[0]?.amountUsdc).toBe('500');
    expect(events[0]?.repoFullName).toBe('octo/repo');

    const hunter = await HunterModel.findOne({ address: HUNTER }).lean();
    expect(hunter?.totalEarnedUsdc).toBe('500');
    expect(hunter?.payoutCount).toBe(1);
    expect(hunter?.reposContributed).toBe(1);
    expect(hunter?.languages).toEqual([{ name: 'typescript', count: 1 }]);
  });

  it('is idempotent on a replayed delivery (same txHash)', async () => {
    await seedBounty('submitted');
    await handleBountyReleased(releasedEvent());
    await handleBountyReleased(releasedEvent()); // replay

    expect(await ReputationEventModel.countDocuments({ hunterAddress: HUNTER })).toBe(1);
    const hunter = await HunterModel.findOne({ address: HUNTER }).lean();
    expect(hunter?.totalEarnedUsdc).toBe('500');
    expect(hunter?.payoutCount).toBe(1);
  });
});

describe('handleBountyRefunded', () => {
  it('marks the bounty refunded', async () => {
    await seedBounty('open');
    await handleBountyRefunded({ id: ID, amount: AMOUNT, txHash: TX1, blockNumber: 20n });
    const bounty = await BountyModel.findOne({ bountyId: ID }).lean();
    expect(bounty?.onChainStatus).toBe('Refunded');
    expect(bounty?.lifecycleStatus).toBe('refunded');
    expect(bounty?.txRefund).toBe(TX1);
  });
});

describe('recomputeHunter', () => {
  it('aggregates totals, repos and languages from reputation events', async () => {
    await ReputationEventModel.create([
      {
        hunterAddress: HUNTER,
        bountyId: `0x${'01'.repeat(32)}`,
        type: 'payout',
        amountUsdc: '100',
        repoFullName: 'a/b',
        language: 'go',
        blockNumber: 1,
        txHash: `0x${'aa'.repeat(32)}`,
      },
      {
        hunterAddress: HUNTER,
        bountyId: `0x${'02'.repeat(32)}`,
        type: 'payout',
        amountUsdc: '200',
        repoFullName: 'c/d',
        language: 'go',
        blockNumber: 2,
        txHash: `0x${'bb'.repeat(32)}`,
      },
    ]);

    await recomputeHunter(HUNTER);

    const hunter = await HunterModel.findOne({ address: HUNTER }).lean();
    expect(hunter?.totalEarnedUsdc).toBe('300');
    expect(hunter?.payoutCount).toBe(2);
    expect(hunter?.reposContributed).toBe(2);
    expect(hunter?.languages).toEqual([{ name: 'go', count: 2 }]);
  });
});
