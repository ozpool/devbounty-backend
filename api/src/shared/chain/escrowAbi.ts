// The slice of the BountyEscrow ABI the backend needs: the three lifecycle
// events the indexer reads, the release() the payout service writes, the
// bounties() getter for status reads, and the custom errors so viem can decode
// a reverted release. Kept hand-curated (not generated) so it has no build-time
// coupling to the contracts workspace.
export const escrowAbi = [
  {
    type: 'event',
    name: 'BountyCreated',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'maintainer', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'refundWindow', type: 'uint64', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'BountyReleased',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'hunter', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'prCommitSha', type: 'bytes32', indexed: false },
    ],
  },
  {
    type: 'event',
    name: 'BountyRefunded',
    inputs: [
      { name: 'id', type: 'bytes32', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'release',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'id', type: 'bytes32' },
      { name: 'hunter', type: 'address' },
      { name: 'prCommitSha', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'bounties',
    stateMutability: 'view',
    inputs: [{ name: '', type: 'bytes32' }],
    outputs: [
      { name: 'maintainer', type: 'address' },
      { name: 'amount', type: 'uint96' },
      { name: 'createdAt', type: 'uint64' },
      { name: 'refundWindow', type: 'uint64' },
      { name: 'status', type: 'uint8' },
    ],
  },
  { type: 'error', name: 'NotAuthorized', inputs: [] },
  { type: 'error', name: 'BountyExists', inputs: [] },
  { type: 'error', name: 'BountyNotOpen', inputs: [] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  { type: 'error', name: 'AmountTooLarge', inputs: [] },
  { type: 'error', name: 'RefundTooEarly', inputs: [] },
  { type: 'error', name: 'NotMaintainer', inputs: [] },
] as const;
