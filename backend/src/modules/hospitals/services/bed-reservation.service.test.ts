import { randomUUID } from 'node:crypto';
import {
  BedReservationStatus,
  BedStatus,
  EmergencyStatus,
  HospitalResponseStatus,
  HospitalStaffRole,
  HospitalStatus,
  MembershipStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import type { HospitalStaffContext } from '../types/hospital.types.js';
import {
  createReservation,
  getReservation,
  listReservations,
  releaseReservation,
} from './bed-reservation.service.js';

const TEST_REG_PREFIX = 'T1576-';
const TEST_PHONE_PREFIX = '+1576';

const randomRegistration = (): string => `${TEST_REG_PREFIX}${randomUUID().slice(0, 12)}`;
const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const createScope = async (): Promise<HospitalStaffContext> => {
  const hospital = await prisma.hospital.create({
    data: {
      name: 'Reservation Service Hospital',
      registrationNumber: randomRegistration(),
      phone: '+15550000000',
      addressLine: '1 Main Street',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      status: HospitalStatus.VERIFIED,
    },
  });

  return {
    membershipId: randomUUID(),
    hospitalId: hospital.id,
    staffRole: HospitalStaffRole.DISPATCHER,
    membershipStatus: MembershipStatus.ACTIVE,
  };
};

const createActor = async (): Promise<string> => {
  const user = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      passwordHash: 'not-used-in-this-fixture',
      role: UserRole.HOSPITAL_STAFF,
      status: UserStatus.ACTIVE,
      displayName: 'Reservation Actor',
    },
  });

  return user.id;
};

const createBed = async (hospitalId: string, status: BedStatus = BedStatus.AVAILABLE) =>
  prisma.bed.create({
    data: { hospitalId, bedCode: `B-${randomUUID().slice(0, 8)}`, status },
  });

/** Seeds an emergency whose response is already ACCEPTED and emergency HOSPITAL_ACCEPTED. */
const seedAcceptedEmergency = async (options: {
  hospitalId: string;
  emergencyStatus?: EmergencyStatus;
  responseStatus?: HospitalResponseStatus;
}) => {
  const patientUser = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      passwordHash: 'not-used-in-this-fixture',
      role: UserRole.PATIENT,
      status: UserStatus.ACTIVE,
      displayName: 'Fixture Patient',
      patientProfile: { create: {} },
    },
    include: { patientProfile: true },
  });

  const emergency = await prisma.emergencyRequest.create({
    data: {
      patientId: patientUser.patientProfile!.id,
      currentStatus: options.emergencyStatus ?? EmergencyStatus.HOSPITAL_ACCEPTED,
    },
  });

  const response = await prisma.hospitalResponse.create({
    data: {
      emergencyId: emergency.id,
      hospitalId: options.hospitalId,
      status: options.responseStatus ?? HospitalResponseStatus.ACCEPTED,
    },
  });

  return { emergency, response };
};

