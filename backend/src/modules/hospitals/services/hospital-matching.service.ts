import {
  BedStatus,
  EmergencyStatus,
  HospitalResponseStatus,
  HospitalStatus,
  Prisma,
  TransitionActorType,
} from '@prisma/client';
import { AppError } from '../../../common/errors/app-error.js';
import { env } from '../../../config/env.js';
import { logger } from '../../../config/logger.js';
import { prisma } from '../../../database/prisma.js';
import { transitionEmergency } from './emergency-status.service.js';

interface MatchingHospital {
  id: string;
  name: string;
  latitude: Prisma.Decimal | null;
  longitude: Prisma.Decimal | null;
}

interface RankedHospital extends MatchingHospital {
  estimatedDistanceKm: number | null;
}

export interface HospitalMatchingResult {
  emergencyId: string;
  matched: boolean;
  hospitalCount: number;
  idempotentReplay: boolean;
}

const EMERGENCY_NOT_FOUND_ERROR = new AppError(
  'EMERGENCY_NOT_FOUND',
  'No emergency was found for this id.',
  404,
);

const matchingStatusConflict = (status: EmergencyStatus): AppError =>
  new AppError(
    'EMERGENCY_MATCHING_STATUS_CONFLICT',
    `Hospital matching can only begin from CREATED; the emergency is currently ${status}.`,
    409,
  );

const hasCoordinatePair = (
  latitude: Prisma.Decimal | null,
  longitude: Prisma.Decimal | null,
): latitude is Prisma.Decimal => latitude !== null && longitude !== null;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

/** Straight-line geographic distance only; routing and external map services are out of scope. */
export const calculateHaversineDistanceKm = (
  originLatitude: number,
  originLongitude: number,
  destinationLatitude: number,
  destinationLongitude: number,
): number => {
  const latitudeDelta = toRadians(destinationLatitude - originLatitude);
  const longitudeDelta = toRadians(destinationLongitude - originLongitude);
  const originLatitudeRadians = toRadians(originLatitude);
  const destinationLatitudeRadians = toRadians(destinationLatitude);
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(originLatitudeRadians) *
      Math.cos(destinationLatitudeRadians) *
      Math.sin(longitudeDelta / 2) ** 2;

  return 6371 * 2 * Math.atan2(Math.sqrt(haversine), Math.sqrt(1 - haversine));
};

/**
 * Ranks verified hospitals by straight-line distance when both coordinate pairs exist.
 * Hospitals missing coordinates remain eligible and are ordered deterministically by name,
 * then UUID, after geographically ranked candidates.
 */
export const rankHospitals = (
  hospitals: MatchingHospital[],
  pickupLatitude: Prisma.Decimal | null,
  pickupLongitude: Prisma.Decimal | null,
): RankedHospital[] => {
  const emergencyHasCoordinates = hasCoordinatePair(pickupLatitude, pickupLongitude);
  const ranked = hospitals.map((hospital) => {
    const estimatedDistanceKm =
      emergencyHasCoordinates && hasCoordinatePair(hospital.latitude, hospital.longitude)
        ? calculateHaversineDistanceKm(
            pickupLatitude.toNumber(),
            pickupLongitude!.toNumber(),
            hospital.latitude.toNumber(),
            hospital.longitude!.toNumber(),
          )
        : null;

    return { ...hospital, estimatedDistanceKm };
  });

  return ranked.sort((left, right) => {
    if (left.estimatedDistanceKm !== null && right.estimatedDistanceKm !== null) {
      const distanceDifference = left.estimatedDistanceKm - right.estimatedDistanceKm;
      if (distanceDifference !== 0) return distanceDifference;
    } else if (left.estimatedDistanceKm !== null) {
      return -1;
    } else if (right.estimatedDistanceKm !== null) {
      return 1;
    }

    const nameDifference = left.name.localeCompare(right.name);
    return nameDifference !== 0 ? nameDifference : left.id.localeCompare(right.id);
  });
};

/**
 * Creates the first bounded batch of PENDING hospital responses. Eligibility is limited to
 * a VERIFIED hospital with at least one AVAILABLE Bed. This uses existing lifecycle and
 * capacity data without inventing clinical-capability matching or reserving a bed.
 */
