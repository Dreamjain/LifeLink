import type { NextFunction, Request, Response } from 'express';
import type { UserRole } from '@prisma/client';
import { AppError } from '../../../common/errors/app-error.js';

export const requireRole = (...roles: UserRole[]) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.user) {
      next(new AppError('MISSING_TOKEN', 'Authentication is required.', 401));
      return;
    }

    if (!roles.includes(req.user.role)) {
      next(
        new AppError(
          'INSUFFICIENT_ROLE',
          'Your role is not permitted to perform this action.',
          403,
        ),
      );
      return;
    }

    next();
  };
};
