import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../../config/logger.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { AuthenticatedPrincipal } from '../../auth/index.js';
import {
  parseApproveDriverInput,
  parseRejectDriverInput,
  parseUserIdParam,
} from '../schemas/admin.schema.js';
import {
  approveDriver,
  getDriverVerificationDetail,
  listPendingDrivers,
  rejectDriver,
} from '../services/admin-driver.service.js';

const requirePrincipal = (req: Request): AuthenticatedPrincipal => {
  if (!req.user) {
    throw new AppError('MISSING_TOKEN', 'Authentication is required.', 401);
  }

  return req.user;
};

export const listPendingDriverAccounts = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    requirePrincipal(req);
    const drivers = await listPendingDrivers();

    res.status(200).json({ drivers });
  } catch (error) {
    next(error);
  }
};

export const getDriverDetail = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    requirePrincipal(req);
    const userId = parseUserIdParam(req.params.userId);
    const driver = await getDriverVerificationDetail(userId);

    res.status(200).json({ driver });
  } catch (error) {
    next(error);
  }
};

export const approve = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const userId = parseUserIdParam(req.params.userId);
    parseApproveDriverInput(req.body ?? {});

    const driver = await approveDriver(userId);

    logger.info(
      {
        correlationId: req.correlationId,
        adminUserId: principal.userId,
        driverUserId: userId,
        action: 'approve',
      },
      'admin.driver.approve.success',
    );
    res.status(200).json({ driver });
  } catch (error) {
    next(error);
  }
};

export const reject = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const principal = requirePrincipal(req);
    const userId = parseUserIdParam(req.params.userId);
    const input = parseRejectDriverInput(req.body ?? {});

    const driver = await rejectDriver(userId);

    logger.info(
      {
        correlationId: req.correlationId,
        adminUserId: principal.userId,
        driverUserId: userId,
        action: 'reject',
        hasReason: Boolean(input.reason),
      },
      'admin.driver.reject.success',
    );
    res.status(200).json({ driver });
  } catch (error) {
    next(error);
  }
};
