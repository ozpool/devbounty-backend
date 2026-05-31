import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from '../shared/config/env.js';
import { httpLogger } from '../shared/utils/logger.js';
import { errorMiddleware } from './middleware/error.js';
import { healthRouter } from './routes/health.js';
import { authRouter } from './routes/auth.js';
import { githubAuthRouter } from './routes/github.js';
import { meRouter } from './routes/me.js';
import { reposRouter } from './routes/repos.js';
import { bountiesRouter } from './routes/bounties.js';
import { claimsRouter } from './routes/claims.js';
import { huntersRouter, leaderboardRouter } from './routes/reputation.js';
import { webhooksRouter } from './routes/webhooks.js';

export function createApp(): express.Application {
  const app = express();

  // ── Security headers ──────────────────────────────────────────────────────
  // Explicit CSP — no unsafe-inline, no unsafe-eval anywhere.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
        },
      },
    }),
  );

  // ── CORS — strict single origin, credentials allowed for cookie auth ───────
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'Idempotency-Key'],
    }),
  );

  // ── Request logging ───────────────────────────────────────────────────────
  app.use(httpLogger);

  // ── Cookie parser ─────────────────────────────────────────────────────────
  app.use(cookieParser());

  // ── Body parsers ──────────────────────────────────────────────────────────
  // /webhooks/github MUST receive the raw byte-exact body for HMAC verification.
  // Mount express.raw() on that path BEFORE express.json() so it wins the route
  // and the signed bytes reach the handler untouched (express.json then skips it
  // because body-parser marks the request body as already read).
  app.use('/webhooks/github', express.raw({ type: 'application/json' }));

  // JSON parser for all other routes — only parse bodies that actually declare
  // application/json, so a mislabelled or unexpected content type is left untouched.
  app.use(express.json({ type: 'application/json' }));

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use('/health', healthRouter);
  app.use('/auth', authRouter);
  app.use('/auth/github', githubAuthRouter);
  app.use('/me', meRouter);
  app.use('/repos', reposRouter);
  app.use('/bounties', bountiesRouter);
  app.use('/bounties', claimsRouter);
  app.use('/hunters', huntersRouter);
  app.use('/leaderboard', leaderboardRouter);
  app.use('/webhooks/github', webhooksRouter);

  // ── Central error handler — MUST be last middleware ───────────────────────
  app.use(errorMiddleware);

  return app;
}
