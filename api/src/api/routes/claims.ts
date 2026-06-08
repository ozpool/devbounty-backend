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
import { fetchPullRequest, GithubError } from '../../shared/github/oauth.js';
import { settleMergedClaim } from '../../shared/bounty/settleMerge.js';
import { AppError } from '../../shared/utils/AppError.js';

const router = Router();

const CLAIM_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7-day soft reservation
const ACTIVE_CLAIM_CAP = 3; // per-wallet Sybil cap
const COOLDOWN_MS = 24 * 60 * 60 * 1000; // re-claim cooldown after a claim ends
const TERMINAL = new Set(['paid', 'refunded', 'releasing', 'release_failed']);

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
    if (TERMINAL.has(bounty.lifecycleStatus)) {
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
    await ClaimModel.create({ bountyId, hunterAddress: address, status: 'active', expiresAt });
    bounty.lifecycleStatus = 'claimed';
    await bounty.save();
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
});

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
  const prNumber = Number(prUrl.split('/').pop());
  try {
    const bounty = await BountyModel.findOne({ bountyId }).lean();
    if (!bounty) {
      next(AppError.notFound('Bounty not found'));
      return;
    }
    const claim = await ClaimModel.findOne({ bountyId, hunterAddress: address, status: 'active' });
    if (!claim) {
      next(AppError.forbidden('No active claim to submit against'));
      return;
    }
    claim.prUrl = prUrl;
    claim.prNumber = prNumber;
    claim.repoIdAtSubmit = bounty.repo.githubRepoId;
    claim.status = 'submitted';
    await claim.save();
    await BountyModel.updateOne({ bountyId }, { $set: { lifecycleStatus: 'submitted' } });
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
