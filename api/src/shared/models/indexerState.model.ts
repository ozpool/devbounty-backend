import mongoose, { Schema, model, type HydratedDocument, type Model } from 'mongoose';

// A single checkpoint row (_id = "singleton"): the last fully-processed block.
// The indexer reads it on cold start and advances it after each scanned range,
// so a restart resumes instead of replaying from genesis.
export interface IndexerState {
  _id: string;
  lastBlock: number;
  lastEventAt?: Date;
  leaseOwner?: string; // id of the indexer instance currently allowed to scan
  leaseExpiresAt?: Date; // when that lease lapses if not renewed
  updatedAt?: Date;
}

const indexerStateSchema = new Schema<IndexerState>(
  {
    _id: { type: String, default: 'singleton' },
    lastBlock: { type: Number, required: true },
    lastEventAt: { type: Date },
    leaseOwner: { type: String },
    leaseExpiresAt: { type: Date },
  },
  { _id: false, timestamps: { createdAt: false, updatedAt: 'updatedAt' } },
);

export type IndexerStateDocument = HydratedDocument<IndexerState>;
export const IndexerStateModel: Model<IndexerState> =
  (mongoose.models.IndexerState as Model<IndexerState> | undefined) ??
  model<IndexerState>('IndexerState', indexerStateSchema);
