import type { Request, Response, NextFunction } from 'express';
import { AppError } from '../../shared/utils/AppError.js';
import { logger } from '../../shared/utils/logger.js';
import { captureException } from '../../shared/utils/sentry.js';

// Express recognises a 4-argument function as an error handler.
export function errorMiddleware(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    // Operational errors — safe to surface to the client
    logger.warn({ err }, 'AppError');
    res.status(err.statusCode).json({
      code: err.code,
      message: err.message,
      ...(err.details !== undefined ? { details: err.details } : {}),
    });
    return;
  }

  // Unknown / programming errors — log full detail, never leak internals to client
  logger.error({ err }, 'Unhandled error');
  captureException(err);

  res.status(500).json({
    code: 'INTERNAL_ERROR',
    message: 'An unexpected error occurred',
  });
}
