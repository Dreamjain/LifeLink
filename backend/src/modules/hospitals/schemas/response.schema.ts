import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';

const reasonSchema = z.string().trim().min(1).max(500, 'Reason is too long.');

/** Accept carries no payload: every field of the decision is server-controlled. */
export const acceptResponseSchema = z.object({}).strict();

export type AcceptResponseInput = z.infer<typeof acceptResponseSchema>;

export const rejectResponseSchema = z
  .object({
    rejectionReason: reasonSchema,
  })
  .strict();

export type RejectResponseInput = z.infer<typeof rejectResponseSchema>;

export const createReservationSchema = z
  .object({
    bedId: z.string().uuid('A valid bed id is required.'),
  })
  .strict();

export type CreateReservationInput = z.infer<typeof createReservationSchema>;

export const releaseReservationSchema = z
  .object({
    releaseReason: reasonSchema.optional(),
  })
  .strict();

export type ReleaseReservationInput = z.infer<typeof releaseReservationSchema>;

const responseIdParamSchema = z.string().uuid('A valid hospital response id is required.');
const reservationIdParamSchema = z.string().uuid('A valid reservation id is required.');

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

export const parseAcceptResponseInput = (payload: unknown): AcceptResponseInput =>
  parse(acceptResponseSchema, payload);
export const parseRejectResponseInput = (payload: unknown): RejectResponseInput =>
  parse(rejectResponseSchema, payload);
export const parseCreateReservationInput = (payload: unknown): CreateReservationInput =>
  parse(createReservationSchema, payload);
export const parseReleaseReservationInput = (payload: unknown): ReleaseReservationInput =>
  parse(releaseReservationSchema, payload);
export const parseResponseIdParam = (payload: unknown): string =>
  parse(responseIdParamSchema, payload);
export const parseReservationIdParam = (payload: unknown): string =>
  parse(reservationIdParamSchema, payload);
