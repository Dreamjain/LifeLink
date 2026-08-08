import type { ErrorRequestHandler } from 'express';
import { logger } from '../../config/logger.js';
import { AppError } from '../errors/app-error.js';

export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  void next;
  const correlationId = req.correlationId;

  if (error instanceof AppError) {
    res.status(error.statusCode).json({
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
        correlationId,
      },
    });
    return;
  }

  logger.error({ err: error, correlationId }, 'Unhandled request error');
  res.status(500).json({
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: 'An unexpected error occurred.',
      correlationId,
    },
  });
};
