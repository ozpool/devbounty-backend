/**
 * Integration tests for GitHub OAuth account linking and admin repo listing.
 * GitHub's HTTP calls are mocked via a stubbed global fetch.
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

const { createApp } = await import('../api/app.js');
const { signSession, signGithubState } = await import('../shared/auth/jwt.js');
const { OAuthTokenModel, HunterModel } = await import('../shared/models/index.js');

const ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const COOKIE = `devbounty_jwt=${signSession({ sub: ADDRESS, role: 'hunter' })}`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function installFetchMock(): void {
  const fn = vi.fn((input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.startsWith('https://github.com/login/oauth/access_token')) {
      return Promise.resolve(json({ access_token: 'gho_example', scope: 'read:user,repo' }));
    }
    if (url === 'https://api.github.com/user') {
      return Promise.resolve(json({ id: 4242, login: 'octocat' }));
    }
    if (url.startsWith('https://api.github.com/user/repos')) {
      return Promise.resolve(
        json([
          { full_name: 'octocat/admin-repo', id: 1, private: false, permissions: { admin: true } },
          { full_name: 'octocat/read-only', id: 2, private: false, permissions: { admin: false } },
        ]),
      );
    }
    return Promise.resolve(new Response('not found', { status: 404 }));
  });
  vi.stubGlobal('fetch', fn);
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
  await OAuthTokenModel.deleteMany({});
  await HunterModel.deleteMany({});
});

async function startLink(agent: ReturnType<typeof request.agent>): Promise<string> {
  const start = await agent.get('/auth/github/start').set('Cookie', COOKIE);
  expect(start.status).toBe(302);
  const match = /[?&]state=([^&]+)/.exec(start.headers.location ?? '');
  const state = match?.[1];
  if (!state) throw new Error('no state in /start redirect');
  return decodeURIComponent(state);
}

describe('GitHub OAuth linking', () => {
  it('redirects /auth/github/start to GitHub with a state', async () => {
    const res = await request(createApp()).get('/auth/github/start').set('Cookie', COOKIE);
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('github.com/login/oauth/authorize');
    expect(res.headers.location).toContain('state=');
  });

  it('rejects /auth/github/start without a session', async () => {
    const res = await request(createApp()).get('/auth/github/start');
    expect(res.status).toBe(401);
  });

  it('links the GitHub account on a valid callback', async () => {
    installFetchMock();
    const agent = request.agent(createApp());
    const state = await startLink(agent);
    const res = await agent.get(
      `/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(302);
    expect(res.headers.location).toContain('github=linked');

    const hunter = await HunterModel.findOne({ address: ADDRESS }).lean();
    expect(hunter?.githubLogin).toBe('octocat');
    const link = await OAuthTokenModel.findOne({ githubUserId: 4242 }).lean();
    expect(link?.linkedAddress).toBe(ADDRESS);
    expect(link?.encryptedToken).toBeDefined();
  });

  it('rejects a callback with an invalid state', async () => {
    installFetchMock();
    const res = await request(createApp()).get('/auth/github/callback?code=abc&state=garbage');
    expect(res.status).toBe(401);
  });

  it('rejects a callback whose state is not bound to this browser', async () => {
    installFetchMock();
    // Validly-signed state but no matching nonce cookie — the CSRF guard.
    const state = signGithubState(ADDRESS, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const res = await request(createApp()).get(
      `/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`,
    );
    expect(res.status).toBe(401);
  });

  it('lists only admin repos for a linked wallet', async () => {
    installFetchMock();
    const agent = request.agent(createApp());
    const state = await startLink(agent);
    await agent.get(`/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`);

    const res = await agent.get('/repos').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.repos).toHaveLength(1);
    expect(res.body.repos[0].fullName).toBe('octocat/admin-repo');
  });

  it('requires a linked account for /repos', async () => {
    const res = await request(createApp()).get('/repos').set('Cookie', COOKIE);
    expect(res.status).toBe(400);
  });

  it('unlinks the caller GitHub account and clears the hunter identity', async () => {
    installFetchMock();
    const agent = request.agent(createApp());
    const state = await startLink(agent);
    await agent.get(`/auth/github/callback?code=abc&state=${encodeURIComponent(state)}`);
    expect(await OAuthTokenModel.findOne({ linkedAddress: ADDRESS }).lean()).not.toBeNull();

    const res = await agent.delete('/auth/github/link').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.unlinked).toBe(true);
    expect(await OAuthTokenModel.findOne({ linkedAddress: ADDRESS }).lean()).toBeNull();
    const hunter = await HunterModel.findOne({ address: ADDRESS }).lean();
    expect(hunter?.githubLogin).toBeUndefined();
    expect(hunter?.githubUserId).toBeUndefined();
  });

  it('rejects unlink without a session', async () => {
    const res = await request(createApp()).delete('/auth/github/link');
    expect(res.status).toBe(401);
  });

  it('treats unlink as idempotent when nothing is linked', async () => {
    const res = await request(createApp()).delete('/auth/github/link').set('Cookie', COOKIE);
    expect(res.status).toBe(200);
    expect(res.body.unlinked).toBe(false);
  });
});
