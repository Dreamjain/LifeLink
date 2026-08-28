import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { HospitalStaffRole, HospitalStatus, UserRole, UserStatus } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { hashPassword, requireAuth, requireRole, signAccessToken } from '../../auth/index.js';
import type { AuthenticatedPrincipal } from '../../auth/index.js';
import {
  create,
  getDetail,
  list,
  provisionAdmin,
  reject,
  verify,
} from './admin-hospital.controller.js';

const TEST_REG_PREFIX = 'T1571-';
const TEST_PHONE_PREFIX = '+1571';

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

const adminPrincipal = (): AuthenticatedPrincipal => ({
  userId: randomUUID(),
  role: UserRole.ADMIN,
  jti: randomUUID(),
});

const buildReq = (options: { body?: unknown; params?: Record<string, string> } = {}): Request =>
  ({
    user: adminPrincipal(),
    body: options.body,
    params: options.params ?? {},
    correlationId: 'test',
  }) as unknown as Request;

const hospitalBody = () => ({
  name: 'Admin Controller Hospital',
  registrationNumber: randomRegistration(),
  phone: randomTestPhone(),
  addressLine: '1 Main Street',
  city: 'Springfield',
  state: 'IL',
  postalCode: '62701',
});

const createUser = async (role: UserRole) =>
  prisma.user.create({
    data: {
      phone: randomTestPhone(),
      email: `u.${randomUUID()}@example.com`,
      passwordHash: await hashPassword('a-very-strong-passphrase'),
      role,
      status: UserStatus.ACTIVE,
      displayName: 'Admin Hospital Role Matrix',
    },
  });

const createHospitalVia = async (): Promise<string> => {
  const res = buildRes();
  await create(buildReq({ body: hospitalBody() }), res, vi.fn());
  return (jsonPayload(res) as { hospital: { id: string } }).hospital.id;
};

