import mongoose, { Schema, model, type HydratedDocument, type Model } from 'mongoose';

// Stores the response of a mutating request keyed by its Idempotency-Key header,
// so a client retry replays the first result instead of acting twice. Rows expire
// after 24h via a TTL index.
export interface IdempotencyKey {
  key: string;
  route: string;
  actor: string;
  responseStatus: number;
  responseBody: unknown;
  createdAt?: Date;
}

const idempotencyKeySchema = new Schema<IdempotencyKey>(
  {
    key: { type: String, required: true, unique: true },
    route: { type: String, required: true },
    actor: { type: String, required: true },
    responseStatus: { type: Number, required: true },
    responseBody: { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 60 * 60 });

export type IdempotencyKeyDocument = HydratedDocument<IdempotencyKey>;
export const IdempotencyKeyModel: Model<IdempotencyKey> =
  (mongoose.models.IdempotencyKey as Model<IdempotencyKey> | undefined) ??
  model<IdempotencyKey>('IdempotencyKey', idempotencyKeySchema);
