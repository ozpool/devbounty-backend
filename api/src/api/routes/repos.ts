import { Router, type Request, type Response, type NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { requireAuth, getAuth } from '../middleware/auth.js';
import { OAuthTokenModel, RepoModel } from '../../shared/models/index.js';
import { decryptToString, encryptToBuffer } from '../../shared/crypto/tokenCrypto.js';
import {
  listAdminRepos,
  createRepoWebhook,
  fetchRepoMetadata,
  GithubError,
} from '../../shared/github/oauth.js';
import { env } from '../../shared/config/env.js';
import { AppError } from '../../shared/utils/AppError.js';

const router = Router();

// Read the linked GitHub access token for a wallet, or null if it isn't linked.
async function linkedAccessToken(address: string): Promise<string | null> {
  const link = await OAuthTokenModel.findOne({ linkedAddress: address });
  if (!link) return null;
  return decryptToString({
    ciphertext: link.encryptedToken,
    iv: link.iv,
    authTag: link.authTag,
    keyVersion: link.keyVersion,
  });
}

// GET /repos — repositories the linked GitHub identity can admin (bounty candidates).
router.get(
  '/',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const { address } = getAuth(req);
      const accessToken = await linkedAccessToken(address);
      if (!accessToken) {
        next(AppError.badRequest('Link a GitHub account first'));
        return;
      }
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

// POST /repos/:owner/:repo/webhook — install the merge webhook on a repo the
// maintainer admins, and store its freshly generated signing key encrypted.
// Re-running it rotates the key: the old one is kept as `previous` (with a
// timestamp) so deliveries already signed with it still verify during the window.
router.post(
  '/:owner/:repo/webhook',
  requireAuth,
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const { owner, repo } = req.params;
    if (typeof owner !== 'string' || typeof repo !== 'string') {
      next(AppError.badRequest('Invalid repository path'));
      return;
    }
    const { address } = getAuth(req);
    try {
      const accessToken = await linkedAccessToken(address);
      if (!accessToken) {
        next(AppError.badRequest('Link a GitHub account before installing a webhook'));
        return;
      }

      // Resolve the repo id server-side from the caller's token — never trust an
      // id from the request — and refuse to overwrite a record another wallet owns.
      const meta = await fetchRepoMetadata(owner, repo, accessToken);
      const existing = await RepoModel.findOne({ githubRepoId: meta.id });
      if (existing?.ownerAddress && existing.ownerAddress !== address) {
        next(AppError.forbidden('This repository is registered to another account'));
        return;
      }

      const secret = randomBytes(32).toString('hex');
      const { id: webhookId } = await createRepoWebhook(owner, repo, accessToken, {
        url: `${env.API_PUBLIC_BASE_URL}/webhooks/github`,
        secret,
      });

      const sealed = encryptToBuffer(secret);
      const update: Record<string, unknown> = {
        fullName: meta.fullName,
        githubRepoId: meta.id,
        ownerAddress: address,
        webhookId,
        webhookSecretCurrent: sealed.buffer,
        webhookKeyVersion: sealed.keyVersion,
      };
      // Rotation: keep the prior signing key as the fallback for in-flight deliveries.
      if (existing?.webhookSecretCurrent) {
        update['webhookSecretPrevious'] = existing.webhookSecretCurrent;
        update['webhookSecretRotatedAt'] = new Date();
      }
      await RepoModel.updateOne({ githubRepoId: meta.id }, { $set: update }, { upsert: true });

      res.status(201).json({ repo: meta.fullName, githubRepoId: meta.id, webhookId });
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
