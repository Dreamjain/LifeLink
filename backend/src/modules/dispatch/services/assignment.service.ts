import {
  AmbulanceAssignmentStatus,
  AmbulanceStatus,
  DriverAvailability,
  EmergencyStatus,
  HospitalResponseStatus,
  Prisma,
  UserStatus,
  VerificationStatus,
} from '@prisma/client';
import type { Ambulance, AmbulanceAssignment, EmergencyRequest } from '@prisma/client';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { HospitalStaffContext } from '../../hospitals/types/hospital.types.js';
import { transitionEmergency } from '../../hospitals/services/emergency-status.service.js';
import {
  toSafeEmergency,
  type SafeEmergencySummary,
} from '../../hospitals/services/hospital-response.service.js';
import type { CreateAssignmentInput } from '../schemas/assignment.schema.js';

/**
 * Operational view of the dispatched vehicle. Carries no hospital-internal maintenance
 * detail beyond the status a dispatcher needs to read the offer.
 */
export interface SafeAssignmentAmbulance {
  id: string;
  vehicleNumber: string;
  ambulanceType: Ambulance['ambulanceType'];
  status: AmbulanceStatus;
}

/**
 * Dispatch view of an assignment. The emergency is projected through the Task 1.15
 * privacy mapper, so no PatientProfile field is ever reachable from this surface
 * (DatabaseDesign.md section 9). The driver is identified by profile id only: the
 * dispatcher needs to address the offer, not the driver's personal details.
 */
export interface SafeHospitalAssignment {
  id: string;
  emergencyId: string;
  hospitalResponseId: string;
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
}

type AssignmentWithRelations = AmbulanceAssignment & {
  emergency: EmergencyRequest;
  ambulance: Ambulance;
};

export const toSafeAssignmentAmbulance = (ambulance: Ambulance): SafeAssignmentAmbulance => ({
  id: ambulance.id,
  vehicleNumber: ambulance.vehicleNumber,
  ambulanceType: ambulance.ambulanceType,
  status: ambulance.status,
});

const toSafeHospitalAssignment = (assignment: AssignmentWithRelations): SafeHospitalAssignment => ({
  id: assignment.id,
  emergencyId: assignment.emergencyId,
  hospitalResponseId: assignment.hospitalResponseId,
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
});

const ASSIGNMENT_NOT_FOUND_ERROR = new AppError(
  'ASSIGNMENT_NOT_FOUND',
  'No ambulance assignment was found for this id.',
  404,
);

/**
 * An emergency reaches a hospital only through an accepted HospitalResponse, so an
 * emergency this hospital never accepted is reported as not found rather than
 * forbidden: existence is not disclosed across hospitals.
 */
const EMERGENCY_NOT_FOUND_ERROR = new AppError(
  'EMERGENCY_NOT_FOUND',
  'No accepted emergency was found for this id.',
  404,
);

const AMBULANCE_NOT_FOUND_ERROR = new AppError(
  'AMBULANCE_NOT_FOUND',
  'No ambulance was found for this id.',
  404,
);

const DRIVER_NOT_FOUND_ERROR = new AppError(
  'DRIVER_NOT_FOUND',
  'No driver profile was found for this id.',
  404,
);

/** Assignments are scoped through their hospital response, which carries the hospitalId. */
const hospitalScope = (context: HospitalStaffContext) => ({
  hospitalResponse: { hospitalId: context.hospitalId },
});

export const listAssignments = async (
  context: HospitalStaffContext,
): Promise<SafeHospitalAssignment[]> => {
  const assignments = await prisma.ambulanceAssignment.findMany({
    where: hospitalScope(context),
    orderBy: { assignedAt: 'desc' },
    include: { emergency: true, ambulance: true },
  });

  return assignments.map(toSafeHospitalAssignment);
};

export const getAssignment = async (
  context: HospitalStaffContext,
  assignmentId: string,
): Promise<SafeHospitalAssignment> => {
  const assignment = await prisma.ambulanceAssignment.findFirst({
    where: { id: assignmentId, ...hospitalScope(context) },
    include: { emergency: true, ambulance: true },
  });

  if (!assignment) {
    throw ASSIGNMENT_NOT_FOUND_ERROR;
  }

  return toSafeHospitalAssignment(assignment);
};

/**
 * Offers an ambulance and driver for an emergency this hospital has already accepted
 * and reserved a bed for.
 *
 * Concurrency is handled by conditional claims rather than pre-checks: the ambulance
 * moves AVAILABLE -> OFFERED and the driver AVAILABLE -> BUSY inside the transaction,
 * so a competing dispatcher's claim matches zero rows and the whole transaction rolls
 * back. The emergency transition serializes competing dispatches for the same emergency,
 * and the (emergencyId, attemptNumber) unique constraint is the final backstop.
 *
 * Operational claim states (OFFERED/ASSIGNED/BUSY) are deliberately distinct from the
 * Task 1.14 maintenance workflow (AVAILABLE <-> OUT_OF_SERVICE / INACTIVE), which only
 * ever transitions from AVAILABLE and therefore cannot touch a committed vehicle.
 */
