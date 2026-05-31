import pino from 'pino';
import { pinoHttp } from 'pino-http';
import type { IncomingMessage, ServerResponse } from 'http';
import { randomUUID } from 'crypto';
import { env } from '../config/env.js';

// Redact sensitive fields wherever they appear in logged objects.
// Paths use pino's wildcard syntax — covers both top-level keys and
// common nested shapes (e.g. req.headers.authorization).
const redactPaths = [
  '*.privateKey',
  '*.password',
  '*.token',
  '*.secret',
  '*.signature',
  '*.authorization',
  '*.cookie',
  '*.webhookSecret',
  '*.encryptedToken',
  // Nested HTTP shapes
  'req.headers.authorization',
  'req.headers.cookie',
  // Double-nested (pino-http wraps the raw req)
  '*.headers.authorization',
  '*.headers.cookie',
];

export const logger = pino({
  level: env.LOG_LEVEL,
  redact: {
    paths: redactPaths,
    censor: '[Redacted]',
  },
  // Human-readable in dev, JSON in production for log aggregators
  transport:
    env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
});

/**
 * pino-http middleware. Attaches a child logger to req.log and propagates
 * x-request-id (generates a UUID if the header is absent).
 */
export const httpLogger = pinoHttp({
  logger,
  // Use incoming header if present; otherwise stamp a new UUID
  genReqId(req: IncomingMessage): string {
    const existing = req.headers['x-request-id'];
    if (typeof existing === 'string' && existing.length > 0) return existing;
    return randomUUID();
  },
  customSuccessMessage(req: IncomingMessage, res: ServerResponse): string {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  // Don't escalate to error level for normal 4xx/5xx — warn is enough for clients
  customLogLevel(_req: IncomingMessage, res: ServerResponse, err?: Error): pino.LevelWithSilent {
    if (err) return 'error';
    if (res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
});
