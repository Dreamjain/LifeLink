import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../../config/logger.js';
import { AppError } from '../../../common/errors/app-error.js';
import {
  parseCreateReservationInput,
  parseReleaseReservationInput,
  parseReservationIdParam,
  parseResponseIdParam,
} from '../schemas/response.schema.js';
import {
  createReservation as createReservationService,
  getReservation as getReservationService,
  listReservations as listReservationsService,
  releaseReservation as releaseReservationService,
} from '../services/bed-reservation.service.js';
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

const requireActorId = (req: Request): string => {
  if (!req.user) {
    throw new AppError('MISSING_TOKEN', 'Authentication is required.', 401);
  }

  return req.user.userId;
};

export const listReservations = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const reservations = await listReservationsService(context);

    res.status(200).json({ reservations });
  } catch (error) {
    next(error);
  }
};

export const getReservation = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const reservationId = parseReservationIdParam(req.params.reservationId);
    const reservation = await getReservationService(context, reservationId);

    res.status(200).json({ reservation });
  } catch (error) {
    next(error);
  }
};

export const createReservation = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const actorUserId = requireActorId(req);
    const responseId = parseResponseIdParam(req.params.responseId);
    const input = parseCreateReservationInput(req.body);

    const reservation = await createReservationService(
      context,
      responseId,
      input.bedId,
      actorUserId,
    );

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId,
        hospitalId: context.hospitalId,
        responseId,
        reservationId: reservation.id,
        bedId: reservation.bedId,
        emergencyId: reservation.emergencyId,
        action: 'create-reservation',
      },
      'hospitals.reservation.create.success',
    );
    res.status(201).json({ reservation });
  } catch (error) {
    next(error);
  }
};

export const releaseReservation = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const actorUserId = requireActorId(req);
    const reservationId = parseReservationIdParam(req.params.reservationId);
    const input = parseReleaseReservationInput(req.body ?? {});

    const reservation = await releaseReservationService(
      context,
      reservationId,
      actorUserId,
      input.releaseReason,
    );

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId,
        hospitalId: context.hospitalId,
        reservationId,
        bedId: reservation.bedId,
        emergencyId: reservation.emergencyId,
        action: 'release-reservation',
        hasReason: Boolean(input.releaseReason),
      },
      'hospitals.reservation.release.success',
    );
    res.status(200).json({ reservation });
  } catch (error) {
    next(error);
  }
};
