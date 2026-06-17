import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, getAuth } from '../middleware/auth.js';
import {
  BountyModel,
  ClaimModel,
  HunterModel,
  OAuthTokenModel,
} from '../../shared/models/index.js';
import { decryptToString } from '../../shared/crypto/tokenCrypto.js';
import { fetchPullRequest, fetchPrClosingIssues, GithubError } from '../../shared/github/oauth.js';
import { settleMergedClaim } from '../../shared/bounty/settleMerge.js';
import { writeAudit } from '../../shared/audit/writeAudit.js';
import { AppError } from '../../shared/utils/AppError.js';

const router = Router();

const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7-day soft reservation
const ACTIVE_CLAIM_CAP = 3; // per-wallet Sybil cap
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // re-claim cooldown after a claim ends
// Not claimable: an unfunded bounty (pending_deposit) or a cancelled one, plus
// the terminal/in-flight payout states. Note 'submitted' IS still claimable on
// purpose — multiple hunters may file competing PRs and the first merge wins.
const NOT_CLAIMABLE = new Set([
  'pending_deposit',
  'cancelled',
  'releasing',
  'paid',
  'refunded',
  'release_failed',
]);

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 11000
  );
}

// POST /bounties/:id/claim — reserve a bounty (gated, capped, cooldown).
router.post('/:id/claim', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  const { address } = getAuth(req);
  const bountyId = req.params.id;
  try {
    const bounty = await BountyModel.findOne({ bountyId });
    if (!bounty) {
      next(AppError.notFound('Bounty not found'));
      return;
    }
    if (NOT_CLAIMABLE.has(bounty.lifecycleStatus)) {
      next(AppError.conflict('Bounty is not claimable'));
      return;
    }

    const hunter = await HunterModel.findOne({ address }).lean();
    if (!hunter?.githubLogin) {
      next(AppError.forbidden('Link a GitHub account before claiming'));
      return;
    }

    const now = Date.now();
    // Lazy-expire stale active claims so the partial-unique index frees up.
    await ClaimModel.updateMany(
      { status: 'active', expiresAt: { $lt: new Date(now) } },
      { $set: { status: 'expired' } },
    );

    const recentlyEnded = await ClaimModel.exists({
      bountyId,
      hunterAddress: address,
      status: { $in: ['expired', 'released'] },
      updatedAt: { $gt: new Date(now - COOLDOWN_MS) },
    });
    if (recentlyEnded) {
      next(AppError.conflict('Re-claim cooldown is still active for this bounty'));
      return;
    }

    const activeCount = await ClaimModel.countDocuments({
      hunterAddress: address,
      status: 'active',
    });
    if (activeCount >= ACTIVE_CLAIM_CAP) {
      next(AppError.conflict('Active claim cap reached'));
      return;
    }

    const expiresAt = new Date(now + CLAIM_TTL_MS);
    const created = await ClaimModel.create({
      bountyId,
      hunterAddress: address,
      status: 'active',
      expiresAt,
    });
    // The pre-check above is racy: two concurrent claims on different bounties
    // can both read activeCount < cap and both insert. Re-count after inserting
    // and roll back our own row if that pushed the wallet over the cap. This can
    // only ever over-reject (a loser retries), never let the cap be exceeded.
    const activeAfter = await ClaimModel.countDocuments({
      hunterAddress: address,
      status: 'active',
    });
    if (activeAfter > ACTIVE_CLAIM_CAP) {
      await ClaimModel.deleteOne({ _id: created._id });
      next(AppError.conflict('Active claim cap reached'));
      return;
    }
    bounty.lifecycleStatus = 'claimed';
    await bounty.save();
    await writeAudit({
      action: 'claim.created',
      actor: getAuth(req),
      target: { type: 'bounty', id: bounty.bountyId },
      ip: req.ip,
    });
    res.status(201).json({ bountyId, expiresAt });
  } catch (err: unknown) {
    if (isDuplicateKeyError(err)) {
      next(AppError.conflict('Bounty already has an active claim'));
      return;
    }
    next(err);
  }
});