afterAll(async () => {
  const hospitals = await prisma.hospital.findMany({
    where: { registrationNumber: { startsWith: TEST_REG_PREFIX } },
    select: { id: true },
  });
  const hospitalIds = hospitals.map((h) => h.id);

  const memberships = await prisma.hospitalStaffMembership.findMany({
    where: { hospitalId: { in: hospitalIds } },
    select: { userId: true },
  });

  await prisma.hospitalStaffMembership.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.user.deleteMany({ where: { id: { in: memberships.map((m) => m.userId) } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });
  await prisma.user.deleteMany({ where: { phone: { startsWith: TEST_PHONE_PREFIX } } });
});

describe('admin hospital route authorization', () => {
  it('rejects an unauthenticated request', async () => {
    const next = vi.fn();
    await requireAuth(buildAuthHeaderReq(undefined), buildRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });

  it.each([UserRole.PATIENT, UserRole.DRIVER, UserRole.HOSPITAL_STAFF])(
    'rejects a %s account with INSUFFICIENT_ROLE',
    async (role) => {
      const user = await createUser(role);
      const token = signAccessToken({ userId: user.id, role: user.role });
      const req = buildAuthHeaderReq(`Bearer ${token}`);

      const authNext = vi.fn();
      await requireAuth(req, buildRes(), authNext);
      expect(authNext).toHaveBeenCalledWith();

      const roleNext = vi.fn();
      requireRole(UserRole.ADMIN)(req, buildRes(), roleNext);
      expect(roleNext).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_ROLE' }));
    },
  );
});

describe('admin-hospital.controller', () => {
  it('creates a hospital with PENDING_VERIFICATION', async () => {
    const res = buildRes();
    await create(buildReq({ body: hospitalBody() }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(201);
    const payload = jsonPayload(res) as { hospital: { status: string } };
    expect(payload.hospital.status).toBe(HospitalStatus.PENDING_VERIFICATION);
  });

  it('rejects an injected status on creation and creates nothing', async () => {
    const body = { ...hospitalBody(), status: 'VERIFIED' };
    const next = vi.fn();

    await create(buildReq({ body }), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(
      await prisma.hospital.count({ where: { registrationNumber: body.registrationNumber } }),
    ).toBe(0);
  });

  it('verifies then refuses to re-verify', async () => {
    const hospitalId = await createHospitalVia();

    const res = buildRes();
    await verify(buildReq({ params: { hospitalId } }), res, vi.fn());
    expect((jsonPayload(res) as { hospital: { status: string } }).hospital.status).toBe(
      HospitalStatus.VERIFIED,
    );

    const next = vi.fn();
    await verify(buildReq({ params: { hospitalId } }), buildRes(), next);
    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'HOSPITAL_STATUS_CONFLICT', statusCode: 409 }),
    );
  });

  it('rejects a hospital and does not persist the optional reason', async () => {
    const hospitalId = await createHospitalVia();

    const res = buildRes();
    await reject(
      buildReq({ params: { hospitalId }, body: { reason: 'Incomplete registration paperwork.' } }),
      res,
      vi.fn(),
    );

    expect((jsonPayload(res) as { hospital: { status: string } }).hospital.status).toBe(
      HospitalStatus.REJECTED,
    );

    const stored = await prisma.hospital.findUniqueOrThrow({ where: { id: hospitalId } });
    expect(Object.keys(stored)).not.toContain('rejectionReason');
    expect(JSON.stringify(stored)).not.toContain('Incomplete registration paperwork.');
  });

  it('returns HOSPITAL_NOT_FOUND for a nonexistent hospital detail', async () => {
    const next = vi.fn();
    await getDetail(buildReq({ params: { hospitalId: randomUUID() } }), buildRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'HOSPITAL_NOT_FOUND', statusCode: 404 }),
    );
  });

  it('lists hospitals', async () => {
    const hospitalId = await createHospitalVia();
    const res = buildRes();

    await list(buildReq(), res, vi.fn());

    const payload = jsonPayload(res) as { hospitals: { id: string }[] };
    expect(payload.hospitals.map((h) => h.id)).toContain(hospitalId);
  });

  it('provisions the first hospital admin only after verification', async () => {
    const hospitalId = await createHospitalVia();
    const body = {
      phone: randomTestPhone(),
      email: `hadmin.${randomUUID()}@example.com`,
      password: 'a-very-strong-passphrase',
      displayName: 'First Hospital Admin',
    };

    const tooEarlyNext = vi.fn();
    await provisionAdmin(buildReq({ params: { hospitalId }, body }), buildRes(), tooEarlyNext);
    expect(tooEarlyNext).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'HOSPITAL_NOT_VERIFIED', statusCode: 409 }),
    );

    await verify(buildReq({ params: { hospitalId } }), buildRes(), vi.fn());

    const res = buildRes();
    await provisionAdmin(buildReq({ params: { hospitalId }, body }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(201);
    const payload = jsonPayload(res) as {
      membership: { staffRole: string; hospitalId: string; user: Record<string, unknown> };
    };
    expect(payload.membership.staffRole).toBe(HospitalStaffRole.ADMIN);
    expect(payload.membership.hospitalId).toBe(hospitalId);
    expect(payload.membership.user).not.toHaveProperty('passwordHash');
  });

  it('rejects an injected staffRole/role when provisioning the hospital admin', async () => {
    const hospitalId = await createHospitalVia();
    await verify(buildReq({ params: { hospitalId } }), buildRes(), vi.fn());

    const body = {
      phone: randomTestPhone(),
      password: 'a-very-strong-passphrase',
      displayName: 'Attempted Escalation',
      role: 'ADMIN',
      staffRole: 'DISPATCHER',
    };
    const next = vi.fn();

    await provisionAdmin(buildReq({ params: { hospitalId }, body }), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(await prisma.user.count({ where: { phone: body.phone } })).toBe(0);
  });
});
