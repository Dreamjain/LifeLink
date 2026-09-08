import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../../config/logger.js';
import { AppError } from '../../../common/errors/app-error.js';
import {
  parseAcceptResponseInput,
  parseRejectResponseInput,
  parseResponseIdParam,
} from '../schemas/response.schema.js';
import {
  acceptResponse as acceptResponseService,
  getResponse as getResponseService,
  listResponses as listResponsesService,
  rejectResponse as rejectResponseService,
} from '../services/hospital-response.service.js';
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

export const listResponses = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const responses = await listResponsesService(context);

    res.status(200).json({ responses });
  } catch (error) {
    next(error);
  }
};

export const getResponse = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const responseId = parseResponseIdParam(req.params.responseId);
    const response = await getResponseService(context, responseId);

    res.status(200).json({ response });
  } catch (error) {
    next(error);
  }
};

export const acceptResponse = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const actorUserId = requireActorId(req);
    const responseId = parseResponseIdParam(req.params.responseId);
    parseAcceptResponseInput(req.body ?? {});

    const response = await acceptResponseService(context, responseId, actorUserId);

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId,
        hospitalId: context.hospitalId,
        responseId,
        emergencyId: response.emergencyId,
        action: 'accept-response',
      },
      'hospitals.response.accept.success',
    );
    res.status(200).json({ response });
  } catch (error) {
    next(error);
  }
};

export const rejectResponse = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const actorUserId = requireActorId(req);
    const responseId = parseResponseIdParam(req.params.responseId);
    const input = parseRejectResponseInput(req.body);

    const response = await rejectResponseService(
      context,
      responseId,
      actorUserId,
      input.rejectionReason,
    );

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId,
        hospitalId: context.hospitalId,
        responseId,
        emergencyId: response.emergencyId,
        action: 'reject-response',
        hasReason: true,
      },
      'hospitals.response.reject.success',
    );
    res.status(200).json({ response });
  } catch (error) {
    next(error);
  }
};
