import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { UserRole, UserStatus } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { hashPassword, requireAuth, requireRole, signAccessToken } from '../../auth/index.js';
import { approve, getDetail, listPending, reject } from './admin-patient.controller.js';

const TEST_PHONE_PREFIX = '+1562';

const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const createUser = async (role: UserRole, status: UserStatus) =>
  prisma.user.create({
    data: {
      phone: randomTestPhone(),
      email: `test.${randomUUID()}@example.com`,
      passwordHash: await hashPassword('a-very-strong-passphrase'),
      role,
      status,
      displayName: 'Admin Controller Test User',
    },
  });

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

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: TEST_PHONE_PREFIX } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);

  const profiles = await prisma.patientProfile.findMany({
    where: { userId: { in: userIds } },
    select: { id: true },
  });
  const profileIds = profiles.map((p) => p.id);

  await prisma.emergencyContact.deleteMany({ where: { patientId: { in: profileIds } } });
  await prisma.patientProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('admin route authorization (requireAuth + requireRole(ADMIN))', () => {
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

  it('accepts an ACTIVE ADMIN account', async () => {
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

  it('rejects an inactive (SUSPENDED) ADMIN account through the existing requireAuth ACTIVE check', async () => {
    const admin = await createUser(UserRole.ADMIN, UserStatus.SUSPENDED);
    const token = signAccessToken({ userId: admin.id, role: admin.role });

    const next = vi.fn();
    await requireAuth(buildAuthHeaderReq(`Bearer ${token}`), buildRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'INACTIVE_ACCOUNT' }));
  });
});

describe('admin-patient.controller', () => {
  const adminPrincipal = () => ({ userId: randomUUID(), role: UserRole.ADMIN, jti: randomUUID() });

  it('listPending returns pending patients without exposing passwordHash', async () => {
    const patient = await createUser(UserRole.PATIENT, UserStatus.PENDING);
    const req = { user: adminPrincipal() } as unknown as Request;
    const res = buildRes();

    await listPending(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = jsonPayload(res) as { patients: Record<string, unknown>[] };
    const entry = payload.patients.find((p) => p.id === patient.id);
    expect(entry).toBeDefined();
    expect(entry).not.toHaveProperty('passwordHash');
  });

  it('getDetail returns 404-style PATIENT_NOT_FOUND for a nonexistent user', async () => {
    const req = { user: adminPrincipal(), params: { userId: randomUUID() } } as unknown as Request;
    const next = vi.fn();

    await getDetail(req, buildRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PATIENT_NOT_FOUND', statusCode: 404 }),
    );
  });

  it('approve transitions a ready PENDING patient to ACTIVE', async () => {
    const patient = await createUser(UserRole.PATIENT, UserStatus.PENDING);
    await prisma.patientProfile.create({ data: { userId: patient.id } });
    const profile = await prisma.patientProfile.findUniqueOrThrow({
      where: { userId: patient.id },
    });
    await prisma.emergencyContact.create({
      data: {
        patientId: profile.id,
        name: 'Jane',
        relationship: 'Sister',
        phone: '+15551239998',
        isPrimary: true,
      },
    });

    const req = {
      user: adminPrincipal(),
      params: { userId: patient.id },
      body: undefined,
      correlationId: 'test',
    } as unknown as Request;
    const res = buildRes();

    await approve(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = jsonPayload(res) as { patient: { status: string } };
    expect(payload.patient.status).toBe(UserStatus.ACTIVE);
  });

  it('approve rejects an attempt to inject status/role via the request body', async () => {
    const patient = await createUser(UserRole.PATIENT, UserStatus.PENDING);
    const req = {
      user: adminPrincipal(),
      params: { userId: patient.id },
      body: { status: 'ACTIVE', role: 'ADMIN' },
      correlationId: 'test',
    } as unknown as Request;
    const next = vi.fn();

    await approve(req, buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    const stillPending = await prisma.user.findUniqueOrThrow({ where: { id: patient.id } });
    expect(stillPending.status).toBe(UserStatus.PENDING);
  });

  it('reject transitions a PENDING patient to REJECTED and does not persist the optional reason', async () => {
    const patient = await createUser(UserRole.PATIENT, UserStatus.PENDING);
    const req = {
      user: adminPrincipal(),
      params: { userId: patient.id },
      body: { reason: 'Could not verify identity.' },
      correlationId: 'test',
    } as unknown as Request;
    const res = buildRes();

    await reject(req, res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = jsonPayload(res) as { patient: { status: string } };
    expect(payload.patient.status).toBe(UserStatus.REJECTED);

    const columns = Object.keys(await prisma.user.findUniqueOrThrow({ where: { id: patient.id } }));
    expect(columns).not.toContain('rejectionReason');
  });
});
