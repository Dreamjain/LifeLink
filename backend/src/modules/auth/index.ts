export { hashPassword, verifyPassword } from './utils/password.util.js';
export { signAccessToken, verifyAccessToken } from './utils/jwt.util.js';
export type {
  AccessTokenClaims,
  SignAccessTokenInput,
  AuthenticatedPrincipal,
} from './types/auth.types.js';
export { authRouter } from './routes/auth.routes.js';
export { requireAuth } from './middleware/auth.middleware.js';
export { requireRole } from './middleware/role.middleware.js';
