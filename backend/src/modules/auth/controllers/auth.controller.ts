import type { NextFunction, Request, Response } from 'express';
import { logger } from '../../../config/logger.js';
import { AppError } from '../../../common/errors/app-error.js';
import { parseLoginInput, parseRegisterInput } from '../schemas/auth.schema.js';
import {
  getCurrentUser,
  login as authenticateUser,
  registerPatient,
} from '../services/auth.service.js';

export const register = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const input = parseRegisterInput(req.body);
    const result = await registerPatient(input);

    logger.info(
      { correlationId: req.correlationId, userId: result.user.id },
      'auth.register.success',
    );
    res.status(201).json(result);
  } catch (error) {
    next(error);
  }
};

export const login = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    const input = parseLoginInput(req.body);
    const result = await authenticateUser(input);

    logger.info({ correlationId: req.correlationId, userId: result.user.id }, 'auth.login.success');
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

export const me = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
  try {
    if (!req.user) {
      throw new AppError('MISSING_TOKEN', 'Authentication is required.', 401);
    }

    const user = await getCurrentUser(req.user);

    res.status(200).json({ user });
  } catch (error) {
    next(error);
  }
};
