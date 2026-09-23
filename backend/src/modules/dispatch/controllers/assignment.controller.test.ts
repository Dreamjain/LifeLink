import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  AmbulanceAssignmentStatus,
  DriverAvailability,
  EmergencyStatus,
  HospitalResponseStatus,
  HospitalStaffRole,
  HospitalStatus,
  MembershipStatus,
  UserRole,
  UserStatus,
  VerificationStatus,
} from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { hashPassword, requireAuth, requireRole, signAccessToken } from '../../auth/index.js';
import { requireHospitalStaffRole } from '../../hospitals/middleware/hospital-scope.middleware.js';
import type { HospitalStaffContext } from '../../hospitals/types/hospital.types.js';
import {
  createAssignment,
  getAssignment,
  listAssignments,
} from './hospital-assignment.controller.js';
import {
  acceptAssignment,
  getAssignment as getDriverAssignment,
  listAssignments as listDriverAssignments,
  rejectAssignment,
} from './driver-assignment.controller.js';

const TEST_REG_PREFIX = 'T1618-';
const TEST_PHONE_PREFIX = '+1618';
const TEST_LICENCE_PREFIX = 'L1618-';

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
  role?: UserRole;
}): Request =>
  ({
    body: options.body,
    params: options.params ?? {},
    hospitalStaff: options.scope,
    user: options.actorUserId
      ? {
          userId: options.actorUserId,
          role: options.role ?? UserRole.HOSPITAL_STAFF,
          jti: randomUUID(),
        }
      : undefined,
    correlationId: 'test-correlation-id',
  }) as unknown as Request;

const createScope = async (
  staffRole: HospitalStaffRole = HospitalStaffRole.DISPATCHER,
): Promise<HospitalStaffContext> => {
  const hospital = await prisma.hospital.create({
    data: {
      name: 'Assignment Controller Hospital',
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
      displayName: 'Controller Actor',
    },
  });

  return user.id;
};

const createAmbulance = async (hospitalId: string) =>
  prisma.ambulance.create({
    data: { hospitalId, vehicleNumber: `V-${randomUUID().slice(0, 10)}` },
  });

const createDriverUser = async () => {
  const user = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      passwordHash: 'not-used-in-this-fixture',
      role: UserRole.DRIVER,
      status: UserStatus.ACTIVE,
      displayName: 'Fixture Driver',
      driverProfile: {
        create: {
          licenceNumber: `${TEST_LICENCE_PREFIX}${randomUUID().slice(0, 12)}`,
          verificationStatus: VerificationStatus.VERIFIED,
          availabilityStatus: DriverAvailability.AVAILABLE,
        },
      },
    },
    include: { driverProfile: true },
  });

  return { userId: user.id, profile: user.driverProfile! };
};

const seedReservedEmergency = async (hospitalId: string) => {
  const patientUser = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      passwordHash: 'not-used-in-this-fixture',
      role: UserRole.PATIENT,
      status: UserStatus.ACTIVE,
      displayName: 'Fixture Patient',
      patientProfile: {
        create: {
          allergies: 'FIXTURE-ALLERGY-MUST-NOT-LEAK',
          medicalSummary: 'FIXTURE-SUMMARY-MUST-NOT-LEAK',
        },
      },
    },
    include: { patientProfile: true },
  });

  const emergency = await prisma.emergencyRequest.create({
    data: {
      patientId: patientUser.patientProfile!.id,
      currentStatus: EmergencyStatus.BED_RESERVED,
      pickupAddress: '12 Elm Street',
    },
  });

  const response = await prisma.hospitalResponse.create({
    data: { emergencyId: emergency.id, hospitalId, status: HospitalResponseStatus.ACCEPTED },
  });

  return { emergency, response, patientUser };
};

