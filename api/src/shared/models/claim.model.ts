import { Schema, model, type HydratedDocument } from 'mongoose';

// A claim is a soft, off-chain reservation of a bounty by a hunter.
export type ClaimStatus = 'active' | 'expired' | 'submitted' | 'paid' | 'released';

export interface Claim {
  bountyId: string;
  hunterAddress: string;
  status: ClaimStatus;
  expiresAt: Date; // lazy-expired on read; a sweeper also flips stale rows
  prUrl?: string;
  prNumber?: number;
  repoIdAtSubmit?: number; // GitHub numeric repo id captured at submit time
  prCommitSha?: string; // pr.merge_commit_sha once merged
  createdAt?: Date;
  updatedAt?: Date;
}

const claimSchema = new Schema<Claim>(
  {
    bountyId: { type: String, required: true, index: true },
    hunterAddress: { type: String, required: true, index: true },
    status: {
      type: String,
      enum: ['active', 'expired', 'submitted', 'paid', 'released'],
      default: 'active',
      required: true,
    },
    expiresAt: { type: Date, required: true },
    prUrl: { type: String },
    prNumber: { type: Number },
    repoIdAtSubmit: { type: Number },
    prCommitSha: { type: String },
  },
  { timestamps: true },
);

// At most one ACTIVE claim per bounty. Partial filter keeps expired/closed
// claims out of the uniqueness scope, so re-claiming after expiry is allowed.
claimSchema.index(
  { bountyId: 1, status: 1 },
  { unique: true, partialFilterExpression: { status: 'active' } },
);

// No duplicate PR submissions against the same bounty (only rows that have a prUrl).
claimSchema.index(
  { bountyId: 1, prUrl: 1 },
  { unique: true, partialFilterExpression: { prUrl: { $type: 'string' } } },
);

// "My claims" listing and the per-wallet Sybil-cap count.
claimSchema.index({ hunterAddress: 1, status: 1 });
claimSchema.index({ hunterAddress: 1, status: 1, expiresAt: 1 });

// Sweeper that lazily expires stale active claims.
claimSchema.index({ expiresAt: 1 });

export type ClaimDocument = HydratedDocument<Claim>;
export const ClaimModel = model<Claim>('Claim', claimSchema);
