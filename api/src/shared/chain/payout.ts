import { BaseError, ContractFunctionRevertedError, type Address, type Hex } from 'viem';
import { escrowAbi } from './escrowAbi.js';
import { getPublicClient, getWalletClient, getEscrowAddress } from './clients.js';

// Raised when the escrow reports the bounty is no longer Open (already paid or
// refunded). The caller must NOT retry — it should mark the bounty release_failed
// and reconcile, never re-send.
export class ReleaseNotOpenError extends Error {
  constructor(cause?: unknown) {
    super('Bounty is not open on chain', { cause });
    this.name = 'ReleaseNotOpenError';
  }
}

export interface ReleaseParams {
  bountyId: Hex;
  hunter: Address;
  prCommitSha: Hex;
}

export interface ReleaseResult {
  txHash: Hex;
}

// The chain effects releaseBounty needs, isolated behind a small interface so the
// release flow can be unit-tested with a fake instead of a live node.
export interface ReleaseDeps {
  simulate(params: ReleaseParams): Promise<{ request: unknown }>;
  write(request: unknown): Promise<Hex>;
  waitForReceipt(hash: Hex): Promise<void>;
}

function isBountyNotOpen(err: unknown): boolean {
  if (err instanceof BaseError) {
    const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
    if (
      revert instanceof ContractFunctionRevertedError &&
      revert.data?.errorName === 'BountyNotOpen'
    ) {
      return true;
    }
  }
  return err instanceof Error && err.message.includes('BountyNotOpen');
}

/**
 * Release a bounty's escrow to the hunter: simulate first so a guaranteed revert
 * never costs gas, then send and wait for the receipt. A BountyNotOpen revert is
 * reclassified as a non-retryable ReleaseNotOpenError.
 */
export async function releaseBounty(
  params: ReleaseParams,
  deps: ReleaseDeps,
): Promise<ReleaseResult> {
  try {
    const { request } = await deps.simulate(params);
    const txHash = await deps.write(request);
    await deps.waitForReceipt(txHash);
    return { txHash };
  } catch (err: unknown) {
    if (isBountyNotOpen(err)) throw new ReleaseNotOpenError(err);
    throw err;
  }
}

/** Wire ReleaseDeps to the live viem clients. Used by the webhook payout path. */
export function buildReleaseDeps(): ReleaseDeps {
  const publicClient = getPublicClient();
  const walletClient = getWalletClient();
  const escrow = getEscrowAddress();
  const account = walletClient.account;
  if (!account) throw new Error('Wallet client has no account configured');

  return {
    async simulate(params) {
      const { request } = await publicClient.simulateContract({
        address: escrow,
        abi: escrowAbi,
        functionName: 'release',
        args: [params.bountyId, params.hunter, params.prCommitSha],
        account,
      });
      return { request };
    },
    write(request) {
      // request is the validated simulation output; viem's writeContract consumes it.
      return walletClient.writeContract(
        request as Parameters<typeof walletClient.writeContract>[0],
      );
    },
    async waitForReceipt(hash) {
      await publicClient.waitForTransactionReceipt({ hash });
    },
  };
}
