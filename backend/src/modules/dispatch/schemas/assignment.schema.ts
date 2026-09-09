import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';

const reasonSchema = z.string().trim().min(1).max(500, 'Reason is too long.');

/**
 * Dispatch targets, not identity claims: the dispatcher chooses which of their own
 * hospital's ambulances and which driver from the shared verified pool is offered.
 * Hospital scope still comes from the caller's membership and the driver's own
 * identity still comes from authentication; neither is accepted here.
 */
export const createAssignmentSchema = z
  .object({
    ambulanceId: z.string().uuid('A valid ambulance id is required.'),
    driverId: z.string().uuid('A valid driver profile id is required.'),
  })
  .strict();

export type CreateAssignmentInput = z.infer<typeof createAssignmentSchema>;

/** Accept carries no payload: every field of the decision is server-controlled. */
export const acceptAssignmentSchema = z.object({}).strict();

export type AcceptAssignmentInput = z.infer<typeof acceptAssignmentSchema>;

export const rejectAssignmentSchema = z
  .object({
    rejectionReason: reasonSchema,
  })
  .strict();

export type RejectAssignmentInput = z.infer<typeof rejectAssignmentSchema>;

const assignmentIdParamSchema = z.string().uuid('A valid assignment id is required.');
const emergencyIdParamSchema = z.string().uuid('A valid emergency id is required.');

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

export const parseCreateAssignmentInput = (payload: unknown): CreateAssignmentInput =>
  parse(createAssignmentSchema, payload);
export const parseAcceptAssignmentInput = (payload: unknown): AcceptAssignmentInput =>
  parse(acceptAssignmentSchema, payload);
export const parseRejectAssignmentInput = (payload: unknown): RejectAssignmentInput =>
  parse(rejectAssignmentSchema, payload);
export const parseAssignmentIdParam = (payload: unknown): string =>
  parse(assignmentIdParamSchema, payload);
export const parseEmergencyIdParam = (payload: unknown): string =>
  parse(emergencyIdParamSchema, payload);
