import { Router, type Request, type Response, type NextFunction } from 'express';
import { logger } from '../../shared/utils/logger.js';
import { AppError } from '../../shared/utils/AppError.js';
import { verifyWebhookSignature } from '../../shared/github/webhook.js';
import { settleMergedClaim } from '../../shared/bounty/settleMerge.js';
import { writeAudit } from '../../shared/audit/writeAudit.js';
import { ClaimModel, RepoModel, WebhookDeliveryModel } from '../../shared/models/index.js';

const router = Router();

// Shape of the slice of a pull_request payload we actually read.
interface PullRequestPayload {
  action?: string;
  pull_request?: {
    number?: number;
    merged?: boolean;
    merge_commit_sha?: string | null;
  };
}

// POST /webhooks/github — ingest a GitHub delivery. express.raw is mounted on
// this path in app.ts, so req.body is the byte-exact Buffer the HMAC covers.
router.post('/', async (req: Request, res: Response, next: NextFunction) => {
  const rawBody = req.body as unknown;
  const deliveryId = req.header('x-github-delivery');
  const event = req.header('x-github-event');
  const hookIdHeader = req.header('x-github-hook-id');
  const signature = req.header('x-hub-signature-256');

  if (!Buffer.isBuffer(rawBody) || !deliveryId || !event || !hookIdHeader || !signature) {
    next(AppError.badRequest('Missing required webhook headers or body'));
    return;
  }
  const webhookId = Number(hookIdHeader);
  if (!Number.isInteger(webhookId)) {
    next(AppError.badRequest('Invalid webhook id header'));
    return;
  }

  try {
    // Look up the repo by its webhook id, never by parsing the (unverified) body.
    // Not .lean(): lean() returns Mongoose Binary for Buffer fields, but the
    // verifier needs real Node Buffers to slice the iv/authTag.
    const repo = await RepoModel.findOne({ webhookId });
    if (!repo) {
      next(AppError.notFound('Unknown webhook'));
      return;
    }

    if (!verifyWebhookSignature(rawBody, signature, repo)) {
      logger.warn({ webhookId, deliveryId }, 'webhook signature verification failed');
      next(AppError.unauthorized('Invalid webhook signature'));
      return;
    }

    // Idempotency: upsert the delivery row (unique on deliveryId is race-safe).
    // processedOk is a success-marker — a row that never finished is re-attempted.
    const delivery = await WebhookDeliveryModel.findOneAndUpdate(
      { deliveryId },
      {
        $inc: { attempts: 1 },
        $set: { event, webhookId },
        $setOnInsert: { receivedAt: new Date(), processedOk: false },
      },
      { upsert: true, new: true },
    );
    if (delivery.processedOk) {
      res.status(200).json({ ok: true, duplicate: true });
      return;
    }

    const result = await processDelivery(rawBody, event, repo.githubRepoId);

    await WebhookDeliveryModel.updateOne({ deliveryId }, { $set: { processedOk: true } });
    res.status(200).json({ ok: true, ...result });
  } catch (err: unknown) {
    // Leave processedOk false so GitHub's redelivery re-attempts; record why.
    await WebhookDeliveryModel.updateOne(
      { deliveryId },
      { $set: { lastError: err instanceof Error ? err.message : String(err) } },
    ).catch(() => undefined);
    next(err);
  }
});

interface ProcessResult {
  ignored?: string;
  matched?: boolean;
  bountyId?: string;
}

// Decide what a verified delivery means and apply the off-chain state change.
// Only a merged pull_request advances a bounty; the on-chain release is #12.
async function processDelivery(
  rawBody: Buffer,
  event: string,
  githubRepoId: number,
): Promise<ProcessResult> {
  if (event !== 'pull_request') return { ignored: 'event' };

  const payload = JSON.parse(rawBody.toString('utf8')) as PullRequestPayload;
  const pr = payload.pull_request;
  const isMerge = payload.action === 'closed' && pr?.merged === true;
  if (!isMerge || typeof pr?.number !== 'number') return { ignored: 'not a merge' };

  const claim = await ClaimModel.findOne({
    repoIdAtSubmit: githubRepoId,
    prNumber: pr.number,
    status: 'submitted',
  });
  if (!claim) return { matched: false };

  const mergeCommitSha = typeof pr.merge_commit_sha === 'string' ? pr.merge_commit_sha : undefined;

  // Hand off to the shared settlement path (also used by manual-release): records
  // the merge commit, advances the bounty to 'releasing', and releases on-chain
  // when a signer is configured.
  await settleMergedClaim(claim.bountyId, claim.hunterAddress, mergeCommitSha);

  // System actor: the merge was confirmed by a signature-verified GitHub delivery.
  await writeAudit({
    action: 'bounty.settled_via_webhook',
    target: { type: 'bounty', id: claim.bountyId },
    metadata: { prNumber: pr.number, hunterAddress: claim.hunterAddress },
  });

  return { matched: true, bountyId: claim.bountyId };
}

export { router as webhooksRouter };
