/**
 * Integration tests for the GitHub merge webhook ingest endpoint.
 * Each test signs a raw body with HMAC-SHA256 over the exact bytes sent, mirroring
 * what GitHub does, so signature verification runs against real payloads.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import request from 'supertest';
import mongoose from 'mongoose';
import { createHmac } from 'crypto';
import { MongoMemoryServer } from 'mongodb-memory-server';

process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'fatal';
process.env['CORS_ORIGIN'] = 'http://localhost:3000';
process.env['API_PUBLIC_BASE_URL'] = 'http://localhost:4000';
process.env['INTERNAL_HEALTH_TOKEN'] = 'test-internal-token';

const mongod = await MongoMemoryServer.create();
process.env['MONGO_URI'] = mongod.getUri();

const { createApp } = await import('../api/app.js');
const { BountyModel, ClaimModel, HunterModel, RepoModel, WebhookDeliveryModel } =
  await import('../shared/models/index.js');
const { encryptToBuffer } = await import('../shared/crypto/tokenCrypto.js');

const WEBHOOK_ID = 700001;
const REPO_ID = 4242;
const PR_NUMBER = 7;
const BOUNTY_ID = `0x${'a'.repeat(64)}`;
const HUNTER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const HUNTER_LOGIN = 'octohunter';
const DEFAULT_BRANCH = 'main';
const SIGNING_KEY = 'primary-test-signing-key';

function sign(rawBody: string, key: string): string {
  return `sha256=${createHmac('sha256', key).update(rawBody).digest('hex')}`;
}

const app = createApp();

interface PostOpts {
  body: string;
  deliveryId: string;
  event?: string;
  hookId?: number;
  signature?: string;
}

function postWebhook(opts: PostOpts): request.Test {
  const req = request(app)
    .post('/webhooks/github')
    .set('Content-Type', 'application/json')
    .set('X-GitHub-Event', opts.event ?? 'pull_request')
    .set('X-GitHub-Delivery', opts.deliveryId)
    .set('X-GitHub-Hook-ID', String(opts.hookId ?? WEBHOOK_ID));
  if (opts.signature !== undefined) req.set('X-Hub-Signature-256', opts.signature);
  return req.send(opts.body);
}

function mergedBody(
  opts: {
    prNumber?: number;
    sha?: string;
    baseRef?: string;
    baseRepoId?: number;
    author?: string;
  } = {},
): string {
  const {
    prNumber = PR_NUMBER,
    sha = 'merge-sha-abc123',
    baseRef = DEFAULT_BRANCH,
    baseRepoId = REPO_ID,
    author = HUNTER_LOGIN,
  } = opts;
  return JSON.stringify({
    action: 'closed',
    repository: { default_branch: DEFAULT_BRANCH },
    pull_request: {
      number: prNumber,
      merged: true,
      merge_commit_sha: sha,
      base: { ref: baseRef, repo: { id: baseRepoId } },
      user: { login: author },
    },
  });
}

async function seedRepo(overrides: Record<string, unknown> = {}): Promise<void> {
  const sealed = encryptToBuffer(SIGNING_KEY);
  await RepoModel.create({
    fullName: 'octo/repo',
    githubRepoId: REPO_ID,
    ownerAddress: '0xowner',
    webhookId: WEBHOOK_ID,
    webhookSecretCurrent: sealed.buffer,
    webhookKeyVersion: sealed.keyVersion,
    ...overrides,
  });
}

async function seedBountyAndClaim(): Promise<void> {
  // The strict merge check requires the PR author to match the claiming hunter's
  // linked GitHub login, so the hunter must exist with that login.
  await HunterModel.create({
    address: HUNTER,
    githubLogin: HUNTER_LOGIN,
    totalEarnedUsdc: '0',
    payoutCount: 0,
    reposContributed: 0,
    languages: [],
  });
  await BountyModel.create({
    bountyId: BOUNTY_ID,
    maintainerAddress: '0xmaintainer',
    repo: { owner: 'octo', name: 'repo', fullName: 'octo/repo', githubRepoId: REPO_ID },
    issueNumber: 1,
    issueTitle: 'Fix the bug',
    issueUrl: 'https://github.com/octo/repo/issues/1',
    amountUsdc: '500',
    language: 'typescript',
    refundWindowSnapshot: 1209600,
    lifecycleStatus: 'submitted',
  });
  await ClaimModel.create({
    bountyId: BOUNTY_ID,
    hunterAddress: HUNTER,
    status: 'submitted',
    expiresAt: new Date(Date.now() + 1_000_000_000),
    prUrl: `https://github.com/octo/repo/pull/${PR_NUMBER}`,
    prNumber: PR_NUMBER,
    repoIdAtSubmit: REPO_ID,
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
    RepoModel.deleteMany({}),
    WebhookDeliveryModel.deleteMany({}),
  ]);
});

describe('POST /webhooks/github', () => {
  it('releases a bounty when a matching pull request is merged', async () => {
    await seedRepo();
    await seedBountyAndClaim();
    const body = mergedBody();
    const res = await postWebhook({
      body,
      deliveryId: 'd-merge',
      signature: sign(body, SIGNING_KEY),
    });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ matched: true, bountyId: BOUNTY_ID });

    const bounty = await BountyModel.findOne({ bountyId: BOUNTY_ID }).lean();
    const claim = await ClaimModel.findOne({ bountyId: BOUNTY_ID }).lean();
    const delivery = await WebhookDeliveryModel.findOne({ deliveryId: 'd-merge' }).lean();
    expect(bounty?.lifecycleStatus).toBe('releasing');
    expect(claim?.prCommitSha).toBe('merge-sha-abc123');
    expect(delivery?.processedOk).toBe(true);
  });

  it('rejects an invalid signature without changing state', async () => {
    await seedRepo();
    await seedBountyAndClaim();
    const body = mergedBody();
    const res = await postWebhook({
      body,
      deliveryId: 'd-bad',
      signature: sign(body, 'wrong-key'),
    });

    expect(res.status).toBe(401);
    const bounty = await BountyModel.findOne({ bountyId: BOUNTY_ID }).lean();
    expect(bounty?.lifecycleStatus).toBe('submitted');
    const delivery = await WebhookDeliveryModel.findOne({ deliveryId: 'd-bad' }).lean();
    expect(delivery).toBeNull();
  });

  it('returns 404 for an unknown webhook id', async () => {
    await seedRepo();
    const body = mergedBody();
    const res = await postWebhook({
      body,
      deliveryId: 'd-unknown',
      hookId: 999999,
      signature: sign(body, SIGNING_KEY),
    });
    expect(res.status).toBe(404);
  });

  it('treats a redelivery of a processed delivery as a duplicate', async () => {
    await seedRepo();
    await seedBountyAndClaim();
    const body = mergedBody();
    const sig = sign(body, SIGNING_KEY);
    const first = await postWebhook({ body, deliveryId: 'd-dup', signature: sig });
    expect(first.body).toMatchObject({ matched: true });

    const second = await postWebhook({ body, deliveryId: 'd-dup', signature: sig });
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);

    const delivery = await WebhookDeliveryModel.findOne({ deliveryId: 'd-dup' }).lean();
    expect(delivery?.attempts).toBe(2);
  });

  it('verifies a delivery signed with the previous secret during rotation', async () => {
    const oldKey = 'old-rotated-key';
    const current = encryptToBuffer(SIGNING_KEY);
    const previous = encryptToBuffer(oldKey);
    await RepoModel.create({
      fullName: 'octo/rotated',
      githubRepoId: 5555,
      ownerAddress: '0xowner',
      webhookId: 800002,
      webhookSecretCurrent: current.buffer,
      webhookSecretPrevious: previous.buffer,
      webhookSecretRotatedAt: new Date(),
      webhookKeyVersion: current.keyVersion,
    });
    const body = JSON.stringify({ action: 'opened', pull_request: { number: 1 } });
    const res = await postWebhook({
      body,
      deliveryId: 'd-rot',
      hookId: 800002,
      signature: sign(body, oldKey),
    });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe('not a merge');
  });

  it('rejects the previous secret once the rotation window has closed', async () => {
    const oldKey = 'expired-key';
    const current = encryptToBuffer(SIGNING_KEY);
    const previous = encryptToBuffer(oldKey);
    await RepoModel.create({
      fullName: 'octo/expired',
      githubRepoId: 6666,
      ownerAddress: '0xowner',
      webhookId: 800003,
      webhookSecretCurrent: current.buffer,
      webhookSecretPrevious: previous.buffer,
      webhookSecretRotatedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
      webhookKeyVersion: current.keyVersion,
    });
    const body = mergedBody();
    const res = await postWebhook({
      body,
      deliveryId: 'd-exp',
      hookId: 800003,
      signature: sign(body, oldKey),
    });
    expect(res.status).toBe(401);
  });

  it('ignores a merge into a non-default branch', async () => {
    await seedRepo();
    await seedBountyAndClaim();
    const body = mergedBody({ baseRef: 'release/v1' });
    const res = await postWebhook({
      body,
      deliveryId: 'd-branch',
      signature: sign(body, SIGNING_KEY),
    });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toMatch(/default branch/);
    const bounty = await BountyModel.findOne({ bountyId: BOUNTY_ID }).lean();
    expect(bounty?.lifecycleStatus).toBe('submitted');
  });

  it('ignores a merge whose PR author is not the claiming hunter', async () => {
    await seedRepo();
    await seedBountyAndClaim();
    const body = mergedBody({ author: 'someone-else' });
    const res = await postWebhook({
      body,
      deliveryId: 'd-author',
      signature: sign(body, SIGNING_KEY),
    });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toMatch(/author/);
    const bounty = await BountyModel.findOne({ bountyId: BOUNTY_ID }).lean();
    expect(bounty?.lifecycleStatus).toBe('submitted');
  });

  it('ignores a non-merge pull request event', async () => {
    await seedRepo();
    await seedBountyAndClaim();
    const body = JSON.stringify({ action: 'opened', pull_request: { number: PR_NUMBER } });
    const res = await postWebhook({
      body,
      deliveryId: 'd-open',
      signature: sign(body, SIGNING_KEY),
    });
    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe('not a merge');
    const bounty = await BountyModel.findOne({ bountyId: BOUNTY_ID }).lean();
    expect(bounty?.lifecycleStatus).toBe('submitted');
  });

  it('returns 400 when the signature header is missing', async () => {
    await seedRepo();
    const body = mergedBody();
    const res = await postWebhook({ body, deliveryId: 'd-nosig' });
    expect(res.status).toBe(400);
  });
});
