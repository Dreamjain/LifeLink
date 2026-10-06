import {
  AmbulanceAssignmentStatus,
  BedReservationStatus,
  EmergencyStatus,
  HospitalResponseStatus,
  TransitionActorType,
} from '@prisma/client';
import { AppError } from '../../../common/errors/app-error.js';
import { logger } from '../../../config/logger.js';
import { prisma } from '../../../database/prisma.js';
import { transitionEmergency } from '../../hospitals/services/emergency-status.service.js';
import {
  autoAssignAmbulanceForReservedEmergency,
  MAX_DISPATCH_ATTEMPTS,
  type AutoAssignmentResult,
  type SafeHospitalAssignment,
} from './assignment.service.js';

/** What ended the previous attempt. Recorded in the SYSTEM history reason; never free text. */
export type DispatchRecoveryTrigger =
  'DRIVER_REJECTED' | 'TRIP_FAILED' | 'OFFER_TIMEOUT' | 'ACCEPTED_TIMEOUT';

export type DispatchRecoveryOutcome =
  /** A replacement offer was created; the emergency is PENDING_DRIVER_ACCEPTANCE again. */
  | 'REDISPATCHED'
  /** Back at BED_RESERVED, but no unused ambulance or driver was free (decision D8). */
  | 'NO_AVAILABLE_RESOURCES'
  /** MAX_DISPATCH_ATTEMPTS rows already exist: BED_RESERVED -> ESCALATED (decision D9). */
  | 'ESCALATED'
  /** No RESERVED bed for this emergency: recovery stopped without touching anything (D11). */
  | 'RESERVATION_MISSING'
  /** No ACCEPTED hospital response: there is no hospital to dispatch from. */
  | 'NO_ACCEPTED_RESPONSE'
  /** Another attempt is still live, e.g. a duplicate recovery call after a re-dispatch. */
  | 'DISPATCH_ALREADY_ACTIVE'
  /** The emergency is not in a failed-dispatch state (already recovered, escalated, etc.). */
  | 'NOT_RECOVERABLE'
  /** A concurrent recovery or dispatch won the conditional claim; this call changed nothing. */
  | 'RECOVERY_CONFLICT';

export interface DispatchRecoveryResult {
  emergencyId: string;
  trigger: DispatchRecoveryTrigger;
  outcome: DispatchRecoveryOutcome;
  /** AmbulanceAssignment rows for the emergency when recovery decided what to do. */
  attemptsUsed: number;
  assignment: SafeHospitalAssignment | null;
  /** Why the automatic re-dispatch found nothing, when outcome is NO_AVAILABLE_RESOURCES. */
  dispatchReason?: AutoAssignmentResult['reason'];
}

/**
 * Emergency states in which the dispatch that served the emergency has ended without delivering
 * the patient: an offer that was rejected or timed out (PENDING_DRIVER_ACCEPTANCE, which also
 * covers an accepted offer that never started), or a trip that failed under way (decision D1).
 */
const RECOVERABLE_STATUSES: EmergencyStatus[] = [
  EmergencyStatus.PENDING_DRIVER_ACCEPTANCE,
  EmergencyStatus.DRIVER_EN_ROUTE,
  EmergencyStatus.AT_PICKUP,
  EmergencyStatus.TRANSPORTING,
];

/** Assignment statuses that still hold an ambulance and a driver for the emergency. */
const LIVE_ASSIGNMENT_STATUSES: AmbulanceAssignmentStatus[] = [
  AmbulanceAssignmentStatus.OFFERED,
  AmbulanceAssignmentStatus.ACCEPTED,
  AmbulanceAssignmentStatus.EN_ROUTE,
  AmbulanceAssignmentStatus.AT_PICKUP,
  AmbulanceAssignmentStatus.TRANSPORTING,
];

const TRIGGER_DESCRIPTIONS: Record<DispatchRecoveryTrigger, string> = {
  DRIVER_REJECTED: 'the driver rejected the ambulance offer',
  TRIP_FAILED: 'the driver reported the trip as failed',
  OFFER_TIMEOUT: 'the driver did not answer the ambulance offer in time',
  ACCEPTED_TIMEOUT: 'the driver did not start the accepted trip in time',
};

/** Codes that mean another caller is already dispatching this emergency. */
const CONCURRENT_DISPATCH_CODES = new Set([
  'EMERGENCY_STATUS_CONFLICT',
  'ASSIGNMENT_CONFLICT',
  'DISPATCH_ATTEMPTS_EXHAUSTED',
  'EMERGENCY_NOT_FOUND',
]);

