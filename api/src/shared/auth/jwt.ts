import jwt, { type SignOptions } from 'jsonwebtoken';
import { env } from '../config/env.js';

// Short window between issuing a SIWE nonce and the wallet signing it.
const NONCE_TTL = '5m';

export interface SessionClaims {
  sub: string; // wallet address (checksummed)
  role: string;
}

const sessionTtl = env.JWT_TTL as SignOptions['expiresIn'];

/** Sign a session JWT (HS256) with the wallet address as the subject. */
export function signSession(claims: SessionClaims): string {
  return jwt.sign({ role: claims.role }, env.JWT_SECRET, {
    subject: claims.sub,
    expiresIn: sessionTtl,
  });
}

/** Verify a session JWT and return its claims. Throws if invalid or expired. */
export function verifySession(token: string): SessionClaims {
  const payload = jwt.verify(token, env.JWT_SECRET);
  if (typeof payload === 'string' || !payload.sub || typeof payload['role'] !== 'string') {
    throw new Error('Malformed session token');
  }
  return { sub: payload.sub, role: payload['role'] };
}

/** Sign a short-lived token that carries a SIWE nonce, server-issued so it can't be forged. */
export function signNonce(nonce: string): string {
  return jwt.sign({ nonce, typ: 'siwe-nonce' }, env.JWT_SECRET, { expiresIn: NONCE_TTL });
}

/** Read and validate a nonce token, returning the nonce. Throws if invalid or expired. */
export function readNonce(token: string): string {
  const payload = jwt.verify(token, env.JWT_SECRET);
  if (
    typeof payload === 'string' ||
    payload['typ'] !== 'siwe-nonce' ||
    typeof payload['nonce'] !== 'string'
  ) {
    throw new Error('Invalid nonce token');
  }
  return payload['nonce'];
}

const GH_STATE_TTL = '10m';

export interface GithubState {
  address: string;
  nonce: string;
}

/**
 * Sign the GitHub OAuth `state`. It carries the initiating wallet plus a nonce
 * that must match an HttpOnly cookie set at /start, binding the callback to the
 * same browser (CSRF guard).
 */
export function signGithubState(address: string, nonce: string): string {
  return jwt.sign({ address, nonce, typ: 'gh-oauth-state' }, env.JWT_SECRET, {
    expiresIn: GH_STATE_TTL,
  });
}

/** Read and validate a GitHub OAuth state, returning the bound address and nonce. */
export function readGithubState(token: string): GithubState {
  const payload = jwt.verify(token, env.JWT_SECRET);
  if (
    typeof payload === 'string' ||
    payload['typ'] !== 'gh-oauth-state' ||
    typeof payload['address'] !== 'string' ||
    typeof payload['nonce'] !== 'string'
  ) {
    throw new Error('Invalid OAuth state');
  }
  return { address: payload['address'], nonce: payload['nonce'] };
}
