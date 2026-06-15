import mongoose, { Schema, model, type HydratedDocument, type Model } from 'mongoose';

// A server-issued SIWE login nonce, recorded so it can be consumed exactly once.
// Without this the nonce lives only in a signed cookie, so a captured nonce +
// signature could be replayed to mint fresh sessions until the cookie's TTL.
// Verify deletes the row atomically; a missing row means already-used or expired.
export interface Nonce {
  nonce: string;
  createdAt?: Date;
}

const nonceSchema = new Schema<Nonce>(
  {
    nonce: { type: String, required: true, unique: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Auto-expire shortly after the nonce cookie's 5-minute TTL so unused rows clear.
nonceSchema.index({ createdAt: 1 }, { expireAfterSeconds: 10 * 60 });

export type NonceDocument = HydratedDocument<Nonce>;
export const NonceModel: Model<Nonce> =
  (mongoose.models.Nonce as Model<Nonce> | undefined) ?? model<Nonce>('Nonce', nonceSchema);
