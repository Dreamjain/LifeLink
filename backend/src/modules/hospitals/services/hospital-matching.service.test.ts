import { randomUUID } from 'node:crypto';
import {
  BedStatus,
  EmergencyStatus,
  HospitalResponseStatus,
  HospitalStatus,
  Prisma,
  TransitionActorType,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { env } from '../../../config/env.js';
import { prisma } from '../../../database/prisma.js';
import { createOwnEmergency } from '../../emergencies/services/emergency.service.js';
import {
  calculateHaversineDistanceKm,
  matchEmergencyToHospitals,
  rankHospitals,
} from './hospital-matching.service.js';

const TEST_REG_PREFIX = 'T1818-';
const TEST_PHONE_PREFIX = '+1818';

const MAX_OFFERS = env.HOSPITAL_MATCH_MAX_OFFERS;

/**
 * Production matching is global by design: it offers to every eligible hospital in the
 * database, not only the ones a test created. These tests therefore measure the eligible
 * hospitals they do NOT own and assert the exact production rule against that measurement,
 * rather than assuming the database contains nothing else.
 */
const countForeignEligibleHospitals = async (ownedHospitalIds: string[]): Promise<number> =>
  prisma.hospital.count({
    where: {
      status: HospitalStatus.VERIFIED,
      beds: { some: { status: BedStatus.AVAILABLE } },
      ...(ownedHospitalIds.length > 0 ? { id: { notIn: ownedHospitalIds } } : {}),
    },
  });

const randomRegistration = (): string => `${TEST_REG_PREFIX}${randomUUID().slice(0, 12)}`;
const randomPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const createHospital = async (
  options: {
    name?: string;
    status?: HospitalStatus;
    latitude?: number;
    longitude?: number;
    withAvailableBed?: boolean;
  } = {},
) => {
  const hospital = await prisma.hospital.create({
    data: {
      name: options.name ?? `Matching Hospital ${randomUUID().slice(0, 6)}`,
      registrationNumber: randomRegistration(),
      phone: '+15550000000',
      addressLine: '1 Matching Street',
      city: 'Matching City',
      state: 'MC',
      postalCode: '10001',
      status: options.status ?? HospitalStatus.VERIFIED,
      latitude: options.latitude,
      longitude: options.longitude,
      ...(options.withAvailableBed === false
        ? {}
        : { beds: { create: { bedCode: `B-${randomUUID().slice(0, 8)}` } } }),
    },
  });

  return hospital;
};

const createEmergency = async (options: { latitude?: number; longitude?: number } = {}) => {
  const user = await prisma.user.create({
    data: {
      phone: randomPhone(),
      passwordHash: 'not-used-in-fixture',
      role: UserRole.PATIENT,
      status: UserStatus.ACTIVE,
      displayName: 'Matching Fixture Patient',
      patientProfile: { create: {} },
    },
    include: { patientProfile: true },
  });
  const emergency = await prisma.emergencyRequest.create({
    data: {
      patientId: user.patientProfile!.id,
      pickupLatitude: options.latitude,
      pickupLongitude: options.longitude,
    },
  });
  return { emergency, user };
};

const cleanupFixtures = async (): Promise<void> => {
  // Ownership-scoped: this suite deletes only rows it created. Matching is global, so an
  // emergency belonging to another suite can legitimately hold an offer against a hospital
  // created here; that offer is detached, but the foreign emergency is left untouched.
  const hospitals = await prisma.hospital.findMany({
    where: { registrationNumber: { startsWith: TEST_REG_PREFIX } },
    select: { id: true },
  });
  const hospitalIds = hospitals.map((hospital) => hospital.id);
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: TEST_PHONE_PREFIX } },
    select: { id: true, patientProfile: { select: { id: true } } },
  });
  const userIds = users.map((user) => user.id);
  const profileIds = users.flatMap((user) => (user.patientProfile ? [user.patientProfile.id] : []));

  // 1. Detach every offer pointing at this suite's hospitals, without deleting the
  //    emergencies behind them.
  const ownHospitalResponses = await prisma.hospitalResponse.findMany({
    where: { hospitalId: { in: hospitalIds } },
    select: { id: true },
  });
  const ownHospitalResponseIds = ownHospitalResponses.map((response) => response.id);
  await prisma.bedReservation.deleteMany({
    where: { hospitalResponseId: { in: ownHospitalResponseIds } },
  });
  await prisma.ambulanceAssignment.deleteMany({
    where: { hospitalResponseId: { in: ownHospitalResponseIds } },
  });
  await prisma.hospitalResponse.deleteMany({ where: { id: { in: ownHospitalResponseIds } } });

  // 2. Tear this suite's own patients' emergencies down completely.
  const emergencies = await prisma.emergencyRequest.findMany({
    where: { patientId: { in: profileIds } },
    select: { id: true },
  });
  const emergencyIds = emergencies.map((emergency) => emergency.id);
  await prisma.ambulanceAssignment.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.bedReservation.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.doctorAssignment.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.notification.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.emergencyStatusHistory.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.hospitalResponse.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.emergencyRequest.deleteMany({ where: { id: { in: emergencyIds } } });

  // 3. Rows referencing this suite's users directly must go before the users do.
  await prisma.emergencyStatusHistory.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { recipientUserId: { in: userIds } } });
  await prisma.patientProfile.deleteMany({ where: { id: { in: profileIds } } });

  // 4. Hospital-owned resources, then the hospitals and users themselves.
  await prisma.bed.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.ambulance.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospitalStaffMembership.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
};

