import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../../config/logger.js';
import { AppError } from '../../../common/errors/app-error.js';
import {
  parseBedIdParam,
  parseBedStatusAction,
  parseCreateBedInput,
  parseUpdateBedInput,
} from '../schemas/resource.schema.js';
import {
  createBed as createBedService,
  getBed as getBedService,
  listBeds as listBedsService,
  transitionBedStatus,
  updateBed as updateBedService,
} from '../services/bed.service.js';
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

export const listBeds = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const context = requireScope(req);
    const beds = await listBedsService(context);

    res.status(200).json({ beds });
  } catch (error) {
    next(error);
  }
};

export const getBed = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const context = requireScope(req);
    const bedId = parseBedIdParam(req.params.bedId);
    const bed = await getBedService(context, bedId);

    res.status(200).json({ bed });
  } catch (error) {
    next(error);
  }
};

export const createBed = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const context = requireScope(req);
    const input = parseCreateBedInput(req.body);
    const bed = await createBedService(context, input);

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId: req.user?.userId,
        hospitalId: context.hospitalId,
        bedId: bed.id,
        action: 'create-bed',
      },
      'hospitals.bed.create.success',
    );
    res.status(201).json({ bed });
  } catch (error) {
    next(error);
  }
};

export const updateBed = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const context = requireScope(req);
    const bedId = parseBedIdParam(req.params.bedId);
    const input = parseUpdateBedInput(req.body ?? {});
    const bed = await updateBedService(context, bedId, input);

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId: req.user?.userId,
        hospitalId: context.hospitalId,
        bedId,
        action: 'update-bed',
      },
      'hospitals.bed.update.success',
    );
    res.status(200).json({ bed });
  } catch (error) {
    next(error);
  }
};

export const changeBedStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const bedId = parseBedIdParam(req.params.bedId);
    const action = parseBedStatusAction(req.body);
    const bed = await transitionBedStatus(context, bedId, action);

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId: req.user?.userId,
        hospitalId: context.hospitalId,
        bedId,
        action,
        status: bed.status,
      },
      'hospitals.bed.status.success',
    );
    res.status(200).json({ bed });
  } catch (error) {
    next(error);
  }
};