afterAll(async () => {
  // Fixtures are resolved from this file's own prefixes only.
  //
  // Emergencies are discovered from this file's own patients, never from hospital responses
  // alone. Task 1.18 matching scans every eligible hospital, so another suite's emergency can
  // legitimately hold an offer against this suite's hospital; deleting that emergency here
  // would corrupt the other suite and can strand a PatientProfile whose User is then deleted
  // (PatientProfile_userId_fkey RESTRICT).
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

  // 1. Detach every response pointing at this file's hospitals — including offers Task 1.18
  //    matching created for another suite's emergency — without touching those emergencies.
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

  // 2. Tear this file's own patients' emergencies down completely, whichever hospitals they
  //    were offered to.
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

  // 3. Rows referencing this file's users directly must go before the users do.
  await prisma.emergencyStatusHistory.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { recipientUserId: { in: userIds } } });
  await prisma.patientProfile.deleteMany({ where: { id: { in: profileIds } } });

  // 4. Hospital-owned resources, then the hospitals and users themselves.
  await prisma.bed.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.ambulance.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospitalStaffMembership.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('createReservation', () => {
  it('reserves a bed, flips the bed, advances the emergency, and writes history atomically', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedAcceptedEmergency({ hospitalId: scope.hospitalId });
    const bed = await createBed(scope.hospitalId);

    const reservation = await createReservation(scope, seed.response.id, bed.id, actorUserId);

    expect(reservation.status).toBe(BedReservationStatus.RESERVED);
    expect(reservation.reservedByUserId).toBe(actorUserId);
    expect(reservation.bedId).toBe(bed.id);

    const storedBed = await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } });
    expect(storedBed.status).toBe(BedStatus.RESERVED);

    const emergency = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: seed.emergency.id },
    });
    expect(emergency.currentStatus).toBe(EmergencyStatus.BED_RESERVED);

    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: seed.emergency.id },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromStatus: EmergencyStatus.HOSPITAL_ACCEPTED,
      toStatus: EmergencyStatus.BED_RESERVED,
    });
  });

  it.each([HospitalResponseStatus.PENDING, HospitalResponseStatus.REJECTED])(
    'refuses when the response is %s rather than ACCEPTED',
    async (responseStatus) => {
      const scope = await createScope();
      const actorUserId = await createActor();
      const seed = await seedAcceptedEmergency({
        hospitalId: scope.hospitalId,
        responseStatus,
        emergencyStatus: EmergencyStatus.PENDING_HOSPITAL_RESPONSE,
      });
      const bed = await createBed(scope.hospitalId);

      await expect(
        createReservation(scope, seed.response.id, bed.id, actorUserId),
      ).rejects.toMatchObject({ code: 'HOSPITAL_RESPONSE_STATUS_CONFLICT' });

      const untouched = await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } });
      expect(untouched.status).toBe(BedStatus.AVAILABLE);
    },
  );

  it.each([BedStatus.RESERVED, BedStatus.OCCUPIED, BedStatus.OUT_OF_SERVICE])(
    'refuses to reserve a %s bed',
    async (bedStatus) => {
      const scope = await createScope();
      const actorUserId = await createActor();
      const seed = await seedAcceptedEmergency({ hospitalId: scope.hospitalId });
      const bed = await createBed(scope.hospitalId, bedStatus);

      await expect(
        createReservation(scope, seed.response.id, bed.id, actorUserId),
      ).rejects.toMatchObject({ code: 'BED_UNAVAILABLE' });
    },
  );

  it('refuses a bed belonging to another hospital', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const actorUserId = await createActor();
    const seedA = await seedAcceptedEmergency({ hospitalId: scopeA.hospitalId });
    const bedB = await createBed(scopeB.hospitalId);

    await expect(
      createReservation(scopeA, seedA.response.id, bedB.id, actorUserId),
    ).rejects.toMatchObject({ code: 'BED_NOT_FOUND' });

    const untouched = await prisma.bed.findUniqueOrThrow({ where: { id: bedB.id } });
    expect(untouched.status).toBe(BedStatus.AVAILABLE);
  });

  it('refuses a response belonging to another hospital', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const actorUserId = await createActor();
    const seedB = await seedAcceptedEmergency({ hospitalId: scopeB.hospitalId });
    const bedA = await createBed(scopeA.hospitalId);

    await expect(
      createReservation(scopeA, seedB.response.id, bedA.id, actorUserId),
    ).rejects.toMatchObject({ code: 'HOSPITAL_RESPONSE_NOT_FOUND' });
  });

  it('rolls back the bed claim when the emergency is in the wrong state', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    // Response ACCEPTED but emergency never advanced: the bed is claimed, then the
    // emergency transition fails and the whole transaction must roll back.
    const seed = await seedAcceptedEmergency({
      hospitalId: scope.hospitalId,
      emergencyStatus: EmergencyStatus.PENDING_HOSPITAL_RESPONSE,
    });
    const bed = await createBed(scope.hospitalId);

    await expect(
      createReservation(scope, seed.response.id, bed.id, actorUserId),
    ).rejects.toMatchObject({ code: 'BED_RESERVATION_CONFLICT' });

    const storedBed = await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } });
    expect(storedBed.status).toBe(BedStatus.AVAILABLE);
    expect(await prisma.bedReservation.count({ where: { bedId: bed.id } })).toBe(0);

    const emergency = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: seed.emergency.id },
    });
    expect(emergency.currentStatus).toBe(EmergencyStatus.PENDING_HOSPITAL_RESPONSE);
  });

  it('refuses a second reservation for an emergency that already has one', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedAcceptedEmergency({ hospitalId: scope.hospitalId });
    const firstBed = await createBed(scope.hospitalId);
    const secondBed = await createBed(scope.hospitalId);

    await createReservation(scope, seed.response.id, firstBed.id, actorUserId);

    await expect(
      createReservation(scope, seed.response.id, secondBed.id, actorUserId),
    ).rejects.toMatchObject({ code: 'BED_RESERVATION_CONFLICT' });

    const untouched = await prisma.bed.findUniqueOrThrow({ where: { id: secondBed.id } });
    expect(untouched.status).toBe(BedStatus.AVAILABLE);
    expect(
      await prisma.bedReservation.count({
        where: { emergencyId: seed.emergency.id, status: BedReservationStatus.RESERVED },
      }),
    ).toBe(1);
  });
});

