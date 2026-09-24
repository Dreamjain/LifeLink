import { EmergencyStatus, HospitalResponseStatus } from '@prisma/client';
import type { EmergencyRequest, HospitalResponse } from '@prisma/client';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';
import type { HospitalStaffContext } from '../types/hospital.types.js';
import { transitionEmergency } from './emergency-status.service.js';

/**
 * Operational subset of the emergency a hospital needs to decide and prepare.
 * Deliberately excludes every PatientProfile field (allergies, medicalSummary, identity)
 * per DatabaseDesign.md §9 and the Task 1.11 privacy precedent.
 */
export interface SafeEmergencySummary {
  id: string;
  requestType: EmergencyRequest['requestType'];
  severity: EmergencyRequest['severity'];
  currentStatus: EmergencyStatus;
  description: string | null;
  pickupAddress: string | null;
  pickupLatitude: string | null;
  pickupLongitude: string | null;
  createdAt: Date;
}

export interface SafeHospitalResponse {
  id: string;
  emergencyId: string;
  hospitalId: string;
  attemptNumber: number;
  status: HospitalResponseStatus;
  rank: number | null;
  estimatedDistanceKm: string | null;
  responseByUserId: string | null;
  rejectionReason: string | null;
  offeredAt: Date;
  respondedAt: Date | null;
  expiresAt: Date | null;
  emergency: SafeEmergencySummary;
}

type ResponseWithEmergency = HospitalResponse & { emergency: EmergencyRequest };

export const toSafeEmergency = (emergency: EmergencyRequest): SafeEmergencySummary => ({
  id: emergency.id,
  requestType: emergency.requestType,
  severity: emergency.severity,
  currentStatus: emergency.currentStatus,
  description: emergency.description,
  pickupAddress: emergency.pickupAddress,
  pickupLatitude: emergency.pickupLatitude?.toString() ?? null,
  pickupLongitude: emergency.pickupLongitude?.toString() ?? null,
  createdAt: emergency.createdAt,
});

const toSafeResponse = (response: ResponseWithEmergency): SafeHospitalResponse => ({
  id: response.id,
  emergencyId: response.emergencyId,
  hospitalId: response.hospitalId,
  attemptNumber: response.attemptNumber,
  status: response.status,
  rank: response.rank,
  estimatedDistanceKm: response.estimatedDistanceKm?.toString() ?? null,
  responseByUserId: response.responseByUserId,
  rejectionReason: response.rejectionReason,
  offeredAt: response.offeredAt,
  respondedAt: response.respondedAt,
  expiresAt: response.expiresAt,
  emergency: toSafeEmergency(response.emergency),
});

const RESPONSE_NOT_FOUND_ERROR = new AppError(
  'HOSPITAL_RESPONSE_NOT_FOUND',
  'No hospital response was found for this id.',
  404,
);

const responseStatusConflict = (): AppError =>
  new AppError(
    'HOSPITAL_RESPONSE_STATUS_CONFLICT',
    'This hospital response has already been decided.',
    409,
  );

export const listResponses = async (
  context: HospitalStaffContext,
): Promise<SafeHospitalResponse[]> => {
  const responses = await prisma.hospitalResponse.findMany({
    where: { hospitalId: context.hospitalId },
    orderBy: { offeredAt: 'desc' },
    include: { emergency: true },
  });

  return responses.map(toSafeResponse);
};

export const getResponse = async (
  context: HospitalStaffContext,
  responseId: string,
): Promise<SafeHospitalResponse> => {
  const response = await prisma.hospitalResponse.findFirst({
    where: { id: responseId, hospitalId: context.hospitalId },
    include: { emergency: true },
  });

  if (!response) {
    throw RESPONSE_NOT_FOUND_ERROR;
  }

  return toSafeResponse(response);
};