export const matchEmergencyToHospitals = async (
  emergencyId: string,
): Promise<HospitalMatchingResult> => {
  logger.info({ emergencyId, action: 'hospital-matching' }, 'hospital.matching.started');

  const result = await prisma.$transaction(async (tx) => {
    const emergency = await tx.emergencyRequest.findUnique({
      where: { id: emergencyId },
      select: {
        id: true,
        currentStatus: true,
        pickupLatitude: true,
        pickupLongitude: true,
      },
    });

    if (!emergency) throw EMERGENCY_NOT_FOUND_ERROR;

    if (emergency.currentStatus === EmergencyStatus.PENDING_HOSPITAL_RESPONSE) {
      const hospitalCount = await tx.hospitalResponse.count({ where: { emergencyId } });
      return { emergencyId, matched: hospitalCount > 0, hospitalCount, idempotentReplay: true };
    }

    if (emergency.currentStatus !== EmergencyStatus.CREATED) {
      throw matchingStatusConflict(emergency.currentStatus);
    }

    const eligibleHospitals = await tx.hospital.findMany({
      where: {
        status: HospitalStatus.VERIFIED,
        beds: { some: { status: BedStatus.AVAILABLE } },
      },
      select: { id: true, name: true, latitude: true, longitude: true },
    });
    const selectedHospitals = rankHospitals(
      eligibleHospitals,
      emergency.pickupLatitude,
      emergency.pickupLongitude,
    ).slice(0, env.HOSPITAL_MATCH_MAX_OFFERS);

    // Zero candidates is intentionally non-terminal: the SOS remains CREATED for a later
    // matching/recovery workflow and no speculative status history is written.
    if (selectedHospitals.length === 0) {
      return { emergencyId, matched: false, hospitalCount: 0, idempotentReplay: false };
    }

    const searching = await transitionEmergency(tx, {
      emergencyId,
      from: EmergencyStatus.CREATED,
      to: EmergencyStatus.SEARCHING_HOSPITAL,
      actorType: TransitionActorType.SYSTEM,
    });

    if (!searching) {
      const current = await tx.emergencyRequest.findUniqueOrThrow({
        where: { id: emergencyId },
        select: { currentStatus: true },
      });
      if (current.currentStatus === EmergencyStatus.PENDING_HOSPITAL_RESPONSE) {
        const hospitalCount = await tx.hospitalResponse.count({ where: { emergencyId } });
        return { emergencyId, matched: hospitalCount > 0, hospitalCount, idempotentReplay: true };
      }
      throw matchingStatusConflict(current.currentStatus);
    }

    await tx.hospitalResponse.createMany({
      data: selectedHospitals.map((hospital, index) => ({
        emergencyId,
        hospitalId: hospital.id,
        attemptNumber: 1,
        status: HospitalResponseStatus.PENDING,
        rank: index + 1,
        estimatedDistanceKm:
          hospital.estimatedDistanceKm === null
            ? undefined
            : new Prisma.Decimal(hospital.estimatedDistanceKm.toFixed(2)),
      })),
      skipDuplicates: true,
    });

    const pendingResponse = await transitionEmergency(tx, {
      emergencyId,
      from: EmergencyStatus.SEARCHING_HOSPITAL,
      to: EmergencyStatus.PENDING_HOSPITAL_RESPONSE,
      actorType: TransitionActorType.SYSTEM,
    });

    if (!pendingResponse) {
      throw new AppError(
        'EMERGENCY_MATCHING_STATUS_CONFLICT',
        'The emergency could not enter the hospital response phase.',
        409,
      );
    }

    return {
      emergencyId,
      matched: true,
      hospitalCount: selectedHospitals.length,
      idempotentReplay: false,
    };
  });

  logger.info(
    {
      emergencyId: result.emergencyId,
      matched: result.matched,
      hospitalCount: result.hospitalCount,
      idempotentReplay: result.idempotentReplay,
      action: 'hospital-matching',
    },
    result.matched ? 'hospital.matching.completed' : 'hospital.matching.no_eligible_hospitals',
  );

  return result;
};
