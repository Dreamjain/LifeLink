import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../../config/logger.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { AuthenticatedPrincipal } from '../../auth/index.js';
import {
  parseAcceptAssignmentInput,
  parseAssignmentIdParam,
  parseFailAssignmentInput,
  parseRejectAssignmentInput,
  parseTripActionInput,
} from '../schemas/assignment.schema.js';
import {
  acceptOwnAssignment,
  failOwnAssignment,
  getOwnAssignment,
  listOwnAssignments,
  rejectOwnAssignment,
  transitionOwnAssignment,
} from '../services/driver-assignment.service.js';

const requirePrincipal = (req: Request): AuthenticatedPrincipal => {
  if (!req.user) {
    throw new AppError('MISSING_TOKEN', 'Authentication is required.', 401);
  }

  return req.user;
};

export const listAssignments = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const assignments = await listOwnAssignments(principal.userId);

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
    const principal = requirePrincipal(req);
    const assignmentId = parseAssignmentIdParam(req.params.assignmentId);
    const assignment = await getOwnAssignment(principal.userId, assignmentId);

    res.status(200).json({ assignment });
  } catch (error) {
    next(error);
  }
};

export const acceptAssignment = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const assignmentId = parseAssignmentIdParam(req.params.assignmentId);
    parseAcceptAssignmentInput(req.body ?? {});

    const assignment = await acceptOwnAssignment(principal.userId, assignmentId);

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId: principal.userId,
        assignmentId,
        emergencyId: assignment.emergencyId,
        ambulanceId: assignment.ambulanceId,
        driverId: assignment.driverId,
        action: 'accept-assignment',
      },
      'dispatch.assignment.accept.success',
    );
    res.status(200).json({ assignment });
  } catch (error) {
    next(error);
  }
};

export const rejectAssignment = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const assignmentId = parseAssignmentIdParam(req.params.assignmentId);
    const input = parseRejectAssignmentInput(req.body);

    const assignment = await rejectOwnAssignment(
      principal.userId,
      assignmentId,
      input.rejectionReason,
    );

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId: principal.userId,
        assignmentId,
        emergencyId: assignment.emergencyId,
        ambulanceId: assignment.ambulanceId,
        driverId: assignment.driverId,
        action: 'reject-assignment',
        // The reason itself is never logged: it is free text from an operational actor.
        hasReason: true,
      },
      'dispatch.assignment.reject.success',
    );
    res.status(200).json({ assignment });
  } catch (error) {
    next(error);
  }
};

export const changeAssignmentStatus = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const assignmentId = parseAssignmentIdParam(req.params.assignmentId);
    const input = parseTripActionInput(req.body);

    const assignment = await transitionOwnAssignment(principal.userId, assignmentId, input.action);

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId: principal.userId,
        assignmentId,
        emergencyId: assignment.emergencyId,
        ambulanceId: assignment.ambulanceId,
        driverId: assignment.driverId,
        tripAction: input.action,
        status: assignment.status,
        emergencyStatus: assignment.emergency.currentStatus,
        action: 'transition-assignment',
      },
      'dispatch.assignment.trip.success',
    );
    res.status(200).json({ assignment });
  } catch (error) {
    next(error);
  }
};

export const failAssignment = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const assignmentId = parseAssignmentIdParam(req.params.assignmentId);
    const input = parseFailAssignmentInput(req.body);

    const assignment = await failOwnAssignment(principal.userId, assignmentId, input.failureReason);

    logger.info(
      {
        correlationId: req.correlationId,
        actorUserId: principal.userId,
        assignmentId,
        emergencyId: assignment.emergencyId,
        ambulanceId: assignment.ambulanceId,
        driverId: assignment.driverId,
        action: 'fail-assignment',
        // The reason itself is never logged: it is free text from an operational actor.
        hasReason: true,
      },
      'dispatch.assignment.fail.success',
    );
    res.status(200).json({ assignment });
  } catch (error) {
    next(error);
  }
};