/** Dispatches one offer through the hospital controller and returns the created record. */
const dispatchOffer = async (scope: HospitalStaffContext) => {
  const actorUserId = await createActor();
  const seed = await seedReservedEmergency(scope.hospitalId);
  const ambulance = await createAmbulance(scope.hospitalId);
  const driver = await createDriverUser();

  const res = buildRes();
  await createAssignment(
    buildReq({
      scope,
      actorUserId,
      params: { emergencyId: seed.emergency.id },
      body: { ambulanceId: ambulance.id, driverId: driver.profile.id },
    }),
    res,
    vi.fn(),
  );

  const assignment = (jsonPayload(res) as { assignment: { id: string } }).assignment;

  return { actorUserId, seed, ambulance, driver, assignment, res };
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
  await prisma.driverProfile.deleteMany({
    where: { licenceNumber: { startsWith: TEST_LICENCE_PREFIX } },
  });

  // 4. Hospital-owned resources, then the hospitals and users themselves.
  await prisma.bed.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.ambulance.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospitalStaffMembership.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('assignment route authentication', () => {
  it('rejects an unauthenticated request', async () => {
    const next = vi.fn();
    await requireAuth(buildAuthHeaderReq(undefined), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });

  const buildPrincipalReq = async (role: UserRole): Promise<Request> => {
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

    return req;
  };

  it.each([UserRole.PATIENT, UserRole.DRIVER, UserRole.ADMIN])(
    'rejects a %s account on hospital dispatch routes (system ADMIN is not hospital staff)',
    async (role) => {
      const req = await buildPrincipalReq(role);

      const roleNext = vi.fn();
      requireRole(UserRole.HOSPITAL_STAFF)(req, buildRes(), roleNext);
      expect(roleNext).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_ROLE' }));
    },
  );

  it.each([UserRole.PATIENT, UserRole.HOSPITAL_STAFF, UserRole.ADMIN])(
    'rejects a %s account on driver assignment routes',
    async (role) => {
      const req = await buildPrincipalReq(role);

      const roleNext = vi.fn();
      requireRole(UserRole.DRIVER)(req, buildRes(), roleNext);
      expect(roleNext).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_ROLE' }));
    },
  );
});

describe('hospital staff role matrix', () => {
  it.each(ALL_STAFF_ROLES)('%s may read assignments', async (staffRole) => {
    const scope = await createScope(staffRole);

    const res = buildRes();
    await listAssignments(buildReq({ scope }), res, vi.fn());
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it.each(RESPONDER_ROLES)('%s passes the dispatch write gate', (staffRole) => {
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

  it('RECEPTIONIST is blocked from the dispatch write gate', () => {
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

describe('hospital assignment controller', () => {
  it.each(RESPONDER_ROLES)('%s can dispatch and read back the assignment', async (staffRole) => {
    const scope = await createScope(staffRole);
    const offer = await dispatchOffer(scope);

    expect(offer.res.status).toHaveBeenCalledWith(201);
    expect(offer.assignment).toMatchObject({ status: AmbulanceAssignmentStatus.OFFERED });

    const readRes = buildRes();
    await getAssignment(
      buildReq({ scope, params: { assignmentId: offer.assignment.id } }),
      readRes,
      vi.fn(),
    );
    expect(readRes.status).toHaveBeenCalledWith(200);
  });

  it('rejects a request with no resolved hospital scope', async () => {
    const next = vi.fn();
    await listAssignments(buildReq({}), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'HOSPITAL_SCOPE_DENIED' }));
  });

  it('rejects a dispatch with no authenticated actor', async () => {
    const scope = await createScope();
    const next = vi.fn();

    await createAssignment(
      buildReq({
        scope,
        params: { emergencyId: randomUUID() },
        body: { ambulanceId: randomUUID(), driverId: randomUUID() },
      }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });

  it('rejects a client-supplied server-controlled field', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const next = vi.fn();

    await createAssignment(
      buildReq({
        scope,
        actorUserId,
        params: { emergencyId: randomUUID() },
        body: {
          ambulanceId: randomUUID(),
          driverId: randomUUID(),
          hospitalId: randomUUID(),
        },
      }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('does not disclose another hospital assignment', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const offerB = await dispatchOffer(scopeB);

    const next = vi.fn();
    await getAssignment(
      buildReq({ scope: scopeA, params: { assignmentId: offerB.assignment.id } }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'ASSIGNMENT_NOT_FOUND' }));
  });

  it('returns no patient or credential data in the dispatch payload', async () => {
    const scope = await createScope();
    const offer = await dispatchOffer(scope);

    const serialized = JSON.stringify(jsonPayload(offer.res));
    expect(serialized).not.toContain('FIXTURE-ALLERGY-MUST-NOT-LEAK');
    expect(serialized).not.toContain('FIXTURE-SUMMARY-MUST-NOT-LEAK');
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain(offer.seed.patientUser.phone);
  });
});

describe('driver assignment controller', () => {
  it('lists, accepts and reports the driver own assignment', async () => {
    const scope = await createScope();
    const offer = await dispatchOffer(scope);

    const listRes = buildRes();
    await listDriverAssignments(
      buildReq({ actorUserId: offer.driver.userId, role: UserRole.DRIVER }),
      listRes,
      vi.fn(),
    );
    expect(listRes.status).toHaveBeenCalledWith(200);

    const acceptRes = buildRes();
    await acceptAssignment(
      buildReq({
        actorUserId: offer.driver.userId,
        role: UserRole.DRIVER,
        params: { assignmentId: offer.assignment.id },
        body: {},
      }),
      acceptRes,
      vi.fn(),
    );
    expect(acceptRes.status).toHaveBeenCalledWith(200);
    expect(jsonPayload(acceptRes)).toMatchObject({
      assignment: { status: AmbulanceAssignmentStatus.ACCEPTED },
    });
  });

  it('rejects an assignment with a reason', async () => {
    const scope = await createScope();
    const offer = await dispatchOffer(scope);

    const res = buildRes();
    await rejectAssignment(
      buildReq({
        actorUserId: offer.driver.userId,
        role: UserRole.DRIVER,
        params: { assignmentId: offer.assignment.id },
        body: { rejectionReason: 'Vehicle fault' },
      }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(jsonPayload(res)).toMatchObject({
      assignment: { status: AmbulanceAssignmentStatus.REJECTED },
    });
  });

  it('requires a rejection reason', async () => {
    const scope = await createScope();
    const offer = await dispatchOffer(scope);
    const next = vi.fn();

    await rejectAssignment(
      buildReq({
        actorUserId: offer.driver.userId,
        role: UserRole.DRIVER,
        params: { assignmentId: offer.assignment.id },
        body: {},
      }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it.each(['accept', 'reject', 'read'] as const)(
    'does not let another driver %s the assignment',
    async (action) => {
      const scope = await createScope();
      const offer = await dispatchOffer(scope);
      const otherDriver = await createDriverUser();
      const next = vi.fn();

      const req = buildReq({
        actorUserId: otherDriver.userId,
        role: UserRole.DRIVER,
        params: { assignmentId: offer.assignment.id },
        body: action === 'reject' ? { rejectionReason: 'Not mine' } : {},
      });

      if (action === 'accept') {
        await acceptAssignment(req, buildRes(), next);
      } else if (action === 'reject') {
        await rejectAssignment(req, buildRes(), next);
      } else {
        await getDriverAssignment(req, buildRes(), next);
      }

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'ASSIGNMENT_NOT_FOUND' }));
    },
  );

  it('rejects a driver request with no authenticated principal', async () => {
    const next = vi.fn();
    await listDriverAssignments(buildReq({}), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });

  it('returns no patient or credential data in the driver payload', async () => {
    const scope = await createScope();
    const offer = await dispatchOffer(scope);

    const res = buildRes();
    await getDriverAssignment(
      buildReq({
        actorUserId: offer.driver.userId,
        role: UserRole.DRIVER,
        params: { assignmentId: offer.assignment.id },
      }),
      res,
      vi.fn(),
    );

    const serialized = JSON.stringify(jsonPayload(res));
    expect(serialized).not.toContain('FIXTURE-ALLERGY-MUST-NOT-LEAK');
    expect(serialized).not.toContain('FIXTURE-SUMMARY-MUST-NOT-LEAK');
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain(offer.seed.patientUser.phone);
  });
});
