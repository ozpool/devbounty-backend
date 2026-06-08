import mongoose, { Schema, model, type HydratedDocument, type Model } from 'mongoose';

// An append-only record of a security-relevant action (a claim, a release, a
// refund, a webhook registration). Rows expire after 180 days via a TTL index:
// long enough to investigate an incident on a testnet flow, bounded so the
// collection cannot grow without limit. The actor is either a wallet (the
// authenticated maintainer/hunter) or the system (a verified GitHub webhook).
export interface AuditLog {
  action: string; // dotted verb, e.g. 'claim.created', 'bounty.refund_recorded'
  actorType: 'wallet' | 'system';
  actorAddress?: string; // set when actorType = 'wallet'
  actorRole?: string;
  targetType: string; // 'bounty' | 'repo'
  targetId: string;
  metadata?: Record<string, unknown>;
  ip?: string;
  createdAt?: Date;
}

const auditLogSchema = new Schema<AuditLog>(
  {
    action: { type: String, required: true },
    actorType: { type: String, required: true, enum: ['wallet', 'system'] },
    actorAddress: { type: String },
    actorRole: { type: String },
    targetType: { type: String, required: true },
    targetId: { type: String, required: true },
    metadata: { type: Schema.Types.Mixed },
    ip: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// Query by actor (what did this wallet do) and by target (what happened to this
// bounty), newest first.
auditLogSchema.index({ actorAddress: 1, createdAt: -1 });
auditLogSchema.index({ targetType: 1, targetId: 1, createdAt: -1 });
// Retention: expire 180 days after creation.
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 60 * 60 });

export type AuditLogDocument = HydratedDocument<AuditLog>;
export const AuditLogModel: Model<AuditLog> =
  (mongoose.models.AuditLog as Model<AuditLog> | undefined) ??
  model<AuditLog>('AuditLog', auditLogSchema);
