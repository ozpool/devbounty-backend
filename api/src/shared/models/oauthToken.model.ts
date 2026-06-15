import mongoose, { Schema, model, type HydratedDocument, type Model } from 'mongoose';

// A GitHub OAuth access token at rest, encrypted with AES-256-GCM (see tokenCrypto).
export interface OAuthToken {
  githubUserId: number;
  githubLogin: string;
  encryptedToken: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyVersion: string;
  scopes: string[];
  linkedAddress?: string; // the wallet this GitHub identity is linked to
  createdAt?: Date;
  updatedAt?: Date;
}

const oauthTokenSchema = new Schema<OAuthToken>(
  {
    githubUserId: { type: Number, required: true, unique: true },
    githubLogin: { type: String, required: true },
    encryptedToken: { type: Buffer, required: true },
    iv: { type: Buffer, required: true },
    authTag: { type: Buffer, required: true },
    keyVersion: { type: String, required: true },
    scopes: { type: [String], default: [] },
    linkedAddress: { type: String },
  },
  { timestamps: true },
);

// At most one GitHub link per wallet (and githubUserId is unique), giving a 1:1
// wallet <-> GitHub binding that the Sybil gate relies on.
oauthTokenSchema.index(
  { linkedAddress: 1 },
  { unique: true, partialFilterExpression: { linkedAddress: { $type: 'string' } } },
);

export type OAuthTokenDocument = HydratedDocument<OAuthToken>;
export const OAuthTokenModel: Model<OAuthToken> =
  (mongoose.models.OAuthToken as Model<OAuthToken> | undefined) ??
  model<OAuthToken>('OAuthToken', oauthTokenSchema);
