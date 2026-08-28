import { z } from 'zod';
import { HospitalStaffRole } from '@prisma/client';
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

const emailSchema = z.string().trim().toLowerCase().email('Email must be a valid email address.');

const passwordSchema = z.string().min(12, 'Password must be at least 12 characters long.');

const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Display name is required.')
  .max(120, 'Display name is too long.');

export const createHospitalSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, 'Hospital name is required.')
      .max(180, 'Hospital name is too long.'),
    registrationNumber: z
      .string()
      .trim()
      .min(1, 'Registration number is required.')
      .max(100, 'Registration number is too long.'),
    phone: phoneSchema,
    email: emailSchema.optional(),
    addressLine: z
      .string()
      .trim()
      .min(1, 'Address line is required.')
      .max(255, 'Address line is too long.'),
    city: z.string().trim().min(1, 'City is required.').max(100, 'City is too long.'),
    state: z.string().trim().min(1, 'State is required.').max(100, 'State is too long.'),
    postalCode: z
      .string()
      .trim()
      .min(1, 'Postal code is required.')
      .max(20, 'Postal code is too long.'),
    latitude: z
      .number()
      .min(-90, 'Latitude is out of range.')
      .max(90, 'Latitude is out of range.')
      .optional(),
    longitude: z
      .number()
      .min(-180, 'Longitude is out of range.')
      .max(180, 'Longitude is out of range.')
      .optional(),
    capabilities: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  })
  .strict();

export type CreateHospitalInput = z.infer<typeof createHospitalSchema>;

/** System ADMIN provisioning the hospital's first administrator: staffRole is server-forced to ADMIN. */
export const provisionHospitalAdminSchema = z
  .object({
    phone: phoneSchema,
    email: emailSchema.optional(),
    password: passwordSchema,
    displayName: displayNameSchema,
  })
  .strict();

export type ProvisionHospitalAdminInput = z.infer<typeof provisionHospitalAdminSchema>;

/** Roles a hospital administrator may provision. Deliberately excludes ADMIN and every UserRole value. */
export const ASSIGNABLE_STAFF_ROLES = [
  HospitalStaffRole.DISPATCHER,
  HospitalStaffRole.RECEPTIONIST,
  HospitalStaffRole.CLINICAL_COORDINATOR,
] as const;

export const createHospitalStaffSchema = z
  .object({
    phone: phoneSchema,
    email: emailSchema.optional(),
    password: passwordSchema,
    displayName: displayNameSchema,
    staffRole: z.enum(ASSIGNABLE_STAFF_ROLES),
  })
  .strict();

export type CreateHospitalStaffInput = z.infer<typeof createHospitalStaffSchema>;

export const hospitalIdParamSchema = z.string().uuid('A valid hospital id is required.');

export const verifyHospitalSchema = z.object({}).strict();

export type VerifyHospitalInput = z.infer<typeof verifyHospitalSchema>;

export const rejectHospitalSchema = z
  .object({
    reason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export type RejectHospitalInput = z.infer<typeof rejectHospitalSchema>;

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

export const parseCreateHospitalInput = (payload: unknown): CreateHospitalInput =>
  parse(createHospitalSchema, payload);
export const parseProvisionHospitalAdminInput = (payload: unknown): ProvisionHospitalAdminInput =>
  parse(provisionHospitalAdminSchema, payload);
export const parseCreateHospitalStaffInput = (payload: unknown): CreateHospitalStaffInput =>
  parse(createHospitalStaffSchema, payload);
export const parseHospitalIdParam = (payload: unknown): string =>
  parse(hospitalIdParamSchema, payload);
export const parseVerifyHospitalInput = (payload: unknown): VerifyHospitalInput =>
  parse(verifyHospitalSchema, payload);
export const parseRejectHospitalInput = (payload: unknown): RejectHospitalInput =>
  parse(rejectHospitalSchema, payload);
