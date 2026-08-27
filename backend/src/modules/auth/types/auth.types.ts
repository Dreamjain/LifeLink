import type { UserRole } from '@prisma/client';

export interface AccessTokenClaims {
  sub: string;
  role: UserRole;
  jti: string;
  iss: string;
  aud: string;
  iat: number;
  exp: number;
}

export interface SignAccessTokenInput {
  userId: string;
  role: UserRole;
  jti?: string;
}

export interface AuthenticatedPrincipal {
  userId: string;
  role: UserRole;
  jti: string;
}
