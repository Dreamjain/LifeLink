import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { z } from 'zod';
import { env } from '../../../config/env.js';
import type { AccessTokenClaims, SignAccessTokenInput } from '../types/auth.types.js';

const accessTokenClaimsSchema = z.object({
  sub: z.string().uuid(),
  role: z.enum(UserRole),
  jti: z.string().uuid(),
  iss: z.string(),
  aud: z.string(),
  iat: z.number(),
  exp: z.number(),
});

export const signAccessToken = (input: SignAccessTokenInput): string => {
  return jwt.sign({ role: input.role }, env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: input.userId,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
    jwtid: input.jti ?? randomUUID(),
    expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn'],
  });
};

export const verifyAccessToken = (token: string): AccessTokenClaims => {
  const decoded = jwt.verify(token, env.JWT_SECRET, {
    algorithms: ['HS256'],
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });

  const parsed = accessTokenClaimsSchema.safeParse(decoded);

  if (!parsed.success) {
    throw new jwt.JsonWebTokenError('Access token claims are malformed.');
  }

  return parsed.data;
};
