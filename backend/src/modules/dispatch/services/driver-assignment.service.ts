import { AmbulanceAssignmentStatus, AmbulanceStatus, DriverAvailability } from '@prisma/client';
import type { Ambulance, AmbulanceAssignment, EmergencyRequest, Hospital } from '@prisma/client';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';
import {
  toSafeEmergency,
  type SafeEmergencySummary,
} from '../../hospitals/services/hospital-response.service.js';
import type { DriverContext } from '../types/dispatch.types.js';
import { toSafeAssignmentAmbulance, type SafeAssignmentAmbulance } from './assignment.service.js';

/** Destination context a driver needs to complete the run. An organisation, not a person. */
export interface SafeAssignmentHospital {
  id: string;
  name: string;
  addressLine: string;
  city: string;
  state: string;
  postalCode: string;
  latitude: string | null;
  longitude: string | null;
}

/**
 * Driver view of an assignment: the emergency through the Task 1.15 privacy mapper
 * (no PatientProfile field), the vehicle to take, and the destination hospital.
 */
export interface SafeDriverAssignment {
  id: string;
  emergencyId: string;
  ambulanceId: string;
  driverId: string;
  attemptNumber: number;
  status: AmbulanceAssignmentStatus;
  rejectionReason: string | null;
  assignedAt: Date;
  respondedAt: Date | null;
  startedAt: Date | null;
  endedAt: Date | null;
  emergency: SafeEmergencySummary;
  ambulance: SafeAssignmentAmbulance;
  hospital: SafeAssignmentHospital;
}

type DriverAssignmentWithRelations = AmbulanceAssignment & {
  emergency: EmergencyRequest;
  ambulance: Ambulance;
  hospitalResponse: { hospital: Hospital };
};

const toSafeAssignmentHospital = (hospital: Hospital): SafeAssignmentHospital => ({
  id: hospital.id,
  name: hospital.name,
  addressLine: hospital.addressLine,
  city: hospital.city,
  state: hospital.state,
  postalCode: hospital.postalCode,
  latitude: hospital.latitude?.toString() ?? null,
  longitude: hospital.longitude?.toString() ?? null,
});

const toSafeDriverAssignment = (
  assignment: DriverAssignmentWithRelations,
): SafeDriverAssignment => ({
  id: assignment.id,
  emergencyId: assignment.emergencyId,
  ambulanceId: assignment.ambulanceId,
  driverId: assignment.driverId,
  attemptNumber: assignment.attemptNumber,
  status: assignment.status,
  rejectionReason: assignment.rejectionReason,
  assignedAt: assignment.assignedAt,
  respondedAt: assignment.respondedAt,
  startedAt: assignment.startedAt,
  endedAt: assignment.endedAt,
  emergency: toSafeEmergency(assignment.emergency),
  ambulance: toSafeAssignmentAmbulance(assignment.ambulance),
  hospital: toSafeAssignmentHospital(assignment.hospitalResponse.hospital),
});

const DRIVER_PROFILE_NOT_FOUND_ERROR = new AppError(
  'DRIVER_NOT_FOUND',
  'No driver profile was found for this account.',
  404,
);

/**
 * Another driver's assignment is reported as not found rather than forbidden, matching
 * the repository's uniform cross-scope behaviour: ownership is never disclosed.
 */
const ASSIGNMENT_NOT_FOUND_ERROR = new AppError(
  'ASSIGNMENT_NOT_FOUND',
  'No ambulance assignment was found for this id.',
  404,
);

const assignmentStatusConflict = (): AppError =>
  new AppError(
    'ASSIGNMENT_STATUS_CONFLICT',
    'This assignment is no longer awaiting a driver response.',
    409,
  );

const DRIVER_ASSIGNMENT_INCLUDE = {
  emergency: true,
  ambulance: true,
  hospitalResponse: { include: { hospital: true } },
} as const;

/**
 * Resolves the caller's driver scope from their own authenticated user id.
 * A client-supplied driver id is never accepted (AuthenticationDesign.md section 12).
 */
export const resolveDriverContext = async (userId: string): Promise<DriverContext> => {
  const profile = await prisma.driverProfile.findUnique({
    where: { userId },
    select: { id: true, userId: true },
  });

  if (!profile) {
    throw DRIVER_PROFILE_NOT_FOUND_ERROR;
  }

  return { driverProfileId: profile.id, userId: profile.userId };
};

export const listOwnAssignments = async (userId: string): Promise<SafeDriverAssignment[]> => {
  const context = await resolveDriverContext(userId);

  const assignments = await prisma.ambulanceAssignment.findMany({
    where: { driverId: context.driverProfileId },
    orderBy: { assignedAt: 'desc' },
    include: DRIVER_ASSIGNMENT_INCLUDE,
  });

  return assignments.map(toSafeDriverAssignment);
};

