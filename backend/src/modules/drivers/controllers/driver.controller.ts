import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../../config/logger.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { AuthenticatedPrincipal } from '../../auth/index.js';
import {
  parseRegisterDriverInput,
  parseUpdateAvailabilityInput,
} from '../schemas/driver.schema.js';
import {
  getOwnDriverProfile,
  registerDriver as registerDriverService,
  updateOwnAvailability,
} from '../services/driver.service.js';

const requirePrincipal = (req: Request): AuthenticatedPrincipal => {
  if (!req.user) {
    throw new AppError('MISSING_TOKEN', 'Authentication is required.', 401);
  }

  return req.user;
};

export const registerDriver = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const input = parseRegisterDriverInput(req.body);
    const result = await registerDriverService(input);

    logger.info(
      { correlationId: req.correlationId, userId: result.user.id },
      'drivers.register.success',
    );
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
};

export const getMe = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const driverProfile = await getOwnDriverProfile(principal.userId);

    res.status(200).json({ driverProfile });
  } catch (error) {
    next(error);
  }
};

export const patchAvailability = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const input = parseUpdateAvailabilityInput(req.body);
    const driverProfile = await updateOwnAvailability(principal.userId, input.availabilityStatus);

    logger.info(
      {
        correlationId: req.correlationId,
        userId: principal.userId,
        availabilityStatus: driverProfile.availabilityStatus,
      },
      'drivers.availability.update.success',
    );
    res.status(200).json({ driverProfile });
  } catch (error) {
    next(error);
  }
};
