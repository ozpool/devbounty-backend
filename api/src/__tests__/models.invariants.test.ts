/**
 * Index/invariant tests for the core models, against an in-memory MongoDB.
 * Covers the constraints that protect the data and bite hardest if wrong:
 * one active claim per bounty, no duplicate PRs, unique bountyId/address/txHash.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'fatal';

const mongod = await MongoMemoryServer.create();
process.env['MONGO_URI'] = mongod.getUri();

const { BountyModel, ClaimModel, HunterModel, ReputationEventModel } =
  await import('../shared/models/index.js');

const soon = (): Date => new Date(Date.now() + 60 * 60 * 1000);

function makeBounty(bountyId: string) {
  return {
    bountyId,
    maintainerAddress: '0xmaintainer',
    repo: { owner: 'o', name: 'n', fullName: 'o/n', githubRepoId: 1 },
    issueNumber: 1,
    issueTitle: 'fix the bug',
    issueUrl: 'https://github.com/o/n/issues/1',
    amountUsdc: '100',
    language: 'typescript',
    onChainStatus: 'None' as const,
    lifecycleStatus: 'pending_deposit' as const,
    refundWindowSnapshot: 1_209_600,
  };
}

beforeAll(async () => {
  await mongoose.connect(process.env['MONGO_URI']!);
  // Build indexes before exercising uniqueness.
  await Promise.all([
    BountyModel.init(),
    ClaimModel.init(),
    HunterModel.init(),
    ReputationEventModel.init(),
  ]);
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

describe('bounty', () => {
  it('rejects a duplicate bountyId', async () => {
    await BountyModel.create(makeBounty('0xunique'));
    await expect(BountyModel.create(makeBounty('0xunique'))).rejects.toThrow();
  });
});

describe('claim', () => {
  it('allows at most one active claim per bounty', async () => {
    await ClaimModel.create({
      bountyId: '0xc1',
      hunterAddress: '0xh1',
      status: 'active',
      expiresAt: soon(),
    });
    await expect(
      ClaimModel.create({
        bountyId: '0xc1',
        hunterAddress: '0xh2',
        status: 'active',
        expiresAt: soon(),
      }),
    ).rejects.toThrow();
  });

  it('allows a fresh active claim once the previous is no longer active', async () => {
    const first = await ClaimModel.create({
      bountyId: '0xc2',
      hunterAddress: '0xh1',
      status: 'active',
      expiresAt: soon(),
    });
    first.status = 'expired';
    await first.save();

    const second = await ClaimModel.create({
      bountyId: '0xc2',
      hunterAddress: '0xh2',
      status: 'active',
      expiresAt: soon(),
    });
    expect(second.status).toBe('active');
  });

  it('rejects a duplicate prUrl on the same bounty', async () => {
    const prUrl = 'https://github.com/o/n/pull/7';
    await ClaimModel.create({
      bountyId: '0xc3',
      hunterAddress: '0xh1',
      status: 'submitted',
      expiresAt: soon(),
      prUrl,
    });
    await expect(
      ClaimModel.create({
        bountyId: '0xc3',
        hunterAddress: '0xh2',
        status: 'submitted',
        expiresAt: soon(),
        prUrl,
      }),
    ).rejects.toThrow();
  });
});

describe('hunter', () => {
  it('rejects a duplicate address', async () => {
    await HunterModel.create({
      address: '0xdup',
      totalEarnedUsdc: '0',
      payoutCount: 0,
      reposContributed: 0,
      languages: [],
    });
    await expect(
      HunterModel.create({
        address: '0xdup',
        totalEarnedUsdc: '0',
        payoutCount: 0,
        reposContributed: 0,
        languages: [],
      }),
    ).rejects.toThrow();
  });
});

describe('reputationEvent', () => {
  it('rejects a duplicate txHash', async () => {
    const base = {
      hunterAddress: '0xh',
      bountyId: '0xb',
      type: 'payout' as const,
      amountUsdc: '100',
      repoFullName: 'o/n',
      blockNumber: 1,
      txHash: '0xtxdup',
    };
    await ReputationEventModel.create(base);
    await expect(ReputationEventModel.create({ ...base })).rejects.toThrow();
  });
});
