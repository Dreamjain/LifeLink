import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { DriverAvailability, UserRole, UserStatus, VerificationStatus } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { hashPassword, requireAuth, requireRole, signAccessToken } from '../../auth/index.js';
import type { AuthenticatedPrincipal } from '../../auth/index.js';
import { getMe, patchAvailability, registerDriver } from './driver.controller.js';

const TEST_PHONE_PREFIX = '+1564';
const TEST_LICENCE_PREFIX = 'T1564-';

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

const buildReq = (body: unknown, user?: AuthenticatedPrincipal): Request =>
  ({ body, user, correlationId: 'test-correlation-id' }) as unknown as Request;

const buildAuthHeaderReq = (authorization?: string): Request =>
  ({
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
  }) as unknown as Request;

const jsonPayload = (res: Response): Record<string, unknown> =>
  (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as Record<
    string,
    unknown
  >;

const createUser = async (role: UserRole, status: UserStatus) =>
  prisma.user.create({
    data: {
      phone: randomTestPhone(),
      email: `test.${randomUUID()}@example.com`,
      passwordHash: await hashPassword('a-very-strong-passphrase'),
      role,
      status,
      displayName: 'Driver Controller Test User',
    },
  });

const registerViaController = async () => {
  const res = buildRes();
  await registerDriver(
    buildReq({
      phone: randomTestPhone(),
      password: 'a-very-strong-passphrase',
      displayName: 'Controller Driver',
      licenceNumber: randomLicence(),
    }),
    res,
    vi.fn(),
  );
  return jsonPayload(res) as {
    user: { id: string };
    driverProfile: { id: string };
  };
};

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: TEST_PHONE_PREFIX } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);

  await prisma.driverProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('driver.controller registerDriver', () => {
  it('returns 201 with user + driverProfile and no token', async () => {
    const res = buildRes();
    const next = vi.fn();

    await registerDriver(
      buildReq({
        phone: randomTestPhone(),
        password: 'a-very-strong-passphrase',
        displayName: 'Controller Driver',
        licenceNumber: randomLicence(),
      }),
      res,
      next,
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    const payload = jsonPayload(res) as {
      user: Record<string, unknown>;
      driverProfile: Record<string, unknown>;
      accessToken?: string;
    };
    expect(payload.user.role).toBe(UserRole.DRIVER);
    expect(payload.user.status).toBe(UserStatus.PENDING);
    expect(payload.driverProfile.verificationStatus).toBe(VerificationStatus.PENDING);
    expect(payload.driverProfile.availabilityStatus).toBe(DriverAvailability.OFFLINE);
    expect(payload.user).not.toHaveProperty('passwordHash');
    expect(payload.accessToken).toBeUndefined();
  });

  it('rejects an attempt to inject a role and creates no account', async () => {
    const phone = randomTestPhone();
    const next = vi.fn();

    await registerDriver(
      buildReq({
        phone,
        password: 'a-very-strong-passphrase',
        displayName: 'Attempted Admin',
        licenceNumber: randomLicence(),
        role: 'ADMIN',
      }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    await expect(prisma.user.findUnique({ where: { phone } })).resolves.toBeNull();
  });

  it('rejects an attempt to inject verificationStatus/status', async () => {
    const next = vi.fn();

    await registerDriver(
      buildReq({
        phone: randomTestPhone(),
        password: 'a-very-strong-passphrase',
        displayName: 'Attempted Verified',
        licenceNumber: randomLicence(),
        status: 'ACTIVE',
        verificationStatus: 'VERIFIED',
      }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});

describe('driver route authorization', () => {
  it('rejects an unauthenticated request', async () => {
    const next = vi.fn();
    await requireAuth(buildAuthHeaderReq(undefined), buildRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });

  it.each([UserRole.PATIENT, UserRole.ADMIN, UserRole.HOSPITAL_STAFF])(
    'rejects a %s account with INSUFFICIENT_ROLE',
    async (role) => {
      const user = await createUser(role, UserStatus.ACTIVE);
      const token = signAccessToken({ userId: user.id, role: user.role });
      const req = buildAuthHeaderReq(`Bearer ${token}`);

      const authNext = vi.fn();
      await requireAuth(req, buildRes(), authNext);
      expect(authNext).toHaveBeenCalledWith();

      const roleNext = vi.fn();
      requireRole(UserRole.DRIVER)(req, buildRes(), roleNext);
      expect(roleNext).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_ROLE' }));
    },
  );

  it('rejects a PENDING driver token through the existing ACTIVE-only requireAuth', async () => {
    const registered = await registerViaController();
    const token = signAccessToken({ userId: registered.user.id, role: UserRole.DRIVER });

    const next = vi.fn();
    await requireAuth(buildAuthHeaderReq(`Bearer ${token}`), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'INACTIVE_ACCOUNT' }));
  });
});

describe('driver.controller getMe / patchAvailability', () => {
  const principalFor = (userId: string): AuthenticatedPrincipal => ({
    userId,
    role: UserRole.DRIVER,
    jti: randomUUID(),
  });

  it('returns the caller own driver profile', async () => {
    const registered = await registerViaController();
    const res = buildRes();

    await getMe(buildReq(undefined, principalFor(registered.user.id)), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = jsonPayload(res) as { driverProfile: { id: string } };
    expect(payload.driverProfile.id).toBe(registered.driverProfile.id);
  });

  it('rejects a request with no authenticated principal', async () => {
    const next = vi.fn();
    await getMe(buildReq(undefined, undefined), buildRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });

  it('resolves ownership from the principal, ignoring any client-supplied id', async () => {
    const mine = await registerViaController();
    const other = await registerViaController();

    const res = buildRes();
    await getMe(
      buildReq({ userId: other.user.id, id: other.driverProfile.id }, principalFor(mine.user.id)),
      res,
      vi.fn(),
    );

    const payload = jsonPayload(res) as { driverProfile: { id: string } };
    expect(payload.driverProfile.id).toBe(mine.driverProfile.id);
    expect(payload.driverProfile.id).not.toBe(other.driverProfile.id);
  });

  it('updates availability for a verified driver', async () => {
    const registered = await registerViaController();
    await prisma.driverProfile.update({
      where: { userId: registered.user.id },
      data: { verificationStatus: VerificationStatus.VERIFIED },
    });

    const res = buildRes();
    await patchAvailability(
      buildReq({ availabilityStatus: 'AVAILABLE' }, principalFor(registered.user.id)),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = jsonPayload(res) as { driverProfile: { availabilityStatus: string } };
    expect(payload.driverProfile.availabilityStatus).toBe(DriverAvailability.AVAILABLE);
  });

  it('refuses availability changes for an unverified driver', async () => {
    const registered = await registerViaController();
    const next = vi.fn();

    await patchAvailability(
      buildReq({ availabilityStatus: 'AVAILABLE' }, principalFor(registered.user.id)),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'DRIVER_NOT_VERIFIED' }));
  });

  it('rejects an injected verificationStatus in the availability body', async () => {
    const registered = await registerViaController();
    const next = vi.fn();

    await patchAvailability(
      buildReq(
        { availabilityStatus: 'AVAILABLE', verificationStatus: 'VERIFIED' },
        principalFor(registered.user.id),
      ),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});
