import {
  Router,
  type Request,
  type Response,
  type NextFunction,
  type CookieOptions,
} from 'express';
import { randomBytes } from 'crypto';
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
import { writeAudit } from '../../shared/audit/writeAudit.js';
import { AppError } from '../../shared/utils/AppError.js';

const router = Router();

// Browser-bound CSRF nonce: set at /start, must match the state's nonce at /callback.
const STATE_NONCE_COOKIE = 'gh_oauth_nonce';

function nonceCookieOptions(): CookieOptions {
  // SameSite=Lax so the cookie rides along on GitHub's top-level redirect back.
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 10 * 60 * 1000,
  };
}

function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 11000
  );
}

// The link flow is a full-page browser redirect, so a failure must hand control
// back to the app with a reason in the query string. Returning a JSON error here
// would strand the user on the API origin; instead the frontend reads `reason`
// and shows a proper message. Kept to known, non-sensitive reason codes.
function redirectLinkError(res: Response, reason: string): void {
  res.redirect(`${env.APP_BASE_URL}/?github=error&reason=${reason}`);
}

// GET /auth/github/start — redirect the logged-in wallet to GitHub's consent screen.
router.get('/start', requireAuth, (req: Request, res: Response): void => {
  const { address } = getAuth(req);
  const nonce = randomBytes(16).toString('hex');
  res.cookie(STATE_NONCE_COOKIE, nonce, nonceCookieOptions());
  res.redirect(buildAuthorizeUrl(signGithubState(address, nonce)));
});

const callbackQuery = z.object({ code: z.string().min(1), state: z.string().min(1) });

// GET /auth/github/callback — exchange the code, store the encrypted grant, link the wallet.
router.get('/callback', async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  const parsed = callbackQuery.safeParse(req.query);
  if (!parsed.success) {
    next(AppError.badRequest('Missing code or state'));
    return;
  }

  let state;
  try {
    state = readGithubState(parsed.data.state);
  } catch {
    next(AppError.unauthorized('Invalid or expired OAuth state'));
    return;
  }

  // The finishing browser must be the one that started the flow.
  const cookieNonce = req.cookies?.[STATE_NONCE_COOKIE] as string | undefined;
  if (!cookieNonce || cookieNonce !== state.nonce) {
    next(AppError.unauthorized('OAuth state does not match this browser session'));
    return;
  }
  const address = state.address;
  res.clearCookie(STATE_NONCE_COOKIE, { path: '/' });

  try {
    const { accessToken, scopes } = await exchangeCodeForToken(parsed.data.code);
    const ghUser = await fetchGitHubUser(accessToken);

    // Refuse to re-point an existing GitHub identity at a different wallet. Without
    // this, wallet B could link GitHub account X that wallet A already owns, moving
    // linkedAddress A->B while A's hunter doc keeps the same githubUserId — two
    // wallets bound to one GitHub id, breaking the 1:1 binding the Sybil gate needs.
    const existingLink = await OAuthTokenModel.findOne({ githubUserId: ghUser.id }).lean();
    if (existingLink?.linkedAddress && existingLink.linkedAddress !== address) {
      redirectLinkError(res, 'already_linked');
      return;
    }

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

    res.redirect(`${env.APP_BASE_URL}/?github=linked`);
  } catch (err: unknown) {
    if (err instanceof GithubError) {
      redirectLinkError(res, 'link_failed');
      return;
    }
    if (isDuplicateKeyError(err)) {
      redirectLinkError(res, 'wallet_already_linked');
      return;
    }
    next(err);
  }
});

// DELETE /auth/github/link — unlink the caller's GitHub account. Safe at any
// time: an in-flight claim snapshots its GitHub identity at submit, so pending
// payouts are unaffected; only future claims (which require a link) are blocked
// until the wallet links again. Idempotent — unlinking when nothing is linked
// returns { unlinked: false }.
router.delete('/link', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  const { address } = getAuth(req);
  try {
    const removed = await OAuthTokenModel.deleteOne({ linkedAddress: address });
    await HunterModel.updateOne({ address }, { $unset: { githubLogin: '', githubUserId: '' } });
    await writeAudit({
      action: 'github.unlinked',
      actor: getAuth(req),
      target: { type: 'hunter', id: address },
      ip: req.ip,
    });
    res.json({ unlinked: removed.deletedCount > 0 });
  } catch (err: unknown) {
    next(err);
  }
});

export { router as githubAuthRouter };
