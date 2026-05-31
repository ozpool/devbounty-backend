import { Schema, model, type HydratedDocument } from 'mongoose';

// Mirror of the on-chain escrow enum.
export type OnChainStatus = 'None' | 'Open' | 'Paid' | 'Refunded';

// Off-chain workflow status, richer than the contract's enum.
export type BountyLifecycleStatus =
  | 'pending_deposit'
  | 'open'
  | 'claimed'
  | 'submitted'
  | 'releasing'
  | 'paid'
  | 'refunded'
  | 'release_failed';

export interface BountyRepo {
  owner: string;
  name: string;
  fullName: string;
  githubRepoId: number;
}

export interface Bounty {
  // keccak256(maintainerAddress, repoFullName, issueNumber, nonce)
  bountyId: string;
  maintainerAddress: string;
  repo: BountyRepo;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  amountUsdc: string; // decimal stored as a string to avoid float drift
  language: string;
  onChainStatus: OnChainStatus;
  lifecycleStatus: BountyLifecycleStatus;
  refundWindowSnapshot: number; // seconds; mirrors the on-chain value for this bounty
  txCreate?: string;
  txRelease?: string;
  txRefund?: string;
  hunterAddress?: string; // set on release
  releasedPrCommitSha?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const repoSchema = new Schema<BountyRepo>(
  {
    owner: { type: String, required: true },
    name: { type: String, required: true },
    fullName: { type: String, required: true, index: true },
    githubRepoId: { type: Number, required: true, index: true },
  },
  { _id: false },
);

const bountySchema = new Schema<Bounty>(
  {
    bountyId: { type: String, required: true, unique: true },
    maintainerAddress: { type: String, required: true, index: true },
    repo: { type: repoSchema, required: true },
    issueNumber: { type: Number, required: true },
    issueTitle: { type: String, required: true },
    issueUrl: { type: String, required: true },
    amountUsdc: { type: String, required: true },
    language: { type: String, required: true, index: true },
    onChainStatus: {
      type: String,
      enum: ['None', 'Open', 'Paid', 'Refunded'],
      default: 'None',
      required: true,
    },
    lifecycleStatus: {
      type: String,
      enum: [
        'pending_deposit',
        'open',
        'claimed',
        'submitted',
        'releasing',
        'paid',
        'refunded',
        'release_failed',
      ],
      default: 'pending_deposit',
      required: true,
    },
    refundWindowSnapshot: { type: Number, required: true },
    txCreate: { type: String },
    txRelease: { type: String },
    txRefund: { type: String },
    hunterAddress: { type: String, index: true },
    releasedPrCommitSha: { type: String },
  },
  { timestamps: true },
);

// Board default query (status + language, newest first) and maintainer dashboard.
bountySchema.index({ onChainStatus: 1, language: 1, createdAt: -1 });
bountySchema.index({ maintainerAddress: 1, createdAt: -1 });

export type BountyDocument = HydratedDocument<Bounty>;
export const BountyModel = model<Bounty>('Bounty', bountySchema);
