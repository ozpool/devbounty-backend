import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { env } from '../../shared/config/env.js';
import { requireAuth, getAuth } from '../middleware/auth.js';
import { signGithubState, readGithubState } from '../../shared/auth/jwt.js';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchGitHubUser,
  GithubError,
} from '../../shared/github/oauth.js';
import { encrypt } from '../../shared/crypto/tokenCrypto.js';
import { OAuthTokenModel, HunterModel } from '../../shared/models/index.js';
import { AppError } from '../../shared/utils/AppError.js';

const router = Router();

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 11000
  );
}

// GET /auth/github/start — redirect the logged-in wallet to GitHub's consent screen.
router.get('/start', requireAuth, (req: Request, res: Response): void => {
  const { address } = getAuth(req);
  res.redirect(buildAuthorizeUrl(signGithubState(address)));
});

const callbackQuery = z.object({ code: z.string().min(1), state: z.string().min(1) });

// GET /auth/github/callback — exchange the code, store the encrypted grant, link the wallet.
router.get('/callback', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const parsed = callbackQuery.safeParse(req.query);
  if (!parsed.success) {
    next(AppError.badRequest('Missing code or state'));
    return;
  }

  let address: string;
  try {
    address = readGithubState(parsed.data.state);
  } catch {
    next(AppError.unauthorized('Invalid or expired OAuth state'));
    return;
  }

  try {
    const { accessToken, scopes } = await exchangeCodeForToken(parsed.data.code);
    const ghUser = await fetchGitHubUser(accessToken);
    const blob = encrypt(accessToken);

    await OAuthTokenModel.updateOne(
      { githubUserId: ghUser.id },
      {
        $set: {
          githubLogin: ghUser.login,
          encryptedToken: blob.ciphertext,
          iv: blob.iv,
          authTag: blob.authTag,
          keyVersion: blob.keyVersion,
          scopes,
          linkedAddress: address,
        },
      },
      { upsert: true },
    );

    await HunterModel.updateOne(
      { address },
      { $set: { githubLogin: ghUser.login, githubUserId: ghUser.id } },
      { upsert: true },
    );

    res.redirect(`${env.CORS_ORIGIN}/?github=linked`);
  } catch (err: unknown) {
    if (err instanceof GithubError) {
      next(AppError.badRequest(err.message));
      return;
    }
    if (isDuplicateKeyError(err)) {
      next(AppError.conflict('This wallet is already linked to a different GitHub account'));
      return;
    }
    next(err);
  }
});

export { router as githubAuthRouter };
