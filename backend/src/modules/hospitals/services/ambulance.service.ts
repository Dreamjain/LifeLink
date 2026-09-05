import { AmbulanceStatus, Prisma } from '@prisma/client';
import type { Ambulance } from '@prisma/client';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { HospitalStaffContext } from '../types/hospital.types.js';
import type {
  AmbulanceStatusAction,
  CreateAmbulanceInput,
  UpdateAmbulanceInput,
} from '../schemas/resource.schema.js';

export interface SafeAmbulance {
  id: string;
  hospitalId: string;
  vehicleNumber: string;
  ambulanceType: Ambulance['ambulanceType'];
  capabilities: Prisma.JsonValue;
  status: AmbulanceStatus;
  createdAt: Date;
  updatedAt: Date;
}

const toSafeAmbulance = (ambulance: Ambulance): SafeAmbulance => ({
  id: ambulance.id,
  hospitalId: ambulance.hospitalId,
  vehicleNumber: ambulance.vehicleNumber,
  ambulanceType: ambulance.ambulanceType,
  capabilities: ambulance.capabilities,
  status: ambulance.status,
  createdAt: ambulance.createdAt,
  updatedAt: ambulance.updatedAt,
});

const AMBULANCE_NOT_FOUND_ERROR = new AppError(
  'AMBULANCE_NOT_FOUND',
  'No ambulance was found for this id.',
  404,
);

// vehicleNumber is globally unique, so the message must not reveal that another hospital owns it.
const ambulanceAlreadyExists = (): AppError =>
  new AppError(
    'AMBULANCE_ALREADY_EXISTS',
    'This vehicle number is not available for registration.',
    409,
  );

/** Only fleet-maintenance transitions; OFFERED/ASSIGNED/EN_ROUTE belong to the dispatch workflow. */
const AMBULANCE_TRANSITIONS: Record<
  AmbulanceStatusAction,
  { from: AmbulanceStatus; to: AmbulanceStatus }
> = {
  MARK_OUT_OF_SERVICE: { from: AmbulanceStatus.AVAILABLE, to: AmbulanceStatus.OUT_OF_SERVICE },
  RETURN_TO_SERVICE: { from: AmbulanceStatus.OUT_OF_SERVICE, to: AmbulanceStatus.AVAILABLE },
  RETIRE: { from: AmbulanceStatus.AVAILABLE, to: AmbulanceStatus.INACTIVE },
};

export const listAmbulances = async (context: HospitalStaffContext): Promise<SafeAmbulance[]> => {
  const ambulances = await prisma.ambulance.findMany({
    where: { hospitalId: context.hospitalId },
    orderBy: { createdAt: 'asc' },
  });

  return ambulances.map(toSafeAmbulance);
};

export const getAmbulance = async (
  context: HospitalStaffContext,
  ambulanceId: string,
): Promise<SafeAmbulance> => {
  const ambulance = await prisma.ambulance.findFirst({
    where: { id: ambulanceId, hospitalId: context.hospitalId },
  });

  if (!ambulance) {
    throw AMBULANCE_NOT_FOUND_ERROR;
  }

  return toSafeAmbulance(ambulance);
};

export const createAmbulance = async (
  context: HospitalStaffContext,
  input: CreateAmbulanceInput,
): Promise<SafeAmbulance> => {
  try {
    const ambulance = await prisma.ambulance.create({
      data: {
        hospitalId: context.hospitalId,
        vehicleNumber: input.vehicleNumber,
        ambulanceType: input.ambulanceType,
        capabilities: input.capabilities,
      },
    });

    return toSafeAmbulance(ambulance);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw ambulanceAlreadyExists();
    }

    throw error;
  }
};

export const updateAmbulance = async (
  context: HospitalStaffContext,
  ambulanceId: string,
  input: UpdateAmbulanceInput,
): Promise<SafeAmbulance> => {
  try {
    // Ownership is enforced in the query itself: another hospital's ambulance matches zero rows.
    const result = await prisma.ambulance.updateMany({
      where: { id: ambulanceId, hospitalId: context.hospitalId },
      data: { ...input },
    });

    if (result.count === 0) {
      throw AMBULANCE_NOT_FOUND_ERROR;
    }
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw ambulanceAlreadyExists();
    }

    throw error;
  }

  return toSafeAmbulance(await prisma.ambulance.findUniqueOrThrow({ where: { id: ambulanceId } }));
};

export const transitionAmbulanceStatus = async (
  context: HospitalStaffContext,
  ambulanceId: string,
  action: AmbulanceStatusAction,
): Promise<SafeAmbulance> => {
  const transition = AMBULANCE_TRANSITIONS[action];

  // Conditional update: a concurrent change away from the expected source state affects zero rows.
  const result = await prisma.ambulance.updateMany({
    where: { id: ambulanceId, hospitalId: context.hospitalId, status: transition.from },
    data: { status: transition.to },
  });

  if (result.count === 0) {
    const existing = await prisma.ambulance.findFirst({
      where: { id: ambulanceId, hospitalId: context.hospitalId },
      select: { id: true },
    });

    if (!existing) {
      throw AMBULANCE_NOT_FOUND_ERROR;
    }

    throw new AppError(
      'AMBULANCE_STATUS_CONFLICT',
      'This ambulance is not in a state that allows the requested transition.',
      409,
    );
  }

  return toSafeAmbulance(await prisma.ambulance.findUniqueOrThrow({ where: { id: ambulanceId } }));
};
