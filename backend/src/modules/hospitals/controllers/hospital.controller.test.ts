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
import { hashPassword } from '../../auth/index.js';
import type { HospitalStaffContext } from '../types/hospital.types.js';
import { createStaff, getOwnHospital, listStaff } from './hospital.controller.js';

const TEST_REG_PREFIX = 'T1570-';
const TEST_PHONE_PREFIX = '+1570';

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

const jsonPayload = (res: Response): Record<string, unknown> =>
  (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as Record<
    string,
    unknown
  >;

const buildReq = (body: unknown, scope?: HospitalStaffContext, userId?: string): Request =>
  ({
    body,
    hospitalStaff: scope,
    user: userId ? { userId, role: UserRole.HOSPITAL_STAFF, jti: randomUUID() } : undefined,
    correlationId: 'test-correlation-id',
  }) as unknown as Request;

const createHospitalRow = async () =>
  prisma.hospital.create({
    data: {
      name: 'Controller Test Hospital',
      registrationNumber: randomRegistration(),
      phone: randomTestPhone(),
      addressLine: '1 Main Street',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      status: HospitalStatus.VERIFIED,
    },
  });

const createStaffMember = async (hospitalId: string, staffRole: HospitalStaffRole) => {
  const user = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      email: `staff.${randomUUID()}@example.com`,
      passwordHash: await hashPassword('a-very-strong-passphrase'),
      role: UserRole.HOSPITAL_STAFF,
      status: UserStatus.ACTIVE,
      displayName: 'Controller Test Staff',
    },
  });
  const membership = await prisma.hospitalStaffMembership.create({
    data: { hospitalId, userId: user.id, staffRole, status: MembershipStatus.ACTIVE },
  });

  const scope: HospitalStaffContext = {
    membershipId: membership.id,
    hospitalId,
    staffRole,
    membershipStatus: MembershipStatus.ACTIVE,
  };

  return { user, scope };
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

describe('hospital.controller getOwnHospital', () => {
  it('returns the caller own hospital and membership', async () => {
    const hospital = await createHospitalRow();
    const { user, scope } = await createStaffMember(hospital.id, HospitalStaffRole.DISPATCHER);
    const res = buildRes();

    await getOwnHospital(buildReq(undefined, scope, user.id), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = jsonPayload(res) as {
      hospital: { id: string };
      membership: { staffRole: string };
    };
    expect(payload.hospital.id).toBe(hospital.id);
    expect(payload.membership.staffRole).toBe(HospitalStaffRole.DISPATCHER);
  });

  it('rejects a request with no resolved hospital scope', async () => {
    const next = vi.fn();
    await getOwnHospital(buildReq(undefined, undefined), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'HOSPITAL_SCOPE_DENIED' }));
  });
});

describe('hospital.controller createStaff', () => {
  const staffBody = (staffRole: string) => ({
    phone: randomTestPhone(),
    email: `new.${randomUUID()}@example.com`,
    password: 'a-very-strong-passphrase',
    displayName: 'Provisioned Staff',
    staffRole,
  });

  it('creates staff scoped to the caller hospital', async () => {
    const hospital = await createHospitalRow();
    const { user, scope } = await createStaffMember(hospital.id, HospitalStaffRole.ADMIN);
    const res = buildRes();

    await createStaff(buildReq(staffBody('DISPATCHER'), scope, user.id), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(201);
    const payload = jsonPayload(res) as {
      membership: { hospitalId: string; staffRole: string; user: Record<string, unknown> };
    };
    expect(payload.membership.hospitalId).toBe(hospital.id);
    expect(payload.membership.staffRole).toBe(HospitalStaffRole.DISPATCHER);
    expect(payload.membership.user).not.toHaveProperty('passwordHash');
  });

  it('rejects an attempt to create a hospital ADMIN', async () => {
    const hospital = await createHospitalRow();
    const { user, scope } = await createStaffMember(hospital.id, HospitalStaffRole.ADMIN);
    const next = vi.fn();

    await createStaff(buildReq(staffBody('ADMIN'), scope, user.id), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it.each([
    ['User.role', { role: 'ADMIN' }],
    ['User.status', { status: 'ACTIVE' }],
    ['membership status', { membershipStatus: 'ACTIVE' }],
    ['hospitalId', { hospitalId: randomUUID() }],
  ])('rejects an injected %s and creates no account', async (_label, injected) => {
    const hospital = await createHospitalRow();
    const { user, scope } = await createStaffMember(hospital.id, HospitalStaffRole.ADMIN);
    const body = { ...staffBody('DISPATCHER'), ...injected };
    const next = vi.fn();

    await createStaff(buildReq(body, scope, user.id), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(await prisma.user.count({ where: { phone: body.phone } })).toBe(0);
  });

  it('ignores any hospital B identifier and always uses the caller scope', async () => {
    const hospitalA = await createHospitalRow();
    const hospitalB = await createHospitalRow();
    const { user, scope } = await createStaffMember(hospitalA.id, HospitalStaffRole.ADMIN);
    const res = buildRes();

    await createStaff(buildReq(staffBody('RECEPTIONIST'), scope, user.id), res, vi.fn());

    const payload = jsonPayload(res) as { membership: { hospitalId: string } };
    expect(payload.membership.hospitalId).toBe(hospitalA.id);
    expect(
      await prisma.hospitalStaffMembership.count({ where: { hospitalId: hospitalB.id } }),
    ).toBe(0);
  });
});

describe('hospital.controller listStaff cross-hospital isolation', () => {
  it('lists only the caller own hospital staff', async () => {
    const hospitalA = await createHospitalRow();
    const hospitalB = await createHospitalRow();
    const a = await createStaffMember(hospitalA.id, HospitalStaffRole.ADMIN);
    const b = await createStaffMember(hospitalB.id, HospitalStaffRole.ADMIN);

    const res = buildRes();
    await listStaff(buildReq(undefined, a.scope, a.user.id), res, vi.fn());

    const payload = jsonPayload(res) as { staff: { user: { id: string }; hospitalId: string }[] };
    const ids = payload.staff.map((s) => s.user.id);
    expect(ids).toContain(a.user.id);
    expect(ids).not.toContain(b.user.id);
    payload.staff.forEach((s) => expect(s.hospitalId).toBe(hospitalA.id));
  });
});
