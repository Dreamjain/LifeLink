import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../../config/logger.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { AuthenticatedPrincipal } from '../../auth/index.js';
import {
  parseApprovePatientInput,
  parseRejectPatientInput,
  parseUserIdParam,
} from '../schemas/admin.schema.js';
import {
  approvePatient,
  getPatientVerificationDetail,
  listPendingPatients,
  rejectPatient,
} from '../services/admin-patient.service.js';

const requirePrincipal = (req: Request): AuthenticatedPrincipal => {
  if (!req.user) {
    throw new AppError('MISSING_TOKEN', 'Authentication is required.', 401);
  }

  return req.user;
};

export const listPending = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    requirePrincipal(req);
    const patients = await listPendingPatients();

    res.status(200).json({ patients });
  } catch (error) {
    next(error);
  }
};

export const getDetail = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    requirePrincipal(req);
    const userId = parseUserIdParam(req.params.userId);
    const patient = await getPatientVerificationDetail(userId);

    res.status(200).json({ patient });
  } catch (error) {
    next(error);
  }
};

export const approve = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const userId = parseUserIdParam(req.params.userId);
    parseApprovePatientInput(req.body ?? {});

    const patient = await approvePatient(userId);

    logger.info(
      {
        correlationId: req.correlationId,
        adminUserId: principal.userId,
        patientUserId: userId,
        action: 'approve',
      },
      'admin.patient.approve.success',
    );
    res.status(200).json({ patient });
  } catch (error) {
    next(error);
  }
};

export const reject = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const userId = parseUserIdParam(req.params.userId);
    const input = parseRejectPatientInput(req.body ?? {});

    const patient = await rejectPatient(userId);

    logger.info(
      {
        correlationId: req.correlationId,
        adminUserId: principal.userId,
        patientUserId: userId,
        action: 'reject',
        hasReason: Boolean(input.reason),
      },
      'admin.patient.reject.success',
    );
    res.status(200).json({ patient });
  } catch (error) {
    next(error);
  }
};
