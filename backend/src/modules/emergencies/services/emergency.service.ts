import { EmergencyStatus, Prisma, TransitionActorType } from '@prisma/client';
import type { EmergencyRequest } from '@prisma/client';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';
import { transitionEmergency } from '../../hospitals/services/emergency-status.service.js';
import type { CreateEmergencyInput } from '../schemas/emergency.schema.js';
import type { PatientContext } from '../types/emergency.types.js';

/**
 * Patient-facing view of their own emergency. Deliberately separate from Task 1.15's
 * `SafeEmergencySummary`, which Tasks 1.15/1.16 depend on and must not change.
 *
 * `patientId` and `idempotencyKey` are internal and never leave the service: the patient
 * already knows who they are, and the stored key is a server-namespaced value. Hospital,
 * ambulance and driver context is absent because none of it exists at CREATED.
 */
export interface SafePatientEmergency {
  id: string;
  requestType: EmergencyRequest['requestType'];
  severity: EmergencyRequest['severity'];
  currentStatus: EmergencyStatus;
  description: string | null;
  pickupAddress: string | null;
  pickupLatitude: string | null;
  pickupLongitude: string | null;
  createdAt: Date;
  updatedAt: Date;
  cancelledAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date | null;
}

export interface CreateEmergencyResult {
  emergency: SafePatientEmergency;
  /** True when an existing emergency was replayed for this idempotency key. */
  idempotentReplay: boolean;
}

const toSafePatientEmergency = (emergency: EmergencyRequest): SafePatientEmergency => ({
  id: emergency.id,
  requestType: emergency.requestType,
  severity: emergency.severity,
  currentStatus: emergency.currentStatus,
  description: emergency.description,
  pickupAddress: emergency.pickupAddress,
  pickupLatitude: emergency.pickupLatitude?.toString() ?? null,
  pickupLongitude: emergency.pickupLongitude?.toString() ?? null,
  createdAt: emergency.createdAt,
  updatedAt: emergency.updatedAt,
  cancelledAt: emergency.cancelledAt,
  completedAt: emergency.completedAt,
  expiresAt: emergency.expiresAt,
});

/**
 * Another patient's emergency is reported as not found rather than forbidden, matching the
 * repository's uniform cross-scope behaviour: existence is never disclosed.
 */
const EMERGENCY_NOT_FOUND_ERROR = new AppError(
  'EMERGENCY_NOT_FOUND',
  'No emergency was found for this id.',
  404,
);

const PATIENT_PROFILE_REQUIRED_ERROR = new AppError(
  'PATIENT_PROFILE_REQUIRED',
  'Complete your patient profile before raising an emergency.',
  409,
);

/**
 * Resolves the caller's patient scope from their own authenticated user id.
 * A client-supplied patient id is never accepted (AuthenticationDesign.md section 13).
 */
export const resolvePatientContext = async (userId: string): Promise<PatientContext> => {
  const profile = await prisma.patientProfile.findUnique({
    where: { userId },
    select: { id: true, userId: true },
  });

  if (!profile) {
    throw PATIENT_PROFILE_REQUIRED_ERROR;
  }

  return { patientProfileId: profile.id, userId: profile.userId };
};

/**
 * The stored key is namespaced with the patient's profile id so that the schema's global
 * unique constraint behaves as a per-patient constraint. Two different patients may send
 * the same client key without colliding, and neither can replay the other's emergency.
 */
export const namespaceIdempotencyKey = (patientProfileId: string, clientKey: string): string =>
  `${patientProfileId}:${clientKey}`;

export const listOwnEmergencies = async (userId: string): Promise<SafePatientEmergency[]> => {
  const context = await resolvePatientContext(userId);

  const emergencies = await prisma.emergencyRequest.findMany({
    where: { patientId: context.patientProfileId },
    orderBy: { createdAt: 'desc' },
  });

  return emergencies.map(toSafePatientEmergency);
};

export const getOwnEmergency = async (
  userId: string,
  emergencyId: string,
): Promise<SafePatientEmergency> => {
  const context = await resolvePatientContext(userId);

  // Ownership is part of the query itself, never an application-level comparison.
  const emergency = await prisma.emergencyRequest.findFirst({
    where: { id: emergencyId, patientId: context.patientProfileId },
  });

  if (!emergency) {
    throw EMERGENCY_NOT_FOUND_ERROR;
  }

  return toSafePatientEmergency(emergency);
};

