import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../../config/logger.js';
import { AppError } from '../../../common/errors/app-error.js';
import { parseCreateHospitalStaffInput } from '../schemas/hospital.schema.js';
import {
  createHospitalStaff,
  getOwnHospitalContext,
  listOwnHospitalStaff,
} from '../services/hospital.service.js';
import type { HospitalStaffContext } from '../types/hospital.types.js';

const requireScope = (req: Request): HospitalStaffContext => {
  if (!req.hospitalStaff) {
    throw new AppError(
      'HOSPITAL_SCOPE_DENIED',
      'You do not have an active hospital membership.',
      403,
    );
  }

  return req.hospitalStaff;
};

export const getOwnHospital = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const result = await getOwnHospitalContext(context);

    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

export const listStaff = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const context = requireScope(req);
    const staff = await listOwnHospitalStaff(context);

    res.status(200).json({ staff });
  } catch (error) {
    next(error);
  }
};

export const createStaff = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const input = parseCreateHospitalStaffInput(req.body);
    const membership = await createHospitalStaff(context, input);

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId: req.user?.userId,
        hospitalId: context.hospitalId,
        staffUserId: membership.user.id,
        staffRole: membership.staffRole,
        action: 'create-staff',
      },
      'hospitals.staff.create.success',
    );
    res.status(201).json({ membership });
  } catch (error) {
    next(error);
  }
};
