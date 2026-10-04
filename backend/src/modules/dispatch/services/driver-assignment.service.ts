import {
  AmbulanceAssignmentStatus,
  AmbulanceStatus,
  DriverAvailability,
  EmergencyStatus,
  TransitionActorType,
} from '@prisma/client';
import type { Ambulance, AmbulanceAssignment, EmergencyRequest, Hospital } from '@prisma/client';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';
import {
  toSafeEmergency,
  type SafeEmergencySummary,
} from '../../../common/projections/emergency.projection.js';
import { transitionEmergency } from '../../hospitals/services/emergency-status.service.js';
import type { TripAction } from '../schemas/assignment.schema.js';
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

/**
 * One row of the driver-trip state machine (Task 1.22).
 *
 * Every field is a conditional claim, never a blind write: the assignment move, the emergency
 * move and each resource move all name the exact state they expect to find, so a stale or
 * repeated request matches zero rows and the whole transaction rolls back.
 */
interface TripTransition {
  assignmentFrom: AmbulanceAssignmentStatus;
  assignmentTo: AmbulanceAssignmentStatus;
  emergencyFrom: EmergencyStatus;
  emergencyTo: EmergencyStatus;
  /** Vehicle move this step performs, when the step changes where the vehicle stands. */
  ambulance?: { from: AmbulanceStatus; to: AmbulanceStatus };
  /** Availability the driver returns to, when the step ends their involvement. */
  driverTo?: DriverAvailability;
  /** Timestamp column this step stamps. Each is stamped by exactly one action. */
  stamp?: 'startedAt' | 'endedAt';
}

/**
 * The driver's leg of the journey, from a committed offer to arrival at the hospital.
 *
 * ARRIVE_HOSPITAL completes the ASSIGNMENT, not the emergency: the dispatch is over, the
 * vehicle and the driver go back to the pool, and the emergency rests at AT_HOSPITAL for
 * admission and completion, which belong to a later task. Nothing here touches the bed
 * reservation, and no retry, escalation or expiry is implied by any outcome.
 */
const TRIP_TRANSITIONS: Record<TripAction, TripTransition> = {
  START: {
    assignmentFrom: AmbulanceAssignmentStatus.ACCEPTED,
    assignmentTo: AmbulanceAssignmentStatus.EN_ROUTE,
    emergencyFrom: EmergencyStatus.PENDING_DRIVER_ACCEPTANCE,
    emergencyTo: EmergencyStatus.DRIVER_EN_ROUTE,
    ambulance: { from: AmbulanceStatus.ASSIGNED, to: AmbulanceStatus.EN_ROUTE },
    stamp: 'startedAt',
  },
  ARRIVE_PICKUP: {
    assignmentFrom: AmbulanceAssignmentStatus.EN_ROUTE,
    assignmentTo: AmbulanceAssignmentStatus.AT_PICKUP,
    emergencyFrom: EmergencyStatus.DRIVER_EN_ROUTE,
    emergencyTo: EmergencyStatus.AT_PICKUP,
  },
  START_TRANSPORT: {
    assignmentFrom: AmbulanceAssignmentStatus.AT_PICKUP,
    assignmentTo: AmbulanceAssignmentStatus.TRANSPORTING,
    emergencyFrom: EmergencyStatus.AT_PICKUP,
    emergencyTo: EmergencyStatus.TRANSPORTING,
  },
  ARRIVE_HOSPITAL: {
    assignmentFrom: AmbulanceAssignmentStatus.TRANSPORTING,
    assignmentTo: AmbulanceAssignmentStatus.COMPLETED,
    emergencyFrom: EmergencyStatus.TRANSPORTING,
    emergencyTo: EmergencyStatus.AT_HOSPITAL,
    ambulance: { from: AmbulanceStatus.EN_ROUTE, to: AmbulanceStatus.AVAILABLE },
    driverTo: DriverAvailability.AVAILABLE,
    stamp: 'endedAt',
  },
};

/** A trip may only be abandoned once it is under way. */
const FAILABLE_STATUSES: AmbulanceAssignmentStatus[] = [
  AmbulanceAssignmentStatus.EN_ROUTE,
  AmbulanceAssignmentStatus.AT_PICKUP,
  AmbulanceAssignmentStatus.TRANSPORTING,
];

const tripStatusConflict = (): AppError =>
  new AppError(
    'ASSIGNMENT_STATUS_CONFLICT',
    'This assignment is not in a state that allows this trip action.',
    409,
  );

const stampFor = (transition: TripTransition): { startedAt?: Date } & { endedAt?: Date } => {
  if (transition.stamp === 'startedAt') return { startedAt: new Date() };
  if (transition.stamp === 'endedAt') return { endedAt: new Date() };
  return {};
};

/**
 * Advances the driver's own trip by one step (Task 1.22).
 *
 * Ownership is part of every write predicate, and each step is a single transaction containing
 * the assignment claim, the vehicle and driver moves the step implies, and the emergency
 * transition with its immutable history row. Every one of those is conditional on the exact
 * state it expects, so a duplicate or out-of-order request mutates nothing and reports 409, and
 * two concurrent actions on the same assignment serialize through the assignment row.
 *
 * Resource moves are fatal rather than best-effort: a trip step that could not move the vehicle
 * it claims to be driving is not a trip step, and leaving the assignment advanced while the
 * vehicle lags behind would be exactly the partial state this transaction exists to prevent.
 *
 * The emergency transition carries actorType DRIVER and the driver's authenticated User id —
 * not their DriverProfile id, which is a resource identifier and not an actor.
 */
