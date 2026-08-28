import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { UserRole, UserStatus } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { hashPassword, requireAuth, requireRole, signAccessToken } from '../../auth/index.js';
import { requirePatientOnboardingAuth } from './patient-onboarding-auth.middleware.js';

const TEST_PHONE_PREFIX = '+1558';

const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const createUser = async (status: UserStatus, role: UserRole = UserRole.PATIENT) =>
  prisma.user.create({
    data: {
      phone: randomTestPhone(),
      email: `test.${randomUUID()}@example.com`,
      passwordHash: await hashPassword('a-very-strong-passphrase'),
      role,
      status,
      displayName: 'Onboarding Auth Test User',
    },
  });

const buildReq = (authorization?: string): Request =>
  ({
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
  }) as unknown as Request;

const buildRes = (): Response => ({}) as Response;

afterAll(async () => {
  await prisma.user.deleteMany({ where: { phone: { startsWith: TEST_PHONE_PREFIX } } });
});

describe('requirePatientOnboardingAuth', () => {
  it('rejects a missing Authorization header', async () => {
    const next = vi.fn();
    await requirePatientOnboardingAuth(buildReq(undefined), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });

  it('accepts a PENDING patient', async () => {
    const user = await createUser(UserStatus.PENDING);
    const token = signAccessToken({ userId: user.id, role: user.role });

    const req = buildReq(`Bearer ${token}`);
    const next = vi.fn();
    await requirePatientOnboardingAuth(req, buildRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toEqual({ userId: user.id, role: UserRole.PATIENT, jti: expect.any(String) });
  });

  it('accepts an ACTIVE patient', async () => {
    const user = await createUser(UserStatus.ACTIVE);
    const token = signAccessToken({ userId: user.id, role: user.role });

    const req = buildReq(`Bearer ${token}`);
    const next = vi.fn();
    await requirePatientOnboardingAuth(req, buildRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toEqual({ userId: user.id, role: UserRole.PATIENT, jti: expect.any(String) });
  });

  it.each([UserStatus.SUSPENDED, UserStatus.DEACTIVATED, UserStatus.REJECTED])(
    'rejects a %s account',
    async (status) => {
      const user = await createUser(status);
      const token = signAccessToken({ userId: user.id, role: user.role });

      const next = vi.fn();
      await requirePatientOnboardingAuth(buildReq(`Bearer ${token}`), buildRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'INACTIVE_ACCOUNT' }));
    },
  );

  it('rejects a PENDING non-patient role when composed with requireRole(PATIENT)', async () => {
    const user = await createUser(UserStatus.PENDING, UserRole.DRIVER);
    const token = signAccessToken({ userId: user.id, role: user.role });

    const req = buildReq(`Bearer ${token}`);
    const authNext = vi.fn();
    await requirePatientOnboardingAuth(req, buildRes(), authNext);
    expect(authNext).toHaveBeenCalledWith();

    const roleNext = vi.fn();
    requireRole(UserRole.PATIENT)(req, buildRes(), roleNext);

    expect(roleNext).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_ROLE' }));
  });

  it('does NOT let a PENDING patient token pass the unmodified requireAuth used by normal business APIs', async () => {
    const user = await createUser(UserStatus.PENDING);
    const token = signAccessToken({ userId: user.id, role: user.role });

    const next = vi.fn();
    await requireAuth(buildReq(`Bearer ${token}`), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'INACTIVE_ACCOUNT' }));
  });
});