// DELETE /bounties/:id/claim — release the reservation early.
router.delete(
  '/:id/claim',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    const { address } = getAuth(req);
    const bountyId = req.params.id;
    try {
      const claim = await ClaimModel.findOneAndUpdate(
        { bountyId, hunterAddress: address, status: 'active' },
        { $set: { status: 'released' } },
        { new: true },
      );
      if (!claim) {
        next(AppError.notFound('No active claim to release'));
        return;
      }
      await BountyModel.updateOne({ bountyId }, { $set: { lifecycleStatus: 'open' } });
      res.json({ bountyId, status: 'released' });
    } catch (err: unknown) {
      next(err);
    }
  },
);

const submitBody = z.object({
  prUrl: z
    .string()
    .regex(
      /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+$/,
      'expected a GitHub pull request URL',
    ),
  // Set true to proceed past the "PR is for a different issue" warning.
  confirmMismatch: z.boolean().optional(),
});

// Does the PR formally close the bounty's issue? Uses the hunter's token to read
// GitHub's closing-issue links (the accurate signal). Returns 'unknown' when it
// can't tell (no token, no linked issues, or a GitHub error) so the early warning
// never blocks on a flaky read — the merge gate is the real enforcement.
async function classifyIssueMatch(
  address: string,
  owner: string,
  repo: string,
  prNumber: number,
  bountyIssue: number,
): Promise<'match' | 'mismatch' | 'unknown'> {
  // Not .lean(): lean() returns Mongoose Binary for Buffer fields, but
  // decryptToString needs real Node Buffers to slice the iv/authTag.
  const link = await OAuthTokenModel.findOne({ linkedAddress: address });
  if (!link) return 'unknown';
  try {
    const token = decryptToString({
      ciphertext: link.encryptedToken,
      iv: link.iv,
      authTag: link.authTag,
      keyVersion: link.keyVersion,
    });
    const closing = await fetchPrClosingIssues(owner, repo, prNumber, token);
    if (closing.length === 0) return 'unknown';
    return closing.includes(bountyIssue) ? 'match' : 'mismatch';
  } catch {
    return 'unknown';
  }
}

// POST /bounties/:id/submit — attach a PR to the active claim.
router.post('/:id/submit', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  const parsed = submitBody.safeParse(req.body);
  if (!parsed.success) {
    next(AppError.badRequest('Invalid submission payload'));
    return;
  }
  const { address } = getAuth(req);
  const bountyId = req.params.id;
  const prUrl = parsed.data.prUrl;
  // The zod regex guarantees this shape, so the capture always succeeds.
  const prParts = prUrl.match(/^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/);
  const prRepoFullName = prParts ? `${prParts[1]}/${prParts[2]}` : '';
  const prNumber = Number(prUrl.split('/').pop());
  try {
    const bounty = await BountyModel.findOne({ bountyId }).lean();
    if (!bounty) {
      next(AppError.notFound('Bounty not found'));
      return;
    }
    // The PR must live in the bounty's own repo. Without this, a hunter could
    // submit an unrelated repo's PR whose number later collides with a real PR
    // in the bounty repo and settles the bounty on merge.
    if (prRepoFullName.toLowerCase() !== bounty.repo.fullName.toLowerCase()) {
      next(AppError.badRequest('The pull request must belong to the bounty repository'));
      return;
    }
    const claim = await ClaimModel.findOne({ bountyId, hunterAddress: address, status: 'active' });
    if (!claim) {
      next(AppError.forbidden('No active claim to submit against'));
      return;
    }
    // If the PR is for a different issue than the bounty's, warn once. The hunter
    // can confirm to proceed, but the merge gate still refuses to pay on a real
    // mismatch — this is just an early heads-up.
    if (!parsed.data.confirmMismatch) {
      const match = await classifyIssueMatch(
        address,
        bounty.repo.owner,
        bounty.repo.name,
        prNumber,
        bounty.issueNumber,
      );
      if (match === 'mismatch') {
        res.json({ warning: 'issue_mismatch', expectedIssue: bounty.issueNumber });
        return;
      }
    }
    // Snapshot the hunter's GitHub identity now, so the merge-time author check
    // is pinned to who they were at submit and survives a later unlink/relink.
    const hunter = await HunterModel.findOne({ address }).lean();
    claim.prUrl = prUrl;
    claim.prNumber = prNumber;
    claim.repoIdAtSubmit = bounty.repo.githubRepoId;
    claim.githubLoginAtSubmit = hunter?.githubLogin;
    claim.githubUserIdAtSubmit = hunter?.githubUserId;
    claim.status = 'submitted';
    await claim.save();
    await BountyModel.updateOne({ bountyId }, { $set: { lifecycleStatus: 'submitted' } });
    await writeAudit({
      action: 'claim.submitted',
      actor: getAuth(req),
      target: { type: 'bounty', id: bounty.bountyId },
      metadata: { prUrl, prNumber },
      ip: req.ip,
    });
    res.json({ bountyId, prUrl, prNumber, status: 'submitted' });
  } catch (err: unknown) {
    if (isDuplicateKeyError(err)) {
      next(AppError.conflict('This pull request is already submitted for the bounty'));
      return;
    }
    next(err);
  }
});