export const acceptResponse = async (
  context: HospitalStaffContext,
  responseId: string,
  actorUserId: string,
): Promise<SafeHospitalResponse> => {
  return prisma.$transaction(async (tx) => {
    const response = await tx.hospitalResponse.findFirst({
      where: { id: responseId, hospitalId: context.hospitalId },
    });

    if (!response) {
      throw RESPONSE_NOT_FOUND_ERROR;
    }

    const claimed = await tx.hospitalResponse.updateMany({
      where: {
        id: responseId,
        hospitalId: context.hospitalId,
        status: HospitalResponseStatus.PENDING,
      },
      data: {
        status: HospitalResponseStatus.ACCEPTED,
        respondedAt: new Date(),
        responseByUserId: actorUserId,
      },
    });

    if (claimed.count === 0) {
      throw responseStatusConflict();
    }

    // The emergency row is the single point of serialization: only one hospital can move it
    // out of PENDING_HOSPITAL_RESPONSE, so competing acceptances cannot both win.
    const moved = await transitionEmergency(tx, {
      emergencyId: response.emergencyId,
      from: EmergencyStatus.PENDING_HOSPITAL_RESPONSE,
      to: EmergencyStatus.HOSPITAL_ACCEPTED,
      actorUserId,
    });

    if (!moved) {
      throw new AppError(
        'EMERGENCY_STATUS_CONFLICT',
        'This emergency is no longer awaiting a hospital response.',
        409,
      );
    }

    // The emergency is now committed to this hospital, so every other offer still awaiting an
    // answer is withdrawn by the system in this same transaction: a losing hospital must not
    // keep a live offer for an emergency that is already placed.
    //
    // The update is conditional on PENDING, so a hospital that already rejected — or that was
    // already withdrawn — is never overwritten, and it excludes the accepted response itself.
    // responseByUserId, rejectionReason and respondedAt are deliberately left null: nobody at
    // those hospitals made a decision, and the withdrawal is not their rejection.
    //
    // No EmergencyStatusHistory row is written here. That table records EmergencyRequest
    // transitions, and the emergency makes exactly one transition during an acceptance; the
    // HospitalResponse rows are themselves the audit trail for each offer's outcome.
    await tx.hospitalResponse.updateMany({
      where: {
        emergencyId: response.emergencyId,
        id: { not: responseId },
        status: HospitalResponseStatus.PENDING,
      },
      data: { status: HospitalResponseStatus.WITHDRAWN },
    });

    return toSafeResponse(
      await tx.hospitalResponse.findUniqueOrThrow({
        where: { id: responseId },
        include: { emergency: true },
      }),
    );
  });
};

/**
 * Rejection is deliberately response-local. Deciding the emergency-level outcome after a
 * rejection requires knowing about every other hospital's response ("All hospitals reject →
 * append ESCALATED or EXPIRED", DatabaseDesign.md §8), which belongs to the orchestration
 * layer, not to a single hospital's decision.
 */
export const rejectResponse = async (
  context: HospitalStaffContext,
  responseId: string,
  actorUserId: string,
  rejectionReason: string,
): Promise<SafeHospitalResponse> => {
  const rejected = await prisma.hospitalResponse.updateMany({
    where: {
      id: responseId,
      hospitalId: context.hospitalId,
      status: HospitalResponseStatus.PENDING,
    },
    data: {
      status: HospitalResponseStatus.REJECTED,
      respondedAt: new Date(),
      responseByUserId: actorUserId,
      rejectionReason,
    },
  });

  if (rejected.count === 0) {
    const existing = await prisma.hospitalResponse.findFirst({
      where: { id: responseId, hospitalId: context.hospitalId },
      select: { id: true },
    });

    if (!existing) {
      throw RESPONSE_NOT_FOUND_ERROR;
    }

    throw responseStatusConflict();
  }

  return toSafeResponse(
    await prisma.hospitalResponse.findUniqueOrThrow({
      where: { id: responseId },
      include: { emergency: true },
    }),
  );
};
