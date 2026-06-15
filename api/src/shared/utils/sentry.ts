// Thin Sentry wrapper — full wiring (DSN, tracing, profiling) lands in a later issue.
// This module is a no-op when SENTRY_DSN is absent — callers don't need to guard individually.
import * as SentryNode from '@sentry/node';
import { logger } from './logger.js';

let _initialized = false;

export function initSentry(dsn: string | undefined): void {
  if (!dsn) {
    logger.info('SENTRY_DSN not set — Sentry disabled');
    return;
  }
  SentryNode.init({ dsn });
  _initialized = true;
  logger.info('Sentry initialized');
}

export function captureException(err: unknown): void {
  if (!_initialized) return;
  SentryNode.captureException(err);
}
