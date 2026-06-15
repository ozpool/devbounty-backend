import { pad, type Address, type Hex } from 'viem';
import { BountyModel, ClaimModel } from '../models/index.js';
import { isPayoutConfigured } from '../chain/clients.js';
import { releaseBounty, buildReleaseDeps } from '../chain/payout.js';
import { logger } from '../utils/logger.js';

// Pad a git commit SHA (20-byte SHA-1 or 32-byte SHA-256) into the bytes32 the
// contract's release() expects, with the value left-aligned in the word.
function shaToBytes32(sha: string): Hex {
  const hex = (sha.startsWith('0x') ? sha : `0x${sha}`) as Hex;
  return pad(hex, { size: 32, dir: 'right' });
}

// Cap on automatic release retries. Once a bounty has failed this many times it
// is left in 'release_failed' for a human, instead of re-sending forever.
export const MAX_RELEASE_ATTEMPTS = 5;

// Send the on-chain release. Errors are logged (never swallowed) and the bounty
// is moved to 'release_failed' for reconciliation; on success the tx hash is
// recorded and the indexer advances the bounty to 'paid' on the BountyReleased event.
export async function attemptRelease(
  bountyId: string,
  hunter: string,
  prCommitSha: string,
): Promise<void> {
  try {
    const { txHash } = await releaseBounty(
      {
        bountyId: bountyId as Hex,
        hunter: hunter as Address,
        prCommitSha: shaToBytes32(prCommitSha),
      },
      buildReleaseDeps(),
    );
    await BountyModel.updateOne({ bountyId }, { $set: { txRelease: txHash } });
  } catch (err: unknown) {
    logger.error(
      { bountyId, err: err instanceof Error ? err.message : String(err) },
      'on-chain release failed',
    );
    await BountyModel.updateOne(
      { bountyId },
      { $set: { lifecycleStatus: 'release_failed' }, $inc: { releaseAttempts: 1 } },
    );
  }
}

// Fire the release without blocking the caller. The webhook (and manual-release)
// must return promptly — GitHub aborts a delivery that takes too long — so the
// on-chain send + receipt wait runs detached; the indexer confirms 'paid' from
// the BountyReleased event, and a failed send lands in 'release_failed' for the
// reconciler below. Errors are caught so a rejected detached promise can't crash
// the process.
function fireRelease(bountyId: string, hunter: string, prCommitSha: string): void {
  void attemptRelease(bountyId, hunter, prCommitSha).catch((err: unknown) => {
    logger.error(
      { bountyId, err: err instanceof Error ? err.message : String(err) },
      'detached release rejected',
    );
  });
}

/**
 * Retry bounties stuck in 'release_failed' (transient RPC/gas failures), up to
 * MAX_RELEASE_ATTEMPTS each. Driven by the indexer loop so it shares the single
 * owner of the on-chain release write. A no-op when payout is not configured.
 */
export async function reconcileFailedReleases(limit = 5): Promise<void> {
  if (!isPayoutConfigured()) return;
  const stuck = await BountyModel.find({
    lifecycleStatus: 'release_failed',
    releaseAttempts: { $lt: MAX_RELEASE_ATTEMPTS },
  })
    .limit(limit)
    .lean();
  for (const b of stuck) {
    const claim = await ClaimModel.findOne({ bountyId: b.bountyId, status: 'submitted' }).lean();
    if (!claim?.prCommitSha || !claim.hunterAddress) continue;
    // Re-arm only if we win the failed->releasing transition (single owner).
    const armed = await BountyModel.updateOne(
      { bountyId: b.bountyId, lifecycleStatus: 'release_failed' },
      { $set: { lifecycleStatus: 'releasing' } },
    );
    if (armed.modifiedCount !== 1) continue;
    await attemptRelease(b.bountyId, claim.hunterAddress, claim.prCommitSha);
  }
}

/**
 * Settle a confirmed merge for a bounty, shared by both the merge sources that own
 * this transition: the GitHub webhook and the maintainer's manual-release fallback.
 * Records the merge commit on the claim, advances the bounty from 'submitted' to
 * 'releasing' (guarded so a redelivery never clobbers a later state), and — only
 * when a signer/escrow is configured — sends the on-chain release. With no chain
 * configured (dev, tests) the bounty simply rests in 'releasing'.
 */
export async function settleMergedClaim(
  bountyId: string,
  hunterAddress: string,
  mergeCommitSha?: string,
): Promise<void> {
  // Atomically claim the 'submitted' -> 'releasing' transition. Only the single
  // caller whose update actually flips the status (modifiedCount === 1) goes on
  // to send the on-chain release; any concurrent settlement (a second webhook
  // delivery, or a webhook racing the maintainer's manual-release) sees
  // modifiedCount === 0 and returns, so release() can never run twice and
  // double-pay the same bounty.
  const transition = await BountyModel.updateOne(
    { bountyId, lifecycleStatus: 'submitted' },
    { $set: { lifecycleStatus: 'releasing' } },
  );
  if (transition.modifiedCount !== 1) return;

  if (mergeCommitSha) {
    await ClaimModel.updateOne(
      { bountyId, status: 'submitted' },
      { $set: { prCommitSha: mergeCommitSha } },
    );
  }
  if (isPayoutConfigured() && mergeCommitSha) {
    fireRelease(bountyId, hunterAddress, mergeCommitSha);
  }
}
