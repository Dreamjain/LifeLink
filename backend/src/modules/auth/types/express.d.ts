import type { AuthenticatedPrincipal } from './auth.types.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedPrincipal;
    }
  }
}

export {};
