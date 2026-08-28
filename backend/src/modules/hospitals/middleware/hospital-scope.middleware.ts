import type { NextFunction, Request, Response } from 'express';
import type { HospitalStaffRole } from '@prisma/client';
import { AppError } from '../../../common/errors/app-error.js';
import { resolveHospitalStaffContext } from '../services/hospital.service.js';

/**
 * Resolves the caller's hospital scope from their own ACTIVE membership and attaches it
 * to the request. Runs after requireAuth + requireRole(HOSPITAL_STAFF); never reads a
 * hospital identifier from the request.
 */
export const requireHospitalMembership = async (
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    if (!req.user) {
      next(new AppError('MISSING_TOKEN', 'Authentication is required.', 401));
      return;
    }

    req.hospitalStaff = await resolveHospitalStaffContext(req.user.userId);
    next();
  } catch (error) {
    next(error);
  }
};

/** Narrows a hospital-scoped operation to specific staff roles (e.g. hospital ADMIN). */
export const requireHospitalStaffRole = (...staffRoles: HospitalStaffRole[]) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    if (!req.hospitalStaff) {
      next(
        new AppError(
          'HOSPITAL_SCOPE_DENIED',
          'You do not have an active hospital membership.',
          403,
        ),
      );
      return;
    }

    if (!staffRoles.includes(req.hospitalStaff.staffRole)) {
      next(
        new AppError(
          'INSUFFICIENT_HOSPITAL_ROLE',
          'Your hospital staff role is not permitted to perform this action.',
          403,
        ),
      );
      return;
    }

    next();
  };
};
