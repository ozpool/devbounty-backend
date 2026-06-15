import { AuditLogModel } from '../models/auditLog.model.js';
import { logger } from '../utils/logger.js';

export interface AuditEntry {
  action: string;
  target: { type: string; id: string };
  /** Omit for a system actor (e.g. a verified GitHub webhook). */
  actor?: { address: string; role?: string };
  metadata?: Record<string, unknown>;
  ip?: string;
}

/**
 * Append an audit row. Observability, not a gate: a failed insert is logged and
 * swallowed so the caller's operation (claim, release, refund) still succeeds.
 * Never throws — safe to `await` on the request path without a try/catch.
 */
export async function writeAudit(entry: AuditEntry): Promise<void> {
  try {
    await AuditLogModel.create({
      action: entry.action,
      actorType: entry.actor ? 'wallet' : 'system',
      actorAddress: entry.actor?.address,
      actorRole: entry.actor?.role,
      targetType: entry.target.type,
      targetId: entry.target.id,
      metadata: entry.metadata,
      ip: entry.ip,
    });
  } catch (err: unknown) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), action: entry.action },
      'audit write failed',
    );
  }
}
