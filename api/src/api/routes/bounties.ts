import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireAuth, getAuth } from '../middleware/auth.js';
import {
  BountyModel,
  ClaimModel,
  IdempotencyKeyModel,
  type Bounty,
  type Claim,
} from '../../shared/models/index.js';
import { deriveBountyId } from '../../shared/bounty/bountyId.js';
import { writeAudit } from '../../shared/audit/writeAudit.js';
import { AppError } from '../../shared/utils/AppError.js';

const router = Router();

const DEFAULT_REFUND_WINDOW_SECONDS = 14 * 24 * 60 * 60; // mirrors the on-chain default later
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Explicit safelist — internal fields (_id, __v) never reach the client.
function toBountyDto(b: Bounty) {
  return {
    bountyId: b.bountyId,
    maintainerAddress: b.maintainerAddress,
    repo: b.repo,
    issueNumber: b.issueNumber,
    issueTitle: b.issueTitle,
    issueUrl: b.issueUrl,
    amountUsdc: b.amountUsdc,
    language: b.language,
    onChainStatus: b.onChainStatus,
    lifecycleStatus: b.lifecycleStatus,
    refundWindowSnapshot: b.refundWindowSnapshot,
    hunterAddress: b.hunterAddress ?? null,
    createdAt: b.createdAt ?? null,
  };
}

// Public claim view — only the fields the board/detail UI needs.
function toPublicClaim(c: Claim) {
  return {
    hunterAddress: c.hunterAddress,
    status: c.status,
    expiresAt: c.expiresAt ?? null,
    prUrl: c.prUrl ?? null,
    prNumber: c.prNumber ?? null,
    createdAt: c.createdAt ?? null,
  };
}

const createBody = z.object({
  repoFullName: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'expected owner/name'),
  githubRepoId: z.number().int().positive(),
  issueNumber: z.number().int().positive(),
  issueTitle: z.string().min(1),
  issueUrl: z.string().url(),
  amountUsdc: z.string().regex(/^\d+(\.\d+)?$/, 'expected a decimal amount'),
  language: z.string().min(1),
});

// POST /bounties — create a pending_deposit bounty (idempotent on Idempotency-Key).
router.post(
  '/',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = createBody.safeParse(req.body);
    if (!parsed.success) {
      next(AppError.badRequest('Invalid bounty payload'));
      return;
    }
    const { address } = getAuth(req);
    const idemKey = req.header('Idempotency-Key');

    try {
      if (idemKey) {
        const prior = await IdempotencyKeyModel.findOne({ key: idemKey }).lean();
        if (prior) {
          res.status(prior.responseStatus).json(prior.responseBody);
          return;
        }
      }

      const body = parsed.data;
      const [owner, name] = body.repoFullName.split('/');
      if (!owner || !name) {
        next(AppError.badRequest('Invalid repo name'));
        return;
      }

      const bountyId = deriveBountyId(address, body.repoFullName, body.issueNumber);
      await BountyModel.create({
        bountyId,
        maintainerAddress: address,
        repo: { owner, name, fullName: body.repoFullName, githubRepoId: body.githubRepoId },
        issueNumber: body.issueNumber,
        issueTitle: body.issueTitle,
        issueUrl: body.issueUrl,
        amountUsdc: body.amountUsdc,
        language: body.language,
        onChainStatus: 'None',
        lifecycleStatus: 'pending_deposit',
        refundWindowSnapshot: DEFAULT_REFUND_WINDOW_SECONDS,
      });

      const responseBody = { bountyId, lifecycleStatus: 'pending_deposit' as const };
      if (idemKey) {
        await IdempotencyKeyModel.create({
          key: idemKey,
          route: 'POST /bounties',
          actor: address,
          responseStatus: 201,
          responseBody,
        });
      }
      res.status(201).json(responseBody);
    } catch (err: unknown) {
      next(err);
    }
  },
);

const listQuery = z.object({
  status: z.string().optional(),
  language: z.string().optional(),
  repo: z.string().optional(),
  minAmount: z.coerce.number().nonnegative().optional(),
  page: z.coerce.number().int().positive().optional(),
  pageSize: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).optional(),
});

