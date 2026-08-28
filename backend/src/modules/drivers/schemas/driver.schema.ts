import { z } from 'zod';
import { DriverAvailability } from '@prisma/client';
import { AppError } from '../../../common/errors/app-error.js';

const phoneSchema = z
  .string()
  .trim()
  .min(8, 'Phone number is too short.')
  .max(20, 'Phone number is too long.')
  .regex(
    /^\+?[0-9]{8,20}$/,
    'Phone number must contain only digits and an optional leading plus sign.',
  );

const passwordSchema = z.string().min(12, 'Password must be at least 12 characters long.');

const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Display name is required.')
  .max(120, 'Display name is too long.');

const emailSchema = z.string().trim().toLowerCase().email('Email must be a valid email address.');

const licenceNumberSchema = z
  .string()
  .trim()
  .min(1, 'Licence number is required.')
  .max(80, 'Licence number is too long.');

export const registerDriverSchema = z
  .object({
    phone: phoneSchema,
    email: emailSchema.optional(),
    password: passwordSchema,
    displayName: displayNameSchema,
    licenceNumber: licenceNumberSchema,
  })
  .strict();

export type RegisterDriverInput = z.infer<typeof registerDriverSchema>;

export const updateAvailabilitySchema = z
  .object({
    availabilityStatus: z.enum(DriverAvailability),
  })
  .strict();

export type UpdateAvailabilityInput = z.infer<typeof updateAvailabilitySchema>;

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

export const parseRegisterDriverInput = (payload: unknown): RegisterDriverInput =>
  parse(registerDriverSchema, payload);
export const parseUpdateAvailabilityInput = (payload: unknown): UpdateAvailabilityInput =>
  parse(updateAvailabilitySchema, payload);
