import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from '../shared/config/env.js';
import { httpLogger } from '../shared/utils/logger.js';
import { errorMiddleware } from './middleware/error.js';
import { healthRouter } from './routes/health.js';

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
  // Mount express.raw() on that path BEFORE express.json() so it wins the route.
  // The actual webhook handler ships in a later issue; this ensures that when it
  // does, @octokit/webhooks receives an untouched Buffer.
  app.use('/webhooks/github', express.raw({ type: 'application/json' }));

  // JSON parser for all other routes
  app.use(express.json());

  // ── Routes ────────────────────────────────────────────────────────────────
  app.use('/health', healthRouter);

  // ── Central error handler — MUST be last middleware ───────────────────────
  app.use(errorMiddleware);

  return app;
}
