import mongoose from 'mongoose';
import { env } from './env.js';
import { logger } from '../utils/logger.js';

// Hold a reference to the HTTP server so shutdown can drain connections first.
// Set via registerServer() called from src/index.ts after listen().
let _server: { close(cb: () => void): void } | null = null;

export function registerServer(server: { close(cb: () => void): void }): void {
  _server = server;
}

export async function connectDb(): Promise<void> {
  mongoose.connection.on('connected', () => {
    logger.info('MongoDB connected');
  });

  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });

  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected');
  });

  mongoose.connection.on('error', (err: unknown) => {
    logger.error({ err }, 'MongoDB connection error');
  });

  await mongoose.connect(env.MONGO_URI);
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
  logger.info('MongoDB disconnected cleanly');
}

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown signal received — draining connections');

  await new Promise<void>((resolve) => {
    if (_server) {
      _server.close(() => resolve());
    } else {
      resolve();
    }
  });

  await disconnectDb();
  process.exit(0);
}

// Register once — idempotent if called multiple times (process listeners are
// additive, so guard with a flag)
let _shutdownRegistered = false;

export function registerShutdownHandlers(): void {
  if (_shutdownRegistered) return;
  _shutdownRegistered = true;

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