afterEach(cleanupFixtures);
afterAll(cleanupFixtures);

describe('geographic ranking', () => {
  it('calculates a deterministic straight-line Haversine distance', () => {
    expect(calculateHaversineDistanceKm(0, 0, 0, 1)).toBeCloseTo(111.195, 2);
  });

  it('orders geographic candidates by distance, then missing-coordinate candidates by name', () => {
    const ranked = rankHospitals(
      [
        {
          id: 'z',
          name: 'Zulu',
          latitude: new Prisma.Decimal(10.1),
          longitude: new Prisma.Decimal(10),
        },
        { id: 'b', name: 'Bravo', latitude: null, longitude: null },
        {
          id: 'a',
          name: 'Alpha',
          latitude: new Prisma.Decimal(10.01),
          longitude: new Prisma.Decimal(10),
        },
      ],
      new Prisma.Decimal(10),
      new Prisma.Decimal(10),
    );

    expect(ranked.map((hospital) => hospital.id)).toEqual(['a', 'z', 'b']);
    expect(ranked[0]?.estimatedDistanceKm).not.toBeNull();
    expect(ranked[2]?.estimatedDistanceKm).toBeNull();
  });
});

describe('matchEmergencyToHospitals', () => {
  it('selects only verified hospitals with available beds, creates pending offers and records system history', async () => {
    const eligible = await createHospital({ latitude: 10.01, longitude: 10 });
    await createHospital({ status: HospitalStatus.PENDING_VERIFICATION });
    await createHospital({ status: HospitalStatus.VERIFIED, withAvailableBed: false });
    const { emergency } = await createEmergency({ latitude: 10, longitude: 10 });

    const foreignEligible = await countForeignEligibleHospitals([eligible.id]);
    const expectedOffers = Math.min(1 + foreignEligible, MAX_OFFERS);

    const result = await matchEmergencyToHospitals(emergency.id);

    expect(result).toMatchObject({
      matched: true,
      hospitalCount: expectedOffers,
      idempotentReplay: false,
    });
    const responses = await prisma.hospitalResponse.findMany({
      where: { emergencyId: emergency.id },
    });
    expect(responses).toHaveLength(expectedOffers);

    // The eligible hospital owned by this test is offered exactly once; the two ineligible
    // ones never are. That is the eligibility rule, and it holds whatever else is in the
    // database.
    const ownedOffer = responses.find((response) => response.hospitalId === eligible.id);
    expect(ownedOffer).toMatchObject({
      status: HospitalResponseStatus.PENDING,
      attemptNumber: 1,
    });
    expect(ownedOffer?.rank).toBeGreaterThan(0);
    expect(Number(ownedOffer?.estimatedDistanceKm)).toBeGreaterThan(0);

    const stored = await prisma.emergencyRequest.findUniqueOrThrow({ where: { id: emergency.id } });
    expect(stored.currentStatus).toBe(EmergencyStatus.PENDING_HOSPITAL_RESPONSE);
    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: emergency.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(history).toHaveLength(2);
    expect(history.map((entry) => [entry.fromStatus, entry.toStatus])).toEqual([
      [EmergencyStatus.CREATED, EmergencyStatus.SEARCHING_HOSPITAL],
      [EmergencyStatus.SEARCHING_HOSPITAL, EmergencyStatus.PENDING_HOSPITAL_RESPONSE],
    ]);
    expect(history.every((entry) => entry.actorType === TransitionActorType.SYSTEM)).toBe(true);
    expect(history.every((entry) => entry.actorUserId === null)).toBe(true);
  });

  it('uses deterministic fallback ordering for hospitals without coordinates and respects the default three-offer limit', async () => {
    const hotels = await Promise.all([
      createHospital({ name: 'Zulu', latitude: undefined, longitude: undefined }),
      createHospital({ name: 'Charlie', latitude: undefined, longitude: undefined }),
      createHospital({ name: 'Bravo', latitude: undefined, longitude: undefined }),
      createHospital({ name: 'Alpha', latitude: undefined, longitude: undefined }),
    ]);
    const { emergency } = await createEmergency();

    const result = await matchEmergencyToHospitals(emergency.id);
    const responses = await prisma.hospitalResponse.findMany({
      where: { emergencyId: emergency.id },
      orderBy: { rank: 'asc' },
    });

    // This test owns four eligible candidates, so the limit is reached no matter what else
    // the database holds.
    expect(result.hospitalCount).toBe(MAX_OFFERS);
    expect(responses).toHaveLength(MAX_OFFERS);

    // The emergency has no coordinates, so every candidate falls back to name ordering.
    expect(responses.every((response) => response.estimatedDistanceKm === null)).toBe(true);
    const ownedNamesInRankOrder = responses
      .map((response) => hotels.find((hospital) => hospital.id === response.hospitalId)?.name)
      .filter((name): name is string => name !== undefined);
    expect(ownedNamesInRankOrder).toEqual([...ownedNamesInRankOrder].sort());
    // 'Zulu' sorts last of the four, so it can never displace an owned candidate.
    expect(ownedNamesInRankOrder).not.toContain('Zulu');
  });

  it('never offers an ineligible hospital and leaves the emergency CREATED when nothing is eligible', async () => {
    const rejected = await createHospital({ status: HospitalStatus.REJECTED });
    const withoutAvailableBed = await createHospital({
      status: HospitalStatus.VERIFIED,
      withAvailableBed: false,
    });
    const ownedIds = [rejected.id, withoutAvailableBed.id];
    const foreignEligible = await countForeignEligibleHospitals(ownedIds);
    const expectedOffers = Math.min(foreignEligible, MAX_OFFERS);
    const { emergency } = await createEmergency();

    const result = await matchEmergencyToHospitals(emergency.id);

    // Ownership-scoped and always deterministic: neither hospital this test created is
    // eligible, so neither may ever receive an offer.
    expect(
      await prisma.hospitalResponse.count({
        where: { emergencyId: emergency.id, hospitalId: { in: ownedIds } },
      }),
    ).toBe(0);

    // The lifecycle follows the exact production rule for the measured candidate set. When
    // this test owns the whole universe (expectedOffers === 0) that is the real zero-match
    // case: no offers, no transition, no speculative history.
    expect(result).toMatchObject({
      matched: expectedOffers > 0,
      hospitalCount: expectedOffers,
      idempotentReplay: false,
    });
    expect(await prisma.hospitalResponse.count({ where: { emergencyId: emergency.id } })).toBe(
      expectedOffers,
    );
    expect(
      await prisma.emergencyRequest.findUniqueOrThrow({ where: { id: emergency.id } }),
    ).toMatchObject({
      currentStatus:
        expectedOffers === 0 ? EmergencyStatus.CREATED : EmergencyStatus.PENDING_HOSPITAL_RESPONSE,
    });
    expect(
      await prisma.emergencyStatusHistory.count({ where: { emergencyId: emergency.id } }),
    ).toBe(expectedOffers === 0 ? 0 : 2);
  });

  it('is idempotent and concurrent calls create one offer per hospital and one pair of transitions', async () => {
    // Seeded at the pickup point: a straight-line distance of 0 guarantees both owned
    // hospitals rank inside the offer limit whatever else is eligible in the database.
    const owned = await Promise.all([
      createHospital({ latitude: 30, longitude: 30 }),
      createHospital({ latitude: 30, longitude: 30 }),
    ]);
    const ownedIds = owned.map((hospital) => hospital.id);
    const foreignEligible = await countForeignEligibleHospitals(ownedIds);
    const expectedOffers = Math.min(owned.length + foreignEligible, MAX_OFFERS);
    const { emergency } = await createEmergency({ latitude: 30, longitude: 30 });

    const first = await matchEmergencyToHospitals(emergency.id);
    const replay = await matchEmergencyToHospitals(emergency.id);
    expect(first).toMatchObject({
      matched: true,
      hospitalCount: expectedOffers,
      idempotentReplay: false,
    });
    expect(replay).toMatchObject({
      matched: true,
      hospitalCount: expectedOffers,
      idempotentReplay: true,
    });
    // One offer per owned hospital, and the replay added none.
    expect(
      await prisma.hospitalResponse.count({
        where: { emergencyId: emergency.id, hospitalId: { in: ownedIds } },
      }),
    ).toBe(owned.length);

    const concurrentEmergency = await createEmergency({ latitude: 30, longitude: 30 });
    const outcomes = await Promise.all([
      matchEmergencyToHospitals(concurrentEmergency.emergency.id),
      matchEmergencyToHospitals(concurrentEmergency.emergency.id),
    ]);
    expect(outcomes.filter((outcome) => outcome.matched)).toHaveLength(2);
    expect(
      await prisma.hospitalResponse.count({
        where: {
          emergencyId: concurrentEmergency.emergency.id,
          hospitalId: { in: ownedIds },
        },
      }),
    ).toBe(owned.length);
    expect(
      await prisma.hospitalResponse.count({
        where: { emergencyId: concurrentEmergency.emergency.id },
      }),
    ).toBe(expectedOffers);
    // Exactly one pair of SYSTEM transitions, never two pairs.
    expect(
      await prisma.emergencyStatusHistory.count({
        where: { emergencyId: concurrentEmergency.emergency.id },
      }),
    ).toBe(2);
  });

  it('rejects matching from an invalid emergency state', async () => {
    const { emergency } = await createEmergency();
    await prisma.emergencyRequest.update({
      where: { id: emergency.id },
      data: { currentStatus: EmergencyStatus.CANCELLED },
    });

    await expect(matchEmergencyToHospitals(emergency.id)).rejects.toMatchObject({
      code: 'EMERGENCY_MATCHING_STATUS_CONFLICT',
      statusCode: 409,
    });
  });

  it('runs matching after a successful patient SOS without changing patient idempotency', async () => {
    const ownedHospital = await createHospital({ latitude: 20, longitude: 20 });
    const foreignEligible = await countForeignEligibleHospitals([ownedHospital.id]);
    const expectedOffers = Math.min(1 + foreignEligible, MAX_OFFERS);
    const user = await prisma.user.create({
      data: {
        phone: randomPhone(),
        passwordHash: 'not-used-in-fixture',
        role: UserRole.PATIENT,
        status: UserStatus.ACTIVE,
        displayName: 'SOS Matching Patient',
        patientProfile: { create: {} },
      },
    });

    const created = await createOwnEmergency(
      user.id,
      { pickupLatitude: 20, pickupLongitude: 20 },
      'sos',
    );
    const replay = await createOwnEmergency(user.id, {}, 'sos');
    expect(created.idempotentReplay).toBe(false);
    expect(created.emergency.currentStatus).toBe(EmergencyStatus.PENDING_HOSPITAL_RESPONSE);
    expect(replay).toMatchObject({ idempotentReplay: true });
    // The hospital this test owns sits at the pickup point, so it is always offered exactly
    // once; the total is whatever the global candidate set allows, bounded by the limit.
    expect(
      await prisma.hospitalResponse.count({
        where: { emergencyId: created.emergency.id, hospitalId: ownedHospital.id },
      }),
    ).toBe(1);
    expect(
      await prisma.hospitalResponse.count({ where: { emergencyId: created.emergency.id } }),
    ).toBe(expectedOffers);
  });
});
