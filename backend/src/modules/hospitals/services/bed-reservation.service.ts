import {
  BedReservationStatus,
  BedStatus,
  EmergencyStatus,
  HospitalResponseStatus,
} from '@prisma/client';
import type { BedReservation } from '@prisma/client';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';
import {
  toSafeEmergency,
  type SafeEmergencySummary,
} from '../../../common/projections/emergency.projection.js';
import type { HospitalStaffContext } from '../types/hospital.types.js';
import { transitionEmergency } from './emergency-status.service.js';

export interface SafeBedReservation {
  id: string;
  emergencyId: string;
  hospitalResponseId: string;
  bedId: string;
  status: BedReservationStatus;
  reservedByUserId: string | null;
  reservedAt: Date;
  expiresAt: Date | null;
  releasedAt: Date | null;
  releaseReason: string | null;
}

const toSafeReservation = (reservation: BedReservation): SafeBedReservation => ({
  id: reservation.id,
  emergencyId: reservation.emergencyId,
  hospitalResponseId: reservation.hospitalResponseId,
  bedId: reservation.bedId,
  status: reservation.status,
  reservedByUserId: reservation.reservedByUserId,
  reservedAt: reservation.reservedAt,
  expiresAt: reservation.expiresAt,
  releasedAt: reservation.releasedAt,
  releaseReason: reservation.releaseReason,
});

const RESERVATION_NOT_FOUND_ERROR = new AppError(
  'RESERVATION_NOT_FOUND',
  'No bed reservation was found for this id.',
  404,
);

const RESPONSE_NOT_FOUND_ERROR = new AppError(
  'HOSPITAL_RESPONSE_NOT_FOUND',
  'No hospital response was found for this id.',
  404,
);

const BED_NOT_FOUND_ERROR = new AppError('BED_NOT_FOUND', 'No bed was found for this id.', 404);

/**
 * An emergency reaches a hospital only through an accepted HospitalResponse, so an emergency
 * this hospital never accepted is reported as not found rather than forbidden: existence is
 * never disclosed across hospitals (the Task 1.16 dispatch precedent).
 */
const EMERGENCY_NOT_FOUND_ERROR = new AppError(
  'EMERGENCY_NOT_FOUND',
  'No accepted emergency was found for this id.',
  404,
);

/** Reservations are scoped through their hospital response, which carries the hospitalId. */
const hospitalScoped = (context: HospitalStaffContext, reservationId: string) => ({
  id: reservationId,
  hospitalResponse: { hospitalId: context.hospitalId },
});

export const listReservations = async (
  context: HospitalStaffContext,
): Promise<SafeBedReservation[]> => {
  const reservations = await prisma.bedReservation.findMany({
    where: { hospitalResponse: { hospitalId: context.hospitalId } },
    orderBy: { reservedAt: 'desc' },
  });

  return reservations.map(toSafeReservation);
};

export const getReservation = async (
  context: HospitalStaffContext,
  reservationId: string,
): Promise<SafeBedReservation> => {
  const reservation = await prisma.bedReservation.findFirst({
    where: hospitalScoped(context, reservationId),
  });

  if (!reservation) {
    throw RESERVATION_NOT_FOUND_ERROR;
  }

  return toSafeReservation(reservation);
};

/**
 * Reserves a bed for an accepted hospital response. Bed claim, emergency transition,
 * status history and the reservation row are one atomic unit; both the bed claim and the
 * emergency transition are conditional updates, so concurrent callers cannot both win.
 */
