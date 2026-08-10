import { PrismaClient } from '@prisma/client';
import { env } from '../config/env.js';
import { logger } from '../config/logger.js';

const globalForPrisma = globalThis as typeof globalThis & {
  prisma?: PrismaClient;
};

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });

if (env.NODE_ENV !== 'production') {
  globalForPrisma.prisma = prisma;
}

let connectionPromise: Promise<void> | undefined;

export const connectDatabase = (): Promise<void> => {
  connectionPromise ??= prisma
    .$connect()
    .then(() => {
      logger.info('PostgreSQL database connection established');
    })
    .catch((error: unknown) => {
      connectionPromise = undefined;
      throw error;
    });

  return connectionPromise;
};

export const disconnectDatabase = async (): Promise<void> => {
  if (!connectionPromise) {
    return;
  }

  await prisma.$disconnect();
  connectionPromise = undefined;
  logger.info('PostgreSQL database connection closed');
};
