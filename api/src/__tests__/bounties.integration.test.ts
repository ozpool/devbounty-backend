/**
 * Integration tests for the bounty create / list / detail endpoints.
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
const { signSession } = await import('../shared/auth/jwt.js');
const { BountyModel, ClaimModel, IdempotencyKeyModel } = await import('../shared/models/index.js');

const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const COOKIE = `devbounty_jwt=${signSession({ sub: ADDRESS, role: 'hunter' })}`;

function validBounty(overrides: Record<string, unknown> = {}) {
  return {
    repoFullName: 'octocat/hello',
    githubRepoId: 99,
    issueNumber: 7,
    issueTitle: 'Fix the bug',
    issueUrl: 'https://github.com/octocat/hello/issues/7',
    amountUsdc: '250',
    language: 'typescript',
    ...overrides,
  };
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
  await ClaimModel.deleteMany({});
  await IdempotencyKeyModel.deleteMany({});
});

describe('bounties', () => {
  it('creates a bounty and returns it by id', async () => {
    const app = createApp();
    const create = await request(app).post('/bounties').set('Cookie', COOKIE).send(validBounty());
    expect(create.status).toBe(201);
    expect(create.body.lifecycleStatus).toBe('pending_deposit');
    const id = create.body.bountyId as string;
    expect(id).toMatch(/^0x[0-9a-f]{64}$/);

    const detail = await request(app).get(`/bounties/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.maintainerAddress).toBe(ADDRESS);
    expect(detail.body.repo.fullName).toBe('octocat/hello');
    expect(detail.body.claims).toEqual([]);
    // No internal fields leak.
    expect(detail.body._id).toBeUndefined();
    expect(detail.body.__v).toBeUndefined();
  });

  it('requires auth to create', async () => {
    const res = await request(createApp()).post('/bounties').send(validBounty());
    expect(res.status).toBe(401);
  });

  it('rejects an invalid payload', async () => {
    const res = await request(createApp())
      .post('/bounties')
      .set('Cookie', COOKIE)
      .send(validBounty({ amountUsdc: 'not-a-number' }));
    expect(res.status).toBe(400);
  });

  it('replays the same response for a repeated Idempotency-Key', async () => {
    const app = createApp();
    const key = 'idem-key-123';
    const first = await request(app)
      .post('/bounties')
      .set('Cookie', COOKIE)
      .set('Idempotency-Key', key)
      .send(validBounty());
    const second = await request(app)
      .post('/bounties')
      .set('Cookie', COOKIE)
      .set('Idempotency-Key', key)
      .send(validBounty());

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.bountyId).toBe(first.body.bountyId);
    expect(await BountyModel.countDocuments({})).toBe(1);
  });

  it('scopes Idempotency-Key per caller without cross-tenant collision', async () => {
    const app = createApp();
    const key = 'shared-key';
    const a = await request(app)
      .post('/bounties')
      .set('Cookie', COOKIE)
      .set('Idempotency-Key', key)
      .send(validBounty());
    const otherCookie = `devbounty_jwt=${signSession({
      sub: '0x1111111111111111111111111111111111111111',
      role: 'hunter',
    })}`;
    const b = await request(app)
      .post('/bounties')
      .set('Cookie', otherCookie)
      .set('Idempotency-Key', key)
      .send(validBounty());

    // A second caller reusing the same key string must not collide with the first
    // (no 500), and gets their own bounty.
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.body.bountyId).not.toBe(a.body.bountyId);
    expect(await BountyModel.countDocuments({})).toBe(2);
  });

  it('lists and filters bounties with pagination', async () => {
    const app = createApp();
    await request(app)
      .post('/bounties')
      .set('Cookie', COOKIE)
      .send(validBounty({ language: 'typescript' }));
    await request(app)
      .post('/bounties')
      .set('Cookie', COOKIE)
      .send(validBounty({ language: 'rust', issueNumber: 8 }));

    // The board only lists funded bounties; simulate the indexer confirming
    // both deposits so they leave 'pending_deposit' and surface on the board.
    await BountyModel.updateMany({}, { $set: { lifecycleStatus: 'open' } });

    const all = await request(app).get('/bounties');
    expect(all.status).toBe(200);
    expect(all.body.total).toBe(2);
    expect(all.body.items).toHaveLength(2);
    expect(all.body.page).toBe(1);

    const rust = await request(app).get('/bounties?language=rust');
    expect(rust.body.total).toBe(1);
    expect(rust.body.items[0].language).toBe('rust');

    const paged = await request(app).get('/bounties?pageSize=1&page=2');
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.pageSize).toBe(1);
  });

  it('records a deposit to move a bounty onto the board (fast-path)', async () => {
    const app = createApp();
    const create = await request(app).post('/bounties').set('Cookie', COOKIE).send(validBounty());
    const id = create.body.bountyId as string;
    expect(create.body.lifecycleStatus).toBe('pending_deposit');

    const tx = `0x${'cd'.repeat(32)}`;
    const recorded = await request(app)
      .post(`/bounties/${id}/deposit-recorded`)
      .set('Cookie', COOKIE)
      .send({ txHash: tx });
    expect(recorded.status).toBe(200);
    expect(recorded.body.status).toBe('open');

    // It now surfaces on the default board and is flagged not-pending.
    const board = await request(app).get('/bounties');
    expect(board.body.total).toBe(1);
    expect(board.body.items[0].pendingConfirmation).toBe(false);

    // A non-maintainer cannot record a deposit.
    const otherCookie = `devbounty_jwt=${signSession({
      sub: '0x2222222222222222222222222222222222222222',
      role: 'hunter',
    })}`;
    const second = await request(app).post('/bounties').set('Cookie', COOKIE).send(validBounty());
    const forbidden = await request(app)
      .post(`/bounties/${second.body.bountyId}/deposit-recorded`)
      .set('Cookie', otherCookie)
      .send({ txHash: tx });
    expect(forbidden.status).toBe(403);
  });

  it('hides unfunded pending_deposit bounties from the default board', async () => {
    const app = createApp();
    // A freshly created bounty is pending_deposit (no on-chain money yet).
    await request(app).post('/bounties').set('Cookie', COOKIE).send(validBounty());

    const board = await request(app).get('/bounties');
    expect(board.body.total).toBe(0);

    // Still discoverable when a maintainer tool asks for it explicitly.
    const pending = await request(app).get('/bounties?status=pending_deposit');
    expect(pending.body.total).toBe(1);
  });

  it('returns 404 for an unknown bounty', async () => {
    const res = await request(createApp()).get('/bounties/0xdeadbeef');
    expect(res.status).toBe(404);
  });

  it('returns public claims on bounty detail', async () => {
    const app = createApp();
    const create = await request(app).post('/bounties').set('Cookie', COOKIE).send(validBounty());
    const id = create.body.bountyId as string;
    await ClaimModel.create({
      bountyId: id,
      hunterAddress: ADDRESS,
      status: 'submitted',
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      prUrl: 'https://github.com/octocat/hello/pull/9',
      prNumber: 9,
    });

    const detail = await request(app).get(`/bounties/${id}`);
    expect(detail.body.claims).toHaveLength(1);
    expect(detail.body.claims[0].hunterAddress).toBe(ADDRESS);
    expect(detail.body.claims[0].status).toBe('submitted');
    expect(detail.body.claims[0].prNumber).toBe(9);
  });

  it('filters by minAmount numerically, not lexicographically', async () => {
    const app = createApp();
    await request(app)
      .post('/bounties')
      .set('Cookie', COOKIE)
      .send(validBounty({ amountUsdc: '9', issueNumber: 1 }));
    await request(app)
      .post('/bounties')
      .set('Cookie', COOKIE)
      .send(validBounty({ amountUsdc: '500', issueNumber: 2 }));

    // Board lists funded bounties only — confirm both deposits first.
    await BountyModel.updateMany({}, { $set: { lifecycleStatus: 'open' } });

    // Lexicographically '9' > '50', so a string compare would wrongly keep it.
    const res = await request(app).get('/bounties?minAmount=50');
    expect(res.body.total).toBe(1);
    expect(res.body.items[0].amountUsdc).toBe('500');
  });

  it('lets the maintainer cancel a pending-deposit bounty and hides it from the board', async () => {
    const app = createApp();
    const create = await request(app).post('/bounties').set('Cookie', COOKIE).send(validBounty());
    const id = create.body.bountyId as string;

    const cancel = await request(app).post(`/bounties/${id}/cancel`).set('Cookie', COOKIE);
    expect(cancel.status).toBe(200);
    expect(cancel.body.status).toBe('cancelled');

    // Hidden from the default board, still fetchable by id.
    const board = await request(app).get('/bounties');
    expect(board.body.total).toBe(0);
    const detail = await request(app).get(`/bounties/${id}`);
    expect(detail.body.lifecycleStatus).toBe('cancelled');
  });

  it('rejects a cancel from a non-maintainer', async () => {
    const app = createApp();
    const create = await request(app).post('/bounties').set('Cookie', COOKIE).send(validBounty());
    const id = create.body.bountyId as string;
    const otherCookie = `devbounty_jwt=${signSession({
      sub: '0x1111111111111111111111111111111111111111',
      role: 'hunter',
    })}`;

    const res = await request(app).post(`/bounties/${id}/cancel`).set('Cookie', otherCookie);
    expect(res.status).toBe(403);
  });

  it('refuses to cancel a bounty that is no longer pending deposit', async () => {
    const app = createApp();
    const create = await request(app).post('/bounties').set('Cookie', COOKIE).send(validBounty());
    const id = create.body.bountyId as string;
    await BountyModel.updateOne({ bountyId: id }, { $set: { lifecycleStatus: 'open' } });

    const res = await request(app).post(`/bounties/${id}/cancel`).set('Cookie', COOKIE);
    expect(res.status).toBe(409);
  });

  it('requires auth to cancel', async () => {
    const app = createApp();
    const create = await request(app).post('/bounties').set('Cookie', COOKIE).send(validBounty());
    const res = await request(app).post(`/bounties/${create.body.bountyId}/cancel`);
    expect(res.status).toBe(401);
  });
});
