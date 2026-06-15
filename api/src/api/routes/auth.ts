import {
  Router,
  type Request,
  type Response,
  type NextFunction,
  type CookieOptions,
} from 'express';
import { z } from 'zod';
import { generateSiweNonce } from 'viem/siwe';
import { env } from '../../shared/config/env.js';
import { signSession, signNonce, readNonce, sessionCookieMaxAgeMs } from '../../shared/auth/jwt.js';
import { verifySiwe, SiweError } from '../../shared/auth/siwe.js';
import { HunterModel, NonceModel } from '../../shared/models/index.js';
import { AppError } from '../../shared/utils/AppError.js';

const router = Router();

const NONCE_COOKIE = 'siwe_nonce';
const DEFAULT_ROLE = 'hunter';

function cookieOptions(): CookieOptions {
  const prod = env.NODE_ENV === 'production';
  // Cross-site (api and web on different domains) needs SameSite=None + Secure in prod.
  return { httpOnly: true, secure: prod, sameSite: prod ? 'none' : 'lax', path: '/' };
}

const nonceBody = z.object({ address: z.string().optional() });
const verifyBody = z.object({
  message: z.string().min(1),
  signature: z.string().regex(/^0x[0-9a-fA-F]+$/, 'signature must be 0x-hex'),
});

// POST /auth/siwe/nonce — issue a nonce, carried in a short-lived signed cookie
// and also recorded server-side so verify can consume it exactly once.
router.post(
  '/siwe/nonce',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    if (!nonceBody.safeParse(req.body).success) {
      next(AppError.badRequest('Invalid request body'));
      return;
    }
    try {
      const nonce = generateSiweNonce();
      await NonceModel.create({ nonce });
      res.cookie(NONCE_COOKIE, signNonce(nonce), { ...cookieOptions(), maxAge: 5 * 60 * 1000 });
      res.json({ nonce });
    } catch (err: unknown) {
      next(err);
    }
  },
);

// POST /auth/siwe/verify — verify the signed message and start a session.
router.post(
  '/siwe/verify',
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) {
      next(AppError.badRequest('Invalid request body'));
      return;
    }
    const nonceToken = req.cookies?.[NONCE_COOKIE] as string | undefined;
    if (!nonceToken) {
      next(AppError.badRequest('Missing or expired nonce'));
      return;
    }

    let nonce: string;
    try {
      nonce = readNonce(nonceToken);
    } catch {
      next(AppError.unauthorized('Invalid or expired nonce'));
      return;
    }

    // Consume the nonce server-side, atomically and exactly once. A replay (or a
    // second tab reusing the same cookie) finds no row and is rejected, so a
    // captured nonce + signature cannot be used to mint another session.
    const consumed = await NonceModel.findOneAndDelete({ nonce });
    if (!consumed) {
      next(AppError.unauthorized('Nonce already used or expired'));
      return;
    }

    try {
      const { address } = await verifySiwe(
        parsed.data.message,
        parsed.data.signature as `0x${string}`,
        nonce,
      );

      // Upsert the hunter so a wallet exists the first time it logs in.
      await HunterModel.updateOne({ address }, { $setOnInsert: { address } }, { upsert: true });

      const token = signSession({ sub: address, role: DEFAULT_ROLE });
      res.clearCookie(NONCE_COOKIE, cookieOptions());
      res.cookie(env.JWT_COOKIE_NAME, token, {
        ...cookieOptions(),
        maxAge: sessionCookieMaxAgeMs(token),
      });
      res.json({ user: { address, role: DEFAULT_ROLE } });
    } catch (err: unknown) {
      if (err instanceof SiweError) {
        next(AppError.unauthorized(err.message));
        return;
      }
      next(err);
    }
  },
);

// POST /auth/logout — clear the session cookie (safe to call without a valid session).
router.post('/logout', (_req: Request, res: Response): void => {
  res.clearCookie(env.JWT_COOKIE_NAME, cookieOptions());
  res.json({ ok: true });
});

export { router as authRouter };
