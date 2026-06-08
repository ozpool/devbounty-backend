/**
 * Tests for the in-memory rate-limit middleware and its wiring into the app.
 * No database needed — every rejection here happens before any DB access.
 */
import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import express, { type Request } from 'express';

process.env['NODE_ENV'] = 'test';
process.env['LOG_LEVEL'] = 'fatal';
// Low caps so the wiring tests below stay tiny and deterministic. Set before any
// import that loads the env (frozen on first read). Cleared in afterAll so a
// later test file sharing this worker re-reads the defaults.
process.env['RATE_LIMIT_AUTH_MAX'] = '3';
process.env['RATE_LIMIT_MUTATION_MAX'] = '2';

const { rateLimit, ipKey } = await import('../api/middleware/rateLimit.js');
const { errorMiddleware } = await import('../api/middleware/error.js');
const { createApp } = await import('../api/app.js');

afterAll(() => {
  delete process.env['RATE_LIMIT_AUTH_MAX'];
  delete process.env['RATE_LIMIT_MUTATION_MAX'];
});

// Build a tiny app whose only route is guarded by the given limiter.
function appWith(limiter: express.RequestHandler): express.Application {
  const app = express();
  app.get('/x', limiter, (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorMiddleware);
  return app;
}

describe('rateLimit middleware', () => {
  it('allows up to max then rejects with 429 and headers', async () => {
    const app = appWith(rateLimit({ windowMs: 60_000, max: 2, keyBy: ipKey }));
    const agent = request.agent(app);

    const first = await agent.get('/x');
    expect(first.status).toBe(200);
    expect(first.headers['ratelimit-limit']).toBe('2');
    expect(first.headers['ratelimit-remaining']).toBe('1');

    const second = await agent.get('/x');
    expect(second.status).toBe(200);
    expect(second.headers['ratelimit-remaining']).toBe('0');

    const third = await agent.get('/x');
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('RATE_LIMITED');
    expect(third.headers['retry-after']).toBeDefined();
  });

  it('rolls the window over once it expires', async () => {
    let clock = 10_000;
    const now = (): number => clock;
    const app = appWith(rateLimit({ windowMs: 1000, max: 1, keyBy: ipKey, now }));
    const agent = request.agent(app);

    expect((await agent.get('/x')).status).toBe(200);
    expect((await agent.get('/x')).status).toBe(429);

    clock += 1001; // advance past the window
    expect((await agent.get('/x')).status).toBe(200);
  });

  it('keeps separate counters per key', async () => {
    const keyBy = (req: Request): string => (req.headers['x-key'] as string) ?? 'none';
    const app = appWith(rateLimit({ windowMs: 60_000, max: 1, keyBy }));

    expect((await request(app).get('/x').set('x-key', 'a')).status).toBe(200);
    expect((await request(app).get('/x').set('x-key', 'a')).status).toBe(429);
    // A different key has its own fresh budget.
    expect((await request(app).get('/x').set('x-key', 'b')).status).toBe(200);
  });
});

describe('rate-limit wiring in createApp', () => {
  it('caps /auth at the configured limit (IP keyed)', async () => {
    const agent = request.agent(createApp());
    // RATE_LIMIT_AUTH_MAX=3 → the 4th nonce request is rejected.
    for (let i = 0; i < 3; i += 1) {
      expect((await agent.post('/auth/siwe/nonce').send({})).status).toBe(200);
    }
    expect((await agent.post('/auth/siwe/nonce').send({})).status).toBe(429);
  });

  it('caps mutating routes; the auth rejection still precedes the limiter', async () => {
    const agent = request.agent(createApp());
    // No session → requireAuth would 401, but the limiter runs first at app level.
    // RATE_LIMIT_MUTATION_MAX=2 → first two reach the router (401), the third is 429.
    expect((await agent.post('/bounties').send({})).status).toBe(401);
    expect((await agent.post('/bounties').send({})).status).toBe(401);
    expect((await agent.post('/bounties').send({})).status).toBe(429);
  });

  it('does not rate-limit safe methods or exempt paths', async () => {
    const agent = request.agent(createApp());
    // Health is a GET (safe method) — never limited.
    for (let i = 0; i < 5; i += 1) {
      expect((await agent.get('/health')).status).toBe(200);
    }
    // /webhooks/github is exempt — many posts never yield a 429 (they fail the
    // signature check with 4xx, but the limiter must not be what blocks them).
    for (let i = 0; i < 5; i += 1) {
      expect((await agent.post('/webhooks/github').send({})).status).not.toBe(429);
    }
  });
});
