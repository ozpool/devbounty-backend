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
import {
  isIndexerConfigured,
  getOnChainBountyStatus,
  verifyEscrowEventTx,
  ON_CHAIN_STATUS_NONE,
} from '../../shared/chain/clients.js';
import { AppError } from '../../shared/utils/AppError.js';

const router = Router();

const DEFAULT_REFUND_WINDOW_SECONDS = 14 * 24 * 60 * 60; // mirrors the on-chain default later
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

// Lifecycle states where a hunter has accepted work in flight or a payout has
// started/finished, so recording a refund would strand or contradict that.
const NON_REFUNDABLE_LIFECYCLE = new Set(['submitted', 'releasing', 'release_failed', 'paid']);

// States where an on-chain action is awaiting indexer confirmation.
const PENDING_CONFIRMATION = new Set(['pending_deposit', 'releasing']);

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
    // A hint for the UI that an on-chain action is still being confirmed by the
    // indexer (deposit not yet 'open', or a sent payout not yet 'paid'), so it can
    // show a "confirming…" state instead of looking stuck or finished.
    pendingConfirmation: PENDING_CONFIRMATION.has(b.lifecycleStatus),
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
      next(AppError.badRequest('Invalid bounty payload', parsed.error.flatten().fieldErrors));
      return;
    }
    const { address } = getAuth(req);
    const idemKey = req.header('Idempotency-Key');

    // Reserve the (key, actor) row BEFORE doing any work. Because deriveBountyId
    // uses a random nonce, two concurrent requests with the same key would
    // otherwise each mint a different bounty. The unique (key, actor) index lets
    // exactly one request win the reservation; the loser replays the winner's
    // stored response (or, if the winner is still in flight, is told to retry).
    let reserved = false;
    if (idemKey) {
      const prior = await IdempotencyKeyModel.findOne({ key: idemKey, actor: address }).lean();
      if (prior) {
        replayOrConflict(res, next, prior);
        return;
      }
      try {
        await IdempotencyKeyModel.create({
          key: idemKey,
          route: 'POST /bounties',
          actor: address,
          responseStatus: 0,
          responseBody: null,
        });
        reserved = true;
      } catch (err: unknown) {
        if (isDuplicateKeyError(err)) {
          const winner = await IdempotencyKeyModel.findOne({
            key: idemKey,
            actor: address,
          }).lean();
          replayOrConflict(res, next, winner);
          return;
        }
        next(err);
        return;
      }
    }

    try {
      const body = parsed.data;
      const [owner, name] = body.repoFullName.split('/');
      if (!owner || !name) {
        if (reserved && idemKey) {
          await IdempotencyKeyModel.deleteOne({ key: idemKey, actor: address });
        }
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
        // Finalize the reservation with the real response so a retry replays it.
        await IdempotencyKeyModel.updateOne(
          { key: idemKey, actor: address },
          { $set: { responseStatus: 201, responseBody } },
        );
      }
      res.status(201).json(responseBody);
    } catch (err: unknown) {
      // The work failed after reserving — release the reservation so the client
      // can retry instead of being stuck on a permanent "in progress".
      if (reserved && idemKey) {
        await IdempotencyKeyModel.deleteOne({ key: idemKey, actor: address }).catch(
          () => undefined,
        );
      }
      next(err);
    }
  },
);

// Replay a finalized idempotency record, or report still-in-flight as a conflict.
function replayOrConflict(
  res: Response,
  next: NextFunction,
  record: { responseStatus: number; responseBody: unknown } | null,
): void {
  if (record && record.responseStatus > 0) {
    res.status(record.responseStatus).json(record.responseBody);
    return;
  }
  next(AppError.conflict('A request with this Idempotency-Key is already in progress'));
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 11000
  );
}

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
  // The public board only lists bounties whose USDC is actually escrowed on
  // chain. A 'pending_deposit' bounty is an off-chain record whose deposit has
  // not landed (or never will, if the maintainer abandoned funding), so it has
  // no money behind it and must never surface here. 'cancelled' is hidden too.
  // An explicit ?status= still honours the request (e.g. a maintainer tool).
  filter['lifecycleStatus'] = q.status ?? { $nin: ['cancelled', 'pending_deposit'] };
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
      // A bounty with a live submission or an in-flight/finished payout must never
      // be flipped to 'refunded' — that would let a maintainer dodge a hunter
      // whose PR is already submitted or merged. Refunds are only legitimate while
      // the bounty is still open/claimed (funded, no accepted work).
      if (NON_REFUNDABLE_LIFECYCLE.has(bounty.lifecycleStatus)) {
        next(AppError.conflict('Bounty has an active submission or payout and cannot be refunded'));
        return;
      }
      // When an escrow is configured, don't trust the caller's hash — confirm the
      // refund tx is mined, succeeded, and targets the escrow. With no escrow
      // (testnet/dev without payout) there is nothing to verify against, so the
      // maintainer-authenticated record is accepted as-is.
      if (isIndexerConfigured()) {
        const verified = await verifyEscrowEventTx(
          parsed.data.txHash as `0x${string}`,
          'BountyRefunded',
          bounty.bountyId,
        );
        if (!verified) {
          next(AppError.badRequest('Refund transaction could not be verified on chain'));
          return;
        }
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

const depositRecordedBody = z.object({ txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) });

