import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../shared/utils/AppError.js';

// A fixed-window counter per key: `count` requests are allowed until `resetAt`,
// after which the window rolls over and the count restarts. Simple and memory-
// cheap; the trade-off is a burst is possible across a window boundary, which is
// acceptable for abuse-limiting (vs. the heavier sliding-window log).
interface Window {
  count: number;
  resetAt: number; // epoch ms when this window expires
}

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  /** Derive the bucket key from the request (e.g. client IP, or wallet address). */
  keyBy: (req: Request) => string;
  /** Injectable clock so tests can advance time without real waits. */
  now?: () => number;
}

/**
 * Build an in-memory fixed-window rate-limit middleware.
 *
 * The store lives in this closure, so each call to the factory owns an isolated
 * counter map. `createApp()` builds fresh limiters per app instance, which keeps
 * test apps from sharing counts. NOTE: the store is per-process — with the API
 * scaled horizontally each instance counts independently, so the effective limit
 * is roughly `max × instances`. A shared store (Redis/Mongo) is a separate issue.
 */
export function rateLimit(opts: RateLimitOptions) {
  const { windowMs, max, keyBy, now = Date.now } = opts;
  const windows = new Map<string, Window>();
  let lastSweep = now();

  // Drop expired windows roughly once per window so the map cannot grow without
  // bound as new keys (IPs/addresses) arrive. O(n) but infrequent.
  function sweep(ts: number): void {
    if (ts - lastSweep < windowMs) return;
    for (const [key, win] of windows) {
      if (ts >= win.resetAt) windows.delete(key);
    }
    lastSweep = ts;
  }

  return function rateLimitMiddleware(req: Request, res: Response, next: NextFunction): void {
    const ts = now();
    sweep(ts);

    const key = keyBy(req);
    let win = windows.get(key);
    if (!win || ts >= win.resetAt) {
      win = { count: 0, resetAt: ts + windowMs };
      windows.set(key, win);
    }
    win.count += 1;

    const resetSeconds = Math.ceil((win.resetAt - ts) / 1000);
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - win.count)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));

    if (win.count > max) {
      res.setHeader('Retry-After', String(resetSeconds));
      next(AppError.tooManyRequests('Rate limit exceeded'));
      return;
    }
    next();
  };
}

/** Bucket key = client IP. Falls back to the socket address, then a constant. */
export function ipKey(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** Bucket key = authenticated wallet address, falling back to IP when anonymous. */
export function authOrIpKey(req: Request): string {
  return req.auth?.address ?? ipKey(req);
}
