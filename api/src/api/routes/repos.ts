import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth, getAuth } from '../middleware/auth.js';
import { OAuthTokenModel } from '../../shared/models/index.js';
import { decryptToString } from '../../shared/crypto/tokenCrypto.js';
import { listAdminRepos, GithubError } from '../../shared/github/oauth.js';
import { AppError } from '../../shared/utils/AppError.js';

const router = Router();

// GET /repos — repositories the linked GitHub identity can admin (bounty candidates).
router.get(
  '/',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { address } = getAuth(req);
      const link = await OAuthTokenModel.findOne({ linkedAddress: address });
      if (!link) {
        next(AppError.badRequest('Link a GitHub account first'));
        return;
      }
      const accessToken = decryptToString({
        ciphertext: link.encryptedToken,
        iv: link.iv,
        authTag: link.authTag,
        keyVersion: link.keyVersion,
      });
      res.json({ repos: await listAdminRepos(accessToken) });
    } catch (err: unknown) {
      if (err instanceof GithubError) {
        next(AppError.badRequest(err.message));
        return;
      }
      next(err);
    }
  },
);

export { router as reposRouter };