export const getOwnAssignment = async (
  userId: string,
  assignmentId: string,
): Promise<SafeDriverAssignment> => {
  const context = await resolveDriverContext(userId);

  const assignment = await prisma.ambulanceAssignment.findFirst({
    where: { id: assignmentId, driverId: context.driverProfileId },
    include: DRIVER_ASSIGNMENT_INCLUDE,
  });

  if (!assignment) {
    throw ASSIGNMENT_NOT_FOUND_ERROR;
  }

  return toSafeDriverAssignment(assignment);
};

/**
 * Accepts an outstanding offer. Ownership is part of every write predicate, and the
 * OFFERED -> ACCEPTED claim is conditional, so a concurrent accept/reject pair can only
 * produce one terminal transition. The driver stays BUSY; the vehicle moves
 * OFFERED -> ASSIGNED.
 *
 * The emergency itself is not transitioned here: PENDING_DRIVER_ACCEPTANCE onwards is
 * the driver-journey stage owned by a later task, and inventing a transition would cross
 * the orchestration boundary.
 */
export const acceptOwnAssignment = async (
  userId: string,
  assignmentId: string,
): Promise<SafeDriverAssignment> => {
  const context = await resolveDriverContext(userId);

  return prisma.$transaction(async (tx) => {
    const assignment = await tx.ambulanceAssignment.findFirst({
      where: { id: assignmentId, driverId: context.driverProfileId },
    });

    if (!assignment) {
      throw ASSIGNMENT_NOT_FOUND_ERROR;
    }

    const claimed = await tx.ambulanceAssignment.updateMany({
      where: {
        id: assignmentId,
        driverId: context.driverProfileId,
        status: AmbulanceAssignmentStatus.OFFERED,
      },
      data: {
        status: AmbulanceAssignmentStatus.ACCEPTED,
        respondedAt: new Date(),
      },
    });

    if (claimed.count === 0) {
      throw assignmentStatusConflict();
    }

    const committed = await tx.ambulance.updateMany({
      where: { id: assignment.ambulanceId, status: AmbulanceStatus.OFFERED },
      data: { status: AmbulanceStatus.ASSIGNED },
    });

    if (committed.count === 0) {
      throw new AppError(
        'AMBULANCE_STATUS_CONFLICT',
        'The offered ambulance is no longer held for this assignment.',
        409,
      );
    }

    return toSafeDriverAssignment(
      await tx.ambulanceAssignment.findUniqueOrThrow({
        where: { id: assignmentId },
        include: DRIVER_ASSIGNMENT_INCLUDE,
      }),
    );
  });
};

/**
 * Rejects an outstanding offer. The row is kept as the historical attempt with its
 * reason; the vehicle and the driver are released back to AVAILABLE so they can be
 * offered again.
 *
 * No replacement assignment is created and no emergency-level transition is invented:
 * whether to retry, rematch, escalate or expire belongs to the orchestration layer
 * (DatabaseDesign.md section 8), not to a single driver's answer.
 */
export const rejectOwnAssignment = async (
  userId: string,
  assignmentId: string,
  rejectionReason: string,
): Promise<SafeDriverAssignment> => {
  const context = await resolveDriverContext(userId);

  return prisma.$transaction(async (tx) => {
    const assignment = await tx.ambulanceAssignment.findFirst({
      where: { id: assignmentId, driverId: context.driverProfileId },
    });

    if (!assignment) {
      throw ASSIGNMENT_NOT_FOUND_ERROR;
    }

    const rejected = await tx.ambulanceAssignment.updateMany({
      where: {
        id: assignmentId,
        driverId: context.driverProfileId,
        status: AmbulanceAssignmentStatus.OFFERED,
      },
      data: {
        status: AmbulanceAssignmentStatus.REJECTED,
        respondedAt: new Date(),
        rejectionReason,
      },
    });

    if (rejected.count === 0) {
      throw assignmentStatusConflict();
    }

    // Conditional releases: if maintenance or a newer workflow already moved either
    // resource on, this is a no-op rather than clobbering the newer state.
    await tx.ambulance.updateMany({
      where: { id: assignment.ambulanceId, status: AmbulanceStatus.OFFERED },
      data: { status: AmbulanceStatus.AVAILABLE },
    });

    await tx.driverProfile.updateMany({
      where: { id: context.driverProfileId, availabilityStatus: DriverAvailability.BUSY },
      data: { availabilityStatus: DriverAvailability.AVAILABLE },
    });

    return toSafeDriverAssignment(
      await tx.ambulanceAssignment.findUniqueOrThrow({
        where: { id: assignmentId },
        include: DRIVER_ASSIGNMENT_INCLUDE,
      }),
    );
  });
};
