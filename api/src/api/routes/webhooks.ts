import { Router, type Request, type Response, type NextFunction } from 'express';
import { pad, type Address, type Hex } from 'viem';
import { logger } from '../../shared/utils/logger.js';
import { AppError } from '../../shared/utils/AppError.js';
import { verifyWebhookSignature } from '../../shared/github/webhook.js';
import { isPayoutConfigured } from '../../shared/chain/clients.js';
import { releaseBounty, buildReleaseDeps } from '../../shared/chain/payout.js';
import {
  BountyModel,
  ClaimModel,
  RepoModel,
  WebhookDeliveryModel,
} from '../../shared/models/index.js';

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
  if (mergeCommitSha) {
    claim.prCommitSha = mergeCommitSha;
    await claim.save();
  }

  // Move the bounty into 'releasing' only from 'submitted', so a redelivery
  // never clobbers a state the indexer has since advanced (paid/refunded).
  await BountyModel.updateOne(
    { bountyId: claim.bountyId, lifecycleStatus: 'submitted' },
    { $set: { lifecycleStatus: 'releasing' } },
  );

  // The webhook path owns the on-chain release() write (the indexer only reads).
  // When no signer/escrow is configured (dev, tests) the bounty simply rests in
  // 'releasing' with the merge commit recorded. When configured, send the release
  // and let the chain indexer flip the bounty to 'paid' on the BountyReleased event.
  if (isPayoutConfigured() && claim.prCommitSha) {
    await attemptRelease(claim.bountyId, claim.hunterAddress, claim.prCommitSha);
  }

  return { matched: true, bountyId: claim.bountyId };
}

// Pad a git commit SHA (20-byte SHA-1 or 32-byte SHA-256) into the bytes32 the
// contract's release() expects, value left-aligned.
function shaToBytes32(sha: string): Hex {
  const hex = (sha.startsWith('0x') ? sha : `0x${sha}`) as Hex;
  return pad(hex, { size: 32, dir: 'right' });
}

// Send the on-chain release. Errors are logged (never swallowed) and the bounty
// is moved to 'release_failed' for reconciliation; on success the tx hash is
// recorded and the indexer advances the bounty to 'paid'.
async function attemptRelease(
  bountyId: string,
  hunter: string,
  prCommitSha: string,
): Promise<void> {
  try {
    const { txHash } = await releaseBounty(
      {
        bountyId: bountyId as Hex,
        hunter: hunter as Address,
        prCommitSha: shaToBytes32(prCommitSha),
      },
      buildReleaseDeps(),
    );
    await BountyModel.updateOne({ bountyId }, { $set: { txRelease: txHash } });
  } catch (err: unknown) {
    logger.error(
      { bountyId, err: err instanceof Error ? err.message : String(err) },
      'on-chain release failed',
    );
    await BountyModel.updateOne({ bountyId }, { $set: { lifecycleStatus: 'release_failed' } });
  }
}

export { router as webhooksRouter };
