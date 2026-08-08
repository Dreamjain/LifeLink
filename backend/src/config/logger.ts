import pino from 'pino';
import { env } from './env.js';

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: 'lifelink-backend',
    environment: env.NODE_ENV,
  },
  redact: ['req.headers.authorization', 'password', 'token', 'refreshToken'],
});
