import { Router, type Request, type Response, type NextFunction } from 'express';
import mongoose from 'mongoose';
import { createPublicClient, http, type PublicClient } from 'viem';
import { env } from '../../shared/config/env.js';
import { logger } from '../../shared/utils/logger.js';
import { AppError } from '../../shared/utils/AppError.js';

const router = Router();

// ── helpers ──────────────────────────────────────────────────────────────────

interface TimedSuccess<T> {
  value: T;
  ms: number;
}
interface TimedError {
  error: string;
  ms: number;
}
type TimedResult<T> = TimedSuccess<T> | TimedError;

/** Race a promise against a timeout. Returns a timed error on timeout or rejection. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<TimedResult<T>> {
  const start = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });

  try {
    const value = await Promise.race([promise, timeout]);
    clearTimeout(timer);
    return { value, ms: Date.now() - start };
  } catch (err: unknown) {
    clearTimeout(timer);
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, ms: Date.now() - start };
  }
}

/** Ping MongoDB admin db — resolves to true on success. */
async function pingDb(): Promise<boolean> {
  const admin = mongoose.connection.db?.admin();
  if (!admin) return false;
  const result = (await admin.ping()) as { ok?: number };
  return result.ok === 1;
}

// Build a minimal viem publicClient from env. Full multi-provider chain config
// lands in a later issue — this is a bootstrap client for health checks only.
function buildPublicClient(): PublicClient | null {
  if (!env.RPC_URL_HTTP) return null;
  return createPublicClient({
    transport: http(env.RPC_URL_HTTP),
    chain: {
      id: env.CHAIN_ID,
      name: 'devbounty-chain',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [env.RPC_URL_HTTP] } },
    },
  });
}

// mongoose readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
const MONGO_STATE_NAMES: Record<number, string> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

// ── GET /health ───────────────────────────────────────────────────────────────

router.get('/', async (_req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const [dbResult, chainResult] = await Promise.all([
      withTimeout(pingDb(), 2000, 'db'),
      (async (): Promise<TimedResult<bigint>> => {
        const client = buildPublicClient();
        if (!client) {
          return { error: 'RPC_URL_HTTP not configured', ms: 0 };
        }
        return withTimeout(client.getBlockNumber(), 3000, 'chain');
      })(),
    ]);

    const dbOk = 'value' in dbResult && dbResult.value === true;
    const chainOk = 'value' in chainResult;
    const ok = dbOk && chainOk;

    // indexerLag: not yet implemented (indexer is a later issue) — honestly null
    const indexerLag: null = null;

    res.status(ok ? 200 : 503).json({
      ok,
      db: dbOk
        ? { status: 'ok', latencyMs: dbResult.ms }
        : {
            status: 'error',
            error: 'error' in dbResult ? dbResult.error : 'ping failed',
            latencyMs: dbResult.ms,
          },
      chain: chainOk
        ? {
            status: 'ok',
            blockNumber: (chainResult.value as bigint).toString(),
            latencyMs: chainResult.ms,
          }
        : {
            status: 'error',
            error: 'error' in chainResult ? chainResult.error : 'unknown',
            latencyMs: chainResult.ms,
          },
      // Indexer lag tracking is wired when the indexer ships (later issue)
      indexerLag,
    });
  } catch (err: unknown) {
    next(err);
  }
});

// ── GET /health/internal ──────────────────────────────────────────────────────

router.get('/internal', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  // Bearer token auth — compare exact match (constant-time comparison not strictly
  // needed here since timing attacks on health endpoints have no meaningful impact,
  // but we avoid branching on the secret length just the same)
  const authHeader = req.headers['authorization'] ?? '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  if (!token || token !== env.INTERNAL_HEALTH_TOKEN) {
    next(AppError.unauthorized('Invalid or missing internal health token'));
    return;
  }

  try {
    const [dbResult, chainResult] = await Promise.all([
      withTimeout(pingDb(), 2000, 'db'),
      (async (): Promise<TimedResult<bigint>> => {
        const client = buildPublicClient();
        if (!client) return { error: 'RPC_URL_HTTP not configured', ms: 0 };
        return withTimeout(client.getBlockNumber(), 3000, 'chain');
      })(),
    ]);

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
          ? {
              ok: true,
              blockNumber: (chainResult.value as bigint).toString(),
              latencyMs: chainResult.ms,
            }
          : {
              ok: false,
              error: 'error' in chainResult ? chainResult.error : 'unknown',
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
