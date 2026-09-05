import { BedStatus, Prisma } from '@prisma/client';
import type { Bed } from '@prisma/client';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { HospitalStaffContext } from '../types/hospital.types.js';
import type {
  BedStatusAction,
  CreateBedInput,
  UpdateBedInput,
} from '../schemas/resource.schema.js';

export interface SafeBed {
  id: string;
  hospitalId: string;
  bedCode: string;
  bedType: Bed['bedType'];
  status: BedStatus;
  createdAt: Date;
  updatedAt: Date;
}

const toSafeBed = (bed: Bed): SafeBed => ({
  id: bed.id,
  hospitalId: bed.hospitalId,
  bedCode: bed.bedCode,
  bedType: bed.bedType,
  status: bed.status,
  createdAt: bed.createdAt,
  updatedAt: bed.updatedAt,
});

const BED_NOT_FOUND_ERROR = new AppError('BED_NOT_FOUND', 'No bed was found for this id.', 404);

const bedAlreadyExists = (): AppError =>
  new AppError('BED_ALREADY_EXISTS', 'A bed with this code already exists in this hospital.', 409);

/** Only maintenance transitions are client-initiable; RESERVED/OCCUPIED belong to the reservation workflow. */
const BED_TRANSITIONS: Record<BedStatusAction, { from: BedStatus; to: BedStatus }> = {
  MARK_OUT_OF_SERVICE: { from: BedStatus.AVAILABLE, to: BedStatus.OUT_OF_SERVICE },
  RETURN_TO_SERVICE: { from: BedStatus.OUT_OF_SERVICE, to: BedStatus.AVAILABLE },
};

export const listBeds = async (context: HospitalStaffContext): Promise<SafeBed[]> => {
  const beds = await prisma.bed.findMany({
    where: { hospitalId: context.hospitalId },
    orderBy: { createdAt: 'asc' },
  });

  return beds.map(toSafeBed);
};

export const getBed = async (context: HospitalStaffContext, bedId: string): Promise<SafeBed> => {
  const bed = await prisma.bed.findFirst({
    where: { id: bedId, hospitalId: context.hospitalId },
  });

  if (!bed) {
    throw BED_NOT_FOUND_ERROR;
  }

  return toSafeBed(bed);
};

export const createBed = async (
  context: HospitalStaffContext,
  input: CreateBedInput,
): Promise<SafeBed> => {
  try {
    const bed = await prisma.bed.create({
      data: {
        hospitalId: context.hospitalId,
        bedCode: input.bedCode,
        bedType: input.bedType,
      },
    });

    return toSafeBed(bed);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw bedAlreadyExists();
    }

    throw error;
  }
};

export const updateBed = async (
  context: HospitalStaffContext,
  bedId: string,
  input: UpdateBedInput,
): Promise<SafeBed> => {
  try {
    // Ownership is enforced in the query itself: another hospital's bed matches zero rows.
    const result = await prisma.bed.updateMany({
      where: { id: bedId, hospitalId: context.hospitalId },
      data: { ...input },
    });

    if (result.count === 0) {
      throw BED_NOT_FOUND_ERROR;
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw bedAlreadyExists();
    }

    throw error;
  }

  return toSafeBed(await prisma.bed.findUniqueOrThrow({ where: { id: bedId } }));
};

export const transitionBedStatus = async (
  context: HospitalStaffContext,
  bedId: string,
  action: BedStatusAction,
): Promise<SafeBed> => {
  const transition = BED_TRANSITIONS[action];

  // Conditional update: a concurrent change away from the expected source state affects zero rows.
  const result = await prisma.bed.updateMany({
    where: { id: bedId, hospitalId: context.hospitalId, status: transition.from },
    data: { status: transition.to },
  });

  if (result.count === 0) {
    const existing = await prisma.bed.findFirst({
      where: { id: bedId, hospitalId: context.hospitalId },
      select: { id: true },
    });

    if (!existing) {
      throw BED_NOT_FOUND_ERROR;
    }

    throw new AppError(
      'BED_STATUS_CONFLICT',
      'This bed is not in a state that allows the requested transition.',
      409,
    );
  }

  return toSafeBed(await prisma.bed.findUniqueOrThrow({ where: { id: bedId } }));
};
