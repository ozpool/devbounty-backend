/**
 * Integration tests for the remaining maintainer-lifecycle endpoints: installing
 * a repo webhook (with secret rotation on re-register) and the refund UX
 * (eligibility check + recording a signed refund tx). GitHub's hook-creation call
 * is mocked so no network is touched.
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
const { encrypt } = await import('../shared/crypto/tokenCrypto.js');
const { BountyModel, ClaimModel, OAuthTokenModel, RepoModel } =
  await import('../shared/models/index.js');

const MAINTAINER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const cookieFor = (addr: string) =>
  `devbounty_jwt=${signSession({ sub: addr, role: 'maintainer' })}`;

async function linkAccount(address: string, githubUserId: number, login: string): Promise<void> {
  const blob = encrypt('gho_faketoken');
  await OAuthTokenModel.create({
    githubUserId,
    githubLogin: login,
    encryptedToken: blob.ciphertext,
    iv: blob.iv,
    authTag: blob.authTag,
    keyVersion: blob.keyVersion,
    scopes: ['repo'],
    linkedAddress: address,
  });
}

const linkMaintainer = () => linkAccount(MAINTAINER, 123, 'octocat');

async function makeBounty(overrides: Record<string, unknown> = {}): Promise<string> {
  const bountyId = `0x${randomBytes(32).toString('hex')}`;
  await BountyModel.create({
    bountyId,
    maintainerAddress: MAINTAINER,
    repo: { owner: 'octo', name: 'repo', fullName: 'octo/repo', githubRepoId: 1 },
    issueNumber: 1,
    issueTitle: 'Fix it',
    issueUrl: 'https://github.com/octo/repo/issues/1',
    amountUsdc: '100',
    language: 'typescript',
    onChainStatus: 'Open',
    lifecycleStatus: 'open',
    refundWindowSnapshot: 0, // window already elapsed by default
    ...overrides,
  });
  return bountyId;
}

// Mocks both GitHub calls the registration makes: GET /repos/:owner/:repo (resolve
// the id server-side) and POST .../hooks (install the webhook).
function mockHookCreate(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/hooks')) {
        return { ok: true, json: async () => ({ id: 555 }) };
      }
      return { ok: true, json: async () => ({ id: 1, full_name: 'octo/repo' }) };
    }),
  );
}

beforeAll(async () => {
  await mongoose.connect(mongod.getUri());
}, 30_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all([
    BountyModel.deleteMany({}),
    ClaimModel.deleteMany({}),
    OAuthTokenModel.deleteMany({}),
    RepoModel.deleteMany({}),
  ]);
});

describe('POST /repos/:owner/:repo/webhook', () => {
  it('installs the webhook and stores its encrypted secret', async () => {
    await linkMaintainer();
    mockHookCreate();
    const res = await request(createApp())
      .post('/repos/octo/repo/webhook')
      .set('Cookie', cookieFor(MAINTAINER))
      .send();

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ repo: 'octo/repo', webhookId: 555 });
    const repo = await RepoModel.findOne({ githubRepoId: 1 });
    expect(repo?.webhookId).toBe(555);
    expect(repo?.ownerAddress).toBe(MAINTAINER);
    expect(repo?.webhookSecretCurrent?.length).toBeGreaterThan(0);
    expect(repo?.webhookSecretPrevious).toBeUndefined();
  });

  it('rotates the secret on re-register, keeping the previous one', async () => {
    await linkMaintainer();
    mockHookCreate();
    const app = createApp();
    await request(app).post('/repos/octo/repo/webhook').set('Cookie', cookieFor(MAINTAINER)).send();
    await request(app).post('/repos/octo/repo/webhook').set('Cookie', cookieFor(MAINTAINER)).send();

    const repo = await RepoModel.findOne({ githubRepoId: 1 });
    expect(repo?.webhookSecretPrevious?.length).toBeGreaterThan(0);
    expect(repo?.webhookSecretRotatedAt).toBeInstanceOf(Date);
  });

  it('requires a linked GitHub account', async () => {
    mockHookCreate();
    const res = await request(createApp())
      .post('/repos/octo/repo/webhook')
      .set('Cookie', cookieFor(MAINTAINER))
      .send();
    expect(res.status).toBe(400);
  });

  it('refuses to take over a repo already registered to another wallet', async () => {
    await linkMaintainer();
    await linkAccount(OTHER, 456, 'otheruser');
    mockHookCreate();
    const app = createApp();
    await request(app).post('/repos/octo/repo/webhook').set('Cookie', cookieFor(MAINTAINER)).send();
    const res = await request(app)
      .post('/repos/octo/repo/webhook')
      .set('Cookie', cookieFor(OTHER))
      .send();
    expect(res.status).toBe(403);
  });
});

describe('GET /bounties/:id/refund-eligibility', () => {
  it('is eligible once the window elapsed with no active claim', async () => {
    const bountyId = await makeBounty();
    const res = await request(createApp())
      .get(`/bounties/${bountyId}/refund-eligibility`)
      .set('Cookie', cookieFor(MAINTAINER));
    expect(res.status).toBe(200);
    expect(res.body.eligible).toBe(true);
  });

  it('is ineligible while the refund window has not elapsed', async () => {
    const bountyId = await makeBounty({ refundWindowSnapshot: 1_000_000 });
    const res = await request(createApp())
      .get(`/bounties/${bountyId}/refund-eligibility`)
      .set('Cookie', cookieFor(MAINTAINER));
    expect(res.body.eligible).toBe(false);
    expect(res.body.reason).toMatch(/window/i);
  });

  it('is ineligible while a claim or submission is in progress', async () => {
    const bountyId = await makeBounty();
    await ClaimModel.create({
      bountyId,
      hunterAddress: OTHER,
      status: 'submitted',
      expiresAt: new Date(Date.now() + 1_000_000),
      prNumber: 7,
      repoIdAtSubmit: 1,
    });
    const res = await request(createApp())
      .get(`/bounties/${bountyId}/refund-eligibility`)
      .set('Cookie', cookieFor(MAINTAINER));
    expect(res.body.eligible).toBe(false);
  });

  it('forbids a non-maintainer', async () => {
    const bountyId = await makeBounty();
    const res = await request(createApp())
      .get(`/bounties/${bountyId}/refund-eligibility`)
      .set('Cookie', cookieFor(OTHER));
    expect(res.status).toBe(403);
  });
});

describe('POST /bounties/:id/refund-recorded', () => {
  const TX = `0x${'ab'.repeat(32)}`;

  it('records the refund and is idempotent on replay', async () => {
    const bountyId = await makeBounty();
    const app = createApp();
    const first = await request(app)
      .post(`/bounties/${bountyId}/refund-recorded`)
      .set('Cookie', cookieFor(MAINTAINER))
      .send({ txHash: TX });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ status: 'refunded' });

    const bounty = await BountyModel.findOne({ bountyId }).lean();
    expect(bounty?.lifecycleStatus).toBe('refunded');
    expect(bounty?.txRefund).toBe(TX);

    const second = await request(app)
      .post(`/bounties/${bountyId}/refund-recorded`)
      .set('Cookie', cookieFor(MAINTAINER))
      .send({ txHash: TX });
    expect(second.body.alreadyRecorded).toBe(true);
  });

  it('rejects a malformed tx hash', async () => {
    const bountyId = await makeBounty();
    const res = await request(createApp())
      .post(`/bounties/${bountyId}/refund-recorded`)
      .set('Cookie', cookieFor(MAINTAINER))
      .send({ txHash: 'nope' });
    expect(res.status).toBe(400);
  });
});
