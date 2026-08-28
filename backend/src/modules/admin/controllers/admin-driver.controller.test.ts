import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { UserRole, UserStatus, VerificationStatus } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { hashPassword, requireAuth, requireRole, signAccessToken } from '../../auth/index.js';
import type { AuthenticatedPrincipal } from '../../auth/index.js';
import {
  approve,
  getDriverDetail,
  listPendingDriverAccounts,
  reject,
} from './admin-driver.controller.js';

const TEST_PHONE_PREFIX = '+1566';
const TEST_LICENCE_PREFIX = 'T1566-';

const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const randomLicence = (): string => `${TEST_LICENCE_PREFIX}${randomUUID().slice(0, 12)}`;

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

const createDriver = async () =>
  prisma.user.create({
    data: {
      phone: randomTestPhone(),
      email: `test.${randomUUID()}@example.com`,
      passwordHash: await hashPassword('a-very-strong-passphrase'),
      role: UserRole.DRIVER,
      status: UserStatus.PENDING,
      displayName: 'Admin Driver Controller Test',
      driverProfile: { create: { licenceNumber: randomLicence() } },
    },
  });

const createUser = async (role: UserRole, status: UserStatus) =>
  prisma.user.create({
    data: {
      phone: randomTestPhone(),
      email: `test.${randomUUID()}@example.com`,
      passwordHash: await hashPassword('a-very-strong-passphrase'),
      role,
      status,
      displayName: 'Role Matrix User',
    },
  });

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: TEST_PHONE_PREFIX } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);

  await prisma.driverProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('admin driver route authorization', () => {
  it('rejects an unauthenticated request', async () => {
    const next = vi.fn();
    await requireAuth(buildAuthHeaderReq(undefined), buildRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });

  it.each([UserRole.PATIENT, UserRole.DRIVER, UserRole.HOSPITAL_STAFF])(
    'rejects a %s account with INSUFFICIENT_ROLE',
    async (role) => {
      const user = await createUser(role, UserStatus.ACTIVE);
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

  it('accepts an ACTIVE ADMIN', async () => {
    const admin = await createUser(UserRole.ADMIN, UserStatus.ACTIVE);
    const token = signAccessToken({ userId: admin.id, role: admin.role });
    const req = buildAuthHeaderReq(`Bearer ${token}`);

    const authNext = vi.fn();
    await requireAuth(req, buildRes(), authNext);
    expect(authNext).toHaveBeenCalledWith();

    const roleNext = vi.fn();
    requireRole(UserRole.ADMIN)(req, buildRes(), roleNext);
    expect(roleNext).toHaveBeenCalledWith();
  });
});

describe('admin-driver.controller', () => {
  it('lists pending drivers without exposing passwordHash', async () => {
    const driver = await createDriver();
    const req = { user: adminPrincipal() } as unknown as Request;
    const res = buildRes();

    await listPendingDriverAccounts(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = jsonPayload(res) as { drivers: Record<string, unknown>[] };
    const entry = payload.drivers.find((d) => d.id === driver.id);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('passwordHash');
  });

  it('returns DRIVER_NOT_FOUND for a nonexistent user', async () => {
    const req = { user: adminPrincipal(), params: { userId: randomUUID() } } as unknown as Request;
    const next = vi.fn();

    await getDriverDetail(req, buildRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'DRIVER_NOT_FOUND', statusCode: 404 }),
    );
  });

  it('approves a pending driver', async () => {
    const driver = await createDriver();
    const req = {
      user: adminPrincipal(),
      params: { userId: driver.id },
      body: undefined,
      correlationId: 'test',
    } as unknown as Request;
    const res = buildRes();

    await approve(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = jsonPayload(res) as {
      driver: { status: string; verificationStatus: string };
    };
    expect(payload.driver.status).toBe(UserStatus.ACTIVE);
    expect(payload.driver.verificationStatus).toBe(VerificationStatus.VERIFIED);
  });

  it('rejects an injected status/role in the approve body', async () => {
    const driver = await createDriver();
    const req = {
      user: adminPrincipal(),
      params: { userId: driver.id },
      body: { status: 'ACTIVE', verificationStatus: 'VERIFIED' },
      correlationId: 'test',
    } as unknown as Request;
    const next = vi.fn();

    await approve(req, buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    const unchanged = await prisma.user.findUniqueOrThrow({ where: { id: driver.id } });
    expect(unchanged.status).toBe(UserStatus.PENDING);
  });

  it('rejects a pending driver and does not persist the optional reason', async () => {
    const driver = await createDriver();
    const req = {
      user: adminPrincipal(),
      params: { userId: driver.id },
      body: { reason: 'Licence could not be verified.' },
      correlationId: 'test',
    } as unknown as Request;
    const res = buildRes();

    await reject(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = jsonPayload(res) as {
      driver: { status: string; verificationStatus: string };
    };
    expect(payload.driver.status).toBe(UserStatus.REJECTED);
    expect(payload.driver.verificationStatus).toBe(VerificationStatus.REJECTED);

    const profileColumns = Object.keys(
      await prisma.driverProfile.findUniqueOrThrow({ where: { userId: driver.id } }),
    );
    expect(profileColumns).not.toContain('rejectionReason');
  });
});