export const createAssignment = async (
  context: HospitalStaffContext,
  emergencyId: string,
  input: CreateAssignmentInput,
  actorUserId: string,
): Promise<SafeHospitalAssignment> => {
  try {
    return await prisma.$transaction(async (tx) => {
      // 1. The accepted response is both the hospital-scope proof and the assignment's parent.
      const response = await tx.hospitalResponse.findFirst({
        where: {
          emergencyId,
          hospitalId: context.hospitalId,
          status: HospitalResponseStatus.ACCEPTED,
        },
      });

      if (!response) {
        throw EMERGENCY_NOT_FOUND_ERROR;
      }

      // 2. Claim the ambulance. Ownership is part of the same conditional update, so
      //    another hospital's vehicle can never be claimed.
      const ambulanceClaimed = await tx.ambulance.updateMany({
        where: {
          id: input.ambulanceId,
          hospitalId: context.hospitalId,
          status: AmbulanceStatus.AVAILABLE,
        },
        data: { status: AmbulanceStatus.OFFERED },
      });

      if (ambulanceClaimed.count === 0) {
        const owned = await tx.ambulance.findFirst({
          where: { id: input.ambulanceId, hospitalId: context.hospitalId },
          select: { id: true },
        });

        if (!owned) {
          throw AMBULANCE_NOT_FOUND_ERROR;
        }

        throw new AppError(
          'AMBULANCE_UNAVAILABLE',
          'This ambulance is not available for dispatch.',
          409,
        );
      }

      // 3. Claim the driver. Verification, account state and availability are all part
      //    of the conditional update, so none of them can change between check and write.
      const driverClaimed = await tx.driverProfile.updateMany({
        where: {
          id: input.driverId,
          verificationStatus: VerificationStatus.VERIFIED,
          availabilityStatus: DriverAvailability.AVAILABLE,
          user: { status: UserStatus.ACTIVE },
        },
        data: { availabilityStatus: DriverAvailability.BUSY },
      });

      if (driverClaimed.count === 0) {
        const exists = await tx.driverProfile.findUnique({
          where: { id: input.driverId },
          select: { id: true },
        });

        if (!exists) {
          throw DRIVER_NOT_FOUND_ERROR;
        }

        throw new AppError(
          'DRIVER_UNAVAILABLE',
          'This driver is not verified, active, and available for dispatch.',
          409,
        );
      }

      // 4. Attempts are never overwritten; each dispatch is a new numbered attempt.
      const attemptNumber = (await tx.ambulanceAssignment.count({ where: { emergencyId } })) + 1;

      const assignment = await tx.ambulanceAssignment.create({
        data: {
          emergencyId,
          hospitalResponseId: response.id,
          ambulanceId: input.ambulanceId,
          driverId: input.driverId,
          attemptNumber,
          status: AmbulanceAssignmentStatus.OFFERED,
        },
      });

      // 5. The emergency row is the single point of serialization for this emergency:
      //    two dispatchers cannot both move it out of BED_RESERVED.
      const assigned = await transitionEmergency(tx, {
        emergencyId,
        from: EmergencyStatus.BED_RESERVED,
        to: EmergencyStatus.AMBULANCE_ASSIGNED,
        actorUserId,
      });

      if (!assigned) {
        throw new AppError(
          'EMERGENCY_STATUS_CONFLICT',
          'This emergency is not awaiting ambulance assignment.',
          409,
        );
      }

      // The offer is outstanding until the driver answers, so the emergency rests in
      // PENDING_DRIVER_ACCEPTANCE rather than AMBULANCE_ASSIGNED.
      const pending = await transitionEmergency(tx, {
        emergencyId,
        from: EmergencyStatus.AMBULANCE_ASSIGNED,
        to: EmergencyStatus.PENDING_DRIVER_ACCEPTANCE,
        actorUserId,
      });

      if (!pending) {
        throw new AppError(
          'EMERGENCY_STATUS_CONFLICT',
          'This emergency is not awaiting ambulance assignment.',
          409,
        );
      }

      return toSafeHospitalAssignment(
        await tx.ambulanceAssignment.findUniqueOrThrow({
          where: { id: assignment.id },
          include: { emergency: true, ambulance: true },
        }),
      );
    });
  } catch (error) {
    // Backstop for the (emergencyId, attemptNumber) unique constraint when two
    // dispatches for the same emergency compute the same attempt number.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new AppError(
        'ASSIGNMENT_CONFLICT',
        'Another dispatch attempt for this emergency is already in progress.',
        409,
      );
    }

    throw error;
  }
};
