import { randomUUID } from 'node:crypto';
import { UserRole, UserStatus } from '@prisma/client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';
import { hashPassword } from '../utils/password.util.js';
import { verifyAccessToken } from '../utils/jwt.util.js';
import { loadOnboardingPrincipalFromClaims } from '../../patients/services/patient.service.js';
import {
  getCurrentUser,
  getPatientAccountStatus,
  loadActivePrincipalFromClaims,
  login,
  registerPatient,
} from './auth.service.js';

const TEST_PHONE_PREFIX = '+1555';

const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const randomTestEmail = (): string => `test.${randomUUID()}@example.com`;

const createdUserIds: string[] = [];

const createUser = async (
  overrides: Partial<{ status: UserStatus; role: UserRole; password: string }> = {},
) => {
  const password = overrides.password ?? 'a-very-strong-passphrase';
  const user = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      email: randomTestEmail(),
      passwordHash: await hashPassword(password),
      role: overrides.role ?? UserRole.PATIENT,
      status: overrides.status ?? UserStatus.ACTIVE,
      displayName: 'Test User',
    },
  });

  createdUserIds.push(user.id);

  return { user, password };
};

afterEach(async () => {
  if (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    createdUserIds.length = 0;
  }
});

afterAll(async () => {
  await prisma.user.deleteMany({ where: { phone: { startsWith: TEST_PHONE_PREFIX } } });
});

beforeAll(async () => {
  await prisma.$connect();
});