describe('bed reservation concurrency', () => {
  it.each([1, 2, 3])('run %i: two callers race for the same bed and only one wins', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seedOne = await seedAcceptedEmergency({ hospitalId: scope.hospitalId });
    const seedTwo = await seedAcceptedEmergency({ hospitalId: scope.hospitalId });
    const bed = await createBed(scope.hospitalId);

    const outcomes = await Promise.allSettled([
      createReservation(scope, seedOne.response.id, bed.id, actorUserId),
      createReservation(scope, seedTwo.response.id, bed.id, actorUserId),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);

    const storedBed = await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } });
    expect(storedBed.status).toBe(BedStatus.RESERVED);

    const active = await prisma.bedReservation.findMany({
      where: { bedId: bed.id, status: BedReservationStatus.RESERVED },
    });
    expect(active).toHaveLength(1);
  });
});

describe('releaseReservation', () => {
  const reserve = async (scope: HospitalStaffContext, actorUserId: string) => {
    const seed = await seedAcceptedEmergency({ hospitalId: scope.hospitalId });
    const bed = await createBed(scope.hospitalId);
    const reservation = await createReservation(scope, seed.response.id, bed.id, actorUserId);
    return { seed, bed, reservation };
  };

  it('releases an active reservation, frees the bed and returns the emergency', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const { seed, bed, reservation } = await reserve(scope, actorUserId);

    const released = await releaseReservation(
      scope,
      reservation.id,
      actorUserId,
      'Bed damaged during cleaning.',
    );

    expect(released.status).toBe(BedReservationStatus.RELEASED);
    expect(released.releasedAt).toBeInstanceOf(Date);
    expect(released.releaseReason).toBe('Bed damaged during cleaning.');

    const storedBed = await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } });
    expect(storedBed.status).toBe(BedStatus.AVAILABLE);

    const emergency = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: seed.emergency.id },
    });
    expect(emergency.currentStatus).toBe(EmergencyStatus.HOSPITAL_ACCEPTED);
  });

  it('keeps the released reservation as history and allows reserving another bed', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const { seed, reservation } = await reserve(scope, actorUserId);
    await releaseReservation(scope, reservation.id, actorUserId);

    const anotherBed = await createBed(scope.hospitalId);
    const second = await createReservation(scope, seed.response.id, anotherBed.id, actorUserId);

    expect(second.status).toBe(BedReservationStatus.RESERVED);
    expect(await prisma.bedReservation.count({ where: { emergencyId: seed.emergency.id } })).toBe(
      2,
    );
  });

  it('refuses to release an already released reservation', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const { reservation } = await reserve(scope, actorUserId);
    await releaseReservation(scope, reservation.id, actorUserId);

    await expect(releaseReservation(scope, reservation.id, actorUserId)).rejects.toMatchObject({
      code: 'RESERVATION_STATUS_CONFLICT',
    });
  });

  it.each([
    BedReservationStatus.CONSUMED,
    BedReservationStatus.EXPIRED,
    BedReservationStatus.FAILED,
  ])('refuses to release a %s reservation', async (status) => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const { reservation } = await reserve(scope, actorUserId);
    await prisma.bedReservation.update({ where: { id: reservation.id }, data: { status } });

    await expect(releaseReservation(scope, reservation.id, actorUserId)).rejects.toMatchObject({
      code: 'RESERVATION_STATUS_CONFLICT',
    });
  });

  it('cannot release another hospital reservation', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const actorUserId = await createActor();
    const { reservation, bed } = await reserve(scopeB, actorUserId);

    await expect(releaseReservation(scopeA, reservation.id, actorUserId)).rejects.toMatchObject({
      code: 'RESERVATION_NOT_FOUND',
    });

    const untouched = await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } });
    expect(untouched.status).toBe(BedStatus.RESERVED);
  });
});

describe('listReservations / getReservation', () => {
  it('lists and reads only the caller hospital reservations', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const actorUserId = await createActor();

    const seedA = await seedAcceptedEmergency({ hospitalId: scopeA.hospitalId });
    const bedA = await createBed(scopeA.hospitalId);
    const reservationA = await createReservation(scopeA, seedA.response.id, bedA.id, actorUserId);

    const seedB = await seedAcceptedEmergency({ hospitalId: scopeB.hospitalId });
    const bedB = await createBed(scopeB.hospitalId);
    const reservationB = await createReservation(scopeB, seedB.response.id, bedB.id, actorUserId);

    const listedA = await listReservations(scopeA);
    expect(listedA.map((r) => r.id)).toContain(reservationA.id);
    expect(listedA.map((r) => r.id)).not.toContain(reservationB.id);

    await expect(getReservation(scopeA, reservationB.id)).rejects.toMatchObject({
      code: 'RESERVATION_NOT_FOUND',
    });
  });

  it('rejects a nonexistent reservation', async () => {
    const scope = await createScope();

    await expect(getReservation(scope, randomUUID())).rejects.toMatchObject({
      code: 'RESERVATION_NOT_FOUND',
    });
  });
});
