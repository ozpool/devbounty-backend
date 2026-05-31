import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth, getAuth } from '../middleware/auth.js';
import { HunterModel } from '../../shared/models/index.js';

const router = Router();

// GET /me — the authenticated wallet plus its GitHub-link status.
router.get(
  '/',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { address, role } = getAuth(req);
      const hunter = await HunterModel.findOne({ address }).lean();
      res.json({
        address,
        role,
        githubLogin: hunter?.githubLogin ?? null,
        hasLinkedGithub: Boolean(hunter?.githubLogin),
      });
    } catch (err: unknown) {
      next(err);
    }
  },
);

export { router as meRouter };
