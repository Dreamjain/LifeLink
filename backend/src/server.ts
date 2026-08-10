import { app } from './app.js';
import { env } from './config/env.js';
import { logger } from './config/logger.js';
import { connectDatabase, disconnectDatabase } from './database/prisma.js';

const bootstrap = async (): Promise<void> => {
  await connectDatabase();

  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, environment: env.NODE_ENV }, 'Backend foundation started');
  });

  server.on('error', (error) => {
    logger.error({ err: error }, 'Backend server failed to start');
    process.exitCode = 1;
  });

  const shutdown = (signal: NodeJS.Signals): void => {
    logger.info({ signal }, 'Shutting down backend server');

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
