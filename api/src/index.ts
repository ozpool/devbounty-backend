import { createApp } from './api/app.js';
import { connectDb, registerServer, registerShutdownHandlers } from './shared/config/db.js';
import { env } from './shared/config/env.js';
import { logger } from './shared/utils/logger.js';
import { initSentry } from './shared/utils/sentry.js';

async function main(): Promise<void> {
  // Sentry must be initialised before anything else so it captures startup errors.
  initSentry(env.SENTRY_DSN);

  await connectDb();

  const app = createApp();

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, nodeEnv: env.NODE_ENV }, 'API server listening');
  });

  // Give the shutdown handler a reference so it can drain HTTP connections
  // before closing the DB.
  registerServer(server);
  registerShutdownHandlers();
}

main().catch((err: unknown) => {
  logger.error({ err }, 'Fatal startup error');
  process.exit(1);
});
