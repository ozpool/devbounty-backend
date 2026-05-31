import { formatUnits, getAddress, type Address, type Hex } from 'viem';
import { Types } from 'mongoose';
import {
  BountyModel,
  ClaimModel,
  HunterModel,
  ReputationEventModel,
} from '../shared/models/index.js';

const USDC_DECIMALS = 6;

export interface CreatedEvent {
  id: Hex;
  maintainer: Address;
  amount: bigint;
  refundWindow: bigint;
  txHash: Hex;
  blockNumber: bigint;
}

export interface ReleasedEvent {
  id: Hex;
  hunter: Address;
  amount: bigint;
  prCommitSha: Hex;
  txHash: Hex;
  blockNumber: bigint;
}

export interface RefundedEvent {
  id: Hex;
  amount: bigint;
  txHash: Hex;
  blockNumber: bigint;
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 11000
  );
}

// BountyCreated confirms the on-chain deposit landed: mark the escrow Open and
// move a still-pending bounty to 'open'. Both updates are id-scoped so a replay
// is a harmless no-op.
export async function handleBountyCreated(e: CreatedEvent): Promise<void> {
  await BountyModel.updateOne(
    { bountyId: e.id },
    { $set: { onChainStatus: 'Open', txCreate: e.txHash } },
  );
  await BountyModel.updateOne(
    { bountyId: e.id, lifecycleStatus: 'pending_deposit' },
    { $set: { lifecycleStatus: 'open' } },
  );
}

// BountyReleased is the payout: settle the bounty and claim, then record the
// reputation event. The unique txHash makes the insert idempotent, so a re-seen
// event neither double-counts earnings nor re-runs the hunter recompute.
export async function handleBountyReleased(e: ReleasedEvent): Promise<void> {
  const hunter = getAddress(e.hunter);
  const amountUsdc = formatUnits(e.amount, USDC_DECIMALS);
  const bounty = await BountyModel.findOne({ bountyId: e.id }).lean();

  await BountyModel.updateOne(
    { bountyId: e.id },
    {
      $set: {
        onChainStatus: 'Paid',
        lifecycleStatus: 'paid',
        hunterAddress: hunter,
        txRelease: e.txHash,
        releasedPrCommitSha: e.prCommitSha,
      },
    },
  );
  await ClaimModel.updateOne(
    { bountyId: e.id, status: 'submitted' },
    { $set: { status: 'paid', prCommitSha: e.prCommitSha } },
  );

  try {
    await ReputationEventModel.create({
      hunterAddress: hunter,
      bountyId: e.id,
      type: 'payout',
      amountUsdc,
      repoFullName: bounty?.repo.fullName ?? 'unknown',
      language: bounty?.language,
      blockNumber: Number(e.blockNumber),
      txHash: e.txHash,
      prCommitSha: e.prCommitSha,
    });
  } catch (err: unknown) {
    if (isDuplicateKeyError(err)) return; // already processed this txHash
    throw err;
  }
  await recomputeHunter(hunter);
}

// BountyRefunded returns funds to the maintainer; mark the bounty refunded.
export async function handleBountyRefunded(e: RefundedEvent): Promise<void> {
  await BountyModel.updateOne(
    { bountyId: e.id },
    { $set: { onChainStatus: 'Refunded', lifecycleStatus: 'refunded', txRefund: e.txHash } },
  );
}

interface HunterAggregate {
  total: Types.Decimal128;
  payoutCount: number;
  repos: string[];
  languages: (string | null)[];
}

// Recompute the hunter's denormalised counters from the insert-only
// reputation_events (never incremented in place), so they always reconcile with
// the source of truth even after a replay.
export async function recomputeHunter(address: string): Promise<void> {
  const hunter = getAddress(address);
  const rows = await ReputationEventModel.aggregate<HunterAggregate>([
    { $match: { hunterAddress: hunter, type: 'payout' } },
    {
      $group: {
        _id: '$hunterAddress',
        total: { $sum: { $toDecimal: '$amountUsdc' } },
        payoutCount: { $sum: 1 },
        repos: { $addToSet: '$repoFullName' },
        languages: { $addToSet: '$language' },
      },
    },
  ]);
  const agg = rows[0];
  const languages = (agg?.languages ?? []).filter((l): l is string => Boolean(l));
  await HunterModel.updateOne(
    { address: hunter },
    {
      $set: {
        totalEarnedUsdc: agg ? agg.total.toString() : '0',
        payoutCount: agg ? agg.payoutCount : 0,
        reposContributed: agg ? agg.repos.filter(Boolean).length : 0,
        languages,
      },
    },
    { upsert: true },
  );
}
