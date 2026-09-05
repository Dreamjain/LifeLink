import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../../config/logger.js';
import { AppError } from '../../../common/errors/app-error.js';
import {
  parseAmbulanceIdParam,
  parseAmbulanceStatusAction,
  parseCreateAmbulanceInput,
  parseUpdateAmbulanceInput,
} from '../schemas/resource.schema.js';
import {
  createAmbulance as createAmbulanceService,
  getAmbulance as getAmbulanceService,
  listAmbulances as listAmbulancesService,
  transitionAmbulanceStatus,
  updateAmbulance as updateAmbulanceService,
} from '../services/ambulance.service.js';
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

export const listAmbulances = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const ambulances = await listAmbulancesService(context);

    res.status(200).json({ ambulances });
  } catch (error) {
    next(error);
  }
};

export const getAmbulance = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const ambulanceId = parseAmbulanceIdParam(req.params.ambulanceId);
    const ambulance = await getAmbulanceService(context, ambulanceId);

    res.status(200).json({ ambulance });
  } catch (error) {
    next(error);
  }
};

export const createAmbulance = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const input = parseCreateAmbulanceInput(req.body);
    const ambulance = await createAmbulanceService(context, input);

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId: req.user?.userId,
        hospitalId: context.hospitalId,
        ambulanceId: ambulance.id,
        action: 'create-ambulance',
      },
      'hospitals.ambulance.create.success',
    );
    res.status(201).json({ ambulance });
  } catch (error) {
    next(error);
  }
};

export const updateAmbulance = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const ambulanceId = parseAmbulanceIdParam(req.params.ambulanceId);
    const input = parseUpdateAmbulanceInput(req.body ?? {});
    const ambulance = await updateAmbulanceService(context, ambulanceId, input);

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId: req.user?.userId,
        hospitalId: context.hospitalId,
        ambulanceId,
        action: 'update-ambulance',
      },
      'hospitals.ambulance.update.success',
    );
    res.status(200).json({ ambulance });
  } catch (error) {
    next(error);
  }
};

export const changeAmbulanceStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const ambulanceId = parseAmbulanceIdParam(req.params.ambulanceId);
    const action = parseAmbulanceStatusAction(req.body);
    const ambulance = await transitionAmbulanceStatus(context, ambulanceId, action);

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId: req.user?.userId,
        hospitalId: context.hospitalId,
        ambulanceId,
        action,
        status: ambulance.status,
      },
      'hospitals.ambulance.status.success',
    );
    res.status(200).json({ ambulance });
  } catch (error) {
    next(error);
  }
};
