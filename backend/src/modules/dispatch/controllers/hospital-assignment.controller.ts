import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../../config/logger.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { HospitalStaffContext } from '../../hospitals/types/hospital.types.js';
import {
  parseAssignmentIdParam,
  parseCreateAssignmentInput,
  parseEmergencyIdParam,
} from '../schemas/assignment.schema.js';
import {
  createAssignment as createAssignmentService,
  getAssignment as getAssignmentService,
  listAssignments as listAssignmentsService,
} from '../services/assignment.service.js';

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

export const listAssignments = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const assignments = await listAssignmentsService(context);

    res.status(200).json({ assignments });
  } catch (error) {
    next(error);
  }
};

export const getAssignment = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const assignmentId = parseAssignmentIdParam(req.params.assignmentId);
    const assignment = await getAssignmentService(context, assignmentId);

    res.status(200).json({ assignment });
  } catch (error) {
    next(error);
  }
};

export const createAssignment = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const context = requireScope(req);
    const actorUserId = requireActorId(req);
    const emergencyId = parseEmergencyIdParam(req.params.emergencyId);
    const input = parseCreateAssignmentInput(req.body);

    const assignment = await createAssignmentService(context, emergencyId, input, actorUserId);

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId,
        hospitalId: context.hospitalId,
        emergencyId,
        assignmentId: assignment.id,
        ambulanceId: assignment.ambulanceId,
        driverId: assignment.driverId,
        attemptNumber: assignment.attemptNumber,
        action: 'create-assignment',
      },
      'dispatch.assignment.create.success',
    );
    res.status(201).json({ assignment });
  } catch (error) {
    next(error);
  }
};
