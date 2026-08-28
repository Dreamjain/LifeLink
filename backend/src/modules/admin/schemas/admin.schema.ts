import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';

export const userIdParamSchema = z.string().uuid('A valid user id is required.');

export const approvePatientSchema = z.object({}).strict();

export type ApprovePatientInput = z.infer<typeof approvePatientSchema>;

export const rejectPatientSchema = z
  .object({
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type RejectPatientInput = z.infer<typeof rejectPatientSchema>;

const parse = <T>(schema: z.ZodType<T>, payload: unknown): T => {
  const result = schema.safeParse(payload);

  if (!result.success) {
    throw new AppError('VALIDATION_ERROR', 'Request validation failed.', 400, {
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  return result.data;
};

export const parseUserIdParam = (payload: unknown): string => parse(userIdParamSchema, payload);
export const parseApprovePatientInput = (payload: unknown): ApprovePatientInput =>
  parse(approvePatientSchema, payload);
export const parseRejectPatientInput = (payload: unknown): RejectPatientInput =>
  parse(rejectPatientSchema, payload);
