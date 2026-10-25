import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../../../common/errors/app-error.js';
import { verifyAccessToken } from '../utils/jwt.util.js';
import { loadActivePrincipalFromClaims } from '../services/auth.service.js';

const BEARER_PREFIX = 'Bearer ';

export const requireAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  const header = req.header('authorization');

  if (!header) {
    next(new AppError('MISSING_TOKEN', 'An access token is required.', 401));
    return;
  }

  if (!header.startsWith(BEARER_PREFIX) || header.slice(BEARER_PREFIX.length).trim().length === 0) {
    next(new AppError('MALFORMED_TOKEN', 'Authorization header must use the Bearer scheme.', 401));
    return;
  }

  const token = header.slice(BEARER_PREFIX.length).trim();

  try {
    const claims = verifyAccessToken(token);
    req.user = await loadActivePrincipalFromClaims(claims);
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      next(new AppError('TOKEN_EXPIRED', 'The access token has expired.', 401));
      return;
    }

    if (error instanceof jwt.JsonWebTokenError) {
      next(new AppError('INVALID_TOKEN', 'The access token could not be verified.', 401));
      return;
    }

    next(error);
  }
};

/**
 * Authenticates a patient solely for the status-only endpoint. Do not replace `requireAuth` with
 * this middleware on `/auth/me` or business routes: the status lookup intentionally allows a
 * valid token from a pending/rejected patient to learn only their own current account status.
 */
export const requirePatientStatusAuth = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  const header = req.header('authorization');

  if (!header) {
    next(new AppError('MISSING_TOKEN', 'An access token is required.', 401));
    return;
  }

  if (!header.startsWith(BEARER_PREFIX) || header.slice(BEARER_PREFIX.length).trim().length === 0) {
    next(new AppError('MALFORMED_TOKEN', 'Authorization header must use the Bearer scheme.', 401));
    return;
  }

  try {
    const claims = verifyAccessToken(header.slice(BEARER_PREFIX.length).trim());

    if (claims.role !== 'PATIENT') {
      next(new AppError('INSUFFICIENT_ROLE', 'Patient account status is unavailable.', 403));
      return;
    }

    req.user = { userId: claims.sub, role: claims.role, jti: claims.jti };
    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      next(new AppError('TOKEN_EXPIRED', 'The access token has expired.', 401));
      return;
    }

    if (error instanceof jwt.JsonWebTokenError) {
      next(new AppError('INVALID_TOKEN', 'The access token could not be verified.', 401));
      return;
    }

    next(error);
  }
};
