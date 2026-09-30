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
  acceptResponse,
  getResponse,
  listResponses,
  rejectResponse,
} from './hospital-response.service.js';

const TEST_REG_PREFIX = 'T1575-';
const TEST_PHONE_PREFIX = '+1575';

const randomRegistration = (): string => `${TEST_REG_PREFIX}${randomUUID().slice(0, 12)}`;
const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const createScope = async (
  staffRole: HospitalStaffRole = HospitalStaffRole.DISPATCHER,
): Promise<HospitalStaffContext> => {
  const hospital = await prisma.hospital.create({
    data: {
      name: 'Response Service Hospital',
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
    staffRole,
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
      displayName: 'Response Actor',
    },
  });

  return user.id;
};

const seedEmergency = async (options: {
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
      description: 'Fixture emergency',
      currentStatus: options.emergencyStatus ?? EmergencyStatus.PENDING_HOSPITAL_RESPONSE,
    },
  });

  const response = await prisma.hospitalResponse.create({
    data: {
      emergencyId: emergency.id,
      hospitalId: options.hospitalId,
      status: options.responseStatus ?? HospitalResponseStatus.PENDING,
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

describe('listResponses / getResponse', () => {
  it('lists only the caller hospital responses and exposes no patient profile data', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const seedA = await seedEmergency({ hospitalId: scopeA.hospitalId });
    const seedB = await seedEmergency({ hospitalId: scopeB.hospitalId });

    const listed = await listResponses(scopeA);

    expect(listed.map((r) => r.id)).toContain(seedA.response.id);
    expect(listed.map((r) => r.id)).not.toContain(seedB.response.id);
    listed.forEach((r) => expect(r.hospitalId).toBe(scopeA.hospitalId));

    const serialized = JSON.stringify(listed);
    expect(serialized).not.toContain('allergies');
    expect(serialized).not.toContain('medicalSummary');
    expect(serialized).not.toContain('passwordHash');
  });

  it('does not disclose another hospital response', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const seedB = await seedEmergency({ hospitalId: scopeB.hospitalId });

    await expect(getResponse(scopeA, seedB.response.id)).rejects.toMatchObject({
      code: 'HOSPITAL_RESPONSE_NOT_FOUND',
    });
  });

  it('rejects a nonexistent response', async () => {
    const scope = await createScope();

    await expect(getResponse(scope, randomUUID())).rejects.toMatchObject({
      code: 'HOSPITAL_RESPONSE_NOT_FOUND',
    });
  });
});

describe('acceptResponse', () => {
  it('accepts a PENDING response, records actor and timestamp, and advances the emergency', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: scope.hospitalId });

    const accepted = await acceptResponse(scope, seed.response.id, actorUserId);

    expect(accepted.status).toBe(HospitalResponseStatus.ACCEPTED);
    expect(accepted.responseByUserId).toBe(actorUserId);
    expect(accepted.respondedAt).toBeInstanceOf(Date);

    const emergency = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: seed.emergency.id },
    });
    expect(emergency.currentStatus).toBe(EmergencyStatus.HOSPITAL_ACCEPTED);

    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: seed.emergency.id },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromStatus: EmergencyStatus.PENDING_HOSPITAL_RESPONSE,
      toStatus: EmergencyStatus.HOSPITAL_ACCEPTED,
      actorUserId,
      actorType: 'HOSPITAL_STAFF',
    });
  });

  it.each([
    HospitalResponseStatus.ACCEPTED,
    HospitalResponseStatus.REJECTED,
    HospitalResponseStatus.EXPIRED,
    HospitalResponseStatus.WITHDRAWN,
  ])('refuses to accept a %s response', async (responseStatus) => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: scope.hospitalId, responseStatus });

    await expect(acceptResponse(scope, seed.response.id, actorUserId)).rejects.toMatchObject({
      code: 'HOSPITAL_RESPONSE_STATUS_CONFLICT',
    });
  });

  it('refuses when the emergency is no longer awaiting a hospital response', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({
      hospitalId: scope.hospitalId,
      emergencyStatus: EmergencyStatus.HOSPITAL_ACCEPTED,
    });

    await expect(acceptResponse(scope, seed.response.id, actorUserId)).rejects.toMatchObject({
      code: 'EMERGENCY_STATUS_CONFLICT',
    });

    // The whole transaction rolled back: the response must still be PENDING.
    const untouched = await prisma.hospitalResponse.findUniqueOrThrow({
      where: { id: seed.response.id },
    });
    expect(untouched.status).toBe(HospitalResponseStatus.PENDING);
  });

  it('cannot accept another hospital response', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const actorUserId = await createActor();
    const seedB = await seedEmergency({ hospitalId: scopeB.hospitalId });

    await expect(acceptResponse(scopeA, seedB.response.id, actorUserId)).rejects.toMatchObject({
      code: 'HOSPITAL_RESPONSE_NOT_FOUND',
    });

    const untouched = await prisma.hospitalResponse.findUniqueOrThrow({
      where: { id: seedB.response.id },
    });
    expect(untouched.status).toBe(HospitalResponseStatus.PENDING);
  });
});

