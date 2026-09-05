import { z } from 'zod';
import { AmbulanceType, BedType } from '@prisma/client';
import { AppError } from '../../../common/errors/app-error.js';

const bedCodeSchema = z
  .string()
  .trim()
  .min(1, 'Bed code is required.')
  .max(50, 'Bed code is too long.');

const vehicleNumberSchema = z
  .string()
  .trim()
  .min(1, 'Vehicle number is required.')
  .max(30, 'Vehicle number is too long.');

const capabilitiesSchema = z.array(z.string().trim().min(1).max(100)).max(50);

export const createBedSchema = z
  .object({
    bedCode: bedCodeSchema,
    bedType: z.enum(BedType).optional(),
  })
  .strict();

export type CreateBedInput = z.infer<typeof createBedSchema>;

export const updateBedSchema = z
  .object({
    bedCode: bedCodeSchema.optional(),
    bedType: z.enum(BedType).optional(),
  })
  .strict();

export type UpdateBedInput = z.infer<typeof updateBedSchema>;

/** Explicit operational actions, never a raw status assignment (DatabaseDesign.md §9). */
export const BED_STATUS_ACTIONS = ['MARK_OUT_OF_SERVICE', 'RETURN_TO_SERVICE'] as const;

export const bedStatusActionSchema = z
  .object({
    action: z.enum(BED_STATUS_ACTIONS),
  })
  .strict();

export type BedStatusAction = (typeof BED_STATUS_ACTIONS)[number];

export const createAmbulanceSchema = z
  .object({
    vehicleNumber: vehicleNumberSchema,
    ambulanceType: z.enum(AmbulanceType).optional(),
    capabilities: capabilitiesSchema.optional(),
  })
  .strict();

export type CreateAmbulanceInput = z.infer<typeof createAmbulanceSchema>;

export const updateAmbulanceSchema = z
  .object({
    vehicleNumber: vehicleNumberSchema.optional(),
    ambulanceType: z.enum(AmbulanceType).optional(),
    capabilities: capabilitiesSchema.optional(),
  })
  .strict();

export type UpdateAmbulanceInput = z.infer<typeof updateAmbulanceSchema>;

export const AMBULANCE_STATUS_ACTIONS = [
  'MARK_OUT_OF_SERVICE',
  'RETURN_TO_SERVICE',
  'RETIRE',
] as const;

export const ambulanceStatusActionSchema = z
  .object({
    action: z.enum(AMBULANCE_STATUS_ACTIONS),
  })
  .strict();

export type AmbulanceStatusAction = (typeof AMBULANCE_STATUS_ACTIONS)[number];

const bedIdParamSchema = z.string().uuid('A valid bed id is required.');
const ambulanceIdParamSchema = z.string().uuid('A valid ambulance id is required.');

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

export const parseCreateBedInput = (payload: unknown): CreateBedInput =>
  parse(createBedSchema, payload);
export const parseUpdateBedInput = (payload: unknown): UpdateBedInput =>
  parse(updateBedSchema, payload);
export const parseBedStatusAction = (payload: unknown): BedStatusAction =>
  parse(bedStatusActionSchema, payload).action;
export const parseBedIdParam = (payload: unknown): string => parse(bedIdParamSchema, payload);

export const parseCreateAmbulanceInput = (payload: unknown): CreateAmbulanceInput =>
  parse(createAmbulanceSchema, payload);
export const parseUpdateAmbulanceInput = (payload: unknown): UpdateAmbulanceInput =>
  parse(updateAmbulanceSchema, payload);
export const parseAmbulanceStatusAction = (payload: unknown): AmbulanceStatusAction =>
  parse(ambulanceStatusActionSchema, payload).action;
export const parseAmbulanceIdParam = (payload: unknown): string =>
  parse(ambulanceIdParamSchema, payload);
