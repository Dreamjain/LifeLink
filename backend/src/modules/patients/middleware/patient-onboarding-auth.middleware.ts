import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../../../common/errors/app-error.js';
import { verifyAccessToken } from '../../auth/index.js';
import { loadOnboardingPrincipalFromClaims } from '../services/patient.service.js';

const BEARER_PREFIX = 'Bearer ';

export const requirePatientOnboardingAuth = async (
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
    req.user = await loadOnboardingPrincipalFromClaims(claims);
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