describe('competing acceptance race', () => {
  it.each([1, 2, 3])('run %i: exactly one hospital wins the same emergency', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const actorA = await createActor();
    const actorB = await createActor();

    const seedA = await seedEmergency({ hospitalId: scopeA.hospitalId });
    // Second hospital offered the same emergency.
    const responseB = await prisma.hospitalResponse.create({
      data: {
        emergencyId: seedA.emergency.id,
        hospitalId: scopeB.hospitalId,
        status: HospitalResponseStatus.PENDING,
      },
    });

    const outcomes = await Promise.allSettled([
      acceptResponse(scopeA, seedA.response.id, actorA),
      acceptResponse(scopeB, responseB.id, actorB),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);

    const accepted = await prisma.hospitalResponse.findMany({
      where: {
        emergencyId: seedA.emergency.id,
        status: HospitalResponseStatus.ACCEPTED,
      },
    });
    expect(accepted).toHaveLength(1);

    const emergency = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: seedA.emergency.id },
    });
    expect(emergency.currentStatus).toBe(EmergencyStatus.HOSPITAL_ACCEPTED);

    // Task 1.19: the losing offer is withdrawn by the winner's transaction, never left
    // PENDING and never rejected.
    const all = await prisma.hospitalResponse.findMany({
      where: { emergencyId: seedA.emergency.id },
    });
    expect(all).toHaveLength(2);
    const loser = all.find((entry) => entry.status !== HospitalResponseStatus.ACCEPTED);
    expect(loser?.status).toBe(HospitalResponseStatus.WITHDRAWN);
    expect(loser?.responseByUserId).toBeNull();
    expect(loser?.respondedAt).toBeNull();
    expect(loser?.rejectionReason).toBeNull();

    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: seedA.emergency.id },
    });
    expect(history).toHaveLength(1);
  });
});

