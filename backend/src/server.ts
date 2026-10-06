import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './database/prisma.js';
import { startDispatchTimeoutSweep } from './modules/dispatch/index.js';

const bootstrap = async (): Promise<void> => {
  await connectDatabase();

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, environment: env.NODE_ENV }, 'Backend foundation started');
  });

  // Task 1.24: reclaims driver offers and accepted trips that were never answered or started.
  // Started here rather than in app.ts so tests that import the app never run a background timer.
  const stopDispatchTimeoutSweep = startDispatchTimeoutSweep();
  logger.info(
    {
      intervalSeconds: env.DISPATCH_TIMEOUT_SWEEP_INTERVAL_SECONDS,
      offerTimeoutSeconds: env.DRIVER_OFFER_TIMEOUT_SECONDS,
      acceptedTimeoutSeconds: env.DRIVER_ACCEPTED_TIMEOUT_SECONDS,
    },
    'Dispatch timeout sweep started',
  );

  server.on('error', (error) => {
    logger.error({ err: error }, 'Backend server failed to start');
    process.exitCode = 1;
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'Shutting down backend server');
    stopDispatchTimeoutSweep();

    server.close((error) => {
      if (error) {
        logger.error({ err: error }, 'Backend server shutdown failed');
        process.exitCode = 1;
      }

      void disconnectDatabase().finally(() => process.exit());
    });
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
};

void bootstrap().catch((error: unknown) => {
  logger.fatal({ err: error }, 'Backend foundation failed to start');
  process.exit(1);
});