// GET /bounties — paginated board with optional status/language/repo filters.
router.get('/', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const parsed = listQuery.safeParse(req.query);
  if (!parsed.success) {
    next(AppError.badRequest('Invalid query parameters'));
    return;
  }
  const q = parsed.data;
  const filter: Record<string, unknown> = {};
  if (q.status) filter['lifecycleStatus'] = q.status;
  if (q.language) filter['language'] = q.language;
  if (q.repo) filter['repo.fullName'] = q.repo;
  // amountUsdc is a decimal string, so compare numerically via $toDecimal
  // rather than lexicographically ('9' would otherwise outrank '500').
  if (q.minAmount !== undefined) {
    filter['$expr'] = {
      $gte: [{ $toDecimal: '$amountUsdc' }, { $toDecimal: String(q.minAmount) }],
    };
  }
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? DEFAULT_PAGE_SIZE;

  try {
    const [items, total] = await Promise.all([
      BountyModel.find(filter)
        .sort({ createdAt: -1 })
        .skip((page - 1) * pageSize)
        .limit(pageSize)
        .lean(),
      BountyModel.countDocuments(filter),
    ]);
    res.json({ items: items.map(toBountyDto), page, pageSize, total });
  } catch (err: unknown) {
    next(err);
  }
});

// GET /bounties/:id — bounty detail by bountyId.
router.get('/:id', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const bounty = await BountyModel.findOne({ bountyId: req.params.id }).lean();
    if (!bounty) {
      next(AppError.notFound('Bounty not found'));
      return;
    }
    const claims = await ClaimModel.find({
      bountyId: bounty.bountyId,
      status: { $in: ['active', 'submitted', 'paid'] },
    })
      .sort({ createdAt: -1 })
      .lean();
    res.json({ ...toBountyDto(bounty), claims: claims.map(toPublicClaim) });
  } catch (err: unknown) {
    next(err);
  }
});

// GET /bounties/:id/refund-eligibility — a UX convenience for the maintainer's
// refund CTA. The chain is canonical; this just answers, from off-chain state,
// whether a refund would currently be allowed and when the window opens.
router.get(
  '/:id/refund-eligibility',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { address } = getAuth(req);
    try {
      const bounty = await BountyModel.findOne({ bountyId: req.params.id }).lean();
      if (!bounty) {
        next(AppError.notFound('Bounty not found'));
        return;
      }
      if (bounty.maintainerAddress !== address) {
        next(AppError.forbidden('Only the bounty maintainer can refund this bounty'));
        return;
      }
      const windowExpiresAt = bounty.createdAt
        ? new Date(bounty.createdAt.getTime() + bounty.refundWindowSnapshot * 1000)
        : null;
      const locked = await ClaimModel.exists({
        bountyId: bounty.bountyId,
        status: { $in: ['active', 'submitted'] },
      });

      let eligible = false;
      let reason: string;
      if (bounty.onChainStatus !== 'Open') {
        reason = 'Bounty is not open on chain';
      } else if (locked) {
        reason = 'An active claim or submission is in progress';
      } else if (!windowExpiresAt || Date.now() < windowExpiresAt.getTime()) {
        reason = 'The refund window has not elapsed yet';
      } else {
        eligible = true;
        reason = 'Eligible to refund';
      }
      res.json({ eligible, reason, windowExpiresAt });
    } catch (err: unknown) {
      next(err);
    }
  },
);

const refundRecordedBody = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });

// POST /bounties/:id/refund-recorded — the frontend tells us the maintainer's
// refund tx landed, so status flips immediately instead of waiting on the indexer.
// Idempotent on txHash: a repeat (or the indexer arriving first) is a safe no-op.
router.post(
  '/:id/refund-recorded',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = refundRecordedBody.safeParse(req.body);
    if (!parsed.success) {
      next(AppError.badRequest('Invalid refund payload'));
      return;
    }
    const { address } = getAuth(req);
    try {
      const bounty = await BountyModel.findOne({ bountyId: req.params.id });
      if (!bounty) {
        next(AppError.notFound('Bounty not found'));
        return;
      }
      if (bounty.maintainerAddress !== address) {
        next(AppError.forbidden('Only the bounty maintainer can refund this bounty'));
        return;
      }
      if (bounty.lifecycleStatus === 'refunded') {
        res.json({ bountyId: bounty.bountyId, status: 'refunded', alreadyRecorded: true });
        return;
      }
      bounty.onChainStatus = 'Refunded';
      bounty.lifecycleStatus = 'refunded';
      bounty.txRefund = parsed.data.txHash;
      await bounty.save();
      await writeAudit({
        action: 'bounty.refund_recorded',
        actor: getAuth(req),
        target: { type: 'bounty', id: bounty.bountyId },
        metadata: { txHash: parsed.data.txHash },
        ip: req.ip,
      });
      res.json({ bountyId: bounty.bountyId, status: 'refunded' });
    } catch (err: unknown) {
      next(err);
    }
  },
);

export { router as bountiesRouter };
