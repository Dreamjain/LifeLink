import {
  BedReservationStatus,
  BedStatus,
  EmergencyStatus,
  HospitalResponseStatus,
} from '@prisma/client';
import type { BedReservation } from '@prisma/client';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';
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