export const createReservation = async (
  context: HospitalStaffContext,
  responseId: string,
  bedId: string,
  actorUserId: string,
): Promise<SafeBedReservation> => {
  return prisma.$transaction(async (tx) => {
    const response = await tx.hospitalResponse.findFirst({
      where: { id: responseId, hospitalId: context.hospitalId },
    });

    if (!response) {
      throw RESPONSE_NOT_FOUND_ERROR;
    }

    if (response.status !== HospitalResponseStatus.ACCEPTED) {
      throw new AppError(
        'HOSPITAL_RESPONSE_STATUS_CONFLICT',
        'This hospital response has not been accepted.',
        409,
      );
    }

    // Claiming the bed is the race guard: only one transaction can move it AVAILABLE -> RESERVED.
    const claimed = await tx.bed.updateMany({
      where: { id: bedId, hospitalId: context.hospitalId, status: BedStatus.AVAILABLE },
      data: { status: BedStatus.RESERVED },
    });

    if (claimed.count === 0) {
      const bed = await tx.bed.findFirst({
        where: { id: bedId, hospitalId: context.hospitalId },
        select: { id: true },
      });

      if (!bed) {
        throw BED_NOT_FOUND_ERROR;
      }

      throw new AppError('BED_UNAVAILABLE', 'This bed is not available for reservation.', 409);
    }

    // Moving the emergency HOSPITAL_ACCEPTED -> BED_RESERVED also enforces the active-reservation
    // invariant: a second reservation for the same emergency finds it no longer HOSPITAL_ACCEPTED.
    const moved = await transitionEmergency(tx, {
      emergencyId: response.emergencyId,
      from: EmergencyStatus.HOSPITAL_ACCEPTED,
      to: EmergencyStatus.BED_RESERVED,
      actorUserId,
    });

    if (!moved) {
      throw new AppError(
        'BED_RESERVATION_CONFLICT',
        'This emergency already has an active bed reservation or is no longer awaiting one.',
        409,
      );
    }

    const reservation = await tx.bedReservation.create({
      data: {
        emergencyId: response.emergencyId,
        hospitalResponseId: response.id,
        bedId,
        status: BedReservationStatus.RESERVED,
        reservedByUserId: actorUserId,
      },
    });

    return toSafeReservation(reservation);
  });
};

/**
 * How many available-bed candidates an automatic reservation will try before giving up.
 * Bounded on purpose: each miss means a concurrent caller won that bed, and an unbounded
 * loop would let one acceptance walk an entire ward under heavy contention.
 */
const AUTO_RESERVATION_MAX_ATTEMPTS = 3;

export interface AutoReservationResult {
  reserved: boolean;
  reservation: SafeBedReservation | null;
  /** Why no bed was held. Absent when `reserved` is true. */
  reason?: 'NO_AVAILABLE_BED' | 'CONTENTION_EXHAUSTED';
  attempts: number;
}

/**
 * Holds capacity automatically for a hospital response that has just been accepted
 * (Task 1.20).
 *
 * Bed choice is the oldest AVAILABLE bed belonging to the accepting hospital and nothing
 * else: no bed-type matching, because no EmergencyRequest field expresses a bed-type
 * requirement. The selected bed is only a candidate — `createReservation` below still
 * performs the conditional AVAILABLE -> RESERVED claim, which remains the sole authority on
 * who gets the bed. If a concurrent caller wins the candidate, the next-oldest bed is tried,
 * up to AUTO_RESERVATION_MAX_ATTEMPTS.
 *
 * Every attempt reuses `createReservation` unchanged, so the manual reservation endpoint and
 * this automatic path share one implementation of the domain rules, one transaction shape and
 * one set of concurrency guarantees.
 *
 * Finding no bed at all is a normal outcome, not an error: the caller keeps its acceptance and
 * the emergency stays HOSPITAL_ACCEPTED. No FAILED reservation row is invented, and retry or
 * escalation belongs to a later task.
 */