// POST /bounties/:id/deposit-recorded — the frontend tells us the maintainer's
// funding tx landed, so the bounty leaves 'pending_deposit' and reaches the board
// immediately instead of waiting on the indexer. The indexer remains the
// canonical source and converges to the same state; this is just a fast-path.
// Idempotent: once 'open' (or any later state), a repeat is a safe no-op.
router.post(
  '/:id/deposit-recorded',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = depositRecordedBody.safeParse(req.body);
    if (!parsed.success) {
      next(AppError.badRequest('Invalid deposit payload'));
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
        next(AppError.forbidden('Only the bounty maintainer can record a deposit'));
        return;
      }
      // Already past pending_deposit (indexer beat us, or duplicate call) — no-op.
      if (bounty.lifecycleStatus !== 'pending_deposit') {
        res.json({
          bountyId: bounty.bountyId,
          status: bounty.lifecycleStatus,
          alreadyRecorded: true,
        });
        return;
      }
      // With an escrow configured, confirm the funding tx really created THIS
      // bounty on chain before trusting it; otherwise accept the maintainer record.
      if (isIndexerConfigured()) {
        const verified = await verifyEscrowEventTx(
          parsed.data.txHash as `0x${string}`,
          'BountyCreated',
          bounty.bountyId,
        );
        if (!verified) {
          next(AppError.badRequest('Deposit transaction could not be verified on chain'));
          return;
        }
      }
      bounty.onChainStatus = 'Open';
      bounty.lifecycleStatus = 'open';
      bounty.txCreate = parsed.data.txHash;
      await bounty.save();
      await writeAudit({
        action: 'bounty.deposit_recorded',
        actor: getAuth(req),
        target: { type: 'bounty', id: bounty.bountyId },
        metadata: { txHash: parsed.data.txHash },
        ip: req.ip,
      });
      res.json({ bountyId: bounty.bountyId, status: 'open' });
    } catch (err: unknown) {
      next(err);
    }
  },
);

// POST /bounties/:id/cancel — the maintainer abandons a bounty that was never
// funded. Soft-cancel (kept for history, hidden from the board). Guarded so a
// bounty that is actually funded on chain can never be cancelled off-chain: the
// off-chain record can lag the chain, and cancelling a funded bounty would strand
// the escrowed USDC and desync the indexer.
router.post(
  '/:id/cancel',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { address } = getAuth(req);
    try {
      const bounty = await BountyModel.findOne({ bountyId: req.params.id });
      if (!bounty) {
        next(AppError.notFound('Bounty not found'));
        return;
      }
      if (bounty.maintainerAddress !== address) {
        next(AppError.forbidden('Only the bounty maintainer can cancel this bounty'));
        return;
      }
      if (bounty.lifecycleStatus !== 'pending_deposit') {
        next(AppError.conflict('Only a bounty still pending deposit can be cancelled'));
        return;
      }
      // When an escrow is configured, confirm on chain that no deposit landed.
      // With no escrow configured, on-chain funding is impossible, so the
      // off-chain status is authoritative and the read is skipped.
      if (isIndexerConfigured()) {
        const onChainStatus = await getOnChainBountyStatus(bounty.bountyId as `0x${string}`);
        if (onChainStatus !== ON_CHAIN_STATUS_NONE) {
          next(
            AppError.conflict('This bounty is funded on chain; refund it instead of cancelling'),
          );
          return;
        }
      }

      bounty.lifecycleStatus = 'cancelled';
      await bounty.save();
      await writeAudit({
        action: 'bounty.cancelled',
        actor: getAuth(req),
        target: { type: 'bounty', id: bounty.bountyId },
        ip: req.ip,
      });
      res.json({ bountyId: bounty.bountyId, status: 'cancelled' });
    } catch (err: unknown) {
      next(err);
    }
  },
);

export { router as bountiesRouter };
