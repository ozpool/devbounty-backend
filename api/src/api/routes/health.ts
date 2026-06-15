import { Router, type Request, type Response, type NextFunction } from 'express';
import { timingSafeEqual } from 'crypto';
import mongoose from 'mongoose';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/utils/logger.js';
import { AppError } from '../../shared/utils/AppError.js';
import {
  runDependencyChecks,
  sanitizeErrorMessage,
  MONGO_STATE_NAMES,
} from '../../shared/utils/healthChecks.js';

const router = Router();

// ── GET /health — liveness ──────────────────────────────────────────────────
// Dependency-free on purpose: it answers instantly whether THIS process is alive,
// touching no DB or RPC. A liveness probe must never flap because Mongo or the RPC
// had a blip — that would kill a healthy instance. Readiness (which does check
// dependencies) is a separate endpoint below.
router.get('/', (_req: Request, res: Response): void => {
  res.status(200).json({ ok: true, status: 'live', uptime: process.uptime() });
});

// ── GET /health/ready — readiness ───────────────────────────────────────────
// Checks the dependencies this instance needs to serve traffic (DB + chain RPC).
// Returns 503 if any is down so a load balancer can route around it.
router.get('/ready', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const { dbResult, chainResult } = await runDependencyChecks();
    const dbOk = 'value' in dbResult && dbResult.value === true;
    const chainOk = 'value' in chainResult;
    const ok = dbOk && chainOk;

    res.status(ok ? 200 : 503).json({
      ok,
      // Public endpoint: report status only, never the upstream error detail.
      db: { status: dbOk ? 'ok' : 'error', latencyMs: dbResult.ms },
      chain: chainOk
        ? {
            status: 'ok',
            blockNumber: (chainResult as { value: bigint }).value.toString(),
            latencyMs: chainResult.ms,
          }
        : { status: 'error', latencyMs: chainResult.ms },
      // Indexer lag tracking is wired when the indexer ships (later issue)
      indexerLag: null,
    });
  } catch (err: unknown) {
    next(err);
  }
});

// ── GET /health/internal — full diagnostics, Bearer-token gated ─────────────
router.get('/internal', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  // Bearer token auth with constant-time comparison.
  const authHeader = req.headers['authorization'] ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  const provided = Buffer.from(token);
  const expected = Buffer.from(env.INTERNAL_HEALTH_TOKEN);
  const authorized = provided.length === expected.length && timingSafeEqual(provided, expected);
  if (!authorized) {
    next(AppError.unauthorized('Invalid or missing internal health token'));
    return;
  }

  try {
    const { dbResult, chainResult } = await runDependencyChecks();
    const mongoState = mongoose.connection.readyState;

    logger.info('Internal health check requested');

    res.status(200).json({
      ok: true,
      uptime: process.uptime(),
      db: {
        state: MONGO_STATE_NAMES[mongoState] ?? 'unknown',
        ok: 'value' in dbResult && dbResult.value === true,
        latencyMs: dbResult.ms,
      },
      chain:
        'value' in chainResult
          ? { ok: true, blockNumber: chainResult.value.toString(), latencyMs: chainResult.ms }
          : {
              ok: false,
              error: 'error' in chainResult ? sanitizeErrorMessage(chainResult.error) : 'unknown',
              latencyMs: chainResult.ms,
            },
      // Indexer state not yet implemented — null is honest
      indexer: null,
    });
  } catch (err: unknown) {
    next(err);
  }
});

export { router as healthRouter };
