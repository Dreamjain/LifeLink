import { z } from 'zod';
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

export const registerSchema = z
  .object({
    phone: phoneSchema,
    email: emailSchema.optional(),
    password: passwordSchema,
    displayName: displayNameSchema,
  })
  .strict();

export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z
  .object({
    phone: phoneSchema,
    password: z.string().min(1, 'Password is required.'),
  })
  .strict();

export type LoginInput = z.infer<typeof loginSchema>;

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

export const parseRegisterInput = (payload: unknown): RegisterInput =>
  parse(registerSchema, payload);
export const parseLoginInput = (payload: unknown): LoginInput => parse(loginSchema, payload);
