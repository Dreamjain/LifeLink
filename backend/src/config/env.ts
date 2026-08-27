import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  JWT_ISSUER: z.string().default('lifelink-api'),
  JWT_AUDIENCE: z.string().default('lifelink-clients'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  BCRYPT_ROUNDS: z.coerce.number().int().min(10).max(16).default(12),
});

export const env = envSchema.parse(process.env);