describe('competing offer withdrawal', () => {
  /** Adds another hospital's offer for the same emergency. */
  const addSiblingOffer = async (
    emergencyId: string,
    hospitalId: string,
    status: HospitalResponseStatus = HospitalResponseStatus.PENDING,
  ) =>
    prisma.hospitalResponse.create({
      data: {
        emergencyId,
        hospitalId,
        status,
        ...(status === HospitalResponseStatus.REJECTED
          ? { rejectionReason: 'No ICU capacity.', respondedAt: new Date() }
          : {}),
      },
    });

  it('withdraws every sibling PENDING offer and keeps the accepted one ACCEPTED', async () => {
    const winner = await createScope();
    const loserOne = await createScope();
    const loserTwo = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: winner.hospitalId });
    const siblingOne = await addSiblingOffer(seed.emergency.id, loserOne.hospitalId);
    const siblingTwo = await addSiblingOffer(seed.emergency.id, loserTwo.hospitalId);

    const accepted = await acceptResponse(winner, seed.response.id, actorUserId);

    expect(accepted.status).toBe(HospitalResponseStatus.ACCEPTED);
    const stored = await prisma.hospitalResponse.findUniqueOrThrow({
      where: { id: seed.response.id },
    });
    expect(stored.status).toBe(HospitalResponseStatus.ACCEPTED);
    expect(stored.responseByUserId).toBe(actorUserId);

    for (const siblingId of [siblingOne.id, siblingTwo.id]) {
      const sibling = await prisma.hospitalResponse.findUniqueOrThrow({
        where: { id: siblingId },
      });
      expect(sibling.status).toBe(HospitalResponseStatus.WITHDRAWN);
      // Nobody at those hospitals decided anything, so no decision metadata is written.
      expect(sibling.responseByUserId).toBeNull();
      expect(sibling.respondedAt).toBeNull();
      expect(sibling.rejectionReason).toBeNull();
    }
  });

  it('leaves an already REJECTED sibling REJECTED with its reason intact', async () => {
    const winner = await createScope();
    const rejecter = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: winner.hospitalId });
    const rejected = await addSiblingOffer(
      seed.emergency.id,
      rejecter.hospitalId,
      HospitalResponseStatus.REJECTED,
    );

    await acceptResponse(winner, seed.response.id, actorUserId);

    const stored = await prisma.hospitalResponse.findUniqueOrThrow({ where: { id: rejected.id } });
    expect(stored.status).toBe(HospitalResponseStatus.REJECTED);
    expect(stored.rejectionReason).toBe('No ICU capacity.');
    expect(stored.respondedAt).not.toBeNull();
  });

  it('leaves an already WITHDRAWN sibling WITHDRAWN', async () => {
    const winner = await createScope();
    const other = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: winner.hospitalId });
    const withdrawn = await addSiblingOffer(
      seed.emergency.id,
      other.hospitalId,
      HospitalResponseStatus.WITHDRAWN,
    );

    await acceptResponse(winner, seed.response.id, actorUserId);

    expect(
      (await prisma.hospitalResponse.findUniqueOrThrow({ where: { id: withdrawn.id } })).status,
    ).toBe(HospitalResponseStatus.WITHDRAWN);
  });

  it('does not touch a PENDING offer belonging to a different emergency', async () => {
    const winner = await createScope();
    const bystander = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: winner.hospitalId });
    const otherEmergency = await seedEmergency({ hospitalId: bystander.hospitalId });

    await acceptResponse(winner, seed.response.id, actorUserId);

    const untouched = await prisma.hospitalResponse.findUniqueOrThrow({
      where: { id: otherEmergency.response.id },
    });
    expect(untouched.status).toBe(HospitalResponseStatus.PENDING);
    expect(
      await prisma.emergencyRequest.findUniqueOrThrow({
        where: { id: otherEmergency.emergency.id },
      }),
    ).toMatchObject({ currentStatus: EmergencyStatus.PENDING_HOSPITAL_RESPONSE });
  });

  it('writes exactly one history row for the acceptance and none for the withdrawals', async () => {
    const winner = await createScope();
    const loserOne = await createScope();
    const loserTwo = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: winner.hospitalId });
    await addSiblingOffer(seed.emergency.id, loserOne.hospitalId);
    await addSiblingOffer(seed.emergency.id, loserTwo.hospitalId);

    await acceptResponse(winner, seed.response.id, actorUserId);

    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: seed.emergency.id },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromStatus: EmergencyStatus.PENDING_HOSPITAL_RESPONSE,
      toStatus: EmergencyStatus.HOSPITAL_ACCEPTED,
      actorUserId,
      actorType: 'HOSPITAL_STAFF',
    });
  });

  it('rolls the whole acceptance back when the emergency transition fails', async () => {
    const winner = await createScope();
    const loser = await createScope();
    const actorUserId = await createActor();
    // The emergency has already left PENDING_HOSPITAL_RESPONSE, so the transition must fail.
    const seed = await seedEmergency({
      hospitalId: winner.hospitalId,
      emergencyStatus: EmergencyStatus.HOSPITAL_ACCEPTED,
    });
    const sibling = await addSiblingOffer(seed.emergency.id, loser.hospitalId);

    await expect(acceptResponse(winner, seed.response.id, actorUserId)).rejects.toMatchObject({
      code: 'EMERGENCY_STATUS_CONFLICT',
    });

    expect(
      (await prisma.hospitalResponse.findUniqueOrThrow({ where: { id: seed.response.id } })).status,
    ).toBe(HospitalResponseStatus.PENDING);
    expect(
      (await prisma.hospitalResponse.findUniqueOrThrow({ where: { id: sibling.id } })).status,
    ).toBe(HospitalResponseStatus.PENDING);
    expect(
      await prisma.emergencyStatusHistory.count({ where: { emergencyId: seed.emergency.id } }),
    ).toBe(0);
  });

  it('refuses to accept or reject a withdrawn offer afterwards', async () => {
    const winner = await createScope();
    const loser = await createScope();
    const actorUserId = await createActor();
    const loserActorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: winner.hospitalId });
    const sibling = await addSiblingOffer(seed.emergency.id, loser.hospitalId);

    await acceptResponse(winner, seed.response.id, actorUserId);

    await expect(acceptResponse(loser, sibling.id, loserActorUserId)).rejects.toMatchObject({
      code: 'HOSPITAL_RESPONSE_STATUS_CONFLICT',
    });
    await expect(
      rejectResponse(loser, sibling.id, loserActorUserId, 'Changed our mind.'),
    ).rejects.toMatchObject({ code: 'HOSPITAL_RESPONSE_STATUS_CONFLICT' });
  });
});

