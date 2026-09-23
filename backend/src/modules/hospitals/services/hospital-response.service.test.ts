import { randomUUID } from 'node:crypto';
import {
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

    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: seedA.emergency.id },
    });
    expect(history).toHaveLength(1);
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

  it.each([HospitalResponseStatus.ACCEPTED, HospitalResponseStatus.REJECTED])(
    'refuses to reject a %s response',
    async (responseStatus) => {
      const scope = await createScope();
      const actorUserId = await createActor();
      const seed = await seedEmergency({ hospitalId: scope.hospitalId, responseStatus });

      await expect(
        rejectResponse(scope, seed.response.id, actorUserId, 'Too late.'),
      ).rejects.toMatchObject({ code: 'HOSPITAL_RESPONSE_STATUS_CONFLICT' });
    },
  );

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
