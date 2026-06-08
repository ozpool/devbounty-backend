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

// Send the on-chain release. Errors are logged (never swallowed) and the bounty
// is moved to 'release_failed' for reconciliation; on success the tx hash is
// recorded and the indexer advances the bounty to 'paid' on the BountyReleased event.
async function attemptRelease(
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
    await BountyModel.updateOne({ bountyId }, { $set: { lifecycleStatus: 'release_failed' } });
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
  if (mergeCommitSha) {
    await ClaimModel.updateOne(
      { bountyId, status: 'submitted' },
      { $set: { prCommitSha: mergeCommitSha } },
    );
  }
  await BountyModel.updateOne(
    { bountyId, lifecycleStatus: 'submitted' },
    { $set: { lifecycleStatus: 'releasing' } },
  );
  if (isPayoutConfigured() && mergeCommitSha) {
    await attemptRelease(bountyId, hunterAddress, mergeCommitSha);
  }
}