describe('rejectResponse', () => {
  it('rejects a PENDING response with reason, actor and timestamp', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: scope.hospitalId });

    const rejected = await rejectResponse(scope, seed.response.id, actorUserId, 'No ICU capacity.');

    expect(rejected.status).toBe(HospitalResponseStatus.REJECTED);
    expect(rejected.rejectionReason).toBe('No ICU capacity.');
    expect(rejected.responseByUserId).toBe(actorUserId);
    expect(rejected.respondedAt).toBeInstanceOf(Date);
  });

  it('leaves the emergency status to the orchestration layer', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: scope.hospitalId });

    await rejectResponse(scope, seed.response.id, actorUserId, 'No capacity.');

    const emergency = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: seed.emergency.id },
    });
    expect(emergency.currentStatus).toBe(EmergencyStatus.PENDING_HOSPITAL_RESPONSE);

    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: seed.emergency.id },
    });
    expect(history).toHaveLength(0);
  });

  it.each([
    HospitalResponseStatus.ACCEPTED,
    HospitalResponseStatus.REJECTED,
    HospitalResponseStatus.EXPIRED,
    HospitalResponseStatus.WITHDRAWN,
  ])('refuses to reject a %s response', async (responseStatus) => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: scope.hospitalId, responseStatus });

    await expect(
      rejectResponse(scope, seed.response.id, actorUserId, 'Too late.'),
    ).rejects.toMatchObject({ code: 'HOSPITAL_RESPONSE_STATUS_CONFLICT' });
  });

  it('cannot reject another hospital response', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const actorUserId = await createActor();
    const seedB = await seedEmergency({ hospitalId: scopeB.hospitalId });

    await expect(
      rejectResponse(scopeA, seedB.response.id, actorUserId, 'Not mine.'),
    ).rejects.toMatchObject({ code: 'HOSPITAL_RESPONSE_NOT_FOUND' });
  });
});

