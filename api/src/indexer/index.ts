import { pathToFileURL } from 'node:url';
import { type Address } from 'viem';
import { env } from '../shared/config/env.js';
import { connectDb, registerShutdownHandlers } from '../shared/config/db.js';
import { logger } from '../shared/utils/logger.js';
import { initSentry } from '../shared/utils/sentry.js';
import { getPublicClient, getEscrowAddress, isIndexerConfigured } from '../shared/chain/clients.js';
import { escrowAbi } from '../shared/chain/escrowAbi.js';
import { IndexerStateModel } from '../shared/models/index.js';
import { handleBountyCreated, handleBountyReleased, handleBountyRefunded } from './handlers.js';

const STATE_ID = 'singleton';
const POLL_INTERVAL_MS = 5_000;
const MAX_RANGE = 2_000n; // blocks scanned per getLogs call, to stay under RPC limits
const BACKOFF_CAP_MS = 30_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function loadLastBlock(): Promise<bigint> {
  const state = await IndexerStateModel.findById(STATE_ID).lean();
  return BigInt(state?.lastBlock ?? env.INDEXER_START_BLOCK);
}

async function saveLastBlock(block: bigint): Promise<void> {
  await IndexerStateModel.updateOne(
    { _id: STATE_ID },
    { $set: { lastBlock: Number(block), lastEventAt: new Date() } },
    { upsert: true },
  );
}

async function scanRange(escrow: Address, fromBlock: bigint, toBlock: bigint): Promise<void> {
  const logs = await getPublicClient().getContractEvents({
    address: escrow,
    abi: escrowAbi,
    fromBlock,
    toBlock,
    strict: true, // only fully-decoded logs; gives non-optional, typed args
  });
  for (const log of logs) {
    if (log.blockNumber === null || log.transactionHash === null) continue; // skip pending
    const base = { txHash: log.transactionHash, blockNumber: log.blockNumber };
    if (log.eventName === 'BountyCreated') {
      await handleBountyCreated({ ...log.args, ...base });
    } else if (log.eventName === 'BountyReleased') {
      await handleBountyReleased({ ...log.args, ...base });
    } else if (log.eventName === 'BountyRefunded') {
      await handleBountyRefunded({ ...log.args, ...base });
    }
  }
}

// Advance once: scan the next confirmed, range-capped window and checkpoint it.
async function tick(escrow: Address): Promise<void> {
  const head = await getPublicClient().getBlockNumber();
  const confirmed = head - BigInt(env.INDEXER_CONFIRMATIONS);
  const last = await loadLastBlock();
  if (confirmed <= last) return;
  const to = last + MAX_RANGE < confirmed ? last + MAX_RANGE : confirmed;
  await scanRange(escrow, last + 1n, to);
  await saveLastBlock(to);
}

export async function startIndexer(): Promise<void> {
  if (!isIndexerConfigured()) {
    logger.warn('Indexer has no ESCROW_ADDRESS configured — nothing to watch, exiting');
    return;
  }
  initSentry(env.SENTRY_DSN);
  await connectDb();
  registerShutdownHandlers();
  const escrow = getEscrowAddress();
  logger.info({ escrow, confirmations: env.INDEXER_CONFIRMATIONS }, 'indexer started');

  let backoff = POLL_INTERVAL_MS;
  for (;;) {
    try {
      await tick(escrow);
      backoff = POLL_INTERVAL_MS; // healthy poll resets the backoff
      await sleep(POLL_INTERVAL_MS);
    } catch (err: unknown) {
      logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        'indexer poll failed',
      );
      await sleep(backoff);
      backoff = Math.min(backoff * 2, BACKOFF_CAP_MS);
    }
  }
}

// Only run when invoked directly (the entrypoint), not when imported by a test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startIndexer().catch((err: unknown) => {
    logger.error({ err }, 'fatal indexer error');
    process.exit(1);
  });
}
