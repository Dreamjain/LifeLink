import { randomUUID } from 'node:crypto';
import { UserRole, UserStatus, VerificationStatus } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { hashPassword } from '../../auth/index.js';
import {
  approveDriver,
  getDriverVerificationDetail,
  listPendingDrivers,
  rejectDriver,
} from './admin-driver.service.js';

const TEST_PHONE_PREFIX = '+1565';
const TEST_LICENCE_PREFIX = 'T1565-';

const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const randomLicence = (): string => `${TEST_LICENCE_PREFIX}${randomUUID().slice(0, 12)}`;

const createDriver = async (
  status: UserStatus = UserStatus.PENDING,
  verificationStatus: VerificationStatus = VerificationStatus.PENDING,
) => {
  const user = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      email: `test.${randomUUID()}@example.com`,
      passwordHash: await hashPassword('a-very-strong-passphrase'),
      role: UserRole.DRIVER,
      status,
      displayName: 'Admin Driver Service Test',
      driverProfile: { create: { licenceNumber: randomLicence(), verificationStatus } },
    },
  });

  return user;
};

const createNonDriver = async (role: UserRole) =>
  prisma.user.create({
    data: {
      phone: randomTestPhone(),
      email: `test.${randomUUID()}@example.com`,
      passwordHash: await hashPassword('a-very-strong-passphrase'),
      role,
      status: UserStatus.PENDING,
      displayName: 'Non Driver',
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

describe('listPendingDrivers', () => {
  it('returns only DRIVER/PENDING accounts with their profile metadata', async () => {
    const pending = await createDriver();
    const activeDriver = await createDriver(UserStatus.ACTIVE, VerificationStatus.VERIFIED);
    const rejectedDriver = await createDriver(UserStatus.REJECTED, VerificationStatus.REJECTED);
    const pendingPatient = await createNonDriver(UserRole.PATIENT);

    const list = await listPendingDrivers();
    const ids = list.map((d) => d.id);

    expect(ids).toContain(pending.id);
    expect(ids).not.toContain(activeDriver.id);
    expect(ids).not.toContain(rejectedDriver.id);
    expect(ids).not.toContain(pendingPatient.id);

    const entry = list.find((d) => d.id === pending.id);
    expect(entry).toMatchObject({
      verificationStatus: VerificationStatus.PENDING,
      availabilityStatus: 'OFFLINE',
    });
    expect(entry?.licenceNumber).toBeDefined();
    expect(entry).not.toHaveProperty('passwordHash');
  });
});

describe('getDriverVerificationDetail', () => {
  it('returns the driver with profile details', async () => {
    const driver = await createDriver();

    const detail = await getDriverVerificationDetail(driver.id);

    expect(detail.status).toBe(UserStatus.PENDING);
    expect(detail.driverProfile?.verificationStatus).toBe(VerificationStatus.PENDING);
    expect(detail).not.toHaveProperty('passwordHash');
  });

  it('rejects a nonexistent user', async () => {
    await expect(getDriverVerificationDetail(randomUUID())).rejects.toMatchObject({
      code: 'DRIVER_NOT_FOUND',
    });
  });

  it('does not expose a non-DRIVER account', async () => {
    const patient = await createNonDriver(UserRole.PATIENT);

    await expect(getDriverVerificationDetail(patient.id)).rejects.toMatchObject({
      code: 'DRIVER_NOT_FOUND',
    });
  });
});

describe('approveDriver', () => {
  it('sets User ACTIVE and DriverProfile VERIFIED together', async () => {
    const driver = await createDriver();

    const result = await approveDriver(driver.id);

    expect(result.status).toBe(UserStatus.ACTIVE);
    expect(result.verificationStatus).toBe(VerificationStatus.VERIFIED);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: driver.id } });
    const profile = await prisma.driverProfile.findUniqueOrThrow({ where: { userId: driver.id } });
    expect(user.status).toBe(UserStatus.ACTIVE);
    expect(profile.verificationStatus).toBe(VerificationStatus.VERIFIED);
  });

  it('rejects an already-ACTIVE driver', async () => {
    const driver = await createDriver(UserStatus.ACTIVE, VerificationStatus.VERIFIED);

    await expect(approveDriver(driver.id)).rejects.toMatchObject({
      code: 'DRIVER_STATUS_CONFLICT',
    });
  });

  it('rejects a REJECTED driver', async () => {
    const driver = await createDriver(UserStatus.REJECTED, VerificationStatus.REJECTED);

    await expect(approveDriver(driver.id)).rejects.toMatchObject({
      code: 'DRIVER_STATUS_CONFLICT',
    });
  });

  it('rejects a non-DRIVER account', async () => {
    const patient = await createNonDriver(UserRole.PATIENT);

    await expect(approveDriver(patient.id)).rejects.toMatchObject({ code: 'DRIVER_NOT_FOUND' });
  });

  it('rejects a nonexistent account', async () => {
    await expect(approveDriver(randomUUID())).rejects.toMatchObject({ code: 'DRIVER_NOT_FOUND' });
  });
});

describe('rejectDriver', () => {
  it('sets User REJECTED and DriverProfile REJECTED together', async () => {
    const driver = await createDriver();

    const result = await rejectDriver(driver.id);

    expect(result.status).toBe(UserStatus.REJECTED);
    expect(result.verificationStatus).toBe(VerificationStatus.REJECTED);

    const profile = await prisma.driverProfile.findUniqueOrThrow({ where: { userId: driver.id } });
    expect(profile.verificationStatus).toBe(VerificationStatus.REJECTED);
  });

  it('cannot reject a non-PENDING driver', async () => {
    const driver = await createDriver(UserStatus.ACTIVE, VerificationStatus.VERIFIED);

    await expect(rejectDriver(driver.id)).rejects.toMatchObject({
      code: 'DRIVER_STATUS_CONFLICT',
    });
  });

  it('rejects a nonexistent account cleanly', async () => {
    await expect(rejectDriver(randomUUID())).rejects.toMatchObject({ code: 'DRIVER_NOT_FOUND' });
  });
});

describe('concurrent approve/reject race safety', () => {
  it('lets exactly one concurrent decision win and leaves no partial state', async () => {
    const driver = await createDriver();

    const outcomes = await Promise.allSettled([approveDriver(driver.id), rejectDriver(driver.id)]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === 'rejected') {
      expect(rejected[0].reason).toMatchObject({ code: 'DRIVER_STATUS_CONFLICT' });
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: driver.id } });
    const profile = await prisma.driverProfile.findUniqueOrThrow({ where: { userId: driver.id } });

    // User status and profile verification must agree — never a partially applied transition.
    const consistent =
      (user.status === UserStatus.ACTIVE &&
        profile.verificationStatus === VerificationStatus.VERIFIED) ||
      (user.status === UserStatus.REJECTED &&
        profile.verificationStatus === VerificationStatus.REJECTED);
    expect(consistent).toBe(true);
  });
});
