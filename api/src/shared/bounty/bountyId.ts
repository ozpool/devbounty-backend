import { keccak256, encodePacked, getAddress } from 'viem';
import { randomBytes } from 'crypto';

/**
 * Derive a bounty id: keccak256(maintainerAddress, repoFullName, issueNumber, nonce).
 * The random nonce lets the same maintainer fund more than one bounty for an issue
 * and keeps ids unpredictable (no front-run griefing). Returns a 0x bytes32 hex.
 */
export function deriveBountyId(
  maintainerAddress: string,
  repoFullName: string,
  issueNumber: number,
): string {
  const nonce = `0x${randomBytes(32).toString('hex')}` as `0x${string}`;
  return keccak256(
    encodePacked(
      ['address', 'string', 'uint256', 'bytes32'],
      [getAddress(maintainerAddress), repoFullName, BigInt(issueNumber), nonce],
    ),
  );
}