type PreparedRecovery =
  | { kind: 'stop'; outcome: DispatchRecoveryOutcome; attemptsUsed: number }
  | {
      kind: 'dispatch';
      hospitalId: string;
      attemptsUsed: number;
      excludeAmbulanceIds: string[];
      excludeDriverIds: string[];
    };

/**
 * Phase 1, one transaction: decide whether this emergency's dispatch can be recovered and, if so,
 * move it back to BED_RESERVED (or on to ESCALATED once every attempt is used).
 *
 * Lock order matches releaseReservation and admitEmergency — reservation first, then emergency —
 * so recovery cannot deadlock against either of them.
 */
const prepareRecovery = async (
  emergencyId: string,
  trigger: DispatchRecoveryTrigger,
): Promise<PreparedRecovery> =>
  prisma.$transaction(async (tx) => {
    const emergency = await tx.emergencyRequest.findUnique({
      where: { id: emergencyId },
      select: { id: true, currentStatus: true, updatedAt: true },
    });

    if (!emergency || !RECOVERABLE_STATUSES.includes(emergency.currentStatus)) {
      return { kind: 'stop', outcome: 'NOT_RECOVERABLE', attemptsUsed: 0 };
    }

    const response = await tx.hospitalResponse.findFirst({
      where: { emergencyId, status: HospitalResponseStatus.ACCEPTED },
      select: { id: true, hospitalId: true },
    });

    if (!response) {
      return { kind: 'stop', outcome: 'NO_ACCEPTED_RESPONSE', attemptsUsed: 0 };
    }

    const attempts = await tx.ambulanceAssignment.findMany({
      where: { emergencyId },
      select: { status: true, ambulanceId: true, driverId: true },
    });

    if (attempts.some((attempt) => LIVE_ASSIGNMENT_STATUSES.includes(attempt.status))) {
      return { kind: 'stop', outcome: 'DISPATCH_ALREADY_ACTIVE', attemptsUsed: attempts.length };
    }

    // Decision D11: without a RESERVED bed there is nothing to dispatch towards. The no-op
    // conditional update both proves the reservation is still active and holds its row lock
    // until commit, so a concurrent releaseReservation cannot slip in between this check and the
    // emergency transition below. Its status is written back unchanged (RESERVED).
    const reservationHeld = await tx.bedReservation.updateMany({
      where: {
        emergencyId,
        status: BedReservationStatus.RESERVED,
        hospitalResponse: { hospitalId: response.hospitalId },
      },
      data: { status: BedReservationStatus.RESERVED },
    });

    if (reservationHeld.count === 0) {
      return { kind: 'stop', outcome: 'RESERVATION_MISSING', attemptsUsed: attempts.length };
    }

    // The exact observed status, the observed updatedAt and "no live attempt" are all part of
    // one conditional claim. Two concurrent recoveries cannot both win it, and a recovery that
    // read the emergency before a re-dispatch cannot roll that re-dispatch back: the re-dispatch
    // changed updatedAt and created a live attempt, so the stale claim matches zero rows.
    const recovered = await transitionEmergency(tx, {
      emergencyId,
      from: emergency.currentStatus,
      to: EmergencyStatus.BED_RESERVED,
      actorType: TransitionActorType.SYSTEM,
      reason: `Dispatch recovery after attempt ${attempts.length}: ${TRIGGER_DESCRIPTIONS[trigger]}.`,
      guard: {
        updatedAt: emergency.updatedAt,
        ambulanceAssignments: { none: { status: { in: LIVE_ASSIGNMENT_STATUSES } } },
      },
    });

    if (!recovered) {
      return { kind: 'stop', outcome: 'RECOVERY_CONFLICT', attemptsUsed: attempts.length };
    }

    if (attempts.length >= MAX_DISPATCH_ATTEMPTS) {
      // Decision D9: every attempt is used. The reservation and the acceptance are kept; the
      // emergency leaves the automatic dispatch loop for human follow-up.
      const escalated = await transitionEmergency(tx, {
        emergencyId,
        from: EmergencyStatus.BED_RESERVED,
        to: EmergencyStatus.ESCALATED,
        actorType: TransitionActorType.SYSTEM,
        reason: `Dispatch attempts exhausted (${attempts.length} of ${MAX_DISPATCH_ATTEMPTS}).`,
      });

      if (!escalated) {
        throw new AppError(
          'EMERGENCY_STATUS_CONFLICT',
          'The emergency could not be escalated after its dispatch attempts were exhausted.',
          409,
        );
      }

      return { kind: 'stop', outcome: 'ESCALATED', attemptsUsed: attempts.length };
    }

    return {
      kind: 'dispatch',
      hospitalId: response.hospitalId,
      attemptsUsed: attempts.length,
      excludeAmbulanceIds: [...new Set(attempts.map((attempt) => attempt.ambulanceId))],
      excludeDriverIds: [...new Set(attempts.map((attempt) => attempt.driverId))],
    };
  });

