import { z } from 'zod';
import { EmergencyType, Severity } from '@prisma/client';
import { AppError } from '../../../common/errors/app-error.js';

/**
 * A namespaced idempotency key is stored as `<patientProfileId>:<client-key>`. The column
 * is VarChar(128) and a UUID profile id is 36 characters, so the client portion is capped
 * at 91 (36 + 1 separator + 91 = 128) and the stored value always fits.
 */
export const MAX_CLIENT_IDEMPOTENCY_KEY_LENGTH = 91;

export const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1, 'An Idempotency-Key header is required.')
  .max(
    MAX_CLIENT_IDEMPOTENCY_KEY_LENGTH,
    `Idempotency-Key must be at most ${MAX_CLIENT_IDEMPOTENCY_KEY_LENGTH} characters.`,
  )
  .regex(
    /^[A-Za-z0-9._:-]+$/,
    'Idempotency-Key may contain only letters, digits, and the characters . _ : -',
  );

const latitudeSchema = z
  .number()
  .min(-90, 'Latitude must be between -90 and 90.')
  .max(90, 'Latitude must be between -90 and 90.');

const longitudeSchema = z
  .number()
  .min(-180, 'Longitude must be between -180 and 180.')
  .max(180, 'Longitude must be between -180 and 180.');

/**
 * Everything a patient may state about their own emergency. Identity, lifecycle state and
 * every timestamp are server-controlled and rejected by `.strict()`.
 */
export const createEmergencySchema = z
  .object({
    requestType: z.enum(EmergencyType).optional(),
    severity: z.enum(Severity).optional(),
    description: z.string().trim().min(1).max(2000, 'Description is too long.').optional(),
    pickupAddress: z.string().trim().min(1).max(500, 'Pickup address is too long.').optional(),
    pickupLatitude: latitudeSchema.optional(),
    pickupLongitude: longitudeSchema.optional(),
  })
  .strict();

export type CreateEmergencyInput = z.infer<typeof createEmergencySchema>;

/** Cancel carries no payload: every field of the decision is server-controlled. */
export const cancelEmergencySchema = z.object({}).strict();

export type CancelEmergencyInput = z.infer<typeof cancelEmergencySchema>;

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

export const parseCreateEmergencyInput = (payload: unknown): CreateEmergencyInput =>
  parse(createEmergencySchema, payload);
export const parseCancelEmergencyInput = (payload: unknown): CancelEmergencyInput =>
  parse(cancelEmergencySchema, payload);
export const parseEmergencyIdParam = (payload: unknown): string =>
  parse(emergencyIdParamSchema, payload);
export const parseIdempotencyKey = (payload: unknown): string =>
  parse(idempotencyKeySchema, payload);
