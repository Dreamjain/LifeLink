import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  BedStatus,
  EmergencyStatus,
  HospitalResponseStatus,
  HospitalStaffRole,
  HospitalStatus,
  MembershipStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { hashPassword, requireAuth, requireRole, signAccessToken } from '../../auth/index.js';
import { requireHospitalStaffRole } from '../middleware/hospital-scope.middleware.js';
import type { HospitalStaffContext } from '../types/hospital.types.js';
import {
  acceptResponse,
  getResponse,
  listResponses,
  rejectResponse,
} from './hospital-response.controller.js';
import {
  createReservation,
  getReservation,
  listReservations,
  releaseReservation,
} from './bed-reservation.controller.js';

const TEST_REG_PREFIX = 'T1577-';
const TEST_PHONE_PREFIX = '+1577';

const RESPONDER_ROLES = [
  HospitalStaffRole.ADMIN,
  HospitalStaffRole.DISPATCHER,
  HospitalStaffRole.CLINICAL_COORDINATOR,
] as const;

const ALL_STAFF_ROLES = [...RESPONDER_ROLES, HospitalStaffRole.RECEPTIONIST] as const;

const randomRegistration = (): string => `${TEST_REG_PREFIX}${randomUUID().slice(0, 12)}`;
const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const buildRes = (): Response => {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

const buildAuthHeaderReq = (authorization?: string): Request =>
  ({
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
  }) as unknown as Request;

const jsonPayload = (res: Response): Record<string, unknown> =>
  (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as Record<
    string,
    unknown
  >;

const buildReq = (options: {
  body?: unknown;
  params?: Record<string, string>;
  scope?: HospitalStaffContext;
  actorUserId?: string;
}): Request =>
  ({
    body: options.body,
    params: options.params ?? {},
    hospitalStaff: options.scope,
    user: options.actorUserId
      ? { userId: options.actorUserId, role: UserRole.HOSPITAL_STAFF, jti: randomUUID() }
      : undefined,
    correlationId: 'test-correlation-id',
  }) as unknown as Request;

const createScope = async (
  staffRole: HospitalStaffRole = HospitalStaffRole.DISPATCHER,
): Promise<HospitalStaffContext> => {
  const hospital = await prisma.hospital.create({
    data: {
      name: 'Response Controller Hospital',
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

const createActor = async (role: UserRole = UserRole.HOSPITAL_STAFF): Promise<string> => {
  const user = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      passwordHash: 'not-used-in-this-fixture',
      role,
      status: UserStatus.ACTIVE,
      displayName: 'Controller Actor',
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

const createBed = async (hospitalId: string) =>
  prisma.bed.create({ data: { hospitalId, bedCode: `B-${randomUUID().slice(0, 8)}` } });

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

describe('response/reservation route authentication', () => {
  it('rejects an unauthenticated request', async () => {
    const next = vi.fn();
    await requireAuth(buildAuthHeaderReq(undefined), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });

  it.each([UserRole.PATIENT, UserRole.DRIVER, UserRole.ADMIN])(
    'rejects a %s account (system ADMIN is not hospital staff)',
    async (role) => {
      const user = await prisma.user.create({
        data: {
          phone: randomTestPhone(),
          passwordHash: await hashPassword('a-very-strong-passphrase'),
          role,
          status: UserStatus.ACTIVE,
          displayName: 'Role Matrix User',
        },
      });
      const token = signAccessToken({ userId: user.id, role: user.role });
      const req = buildAuthHeaderReq(`Bearer ${token}`);

      const authNext = vi.fn();
      await requireAuth(req, buildRes(), authNext);
      expect(authNext).toHaveBeenCalledWith();

      const roleNext = vi.fn();
      requireRole(UserRole.HOSPITAL_STAFF)(req, buildRes(), roleNext);
      expect(roleNext).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_ROLE' }));
    },
  );
});

describe('staff role matrix', () => {
  it.each(ALL_STAFF_ROLES)('%s may read responses and reservations', async (staffRole) => {
    const scope = await createScope(staffRole);
    await seedEmergency({ hospitalId: scope.hospitalId });

    const responsesRes = buildRes();
    await listResponses(buildReq({ scope }), responsesRes, vi.fn());
    expect(responsesRes.status).toHaveBeenCalledWith(200);

    const reservationsRes = buildRes();
    await listReservations(buildReq({ scope }), reservationsRes, vi.fn());
    expect(reservationsRes.status).toHaveBeenCalledWith(200);
  });

  it.each(RESPONDER_ROLES)('%s passes the decision/reservation write gate', (staffRole) => {
    const next = vi.fn();
    requireHospitalStaffRole(...RESPONDER_ROLES)(
      buildReq({
        scope: {
          membershipId: randomUUID(),
          hospitalId: randomUUID(),
          staffRole,
          membershipStatus: MembershipStatus.ACTIVE,
        },
      }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith();
  });

  it('RECEPTIONIST is blocked from the decision/reservation write gate', () => {
    const next = vi.fn();
    requireHospitalStaffRole(...RESPONDER_ROLES)(
      buildReq({
        scope: {
          membershipId: randomUUID(),
          hospitalId: randomUUID(),
          staffRole: HospitalStaffRole.RECEPTIONIST,
          membershipStatus: MembershipStatus.ACTIVE,
        },
      }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INSUFFICIENT_HOSPITAL_ROLE' }),
    );
  });
});

describe('hospital response controller', () => {
  it('accepts a response and returns the updated record', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: scope.hospitalId });
    const res = buildRes();

    await acceptResponse(
      buildReq({ params: { responseId: seed.response.id }, scope, actorUserId }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = jsonPayload(res) as { response: { status: string; responseByUserId: string } };
    expect(payload.response.status).toBe(HospitalResponseStatus.ACCEPTED);
    expect(payload.response.responseByUserId).toBe(actorUserId);
  });

  it.each([
    ['status', { status: 'ACCEPTED' }],
    ['responseByUserId', { responseByUserId: randomUUID() }],
    ['hospitalId', { hospitalId: randomUUID() }],
    ['emergencyId', { emergencyId: randomUUID() }],
  ])('rejects an injected %s on accept and changes nothing', async (_label, injected) => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: scope.hospitalId });
    const next = vi.fn();

    await acceptResponse(
      buildReq({ params: { responseId: seed.response.id }, body: injected, scope, actorUserId }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    const untouched = await prisma.hospitalResponse.findUniqueOrThrow({
      where: { id: seed.response.id },
    });
    expect(untouched.status).toBe(HospitalResponseStatus.PENDING);
  });

  it('requires a rejection reason', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: scope.hospitalId });
    const next = vi.fn();

    await rejectResponse(
      buildReq({ params: { responseId: seed.response.id }, body: {}, scope, actorUserId }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('rejects a response with a reason', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedEmergency({ hospitalId: scope.hospitalId });
    const res = buildRes();

    await rejectResponse(
      buildReq({
        params: { responseId: seed.response.id },
        body: { rejectionReason: 'No ICU capacity.' },
        scope,
        actorUserId,
      }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = jsonPayload(res) as { response: { status: string; rejectionReason: string } };
    expect(payload.response.status).toBe(HospitalResponseStatus.REJECTED);
    expect(payload.response.rejectionReason).toBe('No ICU capacity.');
  });

  it('does not disclose another hospital response', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const actorUserId = await createActor();
    const seedB = await seedEmergency({ hospitalId: scopeB.hospitalId });

    for (const handler of [getResponse, acceptResponse]) {
      const next = vi.fn();
      await handler(
        buildReq({ params: { responseId: seedB.response.id }, scope: scopeA, actorUserId }),
        buildRes(),
        next,
      );
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'HOSPITAL_RESPONSE_NOT_FOUND', statusCode: 404 }),
      );
    }
  });

  it('rejects a request with no resolved hospital scope', async () => {
    const next = vi.fn();
    await listResponses(buildReq({}), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'HOSPITAL_SCOPE_DENIED' }));
  });
});

describe('bed reservation controller', () => {
  const acceptedSeed = async (scope: HospitalStaffContext) =>
    seedEmergency({
      hospitalId: scope.hospitalId,
      emergencyStatus: EmergencyStatus.HOSPITAL_ACCEPTED,
      responseStatus: HospitalResponseStatus.ACCEPTED,
    });

  it('creates and releases a reservation through the full cycle', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await acceptedSeed(scope);
    const bed = await createBed(scope.hospitalId);

    const createRes = buildRes();
    await createReservation(
      buildReq({
        params: { responseId: seed.response.id },
        body: { bedId: bed.id },
        scope,
        actorUserId,
      }),
      createRes,
      vi.fn(),
    );

    expect(createRes.status).toHaveBeenCalledWith(201);
    const created = jsonPayload(createRes) as { reservation: { id: string; status: string } };
    expect(created.reservation.status).toBe('RESERVED');
    expect((await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } })).status).toBe(
      BedStatus.RESERVED,
    );

    const getRes = buildRes();
    await getReservation(
      buildReq({ params: { reservationId: created.reservation.id }, scope, actorUserId }),
      getRes,
      vi.fn(),
    );
    expect(getRes.status).toHaveBeenCalledWith(200);

    const releaseRes = buildRes();
    await releaseReservation(
      buildReq({
        params: { reservationId: created.reservation.id },
        body: { releaseReason: 'Bed unusable.' },
        scope,
        actorUserId,
      }),
      releaseRes,
      vi.fn(),
    );

    expect(releaseRes.status).toHaveBeenCalledWith(200);
    expect(
      (jsonPayload(releaseRes) as { reservation: { status: string } }).reservation.status,
    ).toBe('RELEASED');
    expect((await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } })).status).toBe(
      BedStatus.AVAILABLE,
    );
  });

  it.each([
    ['hospitalId', { hospitalId: randomUUID() }],
    ['status', { status: 'RESERVED' }],
    ['reservedByUserId', { reservedByUserId: randomUUID() }],
    ['emergencyId', { emergencyId: randomUUID() }],
  ])('rejects an injected %s on reservation and creates nothing', async (_label, injected) => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await acceptedSeed(scope);
    const bed = await createBed(scope.hospitalId);
    const next = vi.fn();

    await createReservation(
      buildReq({
        params: { responseId: seed.response.id },
        body: { bedId: bed.id, ...injected },
        scope,
        actorUserId,
      }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(await prisma.bedReservation.count({ where: { bedId: bed.id } })).toBe(0);
    expect((await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } })).status).toBe(
      BedStatus.AVAILABLE,
    );
  });

  it('does not disclose another hospital reservation', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const actorUserId = await createActor();
    const seedB = await acceptedSeed(scopeB);
    const bedB = await createBed(scopeB.hospitalId);

    const createRes = buildRes();
    await createReservation(
      buildReq({
        params: { responseId: seedB.response.id },
        body: { bedId: bedB.id },
        scope: scopeB,
        actorUserId,
      }),
      createRes,
      vi.fn(),
    );
    const reservationId = (jsonPayload(createRes) as { reservation: { id: string } }).reservation
      .id;

    for (const handler of [getReservation, releaseReservation]) {
      const next = vi.fn();
      await handler(
        buildReq({ params: { reservationId }, body: {}, scope: scopeA, actorUserId }),
        buildRes(),
        next,
      );
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'RESERVATION_NOT_FOUND', statusCode: 404 }),
      );
    }

    expect((await prisma.bed.findUniqueOrThrow({ where: { id: bedB.id } })).status).toBe(
      BedStatus.RESERVED,
    );
  });
});
