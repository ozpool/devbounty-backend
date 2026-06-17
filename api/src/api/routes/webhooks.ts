import { Router, type Request, type Response, type NextFunction } from 'express';
import { logger } from '../../shared/utils/logger.js';
import { AppError } from '../../shared/utils/AppError.js';
import { verifyWebhookSignature } from '../../shared/github/webhook.js';
import { settleMergedClaim } from '../../shared/bounty/settleMerge.js';
import { writeAudit } from '../../shared/audit/writeAudit.js';
import { extractIssueRefs } from '../../shared/github/oauth.js';
import {
  BountyModel,
  ClaimModel,
  HunterModel,
  RepoModel,
  WebhookDeliveryModel,
} from '../../shared/models/index.js';

const router = Router();

// Shape of the slice of a pull_request payload we actually read. Every field here
// is GitHub-attested: the body is HMAC-verified against the repo's webhook secret
// before we parse it, so base/default_branch/author can be trusted as authoritative.
interface PullRequestPayload {
  action?: string;
  repository?: { default_branch?: string };
  pull_request?: {
    number?: number;
    merged?: boolean;
    merge_commit_sha?: string | null;
    base?: { ref?: string; repo?: { id?: number } };
    user?: { login?: string };
    title?: string;
    body?: string | null;
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

  // Authorization. A verified signature only proves GitHub sent this delivery —
  // not that the merge is a legitimate completion of THIS bounty. Before paying
  // out we require all three to hold, every value GitHub-attested in the signed
  // body: (1) the PR's base repo is the bounty's repo, (2) it was merged into
  // that repo's default branch (not some unprotected side branch the hunter can
  // self-merge), and (3) the PR was authored by the hunter who holds the claim.
  // Any failure ignores the delivery; the maintainer can still manual-release.
  const baseRepoId = pr.base?.repo?.id;
  if (baseRepoId !== githubRepoId) return { ignored: 'pr base repo does not match bounty repo' };

  const defaultBranch = payload.repository?.default_branch;
  const baseRef = pr.base?.ref;
  if (!defaultBranch || !baseRef || baseRef !== defaultBranch) {
    return { ignored: 'pr not merged into the default branch' };
  }

  // Match the PR author against the login snapshotted on the claim at submit time
  // (not the live Hunter doc), so a later unlink/relink can't break this payout.
  // Legacy claims with no snapshot fall back to the hunter's current login.
  let expectedLogin = claim.githubLoginAtSubmit;
  if (!expectedLogin) {
    const hunter = await HunterModel.findOne({ address: claim.hunterAddress }).lean();
    expectedLogin = hunter?.githubLogin;
  }
  const prAuthor = pr.user?.login;
  if (!expectedLogin || !prAuthor || prAuthor.toLowerCase() !== expectedLogin.toLowerCase()) {
    return { ignored: 'pr author is not the claiming hunter' };
  }

  // The merged PR must address the bounty's issue. We only have the signed
  // payload here (no token), so match `#N` references in the PR title/body
  // against the bounty's issue number. Fail closed: a PR that does not reference
  // this issue pays nobody — the maintainer can still manual-release if a fix was
  // linked only via GitHub's UI rather than the PR text.
  const bounty = await BountyModel.findOne({ bountyId: claim.bountyId }).lean();
  const refs = extractIssueRefs(`${pr.title ?? ''} ${pr.body ?? ''}`);
  if (!bounty || !refs.includes(bounty.issueNumber)) {
    await writeAudit({
      action: 'bounty.merge_issue_mismatch',
      target: { type: 'bounty', id: claim.bountyId },
      metadata: { prNumber: pr.number, expectedIssue: bounty?.issueNumber, referenced: refs },
    });
    return { ignored: 'pr does not reference the bounty issue' };
  }

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