/**
 * Creates an emergency at CREATED together with its immutable opening history row.
 *
 * Idempotency is enforced by the database, not by a pre-check: the insert is attempted and
 * a unique-constraint violation on the namespaced key is resolved into a replay. Two
 * concurrent requests carrying the same patient and client key therefore produce exactly
 * one EmergencyRequest — the loser blocks on the unique index until the winner commits,
 * then reads the winner's committed row.
 *
 * The opening history row is written here rather than through `transitionEmergency`
 * because that helper models a move between two exact prior states; creation has no prior
 * state and its history row carries `fromStatus = null`.
 */
export const createOwnEmergency = async (
  userId: string,
  input: CreateEmergencyInput,
  clientIdempotencyKey: string,
): Promise<CreateEmergencyResult> => {
  const context = await resolvePatientContext(userId);
  const idempotencyKey = namespaceIdempotencyKey(context.patientProfileId, clientIdempotencyKey);

  try {
    const emergency = await prisma.$transaction(async (tx) => {
      const created = await tx.emergencyRequest.create({
        data: {
          patientId: context.patientProfileId,
          requestType: input.requestType,
          severity: input.severity,
          description: input.description,
          pickupAddress: input.pickupAddress,
          pickupLatitude: input.pickupLatitude,
          pickupLongitude: input.pickupLongitude,
          idempotencyKey,
        },
      });

      await tx.emergencyStatusHistory.create({
        data: {
          emergencyId: created.id,
          fromStatus: null,
          toStatus: EmergencyStatus.CREATED,
          actorUserId: context.userId,
          actorType: TransitionActorType.PATIENT,
        },
      });

      return created;
    });

    return { emergency: toSafePatientEmergency(emergency), idempotentReplay: false };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      // The namespaced key already contains the profile id; scoping the lookup by
      // patientId as well means a replay can never reach another patient's record.
      const existing = await prisma.emergencyRequest.findFirst({
        where: { idempotencyKey, patientId: context.patientProfileId },
      });

      if (!existing) {
        throw new AppError(
          'IDEMPOTENCY_KEY_CONFLICT',
          'This idempotency key cannot be used for a new emergency.',
          409,
        );
      }

      return { emergency: toSafePatientEmergency(existing), idempotentReplay: true };
    }

    throw error;
  }
};

/**
 * Cancels an emergency that has not yet entered the hospital workflow.
 *
 * Only CREATED -> CANCELLED is supported in this task. Cancelling from a later state would
 * have to release the bed reserved in Task 1.15 and the ambulance and driver claimed in
 * Task 1.16, which belongs to the resource-lifecycle task, not here.
 *
 * Ownership, the expected source state and the cancellation timestamp are all part of one
 * conditional update, so a concurrent transition cannot be overwritten and a repeated
 * cancellation affects zero rows.
 */
export const cancelOwnEmergency = async (
  userId: string,
  emergencyId: string,
): Promise<SafePatientEmergency> => {
  const context = await resolvePatientContext(userId);

  return prisma.$transaction(async (tx) => {
    const cancelled = await transitionEmergency(tx, {
      emergencyId,
      from: EmergencyStatus.CREATED,
      to: EmergencyStatus.CANCELLED,
      actorUserId: context.userId,
      actorType: TransitionActorType.PATIENT,
      guard: { patientId: context.patientProfileId },
      fields: { cancelledAt: new Date() },
    });

    if (!cancelled) {
      // Distinguish "not yours / does not exist" from "wrong state" without disclosing
      // another patient's emergency: the probe is itself ownership-scoped.
      const owned = await tx.emergencyRequest.findFirst({
        where: { id: emergencyId, patientId: context.patientProfileId },
        select: { id: true },
      });

      if (!owned) {
        throw EMERGENCY_NOT_FOUND_ERROR;
      }

      throw new AppError(
        'EMERGENCY_STATUS_CONFLICT',
        'Only an emergency that has not yet entered the hospital workflow can be cancelled.',
        409,
      );
    }

    return toSafePatientEmergency(
      await tx.emergencyRequest.findUniqueOrThrow({ where: { id: emergencyId } }),
    );
  });
};
