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
  const hospitals = await prisma.hospital.findMany({
    where: { registrationNumber: { startsWith: TEST_REG_PREFIX } },
    select: { id: true },
  });
  const hospitalIds = hospitals.map((h) => h.id);

  const responses = await prisma.hospitalResponse.findMany({
    where: { hospitalId: { in: hospitalIds } },
    select: { id: true, emergencyId: true },
  });
  const emergencyIds = [...new Set(responses.map((r) => r.emergencyId))];

  await prisma.bedReservation.deleteMany({
    where: { hospitalResponseId: { in: responses.map((r) => r.id) } },
  });
  await prisma.emergencyStatusHistory.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.hospitalResponse.deleteMany({ where: { hospitalId: { in: hospitalIds } } });

  const emergencies = await prisma.emergencyRequest.findMany({
    where: { id: { in: emergencyIds } },
    select: { patientId: true },
  });
  await prisma.emergencyRequest.deleteMany({ where: { id: { in: emergencyIds } } });

  const patientIds = emergencies.map((e) => e.patientId);
  const profiles = await prisma.patientProfile.findMany({
    where: { id: { in: patientIds } },
    select: { userId: true },
  });
  await prisma.patientProfile.deleteMany({ where: { id: { in: patientIds } } });
  await prisma.user.deleteMany({ where: { id: { in: profiles.map((p) => p.userId) } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });
  await prisma.user.deleteMany({ where: { phone: { startsWith: TEST_PHONE_PREFIX } } });
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
