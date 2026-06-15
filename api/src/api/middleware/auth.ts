import type { Request, Response, NextFunction } from 'express';
import { env } from '../../shared/config/env.js';
import { verifySession } from '../../shared/auth/jwt.js';
import { AppError } from '../../shared/utils/AppError.js';

export interface AuthContext {
  address: string;
  role: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthContext;
    }
  }
}

/** Require a valid session JWT cookie; attaches req.auth or rejects with 401. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[env.JWT_COOKIE_NAME] as string | undefined;
  if (!token) {
    next(AppError.unauthorized('Authentication required'));
    return;
  }
  try {
    const claims = verifySession(token);
    req.auth = { address: claims.sub, role: claims.role };
    next();
  } catch {
    next(AppError.unauthorized('Invalid or expired session'));
  }
}

/** Require the authenticated user to hold one of the given roles (use after requireAuth). */
export function requireRole(...roles: string[]) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.auth) {
      next(AppError.unauthorized('Authentication required'));
      return;
    }
    if (!roles.includes(req.auth.role)) {
      next(AppError.forbidden('Insufficient role'));
      return;
    }
    next();
  };
}

/** Read the auth context inside a route guarded by requireAuth. */
export function getAuth(req: Request): AuthContext {
  if (!req.auth) throw new Error('getAuth called outside an authenticated route');
  return req.auth;
}
