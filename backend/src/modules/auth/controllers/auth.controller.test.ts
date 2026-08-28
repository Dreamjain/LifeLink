import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { UserRole, UserStatus } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { hashPassword } from '../utils/password.util.js';
import { requireAuth } from '../middleware/auth.middleware.js';
import type { AuthenticatedPrincipal } from '../types/auth.types.js';
import { requirePatientOnboardingAuth } from '../../patients/middleware/patient-onboarding-auth.middleware.js';
import { getProfile as getPatientProfile } from '../../patients/controllers/patient.controller.js';
import { login, me, register } from './auth.controller.js';

const TEST_PHONE_PREFIX = '+1557';

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

afterAll(async () => {
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: TEST_PHONE_PREFIX } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);

  await prisma.patientProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('auth.controller register', () => {
  it('creates a PATIENT/PENDING user, never returns passwordHash, and returns a usable access token', async () => {
    const req = buildReq({
      phone: randomTestPhone(),
      email: `test.${randomUUID()}@example.com`,
      password: 'a-very-strong-passphrase',
      displayName: 'Controller Test',
    });
    const res = buildRes();
    const next = vi.fn();

    await register(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(201);
    const payload = jsonPayload(res) as {
      accessToken: string;
      tokenType: string;
      expiresIn: number;
      user: Record<string, unknown>;
    };
    expect(payload.user).not.toHaveProperty('passwordHash');
    expect(payload.user.role).toBe(UserRole.PATIENT);
    expect(payload.user.status).toBe(UserStatus.PENDING);
    expect(payload.tokenType).toBe('Bearer');
    expect(typeof payload.accessToken).toBe('string');
    expect(payload.expiresIn).toBeGreaterThan(0);
  });

  it('issues a token usable on patient onboarding endpoints but rejected by normal requireAuth-protected endpoints', async () => {
    const req = buildReq({
      phone: randomTestPhone(),
      email: `test.${randomUUID()}@example.com`,
      password: 'a-very-strong-passphrase',
      displayName: 'Onboarding Token Test',
    });
    const res = buildRes();
    await register(req, res, vi.fn());
    const { accessToken, user } = jsonPayload(res) as { accessToken: string; user: { id: string } };

    const onboardingReq = buildAuthHeaderReq(`Bearer ${accessToken}`);
    const onboardingNext = vi.fn();
    await requirePatientOnboardingAuth(onboardingReq, buildRes(), onboardingNext);
    expect(onboardingNext).toHaveBeenCalledWith();
    expect(onboardingReq.user).toEqual({
      userId: user.id,
      role: UserRole.PATIENT,
      jti: expect.any(String),
    });

    const profileRes = buildRes();
    await getPatientProfile(onboardingReq, profileRes, vi.fn());
    expect(profileRes.status).toHaveBeenCalledWith(200);
    expect(jsonPayload(profileRes)).toEqual({ profile: null });

    const normalReq = buildAuthHeaderReq(`Bearer ${accessToken}`);
    const normalNext = vi.fn();
    await requireAuth(normalReq, buildRes(), normalNext);
    expect(normalNext).toHaveBeenCalledWith(expect.objectContaining({ code: 'INACTIVE_ACCOUNT' }));
  });

  it('rejects invalid input with a validation error', async () => {
    const req = buildReq({ phone: randomTestPhone(), password: 'short', displayName: 'X' });
    const res = buildRes();
    const next = vi.fn();

    await register(req, res, next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'VALIDATION_ERROR', statusCode: 400 }),
    );
    expect(res.status).not.toHaveBeenCalled();
  });

  it('rejects an attempt to supply a role and creates no account', async () => {
    const phone = randomTestPhone();
    const req = buildReq({
      phone,
      password: 'a-very-strong-passphrase',
      displayName: 'Attempted Admin',
      role: 'ADMIN',
    });
    const res = buildRes();
    const next = vi.fn();

    await register(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    const created = await prisma.user.findUnique({ where: { phone } });
    expect(created).toBeNull();
  });

  it('rejects a duplicate phone number with a conflict', async () => {
    const phone = randomTestPhone();
    const first = buildReq({
      phone,
      password: 'a-very-strong-passphrase',
      displayName: 'First',
    });
    await register(first, buildRes(), vi.fn());

    const second = buildReq({
      phone,
      password: 'a-very-strong-passphrase',
      displayName: 'Second',
    });
    const next = vi.fn();
    await register(second, buildRes(), next);

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'ACCOUNT_ALREADY_EXISTS', statusCode: 409 }),
    );
  });
});

describe('auth.controller login', () => {
  const createActiveUser = async (password: string) =>
    prisma.user.create({
      data: {
        phone: randomTestPhone(),
        email: `test.${randomUUID()}@example.com`,
        passwordHash: await hashPassword(password),
        role: UserRole.PATIENT,
        status: UserStatus.ACTIVE,
        displayName: 'Login Test User',
      },
    });

  it('returns a safe authentication response for valid credentials', async () => {
    const password = 'a-very-strong-passphrase';
    const user = await createActiveUser(password);

    const res = buildRes();
    await login(buildReq({ phone: user.phone, password }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[0] as {
      accessToken: string;
      tokenType: string;
      expiresIn: number;
      user: Record<string, unknown>;
    };
    expect(payload.tokenType).toBe('Bearer');
    expect(typeof payload.accessToken).toBe('string');
    expect(payload.user).not.toHaveProperty('passwordHash');
  });

  it('returns the same generic error for a wrong password and a nonexistent user', async () => {
    const password = 'a-very-strong-passphrase';
    const user = await createActiveUser(password);

    const wrongPasswordNext = vi.fn();
    await login(
      buildReq({ phone: user.phone, password: 'incorrect-password' }),
      buildRes(),
      wrongPasswordNext,
    );

    const noSuchUserNext = vi.fn();
    await login(
      buildReq({ phone: randomTestPhone(), password: 'incorrect-password' }),
      buildRes(),
      noSuchUserNext,
    );

    const wrongPasswordError = wrongPasswordNext.mock.calls[0]?.[0] as {
      code: string;
      message: string;
    };
    const noSuchUserError = noSuchUserNext.mock.calls[0]?.[0] as { code: string; message: string };

    expect(wrongPasswordError.code).toBe('INVALID_CREDENTIALS');
    expect(noSuchUserError.code).toBe('INVALID_CREDENTIALS');
    expect(wrongPasswordError.message).toBe(noSuchUserError.message);
  });
});

describe('auth.controller me', () => {
  it('returns the authenticated user without passwordHash', async () => {
    const user = await prisma.user.create({
      data: {
        phone: randomTestPhone(),
        email: `test.${randomUUID()}@example.com`,
        passwordHash: await hashPassword('a-very-strong-passphrase'),
        role: UserRole.PATIENT,
        status: UserStatus.ACTIVE,
        displayName: 'Me Test User',
      },
    });

    const res = buildRes();
    await me(
      buildReq(undefined, { userId: user.id, role: user.role, jti: randomUUID() }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = (res.json as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0]?.[0] as {
      user: Record<string, unknown>;
    };
    expect(payload.user.id).toBe(user.id);
    expect(payload.user).not.toHaveProperty('passwordHash');
  });

  it('rejects a request without an authenticated principal', async () => {
    const next = vi.fn();
    await me(buildReq(undefined, undefined), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });
});
