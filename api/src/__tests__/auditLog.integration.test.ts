/**
 * Tests for the audit log: the writeAudit helper (shape, system vs wallet actor,
 * error-swallowing) and that real route transitions append an audit row.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
const { writeAudit } = await import('../shared/audit/writeAudit.js');
const { AuditLogModel, BountyModel, ClaimModel, HunterModel } =
  await import('../shared/models/index.js');

const WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const COOKIE = `devbounty_jwt=${signSession({ sub: WALLET, role: 'hunter' })}`;

async function makeBounty(over: Record<string, unknown> = {}): Promise<string> {
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
    ...over,
  });
  return bountyId;
}

beforeAll(async () => {
  await mongoose.connect(mongod.getUri());
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    AuditLogModel.deleteMany({}),
    BountyModel.deleteMany({}),
    ClaimModel.deleteMany({}),
    HunterModel.deleteMany({}),
  ]);
});

describe('writeAudit helper', () => {
  it('records a wallet actor with full shape', async () => {
    await writeAudit({
      action: 'claim.created',
      actor: { address: WALLET, role: 'hunter' },
      target: { type: 'bounty', id: 'b1' },
      metadata: { prNumber: 7 },
      ip: '203.0.113.5',
    });
    const row = await AuditLogModel.findOne({ action: 'claim.created' }).lean();
    expect(row?.actorType).toBe('wallet');
    expect(row?.actorAddress).toBe(WALLET);
    expect(row?.actorRole).toBe('hunter');
    expect(row?.targetType).toBe('bounty');
    expect(row?.targetId).toBe('b1');
    expect(row?.metadata).toMatchObject({ prNumber: 7 });
    expect(row?.ip).toBe('203.0.113.5');
    expect(row?.createdAt).toBeInstanceOf(Date);
  });

  it('records a system actor when no actor is given', async () => {
    await writeAudit({
      action: 'bounty.settled_via_webhook',
      target: { type: 'bounty', id: 'b2' },
    });
    const row = await AuditLogModel.findOne({ action: 'bounty.settled_via_webhook' }).lean();
    expect(row?.actorType).toBe('system');
    expect(row?.actorAddress).toBeUndefined();
  });

  it('never throws when the insert fails', async () => {
    vi.spyOn(AuditLogModel, 'create').mockRejectedValueOnce(new Error('db down') as never);
    await expect(
      writeAudit({ action: 'x.y', target: { type: 'bounty', id: 'b3' } }),
    ).resolves.toBeUndefined();
    expect(await AuditLogModel.countDocuments({ action: 'x.y' })).toBe(0);
  });
});

describe('routes append audit rows', () => {
  it('writes claim.created on a successful claim', async () => {
    const bountyId = await makeBounty();
    await HunterModel.create({
      address: WALLET,
      githubLogin: 'octocat',
      totalEarnedUsdc: '0',
      payoutCount: 0,
      reposContributed: 0,
      languages: [],
    });

    const res = await request(createApp())
      .post(`/bounties/${bountyId}/claim`)
      .set('Cookie', COOKIE);
    expect(res.status).toBe(201);

    const row = await AuditLogModel.findOne({ action: 'claim.created' }).lean();
    expect(row?.actorAddress).toBe(WALLET);
    expect(row?.targetId).toBe(bountyId);
  });

  it('writes bounty.refund_recorded on a maintainer refund', async () => {
    const bountyId = await makeBounty({ maintainerAddress: WALLET, onChainStatus: 'Open' });
    const txHash = `0x${'a'.repeat(64)}`;

    const res = await request(createApp())
      .post(`/bounties/${bountyId}/refund-recorded`)
      .set('Cookie', COOKIE)
      .send({ txHash });
    expect(res.status).toBe(200);

    const row = await AuditLogModel.findOne({ action: 'bounty.refund_recorded' }).lean();
    expect(row?.actorAddress).toBe(WALLET);
    expect(row?.targetId).toBe(bountyId);
    expect(row?.metadata).toMatchObject({ txHash });
  });
});