/**
 * Recovers an emergency whose dispatch attempt has just ended without delivering the patient
 * (Task 1.24): a driver rejection, a failed trip, or a timed-out offer or accepted trip.
 *
 * Called only after the transaction that ended the attempt has committed (decision D7), so the
 * ended attempt can never be undone by anything here.
 *
 * Phase 1 (one transaction) returns the emergency to BED_RESERVED as SYSTEM, or escalates it when
 * MAX_DISPATCH_ATTEMPTS rows already exist. Phase 2 (after commit) re-dispatches through the
 * unchanged Task 1.21 automatic dispatch, excluding every ambulance and driver the emergency has
 * already used (decision D3). Phase 2 is a separate transaction for the same reason the 1.20/1.21
 * follow-ups are: finding no resources is a normal outcome that must not undo phase 1, and the
 * emergency then rests at BED_RESERVED for manual dispatch (decision D8).
 *
 * The hospital acceptance and the bed reservation are never changed (decisions D9, D11).
 *
 * Idempotent: a duplicate or concurrent call either loses the phase 1 claim, finds the emergency
 * no longer in a failed-dispatch state, or finds a live attempt — and changes nothing.
 */
export const recoverEmergencyDispatch = async (
  emergencyId: string,
  trigger: DispatchRecoveryTrigger,
): Promise<DispatchRecoveryResult> => {
  const prepared = await prepareRecovery(emergencyId, trigger);

  if (prepared.kind === 'stop') {
    const result: DispatchRecoveryResult = {
      emergencyId,
      trigger,
      outcome: prepared.outcome,
      attemptsUsed: prepared.attemptsUsed,
      assignment: null,
    };
    logRecovery(result);
    return result;
  }

  let result: DispatchRecoveryResult;

  try {
    const dispatch = await autoAssignAmbulanceForReservedEmergency(
      { hospitalId: prepared.hospitalId },
      emergencyId,
      null,
      {
        excludeAmbulanceIds: prepared.excludeAmbulanceIds,
        excludeDriverIds: prepared.excludeDriverIds,
      },
    );

    result = dispatch.assigned
      ? {
          emergencyId,
          trigger,
          outcome: 'REDISPATCHED',
          attemptsUsed: prepared.attemptsUsed,
          assignment: dispatch.assignment,
        }
      : {
          emergencyId,
          trigger,
          outcome: 'NO_AVAILABLE_RESOURCES',
          attemptsUsed: prepared.attemptsUsed,
          assignment: null,
          dispatchReason: dispatch.reason,
        };
  } catch (error) {
    // A manual dispatch (or another recovery) reached BED_RESERVED first. Its claim is the one
    // that counts; this call simply did not create a replacement.
    if (error instanceof AppError && CONCURRENT_DISPATCH_CODES.has(error.code)) {
      result = {
        emergencyId,
        trigger,
        outcome: 'RECOVERY_CONFLICT',
        attemptsUsed: prepared.attemptsUsed,
        assignment: null,
      };
    } else {
      throw error;
    }
  }

  logRecovery(result);
  return result;
};

const logRecovery = (result: DispatchRecoveryResult): void => {
  const payload = {
    emergencyId: result.emergencyId,
    trigger: result.trigger,
    outcome: result.outcome,
    attemptsUsed: result.attemptsUsed,
    assignmentId: result.assignment?.id,
    ambulanceId: result.assignment?.ambulanceId,
    driverId: result.assignment?.driverId,
    attemptNumber: result.assignment?.attemptNumber,
    dispatchReason: result.dispatchReason,
    action: 'dispatch-recovery',
  };

  if (result.outcome === 'RESERVATION_MISSING' || result.outcome === 'NO_ACCEPTED_RESPONSE') {
    logger.warn(payload, 'dispatch.recovery.conflict');
  } else if (result.outcome === 'ESCALATED') {
    logger.warn(payload, 'dispatch.recovery.escalated');
  } else {
    logger.info(payload, 'dispatch.recovery.completed');
  }
};

/**
 * Post-commit hook used by the reject, fail and timeout paths. Recovery is a follow-up: its
 * failure is logged and never surfaces to the caller whose own transaction already succeeded.
 */
export const runDispatchRecoverySafely = async (
  emergencyId: string,
  trigger: DispatchRecoveryTrigger,
): Promise<DispatchRecoveryResult | null> => {
  try {
    return await recoverEmergencyDispatch(emergencyId, trigger);
  } catch (error) {
    logger.error(
      { err: error, emergencyId, trigger, action: 'dispatch-recovery' },
      'dispatch.recovery.failed',
    );
    return null;
  }
};
