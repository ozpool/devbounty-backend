import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { getAddress, isAddress } from 'viem';
import { HunterModel, ReputationEventModel } from '../../shared/models/index.js';
import { AppError } from '../../shared/utils/AppError.js';

const LEADERBOARD_LIMIT = 50;
const CACHE_TTL_MS = 30_000;
const WINDOW_30D_MS = 30 * 24 * 60 * 60 * 1000;

const huntersRouter = Router();
const leaderboardRouter = Router();

// GET /hunters/:address — public profile plus recent payout history.
huntersRouter.get('/:address', async (req: Request, res: Response, next: NextFunction) => {
  const param = req.params.address;
  const raw = typeof param === 'string' ? param : '';
  if (!isAddress(raw)) {
    next(AppError.badRequest('Invalid address'));
    return;
  }
  const address = getAddress(raw);
  try {
    const hunter = await HunterModel.findOne({ address }).lean();
    if (!hunter) {
      next(AppError.notFound('Hunter not found'));
      return;
    }
    const recent = await ReputationEventModel.find({ hunterAddress: address })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();
    res.json({
      address: hunter.address,
      githubLogin: hunter.githubLogin ?? null,
      totalEarnedUsdc: hunter.totalEarnedUsdc,
      payoutCount: hunter.payoutCount,
      reposContributed: hunter.reposContributed,
      languages: hunter.languages,
      recentPayouts: recent.map((e) => ({
        bountyId: e.bountyId,
        amountUsdc: e.amountUsdc,
        repoFullName: e.repoFullName,
        language: e.language ?? null,
        txHash: e.txHash,
        prCommitSha: e.prCommitSha ?? null,
        blockNumber: e.blockNumber,
        createdAt: e.createdAt ?? null,
      })),
    });
  } catch (err: unknown) {
    next(err);
  }
});

interface LeaderboardRow {
  rank: number;
  address: string;
  githubLogin: string | null;
  totalEarnedUsdc: string;
  payoutCount: number;
}

// Short-lived cache; the indexer will also invalidate on payout events (later issue).
const cache = new Map<string, { at: number; rows: LeaderboardRow[] }>();

const leaderboardQuery = z.object({
  lang: z.string().optional(),
  window: z.enum(['30d', 'all']).optional(),
});

async function computeLeaderboard(
  lang: string | undefined,
  window: string,
): Promise<LeaderboardRow[]> {
  const match: Record<string, unknown> = { type: 'payout' };
  if (lang) match['language'] = lang;
  if (window === '30d') match['createdAt'] = { $gte: new Date(Date.now() - WINDOW_30D_MS) };
  const rows = await ReputationEventModel.aggregate<Omit<LeaderboardRow, 'rank'>>([
    { $match: match },
    {
      $group: {
        _id: '$hunterAddress',
        total: { $sum: { $toDecimal: '$amountUsdc' } },
        payoutCount: { $sum: 1 },
      },
    },
    { $sort: { total: -1 } },
    { $limit: LEADERBOARD_LIMIT },
    { $lookup: { from: 'hunters', localField: '_id', foreignField: 'address', as: 'hunter' } },
    {
      $project: {
        _id: 0,
        address: '$_id',
        githubLogin: { $ifNull: [{ $arrayElemAt: ['$hunter.githubLogin', 0] }, null] },
        totalEarnedUsdc: { $toString: '$total' },
        payoutCount: 1,
      },
    },
  ]);
  // Rank is positional over the total-desc sort above.
  return rows.map((row, i) => ({ rank: i + 1, ...row }));
}

// GET /leaderboard?lang&window=30d|all — top hunters by USDC earned.
leaderboardRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  const parsed = leaderboardQuery.safeParse(req.query);
  if (!parsed.success) {
    next(AppError.badRequest('Invalid query parameters'));
    return;
  }
  const lang = parsed.data.lang;
  const window = parsed.data.window ?? 'all';
  const key = `${window}:${lang ?? '*'}`;
  try {
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      res.json({ window, lang: lang ?? null, items: hit.rows, cached: true });
      return;
    }
    const rows = await computeLeaderboard(lang, window);
    cache.set(key, { at: Date.now(), rows });
    res.json({ window, lang: lang ?? null, items: rows, cached: false });
  } catch (err: unknown) {
    next(err);
  }
});

export { huntersRouter, leaderboardRouter };
