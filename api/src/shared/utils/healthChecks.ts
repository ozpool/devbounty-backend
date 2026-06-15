import mongoose from 'mongoose';
import { createPublicClient, http, type PublicClient } from 'viem';
import { env } from '../config/env.js';
import { IndexerStateModel } from '../models/indexerState.model.js';

// ── Timed results ──────────────────────────────────────────────────────────────

export interface TimedSuccess<T> {
  value: T;
  ms: number;
}
export interface TimedError {
  error: string;
  ms: number;
}
export type TimedResult<T> = TimedSuccess<T> | TimedError;

/** Race a promise against a timeout. Returns a timed error on timeout or rejection. */
export async function withTimeout<T>(
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

/**
 * Ping MongoDB admin db — resolves to true on success, false otherwise.
 * Never throws: a disconnected client or a failed ping is reported as false so
 * callers can treat the result as a plain health boolean.
 */
export async function pingDb(): Promise<boolean> {
  // readyState 1 = connected; anything else means there is nothing to ping.
  if (mongoose.connection.readyState !== 1) return false;
  try {
    const admin = mongoose.connection.db?.admin();
    if (!admin) return false;
    const result = (await admin.ping()) as { ok?: number };
    return result.ok === 1;
  } catch {
    return false;
  }
}

// Build a minimal viem publicClient from env. Full multi-provider chain config
// lands in a later issue — this is a bootstrap client for health checks only.
export function buildPublicClient(): PublicClient | null {
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

// Error messages from viem/mongoose can embed the RPC URL, which may carry an
// API key or credentials. Strip URLs before returning a message to any caller.
export function sanitizeErrorMessage(msg: string): string {
  return msg.replace(/https?:\/\/\S+/gi, '[redacted-url]');
}

// mongoose readyState: 0=disconnected, 1=connected, 2=connecting, 3=disconnecting
export const MONGO_STATE_NAMES: Record<number, string> = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

export interface DependencyChecks {
  dbResult: TimedResult<boolean>;
  chainResult: TimedResult<bigint>;
}

// ── Indexer heartbeat / lag ──────────────────────────────────────────────────

export interface IndexerStateSnapshot {
  lastBlock: number;
  updatedAt?: Date;
  lastEventAt?: Date;
}

export interface IndexerHealth {
  lastBlock: number;
  lastEventAt: string | null;
  updatedAt: string | null;
  heartbeatAgeMs: number | null; // how long since the checkpoint last advanced
  lagBlocks: number | null; // chain head minus the indexed block, when head is known
  stale: boolean; // heartbeat older than the configured threshold (or never seen)
}

/** Read the singleton indexer checkpoint, or null when it has never run / DB is down. */
export async function readIndexerState(): Promise<IndexerStateSnapshot | null> {
  if (mongoose.connection.readyState !== 1) return null;
  try {
    const row = await IndexerStateModel.findById('singleton').lean();
    if (!row) return null;
    return { lastBlock: row.lastBlock, updatedAt: row.updatedAt, lastEventAt: row.lastEventAt };
  } catch {
    return null;
  }
}

/**
 * Assemble the reported indexer health from a checkpoint snapshot and the current
 * chain head. Pure (clock and head injected) so the lag/staleness logic is unit
 * testable. Returns null when the indexer has no checkpoint yet.
 */
export function buildIndexerHealth(
  state: IndexerStateSnapshot | null,
  headBlock: bigint | null,
  staleAfterMs: number,
  now: number,
): IndexerHealth | null {
  if (!state) return null;
  const updatedMs = state.updatedAt ? state.updatedAt.getTime() : null;
  const heartbeatAgeMs = updatedMs === null ? null : now - updatedMs;
  const lagBlocks = headBlock === null ? null : Number(headBlock) - state.lastBlock;
  const stale = heartbeatAgeMs === null || heartbeatAgeMs > staleAfterMs;
  return {
    lastBlock: state.lastBlock,
    lastEventAt: state.lastEventAt ? state.lastEventAt.toISOString() : null,
    updatedAt: state.updatedAt ? state.updatedAt.toISOString() : null,
    heartbeatAgeMs,
    lagBlocks,
    stale,
  };
}

/** Run the DB ping and chain block-number read concurrently, each time-boxed. */
export async function runDependencyChecks(): Promise<DependencyChecks> {
  const [dbResult, chainResult] = await Promise.all([
    withTimeout(pingDb(), 2000, 'db'),
    (async (): Promise<TimedResult<bigint>> => {
      const client = buildPublicClient();
      if (!client) return { error: 'RPC_URL_HTTP not configured', ms: 0 };
      return withTimeout(client.getBlockNumber(), 3000, 'chain');
    })(),
  ]);
  return { dbResult, chainResult };
}