export const autoReserveBedForAcceptedResponse = async (
  context: HospitalStaffContext,
  responseId: string,
  actorUserId: string,
): Promise<AutoReservationResult> => {
  const triedBedIds: string[] = [];

  for (let attempt = 1; attempt <= AUTO_RESERVATION_MAX_ATTEMPTS; attempt += 1) {
    const candidate = await prisma.bed.findFirst({
      where: {
        hospitalId: context.hospitalId,
        status: BedStatus.AVAILABLE,
        ...(triedBedIds.length > 0 ? { id: { notIn: triedBedIds } } : {}),
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });

    if (!candidate) {
      return {
        reserved: false,
        reservation: null,
        reason: 'NO_AVAILABLE_BED',
        attempts: attempt - 1,
      };
    }

    triedBedIds.push(candidate.id);

    try {
      const reservation = await createReservation(context, responseId, candidate.id, actorUserId);
      return { reserved: true, reservation, attempts: attempt };
    } catch (error) {
      // BED_UNAVAILABLE means another caller claimed this candidate between selection and the
      // conditional claim, so the next-oldest bed is worth trying. Every other failure —
      // an unaccepted response, an emergency that already holds a reservation — would fail
      // identically on the next bed, so it is surfaced to the caller instead.
      if (error instanceof AppError && error.code === 'BED_UNAVAILABLE') {
        continue;
      }

      throw error;
    }
  }

  return {
    reserved: false,
    reservation: null,
    reason: 'CONTENTION_EXHAUSTED',
    attempts: AUTO_RESERVATION_MAX_ATTEMPTS,
  };
};

/**
 * Releases an active reservation, frees the bed, and returns the emergency to
 * HOSPITAL_ACCEPTED so another bed can be sought (DatabaseDesign.md §8).
 */
export const releaseReservation = async (
  context: HospitalStaffContext,
  reservationId: string,
  actorUserId: string,
  releaseReason?: string,
): Promise<SafeBedReservation> => {
  return prisma.$transaction(async (tx) => {
    const reservation = await tx.bedReservation.findFirst({
      where: hospitalScoped(context, reservationId),
    });

    if (!reservation) {
      throw RESERVATION_NOT_FOUND_ERROR;
    }

    const released = await tx.bedReservation.updateMany({
      where: { id: reservationId, status: BedReservationStatus.RESERVED },
      data: {
        status: BedReservationStatus.RELEASED,
        releasedAt: new Date(),
        releaseReason,
      },
    });

    if (released.count === 0) {
      throw new AppError(
        'RESERVATION_STATUS_CONFLICT',
        'Only an active reservation can be released.',
        409,
      );
    }

    await tx.bed.updateMany({
      where: {
        id: reservation.bedId,
        hospitalId: context.hospitalId,
        status: BedStatus.RESERVED,
      },
      data: { status: BedStatus.AVAILABLE },
    });

    // Conditional: if orchestration already advanced the emergency past BED_RESERVED,
    // this is a no-op rather than clobbering the newer state.
    await transitionEmergency(tx, {
      emergencyId: reservation.emergencyId,
      from: EmergencyStatus.BED_RESERVED,
      to: EmergencyStatus.HOSPITAL_ACCEPTED,
      actorUserId,
      reason: releaseReason,
    });

    return toSafeReservation(
      await tx.bedReservation.findUniqueOrThrow({ where: { id: reservationId } }),
    );
  });
};

export interface AdmissionResult {
  emergency: SafeEmergencySummary;
  reservation: SafeBedReservation;
}

/**
 * Resolves the accepting hospital response for an emergency, which is this hospital's proof of
 * scope. A client-supplied hospital id is never accepted; the id comes from the caller's
 * membership (AuthenticationDesign.md section 11).
 */
const requireAcceptedResponse = async (
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  context: HospitalStaffContext,
  emergencyId: string,
): Promise<{ id: string }> => {
  const response = await tx.hospitalResponse.findFirst({
    where: {
      emergencyId,
      hospitalId: context.hospitalId,
      status: HospitalResponseStatus.ACCEPTED,
    },
    select: { id: true },
  });

  if (!response) {
    throw EMERGENCY_NOT_FOUND_ERROR;
  }

  return response;
};

/**
 * Admits a patient who has arrived at the accepting hospital (Task 1.23).
 *
 * One transaction, three conditional claims, all of which must succeed: the reservation is
 * consumed, the bed it was holding becomes occupied, and the emergency moves
 * AT_HOSPITAL -> ADMITTED with its immutable history row. A failure anywhere rolls the whole
 * thing back, so a consumed reservation can never coexist with an unoccupied bed, and an
 * ADMITTED emergency can never coexist with a bed that is still merely reserved.
 *
 * Every claim names one EXACT expected status. A set predicate would be unsafe here: under
 * READ COMMITTED a blocked UPDATE re-evaluates its predicate against the row version the
 * winning transaction committed, so a range of acceptable states can re-match and let a second
 * caller succeed on top of the first (the defect Task 1.22 exposed). With exact predicates the
 * loser matches zero rows and reports the conflict.
 *
 * Bed occupation lives here rather than in the maintenance-only bed service, which states that
 * RESERVED/OCCUPIED belong to the reservation workflow.
 */
export const admitEmergency = async (
  context: HospitalStaffContext,
  emergencyId: string,
  actorUserId: string,
): Promise<AdmissionResult> => {
  return prisma.$transaction(async (tx) => {
    await requireAcceptedResponse(tx, context, emergencyId);

    // 1. The active reservation for this emergency, scoped through its hospital response.
    const reservation = await tx.bedReservation.findFirst({
      where: {
        emergencyId,
        hospitalResponse: { hospitalId: context.hospitalId },
        status: BedReservationStatus.RESERVED,
      },
    });

    if (!reservation) {
      // Distinguish "this emergency never held a reservation here" from "its reservation is no
      // longer active". Both probes are hospital-scoped, so neither discloses another hospital.
      const historic = await tx.bedReservation.findFirst({
        where: { emergencyId, hospitalResponse: { hospitalId: context.hospitalId } },
        select: { id: true },
      });

      if (!historic) {
        throw RESERVATION_NOT_FOUND_ERROR;
      }

      throw new AppError(
        'RESERVATION_STATUS_CONFLICT',
        'Only an active reservation can be consumed on admission.',
        409,
      );
    }

    // 2. Consume the reservation. This is the race guard for admission: only one transaction
    //    can move it RESERVED -> CONSUMED.
    const consumed = await tx.bedReservation.updateMany({
      where: { id: reservation.id, status: BedReservationStatus.RESERVED },
      data: { status: BedReservationStatus.CONSUMED },
    });

    if (consumed.count === 0) {
      throw new AppError(
        'RESERVATION_STATUS_CONFLICT',
        'Only an active reservation can be consumed on admission.',
        409,
      );
    }

    // 3. Occupy the bed it was holding. Ownership is part of the same conditional update, so
    //    another hospital's bed can never be occupied.
    const occupied = await tx.bed.updateMany({
      where: {
        id: reservation.bedId,
        hospitalId: context.hospitalId,
        status: BedStatus.RESERVED,
      },
      data: { status: BedStatus.OCCUPIED },
    });

    if (occupied.count === 0) {
      throw new AppError(
        'BED_STATUS_CONFLICT',
        'The reserved bed for this emergency is no longer held for it.',
        409,
      );
    }

    // 4. The emergency row is the single point of serialization for this emergency: two
    //    admissions cannot both move it out of AT_HOSPITAL.
    const admitted = await transitionEmergency(tx, {
      emergencyId,
      from: EmergencyStatus.AT_HOSPITAL,
      to: EmergencyStatus.ADMITTED,
      actorUserId,
    });

    if (!admitted) {
      throw new AppError(
        'EMERGENCY_STATUS_CONFLICT',
        'This emergency is not awaiting admission.',
        409,
      );
    }

    return {
      emergency: toSafeEmergency(
        await tx.emergencyRequest.findUniqueOrThrow({ where: { id: emergencyId } }),
      ),
      reservation: toSafeReservation(
        await tx.bedReservation.findUniqueOrThrow({ where: { id: reservation.id } }),
      ),
    };
  });
};

/**
 * Completes an admitted emergency (Task 1.23).
 *
 * A separate transaction from admission, and a separate decision: a hospital admits on arrival
 * and completes when care for this emergency is finished. ADMITTED is the only accepted source
 * state, so AT_HOSPITAL can never skip straight to COMPLETED.
 *
 * completedAt is written by the same conditional update that moves the status, through
 * transitionEmergency's `fields` (the Task 1.17 cancelledAt precedent). A second write would
 * allow the timestamp to be stamped without the status moving, or stamped twice by a losing
 * concurrent caller. cancelledAt and expiresAt are untouched.
 *
 * No resource is released here: the bed stays OCCUPIED and the reservation stays CONSUMED.
 * Discharge is not part of this task.
 */
export const completeEmergency = async (
  context: HospitalStaffContext,
  emergencyId: string,
  actorUserId: string,
): Promise<SafeEmergencySummary> => {
  return prisma.$transaction(async (tx) => {
    await requireAcceptedResponse(tx, context, emergencyId);

    const completed = await transitionEmergency(tx, {
      emergencyId,
      from: EmergencyStatus.ADMITTED,
      to: EmergencyStatus.COMPLETED,
      actorUserId,
      fields: { completedAt: new Date() },
    });

    if (!completed) {
      throw new AppError(
        'EMERGENCY_STATUS_CONFLICT',
        'Only an admitted emergency can be completed.',
        409,
      );
    }

    return toSafeEmergency(
      await tx.emergencyRequest.findUniqueOrThrow({ where: { id: emergencyId } }),
    );
  });
};
