import mongoose, { Schema, model, type HydratedDocument, type Model } from 'mongoose';

// A GitHub repository that has a DevBounty webhook installed. The per-repo
// webhook secret is held encrypted (AES-256-GCM, packed into one Buffer by
// tokenCrypto). Two secrets can coexist during a rotation window so a webhook
// signed with either the new or the old secret still verifies.
export interface Repo {
  fullName: string; // owner/name
  githubRepoId: number; // numeric id, stable across renames
  ownerAddress: string; // wallet that installed the webhook
  webhookId: number; // X-GitHub-Hook-ID, the per-webhook lookup key
  webhookSecretCurrent: Buffer;
  webhookSecretPrevious?: Buffer; // set only while a rotation is in progress
  webhookSecretRotatedAt?: Date; // when the previous secret was superseded
  webhookKeyVersion: string; // encryption key version both secrets were sealed with
  createdAt?: Date;
  updatedAt?: Date;
}

const repoSchema = new Schema<Repo>(
  {
    fullName: { type: String, required: true, unique: true },
    githubRepoId: { type: Number, required: true, unique: true },
    ownerAddress: { type: String, required: true, index: true },
    webhookId: { type: Number, required: true, unique: true },
    webhookSecretCurrent: { type: Buffer, required: true },
    webhookSecretPrevious: { type: Buffer },
    webhookSecretRotatedAt: { type: Date },
    webhookKeyVersion: { type: String, required: true },
  },
  { timestamps: true },
);

export type RepoDocument = HydratedDocument<Repo>;
export const RepoModel: Model<Repo> =
  (mongoose.models.Repo as Model<Repo> | undefined) ?? model<Repo>('Repo', repoSchema);
