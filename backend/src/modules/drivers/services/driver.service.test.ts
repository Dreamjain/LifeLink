import { randomUUID } from 'node:crypto';
import { DriverAvailability, UserRole, UserStatus, VerificationStatus } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { getOwnDriverProfile, registerDriver, updateOwnAvailability } from './driver.service.js';

const TEST_PHONE_PREFIX = '+1563';
const TEST_LICENCE_PREFIX = 'T1563-';

const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const randomLicence = (): string => `${TEST_LICENCE_PREFIX}${randomUUID().slice(0, 12)}`;

const registerTestDriver = async (
  overrides: Partial<{ phone: string; licenceNumber: string }> = {},
) =>
  registerDriver({
    phone: overrides.phone ?? randomTestPhone(),
    email: `test.${randomUUID()}@example.com`,
    password: 'a-very-strong-passphrase',
    displayName: 'Service Test Driver',
    licenceNumber: overrides.licenceNumber ?? randomLicence(),
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

describe('registerDriver', () => {
  it('creates a DRIVER/PENDING user with a PENDING/OFFLINE driver profile', async () => {
    const result = await registerTestDriver();

    expect(result.user.role).toBe(UserRole.DRIVER);
    expect(result.user.status).toBe(UserStatus.PENDING);
    expect(result.driverProfile.verificationStatus).toBe(VerificationStatus.PENDING);
    expect(result.driverProfile.availabilityStatus).toBe(DriverAvailability.OFFLINE);
  });

  it('never returns a password hash or an access token', async () => {
    const result = await registerTestDriver();

    expect(result.user).not.toHaveProperty('passwordHash');
    expect(result).not.toHaveProperty('accessToken');
    expect(result).not.toHaveProperty('tokenType');
  });

  it('stores the password hashed, not in plaintext', async () => {
    const result = await registerTestDriver();

    const stored = await prisma.user.findUniqueOrThrow({ where: { id: result.user.id } });
    expect(stored.passwordHash).not.toBe('a-very-strong-passphrase');
    expect(stored.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/);
  });

  it('rejects a duplicate phone number', async () => {
    const phone = randomTestPhone();
    await registerTestDriver({ phone });

    await expect(registerTestDriver({ phone })).rejects.toMatchObject({
      code: 'ACCOUNT_ALREADY_EXISTS',
    });
  });

  it('rejects a duplicate licence number', async () => {
    const licenceNumber = randomLicence();
    await registerTestDriver({ licenceNumber });

    await expect(registerTestDriver({ licenceNumber })).rejects.toMatchObject({
      code: 'ACCOUNT_ALREADY_EXISTS',
    });
  });

  it('rolls back the User when DriverProfile creation fails (atomicity)', async () => {
    const licenceNumber = randomLicence();
    await registerTestDriver({ licenceNumber });

    const orphanPhone = randomTestPhone();
    await expect(registerTestDriver({ phone: orphanPhone, licenceNumber })).rejects.toMatchObject({
      code: 'ACCOUNT_ALREADY_EXISTS',
    });

    // The duplicate licence fails at profile creation, so the User row must not survive.
    await expect(prisma.user.findUnique({ where: { phone: orphanPhone } })).resolves.toBeNull();
  });
});

describe('getOwnDriverProfile', () => {
  it('returns the caller own profile', async () => {
    const result = await registerTestDriver();

    const profile = await getOwnDriverProfile(result.user.id);

    expect(profile.id).toBe(result.driverProfile.id);
    expect(profile.verificationStatus).toBe(VerificationStatus.PENDING);
  });

  it('throws DRIVER_NOT_FOUND when the user has no driver profile', async () => {
    await expect(getOwnDriverProfile(randomUUID())).rejects.toMatchObject({
      code: 'DRIVER_NOT_FOUND',
    });
  });
});

describe('updateOwnAvailability', () => {
  const verify = async (userId: string) =>
    prisma.driverProfile.update({
      where: { userId },
      data: { verificationStatus: VerificationStatus.VERIFIED },
    });

  it('updates availability for a VERIFIED driver', async () => {
    const result = await registerTestDriver();
    await verify(result.user.id);

    const profile = await updateOwnAvailability(result.user.id, DriverAvailability.AVAILABLE);

    expect(profile.availabilityStatus).toBe(DriverAvailability.AVAILABLE);
  });

  it('refuses availability changes for a PENDING (unverified) driver', async () => {
    const result = await registerTestDriver();

    await expect(
      updateOwnAvailability(result.user.id, DriverAvailability.AVAILABLE),
    ).rejects.toMatchObject({ code: 'DRIVER_NOT_VERIFIED' });

    const unchanged = await prisma.driverProfile.findUniqueOrThrow({
      where: { userId: result.user.id },
    });
    expect(unchanged.availabilityStatus).toBe(DriverAvailability.OFFLINE);
  });

  it('refuses availability changes for a REJECTED driver', async () => {
    const result = await registerTestDriver();
    await prisma.driverProfile.update({
      where: { userId: result.user.id },
      data: { verificationStatus: VerificationStatus.REJECTED },
    });

    await expect(
      updateOwnAvailability(result.user.id, DriverAvailability.AVAILABLE),
    ).rejects.toMatchObject({ code: 'DRIVER_NOT_VERIFIED' });
  });

  it('throws DRIVER_NOT_FOUND when no profile exists', async () => {
    await expect(
      updateOwnAvailability(randomUUID(), DriverAvailability.AVAILABLE),
    ).rejects.toMatchObject({ code: 'DRIVER_NOT_FOUND' });
  });

  it('only changes the caller own profile', async () => {
    const mine = await registerTestDriver();
    const other = await registerTestDriver();
    await verify(mine.user.id);
    await verify(other.user.id);

    await updateOwnAvailability(mine.user.id, DriverAvailability.AVAILABLE);

    const otherProfile = await prisma.driverProfile.findUniqueOrThrow({
      where: { userId: other.user.id },
    });
    expect(otherProfile.availabilityStatus).toBe(DriverAvailability.OFFLINE);
  });
});
