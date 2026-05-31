import { Schema, model, type HydratedDocument } from 'mongoose';

// Source of truth for a hunter's payout history — one row per on-chain
// BountyReleased event. Rows are immutable (insert-only), so there is no
// updatedAt; txHash makes inserts idempotent across indexer replays.
export interface ReputationEvent {
  hunterAddress: string;
  bountyId: string;
  type: 'payout';
  amountUsdc: string;
  repoFullName: string;
  language?: string;
  blockNumber: number;
  txHash: string;
  prCommitSha?: string;
  createdAt?: Date;
}

const reputationEventSchema = new Schema<ReputationEvent>(
  {
    hunterAddress: { type: String, required: true, index: true },
    bountyId: { type: String, required: true },
    type: { type: String, enum: ['payout'], default: 'payout', required: true },
    amountUsdc: { type: String, required: true },
    repoFullName: { type: String, required: true },
    language: { type: String },
    blockNumber: { type: Number, required: true },
    txHash: { type: String, required: true, unique: true },
    prCommitSha: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Recent payouts for a hunter profile, and leaderboard-by-language.
reputationEventSchema.index({ hunterAddress: 1, createdAt: -1 });
reputationEventSchema.index({ language: 1, createdAt: -1 });

export type ReputationEventDocument = HydratedDocument<ReputationEvent>;
export const ReputationEventModel = model<ReputationEvent>(
  'ReputationEvent',
  reputationEventSchema,
);