// POST /bounties/:id/manual-release — the maintainer's fallback for when the
// merge webhook never arrived (GitHub outage, webhook disabled): confirm the PR
// merge directly with GitHub using the maintainer's own token, then settle the
// bounty through the same path the webhook uses.
router.post(
  '/:id/manual-release',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction) => {
    const { address } = getAuth(req);
    const bountyId = req.params.id;
    if (typeof bountyId !== 'string') {
      next(AppError.badRequest('Invalid bounty id'));
      return;
    }
    try {
      const bounty = await BountyModel.findOne({ bountyId }).lean();
      if (!bounty) {
        next(AppError.notFound('Bounty not found'));
        return;
      }
      if (bounty.maintainerAddress !== address) {
        next(AppError.forbidden('Only the bounty maintainer can release this bounty'));
        return;
      }
      const claim = await ClaimModel.findOne({ bountyId, status: 'submitted' }).lean();
      if (!claim || typeof claim.prNumber !== 'number') {
        next(AppError.conflict('No submitted pull request to release for this bounty'));
        return;
      }

      const link = await OAuthTokenModel.findOne({ linkedAddress: address });
      if (!link) {
        next(AppError.badRequest('Link a GitHub account before releasing'));
        return;
      }
      const accessToken = decryptToString({
        ciphertext: link.encryptedToken,
        iv: link.iv,
        authTag: link.authTag,
        keyVersion: link.keyVersion,
      });

      const pr = await fetchPullRequest(
        bounty.repo.owner,
        bounty.repo.name,
        claim.prNumber,
        accessToken,
      );
      if (!pr.merged) {
        next(AppError.conflict('The pull request is not merged yet'));
        return;
      }

      await settleMergedClaim(bountyId, claim.hunterAddress, pr.mergeCommitSha);
      await writeAudit({
        action: 'bounty.manual_release',
        actor: getAuth(req),
        target: { type: 'bounty', id: bounty.bountyId },
        metadata: { prNumber: claim.prNumber, mergeCommitSha: pr.mergeCommitSha },
        ip: req.ip,
      });
      res.json({ bountyId, status: 'releasing', prNumber: claim.prNumber });
    } catch (err: unknown) {
      if (err instanceof GithubError) {
        next(AppError.badRequest(err.message));
        return;
      }
      next(err);
    }
  },
);

export { router as claimsRouter };
