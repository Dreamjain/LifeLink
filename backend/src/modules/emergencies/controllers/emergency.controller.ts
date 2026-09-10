import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../../config/logger.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { AuthenticatedPrincipal } from '../../auth/index.js';
import {
  parseCancelEmergencyInput,
  parseCreateEmergencyInput,
  parseEmergencyIdParam,
  parseIdempotencyKey,
} from '../schemas/emergency.schema.js';
import {
  cancelOwnEmergency,
  createOwnEmergency,
  getOwnEmergency,
  listOwnEmergencies,
} from '../services/emergency.service.js';

const requirePrincipal = (req: Request): AuthenticatedPrincipal => {
  if (!req.user) {
    throw new AppError('MISSING_TOKEN', 'Authentication is required.', 401);
  }

  return req.user;
};

export const createEmergency = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const clientIdempotencyKey = parseIdempotencyKey(req.header('idempotency-key'));
    const input = parseCreateEmergencyInput(req.body ?? {});

    const result = await createOwnEmergency(principal.userId, input, clientIdempotencyKey);

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId: principal.userId,
        emergencyId: result.emergency.id,
        action: 'create-emergency',
        idempotentReplay: result.idempotentReplay,
        // Patient-authored content and coordinates are never logged, only their presence.
        hasDescription: Boolean(input.description),
        hasPickupAddress: Boolean(input.pickupAddress),
        hasCoordinates: input.pickupLatitude !== undefined || input.pickupLongitude !== undefined,
      },
      'emergencies.create.success',
    );
    res.status(result.idempotentReplay ? 200 : 201).json({
      emergency: result.emergency,
      idempotentReplay: result.idempotentReplay,
    });
  } catch (error) {
    next(error);
  }
};

export const listEmergencies = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const emergencies = await listOwnEmergencies(principal.userId);

    res.status(200).json({ emergencies });
  } catch (error) {
    next(error);
  }
};

export const getEmergency = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const emergencyId = parseEmergencyIdParam(req.params.emergencyId);
    const emergency = await getOwnEmergency(principal.userId, emergencyId);

    res.status(200).json({ emergency });
  } catch (error) {
    next(error);
  }
};

export const cancelEmergency = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const emergencyId = parseEmergencyIdParam(req.params.emergencyId);
    parseCancelEmergencyInput(req.body ?? {});

    const emergency = await cancelOwnEmergency(principal.userId, emergencyId);

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId: principal.userId,
        emergencyId,
        action: 'cancel-emergency',
      },
      'emergencies.cancel.success',
    );
    res.status(200).json({ emergency });
  } catch (error) {
    next(error);
  }
};