export const transitionOwnAssignment = async (
  userId: string,
  assignmentId: string,
  action: TripAction,
): Promise<SafeDriverAssignment> => {
  const context = await resolveDriverContext(userId);
  const transition = TRIP_TRANSITIONS[action];

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
        status: transition.assignmentFrom,
      },
      data: { status: transition.assignmentTo, ...stampFor(transition) },
    });

    if (claimed.count === 0) {
      throw tripStatusConflict();
    }

    if (transition.ambulance) {
      const moved = await tx.ambulance.updateMany({
        where: { id: assignment.ambulanceId, status: transition.ambulance.from },
        data: { status: transition.ambulance.to },
      });

      if (moved.count === 0) {
        throw new AppError(
          'AMBULANCE_STATUS_CONFLICT',
          'The ambulance for this assignment is not in the expected state for this trip action.',
          409,
        );
      }
    }

    if (transition.driverTo) {
      const released = await tx.driverProfile.updateMany({
        where: { id: context.driverProfileId, availabilityStatus: DriverAvailability.BUSY },
        data: { availabilityStatus: transition.driverTo },
      });

      if (released.count === 0) {
        throw new AppError(
          'DRIVER_STATUS_CONFLICT',
          'Your availability is not in the expected state for this trip action.',
          409,
        );
      }
    }

    const advanced = await transitionEmergency(tx, {
      emergencyId: assignment.emergencyId,
      from: transition.emergencyFrom,
      to: transition.emergencyTo,
      actorUserId: context.userId,
      actorType: TransitionActorType.DRIVER,
    });

    if (!advanced) {
      throw new AppError(
        'EMERGENCY_STATUS_CONFLICT',
        'This emergency is not in the expected state for this trip action.',
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
 * Abandons a trip that is already under way (Task 1.22).
 *
 * The row is kept as the historical attempt with its reason, stored in the existing
 * rejectionReason column — the schema's single free-text field for a driver or operational
 * explanation. The vehicle and the driver are released so they can be dispatched again.
 *
 * The emergency is deliberately NOT transitioned: no EmergencyStatus represents a failed
 * transport, and whether to re-dispatch, escalate or expire after a failure is an
 * emergency-level policy decision (DatabaseDesign.md section 8) that belongs to the
 * orchestration layer, not to one driver's answer. The bed reservation is left untouched for
 * the same reason; releasing it is the hospital's existing explicit action.
 */
export const failOwnAssignment = async (
  userId: string,
  assignmentId: string,
  failureReason: string,
): Promise<SafeDriverAssignment> => {
  const context = await resolveDriverContext(userId);

  return prisma.$transaction(async (tx) => {
    const assignment = await tx.ambulanceAssignment.findFirst({
      where: { id: assignmentId, driverId: context.driverProfileId },
    });

    if (!assignment) {
      throw ASSIGNMENT_NOT_FOUND_ERROR;
    }

    if (!FAILABLE_STATUSES.includes(assignment.status)) {
      throw tripStatusConflict();
    }

    // The claim names the exact status observed in this transaction, never the failable set.
    // Under READ COMMITTED a waiting UPDATE re-evaluates its predicate against the new row
    // version once the transaction holding the lock commits, so a set predicate would still
    // match a concurrent move into another failable status (ARRIVE_PICKUP -> AT_PICKUP,
    // START_TRANSPORT -> TRANSPORTING) and both callers would succeed. An exact predicate
    // cannot re-match, so the loser sees zero rows and reports the conflict.
    const failed = await tx.ambulanceAssignment.updateMany({
      where: {
        id: assignmentId,
        driverId: context.driverProfileId,
        status: assignment.status,
      },
      data: {
        status: AmbulanceAssignmentStatus.FAILED,
        endedAt: new Date(),
        rejectionReason: failureReason,
      },
    });

    if (failed.count === 0) {
      throw tripStatusConflict();
    }

    // Every failable status is reached through START, which moved the vehicle to EN_ROUTE, so
    // this is a required claim rather than a best-effort release.
    const releasedAmbulance = await tx.ambulance.updateMany({
      where: { id: assignment.ambulanceId, status: AmbulanceStatus.EN_ROUTE },
      data: { status: AmbulanceStatus.AVAILABLE },
    });

    if (releasedAmbulance.count === 0) {
      throw new AppError(
        'AMBULANCE_STATUS_CONFLICT',
        'The ambulance for this assignment is not in the expected state for this trip action.',
        409,
      );
    }

    const releasedDriver = await tx.driverProfile.updateMany({
      where: { id: context.driverProfileId, availabilityStatus: DriverAvailability.BUSY },
      data: { availabilityStatus: DriverAvailability.AVAILABLE },
    });

    if (releasedDriver.count === 0) {
      throw new AppError(
        'DRIVER_STATUS_CONFLICT',
        'Your availability is not in the expected state for this trip action.',
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