describe('auth.service', () => {
  describe('registerPatient', () => {
    it('creates a PENDING patient with a hashed password', async () => {
      const phone = randomTestPhone();
      const result = await registerPatient({
        phone,
        email: randomTestEmail(),
        password: 'a-very-strong-passphrase',
        displayName: 'New Patient',
      });
      createdUserIds.push(result.user.id);

      expect(result.user.role).toBe(UserRole.PATIENT);
      expect(result.user.status).toBe(UserStatus.PENDING);
      expect(result.user).not.toHaveProperty('passwordHash');

      const stored = await prisma.user.findUniqueOrThrow({ where: { id: result.user.id } });
      expect(stored.passwordHash).not.toBe('a-very-strong-passphrase');
      expect(stored.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/);
    });

    it('returns a valid access token whose claims match the newly created PENDING patient', async () => {
      const result = await registerPatient({
        phone: randomTestPhone(),
        email: randomTestEmail(),
        password: 'a-very-strong-passphrase',
        displayName: 'New Patient',
      });
      createdUserIds.push(result.user.id);

      expect(result.tokenType).toBe('Bearer');
      expect(result.expiresIn).toBeGreaterThan(0);

      const claims = verifyAccessToken(result.accessToken);
      expect(claims.sub).toBe(result.user.id);
      expect(claims.role).toBe(UserRole.PATIENT);
    });

    it('issues a token that works on patient onboarding access but is rejected by the ACTIVE-only account loader', async () => {
      const result = await registerPatient({
        phone: randomTestPhone(),
        email: randomTestEmail(),
        password: 'a-very-strong-passphrase',
        displayName: 'New Patient',
      });
      createdUserIds.push(result.user.id);

      const claims = verifyAccessToken(result.accessToken);

      await expect(loadOnboardingPrincipalFromClaims(claims)).resolves.toMatchObject({
        userId: result.user.id,
        role: UserRole.PATIENT,
      });
      await expect(loadActivePrincipalFromClaims(claims)).rejects.toMatchObject({
        code: 'INACTIVE_ACCOUNT',
      });
    });

    it('rejects a duplicate phone number', async () => {
      const phone = randomTestPhone();
      const first = await registerPatient({
        phone,
        email: randomTestEmail(),
        password: 'a-very-strong-passphrase',
        displayName: 'First',
      });
      createdUserIds.push(first.user.id);

      await expect(
        registerPatient({
          phone,
          email: randomTestEmail(),
          password: 'a-very-strong-passphrase',
          displayName: 'Second',
        }),
      ).rejects.toThrow(AppError);
    });

    it('rejects a duplicate email', async () => {
      const email = randomTestEmail();
      const first = await registerPatient({
        phone: randomTestPhone(),
        email,
        password: 'a-very-strong-passphrase',
        displayName: 'First',
      });
      createdUserIds.push(first.user.id);

      await expect(
        registerPatient({
          phone: randomTestPhone(),
          email,
          password: 'a-very-strong-passphrase',
          displayName: 'Second',
        }),
      ).rejects.toThrow(AppError);
    });
  });

  describe('login', () => {
    it('succeeds with valid credentials for an active user', async () => {
      const { user, password } = await createUser({ status: UserStatus.ACTIVE });

      const result = await login({ phone: user.phone, password });

      expect(result.tokenType).toBe('Bearer');
      expect(result.expiresIn).toBeGreaterThan(0);
      expect(result.user.id).toBe(user.id);
      expect(result.user).not.toHaveProperty('passwordHash');
    });

    it('rejects an incorrect password', async () => {
      const { user } = await createUser({ status: UserStatus.ACTIVE });

      await expect(
        login({ phone: user.phone, password: 'the-wrong-password' }),
      ).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });
    });

    it('rejects a nonexistent user with the same generic error as a wrong password', async () => {
      await expect(
        login({ phone: randomTestPhone(), password: 'whatever-the-caller-typed' }),
      ).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
      });
    });

    it.each([UserStatus.SUSPENDED, UserStatus.DEACTIVATED])(
      'rejects a %s account with INACTIVE_ACCOUNT',
      async (status) => {
        const { user, password } = await createUser({ status });

        await expect(login({ phone: user.phone, password })).rejects.toMatchObject({
          code: 'INACTIVE_ACCOUNT',
        });
      },
    );

    it('reports rejection only after valid credentials are verified', async () => {
      const { user, password } = await createUser({ status: UserStatus.REJECTED });

      await expect(login({ phone: user.phone, password })).rejects.toMatchObject({
        code: 'ACCOUNT_REJECTED',
        statusCode: 403,
      });
      await expect(
        login({ phone: user.phone, password: 'incorrect-password' }),
      ).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
        statusCode: 401,
      });
    });
  });

  describe('login for a PENDING patient (Task 1.25 onboarding)', () => {
    it('lets a PENDING patient authenticate so they can finish onboarding', async () => {
      const { user, password } = await createUser({
        status: UserStatus.PENDING,
        role: UserRole.PATIENT,
      });

      const result = await login({ phone: user.phone, password });

      expect(result.accessToken).toBeTypeOf('string');
      expect(result.tokenType).toBe('Bearer');
      expect(result.expiresIn).toBeGreaterThan(0);
      expect(result.user).toMatchObject({
        id: user.id,
        role: UserRole.PATIENT,
        status: UserStatus.PENDING,
      });
      expect(result.user).not.toHaveProperty('passwordHash');
    });

    it('issues a token the onboarding loader accepts and the ACTIVE-only loader rejects', async () => {
      const { user, password } = await createUser({
        status: UserStatus.PENDING,
        role: UserRole.PATIENT,
      });

      const result = await login({ phone: user.phone, password });
      const claims = verifyAccessToken(result.accessToken);

      // The middleware separation is the whole safety argument for this change: the onboarding
      // routes open, and nothing else does.
      await expect(loadOnboardingPrincipalFromClaims(claims)).resolves.toMatchObject({
        userId: user.id,
        role: UserRole.PATIENT,
      });
      await expect(loadActivePrincipalFromClaims(claims)).rejects.toMatchObject({
        code: 'INACTIVE_ACCOUNT',
      });
    });

    it.each([UserRole.DRIVER, UserRole.HOSPITAL_STAFF, UserRole.ADMIN])(
      'still refuses a PENDING %s',
      async (role) => {
        const { user, password } = await createUser({ status: UserStatus.PENDING, role });

        await expect(login({ phone: user.phone, password })).rejects.toMatchObject({
          code: 'INACTIVE_ACCOUNT',
          statusCode: 403,
        });
      },
    );

    it.each([UserStatus.SUSPENDED, UserStatus.DEACTIVATED])(
      'still refuses a %s patient',
      async (status) => {
        const { user, password } = await createUser({ status, role: UserRole.PATIENT });

        await expect(login({ phone: user.phone, password })).rejects.toMatchObject({
          code: 'INACTIVE_ACCOUNT',
          statusCode: 403,
        });
      },
    );

    it('still refuses a PENDING patient who gives the wrong password', async () => {
      const { user } = await createUser({ status: UserStatus.PENDING, role: UserRole.PATIENT });

      await expect(
        login({ phone: user.phone, password: 'not-the-password' }),
      ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS', statusCode: 401 });
    });
  });

  describe('loadActivePrincipalFromClaims / getCurrentUser', () => {
    it('resolves the principal for an active user', async () => {
      const { user } = await createUser({ status: UserStatus.ACTIVE });

      const principal = await loadActivePrincipalFromClaims({ sub: user.id, jti: randomUUID() });

      expect(principal.userId).toBe(user.id);
      expect(principal.role).toBe(user.role);
    });

    it('rejects a deactivated user', async () => {
      const { user } = await createUser({ status: UserStatus.DEACTIVATED });

      await expect(
        loadActivePrincipalFromClaims({ sub: user.id, jti: randomUUID() }),
      ).rejects.toMatchObject({
        code: 'INACTIVE_ACCOUNT',
      });
    });

    it('rejects a nonexistent user id', async () => {
      await expect(
        loadActivePrincipalFromClaims({ sub: randomUUID(), jti: randomUUID() }),
      ).rejects.toMatchObject({
        code: 'INACTIVE_ACCOUNT',
      });
    });

    it('getCurrentUser returns a safe user without passwordHash', async () => {
      const { user } = await createUser({ status: UserStatus.ACTIVE });

      const safeUser = await getCurrentUser({
        userId: user.id,
        role: user.role,
        jti: randomUUID(),
      });

      expect(safeUser.id).toBe(user.id);
      expect(safeUser).not.toHaveProperty('passwordHash');
    });
  });

  describe('getPatientAccountStatus', () => {
    it.each([UserStatus.PENDING, UserStatus.ACTIVE, UserStatus.REJECTED])(
      'returns the caller patient status %s',
      async (status) => {
        const { user } = await createUser({ status, role: UserRole.PATIENT });

        await expect(getPatientAccountStatus(user.id)).resolves.toBe(status);
      },
    );

    it('does not expose status for non-patient roles', async () => {
      const { user } = await createUser({ status: UserStatus.ACTIVE, role: UserRole.DRIVER });

      await expect(getPatientAccountStatus(user.id)).rejects.toMatchObject({
        code: 'INSUFFICIENT_ROLE',
        statusCode: 403,
      });
    });

    it('does not expose suspended account status', async () => {
      const { user } = await createUser({ status: UserStatus.SUSPENDED });

      await expect(getPatientAccountStatus(user.id)).rejects.toMatchObject({
        code: 'INACTIVE_ACCOUNT',
        statusCode: 403,
      });
    });
  });
});
