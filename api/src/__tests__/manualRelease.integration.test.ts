/**
 * Integration tests for the maintainer manual-release fallback. GitHub's REST API
 * is mocked so the merge check runs without a network call; payout stays disabled
 * in tests, so a confirmed merge advances the bounty to 'releasing' (the indexer
 * would later flip it to 'paid' on the BountyReleased event).
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
const { BountyModel, ClaimModel, OAuthTokenModel } = await import('../shared/models/index.js');

const MAINTAINER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const OTHER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const HUNTER = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
const cookieFor = (addr: string) =>
  `devbounty_jwt=${signSession({ sub: addr, role: 'maintainer' })}`;

interface SeedOpts {
  withClaim?: boolean;
  linked?: boolean;
}

async function seed({ withClaim = true, linked = true }: SeedOpts = {}): Promise<string> {
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
    lifecycleStatus: 'submitted',
    refundWindowSnapshot: 1_209_600,
  });
  if (withClaim) {
    await ClaimModel.create({
      bountyId,
      hunterAddress: HUNTER,
      status: 'submitted',
      expiresAt: new Date(Date.now() + 1_000_000_000),
      prUrl: 'https://github.com/octo/repo/pull/7',
      prNumber: 7,
      repoIdAtSubmit: 1,
    });
  }
  if (linked) {
    const blob = encrypt('gho_faketoken');
    await OAuthTokenModel.create({
      githubUserId: 123,
      githubLogin: 'octocat',
      encryptedToken: blob.ciphertext,
      iv: blob.iv,
      authTag: blob.authTag,
      keyVersion: blob.keyVersion,
      scopes: ['repo'],
      linkedAddress: MAINTAINER,
    });
  }
  return bountyId;
}

function mockPullRequest(merged: boolean): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        merged,
        merge_commit_sha: merged ? 'abc123def456' : null,
        base: { repo: { id: 1 } },
      }),
    })),
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
  ]);
});

describe('POST /bounties/:id/manual-release', () => {
  it('releases when GitHub confirms the pull request is merged', async () => {
    const bountyId = await seed();
    mockPullRequest(true);
    const res = await request(createApp())
      .post(`/bounties/${bountyId}/manual-release`)
      .set('Cookie', cookieFor(MAINTAINER));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ bountyId, status: 'releasing', prNumber: 7 });
    const bounty = await BountyModel.findOne({ bountyId }).lean();
    expect(bounty?.lifecycleStatus).toBe('releasing');
    const claim = await ClaimModel.findOne({ bountyId }).lean();
    expect(claim?.prCommitSha).toBe('abc123def456');
  });

  it('rejects when the pull request is not merged', async () => {
    const bountyId = await seed();
    mockPullRequest(false);
    const res = await request(createApp())
      .post(`/bounties/${bountyId}/manual-release`)
      .set('Cookie', cookieFor(MAINTAINER));
    expect(res.status).toBe(409);
    const bounty = await BountyModel.findOne({ bountyId }).lean();
    expect(bounty?.lifecycleStatus).toBe('submitted');
  });

  it('forbids a non-maintainer from releasing', async () => {
    const bountyId = await seed();
    mockPullRequest(true);
    const res = await request(createApp())
      .post(`/bounties/${bountyId}/manual-release`)
      .set('Cookie', cookieFor(OTHER));
    expect(res.status).toBe(403);
  });

  it('returns 409 when there is no submitted pull request', async () => {
    const bountyId = await seed({ withClaim: false });
    mockPullRequest(true);
    const res = await request(createApp())
      .post(`/bounties/${bountyId}/manual-release`)
      .set('Cookie', cookieFor(MAINTAINER));
    expect(res.status).toBe(409);
  });

  it('requires a linked GitHub account', async () => {
    const bountyId = await seed({ linked: false });
    mockPullRequest(true);
    const res = await request(createApp())
      .post(`/bounties/${bountyId}/manual-release`)
      .set('Cookie', cookieFor(MAINTAINER));
    expect(res.status).toBe(400);
  });
});
