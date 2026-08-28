import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  HospitalStaffRole,
  HospitalStatus,
  MembershipStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { hashPassword, requireAuth, requireRole, signAccessToken } from '../../auth/index.js';
import {
  requireHospitalMembership,
  requireHospitalStaffRole,
} from './hospital-scope.middleware.js';

const TEST_REG_PREFIX = 'T1569-';
const TEST_PHONE_PREFIX = '+1569';

const randomRegistration = (): string => `${TEST_REG_PREFIX}${randomUUID().slice(0, 12)}`;
const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const buildRes = (): Response => ({}) as Response;

const buildAuthHeaderReq = (authorization?: string): Request =>
  ({
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
  }) as unknown as Request;

const createHospitalRow = async () =>
  prisma.hospital.create({
    data: {
      name: 'Middleware Test Hospital',
      registrationNumber: randomRegistration(),
      phone: randomTestPhone(),
      addressLine: '1 Main Street',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      status: HospitalStatus.VERIFIED,
    },
  });

const createUser = async (role: UserRole, status: UserStatus = UserStatus.ACTIVE) =>
  prisma.user.create({
    data: {
      phone: randomTestPhone(),
      email: `u.${randomUUID()}@example.com`,
      passwordHash: await hashPassword('a-very-strong-passphrase'),
      role,
      status,
      displayName: 'Middleware Test User',
    },
  });

const createStaff = async (hospitalId: string, staffRole: HospitalStaffRole) => {
  const user = await createUser(UserRole.HOSPITAL_STAFF);
  await prisma.hospitalStaffMembership.create({
    data: { hospitalId, userId: user.id, staffRole, status: MembershipStatus.ACTIVE },
  });
  return user;
};

afterAll(async () => {
  const hospitals = await prisma.hospital.findMany({
    where: { registrationNumber: { startsWith: TEST_REG_PREFIX } },
    select: { id: true },
  });
  const hospitalIds = hospitals.map((h) => h.id);

  await prisma.hospitalStaffMembership.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });
  await prisma.user.deleteMany({ where: { phone: { startsWith: TEST_PHONE_PREFIX } } });
});

describe('requireHospitalMembership', () => {
  it('rejects an unauthenticated request', async () => {
    const next = vi.fn();
    await requireHospitalMembership({} as Request, buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });

  it('attaches server-resolved scope for an active member', async () => {
    const hospital = await createHospitalRow();
    const staff = await createStaff(hospital.id, HospitalStaffRole.DISPATCHER);

    const req = {
      user: { userId: staff.id, role: UserRole.HOSPITAL_STAFF, jti: randomUUID() },
    } as unknown as Request;
    const next = vi.fn();
    await requireHospitalMembership(req, buildRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.hospitalStaff).toMatchObject({
      hospitalId: hospital.id,
      staffRole: HospitalStaffRole.DISPATCHER,
    });
  });

  it('denies a HOSPITAL_STAFF user with no membership', async () => {
    const orphan = await createUser(UserRole.HOSPITAL_STAFF);

    const req = {
      user: { userId: orphan.id, role: UserRole.HOSPITAL_STAFF, jti: randomUUID() },
    } as unknown as Request;
    const next = vi.fn();
    await requireHospitalMembership(req, buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'HOSPITAL_SCOPE_DENIED' }));
  });

  it('ignores a client-supplied hospitalId in body or params', async () => {
    const hospitalA = await createHospitalRow();
    const hospitalB = await createHospitalRow();
    const staffA = await createStaff(hospitalA.id, HospitalStaffRole.ADMIN);

    const req = {
      user: { userId: staffA.id, role: UserRole.HOSPITAL_STAFF, jti: randomUUID() },
      body: { hospitalId: hospitalB.id },
      params: { hospitalId: hospitalB.id },
    } as unknown as Request;
    await requireHospitalMembership(req, buildRes(), vi.fn());

    expect(req.hospitalStaff?.hospitalId).toBe(hospitalA.id);
    expect(req.hospitalStaff?.hospitalId).not.toBe(hospitalB.id);
  });
});

describe('requireHospitalStaffRole', () => {
  const reqWithRole = (staffRole: HospitalStaffRole): Request =>
    ({
      hospitalStaff: {
        membershipId: randomUUID(),
        hospitalId: randomUUID(),
        staffRole,
        membershipStatus: MembershipStatus.ACTIVE,
      },
    }) as unknown as Request;

  it('allows a hospital ADMIN', () => {
    const next = vi.fn();
    requireHospitalStaffRole(HospitalStaffRole.ADMIN)(
      reqWithRole(HospitalStaffRole.ADMIN),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith();
  });

  it.each([
    HospitalStaffRole.DISPATCHER,
    HospitalStaffRole.RECEPTIONIST,
    HospitalStaffRole.CLINICAL_COORDINATOR,
  ])('rejects a %s with INSUFFICIENT_HOSPITAL_ROLE', (staffRole) => {
    const next = vi.fn();
    requireHospitalStaffRole(HospitalStaffRole.ADMIN)(reqWithRole(staffRole), buildRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INSUFFICIENT_HOSPITAL_ROLE' }),
    );
  });

  it('rejects when no hospital scope was resolved', () => {
    const next = vi.fn();
    requireHospitalStaffRole(HospitalStaffRole.ADMIN)({} as Request, buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'HOSPITAL_SCOPE_DENIED' }));
  });
});

describe('UserRole gate for hospital routes', () => {
  it.each([UserRole.PATIENT, UserRole.DRIVER, UserRole.ADMIN])(
    'rejects a %s account with INSUFFICIENT_ROLE (system ADMIN is not hospital staff)',
    async (role) => {
      const user = await createUser(role);
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

  it('rejects an unauthenticated request before any hospital scoping', async () => {
    const next = vi.fn();
    await requireAuth(buildAuthHeaderReq(undefined), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });
});
