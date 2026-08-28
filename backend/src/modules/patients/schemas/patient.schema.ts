import { z } from 'zod';
import { BloodGroup } from '@prisma/client';
import { AppError } from '../../../common/errors/app-error.js';

const contactPhoneSchema = z
  .string()
  .trim()
  .min(8, 'Phone number is too short.')
  .max(20, 'Phone number is too long.')
  .regex(
    /^\+?[0-9]{8,20}$/,
    'Phone number must contain only digits and an optional leading plus sign.',
  );

export const updateProfileSchema = z
  .object({
    dateOfBirth: z.coerce.date().optional(),
    gender: z.string().trim().min(1).max(32).optional(),
    bloodGroup: z.enum(BloodGroup).optional(),
    allergies: z.string().trim().max(5000).optional(),
    medicalSummary: z.string().trim().max(5000).optional(),
    addressLine: z.string().trim().min(1).max(255).optional(),
    city: z.string().trim().min(1).max(100).optional(),
    state: z.string().trim().min(1).max(100).optional(),
    postalCode: z.string().trim().min(1).max(20).optional(),
  })
  .strict();

export type UpdateProfileInput = z.infer<typeof updateProfileSchema>;

export const createContactSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required.').max(120, 'Name is too long.'),
    relationship: z
      .string()
      .trim()
      .min(1, 'Relationship is required.')
      .max(60, 'Relationship is too long.'),
    phone: contactPhoneSchema,
    isPrimary: z.boolean().optional(),
  })
  .strict();

export type CreateContactInput = z.infer<typeof createContactSchema>;

export const updateContactSchema = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    relationship: z.string().trim().min(1).max(60).optional(),
    phone: contactPhoneSchema.optional(),
    isPrimary: z.boolean().optional(),
  })
  .strict();

export type UpdateContactInput = z.infer<typeof updateContactSchema>;

const contactIdParamSchema = z.string().uuid('A valid emergency contact id is required.');

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

export const parseUpdateProfileInput = (payload: unknown): UpdateProfileInput =>
  parse(updateProfileSchema, payload);
export const parseCreateContactInput = (payload: unknown): CreateContactInput =>
  parse(createContactSchema, payload);
export const parseUpdateContactInput = (payload: unknown): UpdateContactInput =>
  parse(updateContactSchema, payload);
export const parseContactIdParam = (payload: unknown): string =>
  parse(contactIdParamSchema, payload);
