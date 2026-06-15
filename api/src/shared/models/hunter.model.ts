import { Schema, model, type HydratedDocument } from 'mongoose';

export interface HunterLanguage {
  name: string;
  count: number;
}

export interface Hunter {
  address: string;
  githubLogin?: string; // must be linked before a hunter may claim (Sybil gate)
  githubUserId?: number;
  // Denormalised counters — a read-through cache recomputed from reputation_events,
  // never incremented in place (keeps it replay-safe).
  totalEarnedUsdc: string;
  payoutCount: number;
  reposContributed: number;
  languages: HunterLanguage[];
  cacheStaleAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const languageSchema = new Schema<HunterLanguage>(
  {
    name: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const hunterSchema = new Schema<Hunter>(
  {
    address: { type: String, required: true, unique: true },
    githubLogin: { type: String, index: { sparse: true } },
    githubUserId: { type: Number, index: { sparse: true } },
    totalEarnedUsdc: { type: String, required: true, default: '0' },
    payoutCount: { type: Number, required: true, default: 0 },
    reposContributed: { type: Number, required: true, default: 0 },
    languages: { type: [languageSchema], default: [] },
    cacheStaleAt: { type: Date },
  },
  { timestamps: true },
);

export type HunterDocument = HydratedDocument<Hunter>;
export const HunterModel = model<Hunter>('Hunter', hunterSchema);
