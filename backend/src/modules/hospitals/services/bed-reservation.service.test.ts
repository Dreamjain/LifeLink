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
  autoReserveBedForAcceptedResponse,
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
  //
  //    This runs twice: here, and again immediately before the beds and hospitals are deleted.
  //    A VERIFIED hospital with an AVAILABLE bed is globally eligible for matching, so another
  //    suite can create a fresh offer against this file's hospitals at any moment, including
  //    after this first pass.
  const detachOwnHospitalResponses = async (): Promise<void> => {
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
  };

  await detachOwnHospitalResponses();

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

  // 4. Hospital-owned resources nothing else can point at.
  await prisma.ambulance.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospitalStaffMembership.deleteMany({ where: { hospitalId: { in: hospitalIds } } });

  // 5. Final sweep, as late as possible: an offer matching created since step 1 would
  //    otherwise block the deletes below, because BedReservation and HospitalResponse both
  //    reference beds and hospitals with onDelete: Restrict.
  await detachOwnHospitalResponses();
  await prisma.bed.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
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

describe('autoReserveBedForAcceptedResponse', () => {
  /**
   * Beds carry an explicit createdAt so "the oldest AVAILABLE bed" is a property of the
   * fixture rather than a race between two inserts landing in the same millisecond.
   */
  const createAgedBed = async (
    hospitalId: string,
    minutesOld: number,
    status: BedStatus = BedStatus.AVAILABLE,
  ) =>
    prisma.bed.create({
      data: {
        hospitalId,
        bedCode: `B-${randomUUID().slice(0, 8)}`,
        status,
        createdAt: new Date(Date.now() - minutesOld * 60_000),
      },
    });

  it('reserves the oldest AVAILABLE bed and advances the emergency', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedAcceptedEmergency({ hospitalId: scope.hospitalId });
    const oldest = await createAgedBed(scope.hospitalId, 30);
    const newer = await createAgedBed(scope.hospitalId, 5);

    const outcome = await autoReserveBedForAcceptedResponse(scope, seed.response.id, actorUserId);

    expect(outcome.reserved).toBe(true);
    expect(outcome.attempts).toBe(1);
    expect(outcome.reason).toBeUndefined();
    expect(outcome.reservation?.bedId).toBe(oldest.id);
    expect(outcome.reservation?.status).toBe(BedReservationStatus.RESERVED);
    expect(outcome.reservation?.hospitalResponseId).toBe(seed.response.id);
    expect(outcome.reservation?.emergencyId).toBe(seed.emergency.id);
    // The accepting staff member is the reserver: this is their hospital's commitment,
    // not an anonymous system action.
    expect(outcome.reservation?.reservedByUserId).toBe(actorUserId);

    expect((await prisma.bed.findUniqueOrThrow({ where: { id: oldest.id } })).status).toBe(
      BedStatus.RESERVED,
    );
    expect((await prisma.bed.findUniqueOrThrow({ where: { id: newer.id } })).status).toBe(
      BedStatus.AVAILABLE,
    );

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
      actorUserId,
      actorType: 'HOSPITAL_STAFF',
    });
  });

  it('reports NO_AVAILABLE_BED without selecting anything when the hospital has no beds', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedAcceptedEmergency({ hospitalId: scope.hospitalId });

    const outcome = await autoReserveBedForAcceptedResponse(scope, seed.response.id, actorUserId);

    expect(outcome).toMatchObject({
      reserved: false,
      reservation: null,
      reason: 'NO_AVAILABLE_BED',
      attempts: 0,
    });

    // Finding no bed is a normal outcome: nothing moves and nothing is recorded as failed.
    const emergency = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: seed.emergency.id },
    });
    expect(emergency.currentStatus).toBe(EmergencyStatus.HOSPITAL_ACCEPTED);
    expect(await prisma.bedReservation.count({ where: { emergencyId: seed.emergency.id } })).toBe(
      0,
    );
    expect(
      await prisma.emergencyStatusHistory.count({ where: { emergencyId: seed.emergency.id } }),
    ).toBe(0);
  });

  it('never considers a bed that is not AVAILABLE', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedAcceptedEmergency({ hospitalId: scope.hospitalId });
    const unavailable = await Promise.all([
      createAgedBed(scope.hospitalId, 30, BedStatus.RESERVED),
      createAgedBed(scope.hospitalId, 20, BedStatus.OCCUPIED),
      createAgedBed(scope.hospitalId, 10, BedStatus.OUT_OF_SERVICE),
    ]);

    const outcome = await autoReserveBedForAcceptedResponse(scope, seed.response.id, actorUserId);

    expect(outcome.reserved).toBe(false);
    expect(outcome.reason).toBe('NO_AVAILABLE_BED');

    for (const bed of unavailable) {
      const stored = await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } });
      expect(stored.status).toBe(bed.status);
    }
    expect(await prisma.bedReservation.count({ where: { emergencyId: seed.emergency.id } })).toBe(
      0,
    );
  });

  it('never reserves a bed belonging to another hospital', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const actorUserId = await createActor();
    const seedA = await seedAcceptedEmergency({ hospitalId: scopeA.hospitalId });
    const bedB = await createAgedBed(scopeB.hospitalId, 30);

    const outcome = await autoReserveBedForAcceptedResponse(scopeA, seedA.response.id, actorUserId);

    expect(outcome.reserved).toBe(false);
    expect(outcome.reason).toBe('NO_AVAILABLE_BED');
    expect((await prisma.bed.findUniqueOrThrow({ where: { id: bedB.id } })).status).toBe(
      BedStatus.AVAILABLE,
    );
  });

  it('surfaces a non-contention failure instead of walking the ward', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    // The response was never accepted, so every candidate bed would fail identically.
    const seed = await seedAcceptedEmergency({
      hospitalId: scope.hospitalId,
      responseStatus: HospitalResponseStatus.PENDING,
      emergencyStatus: EmergencyStatus.PENDING_HOSPITAL_RESPONSE,
    });
    const beds = await Promise.all([
      createAgedBed(scope.hospitalId, 30),
      createAgedBed(scope.hospitalId, 20),
    ]);

    await expect(
      autoReserveBedForAcceptedResponse(scope, seed.response.id, actorUserId),
    ).rejects.toMatchObject({ code: 'HOSPITAL_RESPONSE_STATUS_CONFLICT' });

    for (const bed of beds) {
      expect((await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } })).status).toBe(
        BedStatus.AVAILABLE,
      );
    }
  });

  it('consumes no bed when the emergency already holds a reservation', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedAcceptedEmergency({ hospitalId: scope.hospitalId });
    const first = await createAgedBed(scope.hospitalId, 30);
    const second = await createAgedBed(scope.hospitalId, 20);

    const initial = await autoReserveBedForAcceptedResponse(scope, seed.response.id, actorUserId);
    expect(initial.reservation?.bedId).toBe(first.id);

    // BED_RESERVATION_CONFLICT is not contention, so it must not be retried against the
    // next bed and must not leave a claimed-then-abandoned bed behind.
    await expect(
      autoReserveBedForAcceptedResponse(scope, seed.response.id, actorUserId),
    ).rejects.toMatchObject({ code: 'BED_RESERVATION_CONFLICT' });

    expect((await prisma.bed.findUniqueOrThrow({ where: { id: second.id } })).status).toBe(
      BedStatus.AVAILABLE,
    );
    expect(
      await prisma.bedReservation.count({
        where: { emergencyId: seed.emergency.id, status: BedReservationStatus.RESERVED },
      }),
    ).toBe(1);
  });

  it.each([1, 2, 3])(
    'run %i: concurrent acceptances never double-book a bed and never over-report',
    async () => {
      const scope = await createScope();
      const actorUserId = await createActor();
      const seeds = await Promise.all([
        seedAcceptedEmergency({ hospitalId: scope.hospitalId }),
        seedAcceptedEmergency({ hospitalId: scope.hospitalId }),
        seedAcceptedEmergency({ hospitalId: scope.hospitalId }),
        seedAcceptedEmergency({ hospitalId: scope.hospitalId }),
      ]);
      const beds = [];
      for (let index = 0; index < seeds.length; index += 1) {
        beds.push(await createAgedBed(scope.hospitalId, 40 - index));
      }
      const bedIds = beds.map((bed) => bed.id);

      const outcomes = await Promise.all(
        seeds.map((seed) =>
          autoReserveBedForAcceptedResponse(scope, seed.response.id, actorUserId),
        ),
      );

      // Asserted on the observed outcome rather than a predicted one: how many callers win
      // depends on interleaving, but the invariants below hold for every interleaving.
      const winners = outcomes.filter((outcome) => outcome.reserved);
      const heldBedIds = winners.map((outcome) => outcome.reservation!.bedId);
      expect(new Set(heldBedIds).size).toBe(heldBedIds.length);
      heldBedIds.forEach((bedId) => expect(bedIds).toContain(bedId));
      winners.forEach((outcome) => {
        expect(outcome.attempts).toBeGreaterThanOrEqual(1);
        expect(outcome.attempts).toBeLessThanOrEqual(3);
        expect(outcome.reason).toBeUndefined();
      });
      outcomes
        .filter((outcome) => !outcome.reserved)
        .forEach((outcome) => {
          expect(outcome.reservation).toBeNull();
          expect(['NO_AVAILABLE_BED', 'CONTENTION_EXHAUSTED']).toContain(outcome.reason);
        });

      // The database agrees with what the callers were told.
      expect(
        await prisma.bedReservation.count({
          where: { bedId: { in: bedIds }, status: BedReservationStatus.RESERVED },
        }),
      ).toBe(winners.length);
      expect(
        await prisma.bed.count({ where: { id: { in: bedIds }, status: BedStatus.RESERVED } }),
      ).toBe(winners.length);
      expect(
        await prisma.emergencyRequest.count({
          where: {
            id: { in: seeds.map((seed) => seed.emergency.id) },
            currentStatus: EmergencyStatus.BED_RESERVED,
          },
        }),
      ).toBe(winners.length);
    },
  );
});