describe('automatic bed reservation on acceptance', () => {
  /**
   * Beds carry an explicit createdAt so "the oldest AVAILABLE bed" is a property of the
   * fixture rather than a race between two inserts landing in the same millisecond.
   */
  const createBed = async (
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

  it('holds the oldest available bed and returns the emergency already advanced', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: scope.hospitalId });
    const oldest = await createBed(scope.hospitalId, 30);
    const newer = await createBed(scope.hospitalId, 5);

    const accepted = await acceptResponse(scope, seed.response.id, actorUserId);

    expect(accepted.status).toBe(HospitalResponseStatus.ACCEPTED);
    expect(accepted.responseByUserId).toBe(actorUserId);
    // acceptResponse re-reads after the reservation, so the caller is told the real state.
    expect(accepted.emergency.currentStatus).toBe(EmergencyStatus.BED_RESERVED);

    const reservation = await prisma.bedReservation.findFirstOrThrow({
      where: { emergencyId: seed.emergency.id },
    });
    expect(reservation.bedId).toBe(oldest.id);
    expect(reservation.hospitalResponseId).toBe(seed.response.id);
    expect(reservation.status).toBe(BedReservationStatus.RESERVED);
    // The accepting staff member, not SYSTEM and not null.
    expect(reservation.reservedByUserId).toBe(actorUserId);

    expect((await prisma.bed.findUniqueOrThrow({ where: { id: oldest.id } })).status).toBe(
      BedStatus.RESERVED,
    );
    expect((await prisma.bed.findUniqueOrThrow({ where: { id: newer.id } })).status).toBe(
      BedStatus.AVAILABLE,
    );
  });

  it('records the acceptance and the reservation as two separate history rows', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: scope.hospitalId });
    await createBed(scope.hospitalId, 30);

    await acceptResponse(scope, seed.response.id, actorUserId);

    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: seed.emergency.id },
    });
    expect(history).toHaveLength(2);

    const acceptance = history.find(
      (entry) => entry.toStatus === EmergencyStatus.HOSPITAL_ACCEPTED,
    );
    const reservation = history.find((entry) => entry.toStatus === EmergencyStatus.BED_RESERVED);

    expect(acceptance).toMatchObject({
      fromStatus: EmergencyStatus.PENDING_HOSPITAL_RESPONSE,
      actorUserId,
      actorType: 'HOSPITAL_STAFF',
    });
    expect(reservation).toMatchObject({
      fromStatus: EmergencyStatus.HOSPITAL_ACCEPTED,
      actorUserId,
      actorType: 'HOSPITAL_STAFF',
    });
    expect(reservation!.occurredAt.getTime()).toBeGreaterThanOrEqual(
      acceptance!.occurredAt.getTime(),
    );
  });

  it('leaves the acceptance standing when the hospital has no bed to give', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: scope.hospitalId });

    const accepted = await acceptResponse(scope, seed.response.id, actorUserId);

    // An acceptance is never rolled back, downgraded or withdrawn because no bed was free.
    expect(accepted.status).toBe(HospitalResponseStatus.ACCEPTED);
    expect(accepted.emergency.currentStatus).toBe(EmergencyStatus.HOSPITAL_ACCEPTED);

    const stored = await prisma.hospitalResponse.findUniqueOrThrow({
      where: { id: seed.response.id },
    });
    expect(stored.status).toBe(HospitalResponseStatus.ACCEPTED);
    expect(stored.responseByUserId).toBe(actorUserId);
    expect(stored.respondedAt).not.toBeNull();

    // No FAILED reservation row is invented for a bed that was never sought successfully.
    expect(await prisma.bedReservation.count({ where: { emergencyId: seed.emergency.id } })).toBe(
      0,
    );
    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: seed.emergency.id },
    });
    expect(history).toHaveLength(1);
    expect(history[0]!.toStatus).toBe(EmergencyStatus.HOSPITAL_ACCEPTED);
  });

  it('keeps the acceptance when every bed is unavailable and touches none of them', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: scope.hospitalId });
    const beds = await Promise.all([
      createBed(scope.hospitalId, 30, BedStatus.RESERVED),
      createBed(scope.hospitalId, 20, BedStatus.OCCUPIED),
      createBed(scope.hospitalId, 10, BedStatus.OUT_OF_SERVICE),
    ]);

    const accepted = await acceptResponse(scope, seed.response.id, actorUserId);

    expect(accepted.emergency.currentStatus).toBe(EmergencyStatus.HOSPITAL_ACCEPTED);
    for (const bed of beds) {
      expect((await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } })).status).toBe(
        bed.status,
      );
    }
    expect(await prisma.bedReservation.count({ where: { emergencyId: seed.emergency.id } })).toBe(
      0,
    );
  });

  it('never takes a bed belonging to a different hospital', async () => {
    const accepting = await createScope();
    const bystander = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: accepting.hospitalId });
    const foreignBed = await createBed(bystander.hospitalId, 30);

    const accepted = await acceptResponse(accepting, seed.response.id, actorUserId);

    expect(accepted.emergency.currentStatus).toBe(EmergencyStatus.HOSPITAL_ACCEPTED);
    expect((await prisma.bed.findUniqueOrThrow({ where: { id: foreignBed.id } })).status).toBe(
      BedStatus.AVAILABLE,
    );
    expect(await prisma.bedReservation.count({ where: { emergencyId: seed.emergency.id } })).toBe(
      0,
    );
  });

  it('still withdraws competing offers when a bed is reserved', async () => {
    const winner = await createScope();
    const loser = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: winner.hospitalId });
    const sibling = await prisma.hospitalResponse.create({
      data: {
        emergencyId: seed.emergency.id,
        hospitalId: loser.hospitalId,
        status: HospitalResponseStatus.PENDING,
      },
    });
    const bed = await createBed(winner.hospitalId, 30);

    const accepted = await acceptResponse(winner, seed.response.id, actorUserId);

    expect(accepted.emergency.currentStatus).toBe(EmergencyStatus.BED_RESERVED);
    expect(
      (await prisma.hospitalResponse.findUniqueOrThrow({ where: { id: sibling.id } })).status,
    ).toBe(HospitalResponseStatus.WITHDRAWN);
    expect((await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } })).status).toBe(
      BedStatus.RESERVED,
    );
  });

  it('reserves nothing when the acceptance itself fails', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    // Already placed elsewhere, so the acceptance transaction must fail before committing.
    const seed = await seedEmergency({
      hospitalId: scope.hospitalId,
      emergencyStatus: EmergencyStatus.HOSPITAL_ACCEPTED,
    });
    const bed = await createBed(scope.hospitalId, 30);

    await expect(acceptResponse(scope, seed.response.id, actorUserId)).rejects.toMatchObject({
      code: 'EMERGENCY_STATUS_CONFLICT',
    });

    expect((await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } })).status).toBe(
      BedStatus.AVAILABLE,
    );
    expect(await prisma.bedReservation.count({ where: { emergencyId: seed.emergency.id } })).toBe(
      0,
    );
  });

  it('reserves nothing when the offer is rejected', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: scope.hospitalId });
    const bed = await createBed(scope.hospitalId, 30);

    await rejectResponse(scope, seed.response.id, actorUserId, 'No ICU capacity.');

    expect((await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } })).status).toBe(
      BedStatus.AVAILABLE,
    );
    expect(await prisma.bedReservation.count({ where: { emergencyId: seed.emergency.id } })).toBe(
      0,
    );
    expect(
      (await prisma.emergencyRequest.findUniqueOrThrow({ where: { id: seed.emergency.id } }))
        .currentStatus,
    ).toBe(EmergencyStatus.PENDING_HOSPITAL_RESPONSE);
  });
});
