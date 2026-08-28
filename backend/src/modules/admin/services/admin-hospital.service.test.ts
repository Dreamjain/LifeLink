import { randomUUID } from 'node:crypto';
import {
  HospitalStaffRole,
  HospitalStatus,
  MembershipStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import {
  createHospital,
  getHospitalDetail,
  listHospitals,
  provisionHospitalAdmin,
  rejectHospital,
  verifyHospital,
} from './admin-hospital.service.js';

const TEST_REG_PREFIX = 'T1567-';
const TEST_PHONE_PREFIX = '+1567';

const randomRegistration = (): string => `${TEST_REG_PREFIX}${randomUUID().slice(0, 12)}`;
const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const hospitalInput = (overrides: Partial<{ registrationNumber: string; email: string }> = {}) => ({
  name: 'Service Test Hospital',
  registrationNumber: overrides.registrationNumber ?? randomRegistration(),
  phone: randomTestPhone(),
  email: overrides.email ?? `hospital.${randomUUID()}@example.com`,
  addressLine: '1 Main Street',
  city: 'Springfield',
  state: 'IL',
  postalCode: '62701',
});

const adminInput = () => ({
  phone: randomTestPhone(),
  email: `admin.${randomUUID()}@example.com`,
  password: 'a-very-strong-passphrase',
  displayName: 'Hospital Administrator',
});

const createVerifiedHospital = async () => {
  const hospital = await createHospital(hospitalInput());
  return verifyHospital(hospital.id);
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
  const userIds = memberships.map((m) => m.userId);

  await prisma.hospitalStaffMembership.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });
});

describe('createHospital', () => {
  it('creates a hospital with server-forced PENDING_VERIFICATION status', async () => {
    const hospital = await createHospital(hospitalInput());

    expect(hospital.status).toBe(HospitalStatus.PENDING_VERIFICATION);
    expect(hospital.capabilities).toEqual([]);
  });

  it('rejects a duplicate registration number', async () => {
    const registrationNumber = randomRegistration();
    await createHospital(hospitalInput({ registrationNumber }));

    await expect(createHospital(hospitalInput({ registrationNumber }))).rejects.toMatchObject({
      code: 'HOSPITAL_ALREADY_EXISTS',
    });
  });

  it('rejects a duplicate email', async () => {
    const email = `hospital.${randomUUID()}@example.com`;
    await createHospital(hospitalInput({ email }));

    await expect(createHospital(hospitalInput({ email }))).rejects.toMatchObject({
      code: 'HOSPITAL_ALREADY_EXISTS',
    });
  });
});

describe('verifyHospital / rejectHospital', () => {
  it('transitions PENDING_VERIFICATION to VERIFIED', async () => {
    const hospital = await createHospital(hospitalInput());

    const verified = await verifyHospital(hospital.id);

    expect(verified.status).toBe(HospitalStatus.VERIFIED);
  });

  it('transitions PENDING_VERIFICATION to REJECTED', async () => {
    const hospital = await createHospital(hospitalInput());

    const rejected = await rejectHospital(hospital.id);

    expect(rejected.status).toBe(HospitalStatus.REJECTED);
  });

  it('cannot verify an already-verified hospital', async () => {
    const hospital = await createVerifiedHospital();

    await expect(verifyHospital(hospital.id)).rejects.toMatchObject({
      code: 'HOSPITAL_STATUS_CONFLICT',
    });
  });

  it('cannot reject an already-rejected hospital', async () => {
    const hospital = await createHospital(hospitalInput());
    await rejectHospital(hospital.id);

    await expect(rejectHospital(hospital.id)).rejects.toMatchObject({
      code: 'HOSPITAL_STATUS_CONFLICT',
    });
  });

  it('cannot reject a hospital that is already VERIFIED (no VERIFIED -> REJECTED)', async () => {
    const hospital = await createVerifiedHospital();

    await expect(rejectHospital(hospital.id)).rejects.toMatchObject({
      code: 'HOSPITAL_STATUS_CONFLICT',
    });
  });

  it('cannot verify a hospital that is already REJECTED (no REJECTED -> VERIFIED)', async () => {
    const hospital = await createHospital(hospitalInput());
    await rejectHospital(hospital.id);

    await expect(verifyHospital(hospital.id)).rejects.toMatchObject({
      code: 'HOSPITAL_STATUS_CONFLICT',
    });
  });

  it('rejects a nonexistent hospital', async () => {
    await expect(verifyHospital(randomUUID())).rejects.toMatchObject({
      code: 'HOSPITAL_NOT_FOUND',
    });
    await expect(rejectHospital(randomUUID())).rejects.toMatchObject({
      code: 'HOSPITAL_NOT_FOUND',
    });
  });

  it('lets exactly one concurrent verify/reject win', async () => {
    const hospital = await createHospital(hospitalInput());

    const outcomes = await Promise.allSettled([
      verifyHospital(hospital.id),
      rejectHospital(hospital.id),
    ]);
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejectedOutcomes = outcomes.filter((o) => o.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejectedOutcomes).toHaveLength(1);
    if (rejectedOutcomes[0]?.status === 'rejected') {
      expect(rejectedOutcomes[0].reason).toMatchObject({ code: 'HOSPITAL_STATUS_CONFLICT' });
    }

    const final = await prisma.hospital.findUniqueOrThrow({ where: { id: hospital.id } });
    expect([HospitalStatus.VERIFIED, HospitalStatus.REJECTED]).toContain(final.status);
  });
});

describe('provisionHospitalAdmin', () => {
  it('creates a HOSPITAL_STAFF/ACTIVE user with an ACTIVE ADMIN membership', async () => {
    const hospital = await createVerifiedHospital();

    const membership = await provisionHospitalAdmin(hospital.id, adminInput());

    expect(membership.staffRole).toBe(HospitalStaffRole.ADMIN);
    expect(membership.status).toBe(MembershipStatus.ACTIVE);
    expect(membership.hospitalId).toBe(hospital.id);
    expect(membership.user.status).toBe(UserStatus.ACTIVE);
    expect(membership.user).not.toHaveProperty('passwordHash');

    const user = await prisma.user.findUniqueOrThrow({ where: { id: membership.user.id } });
    expect(user.role).toBe(UserRole.HOSPITAL_STAFF);
    expect(user.passwordHash).toMatch(/^\$2[aby]\$\d{2}\$/);
    expect(user.passwordHash).not.toBe('a-very-strong-passphrase');
  });

  it('refuses to provision staff for a hospital that is not yet VERIFIED', async () => {
    const hospital = await createHospital(hospitalInput());

    await expect(provisionHospitalAdmin(hospital.id, adminInput())).rejects.toMatchObject({
      code: 'HOSPITAL_NOT_VERIFIED',
    });
  });

  it('refuses to provision staff for a REJECTED hospital', async () => {
    const hospital = await createHospital(hospitalInput());
    await rejectHospital(hospital.id);

    await expect(provisionHospitalAdmin(hospital.id, adminInput())).rejects.toMatchObject({
      code: 'HOSPITAL_NOT_VERIFIED',
    });
  });

  it('rejects a nonexistent hospital', async () => {
    await expect(provisionHospitalAdmin(randomUUID(), adminInput())).rejects.toMatchObject({
      code: 'HOSPITAL_NOT_FOUND',
    });
  });

  it('rolls back the User when membership creation fails (atomicity)', async () => {
    const hospital = await createVerifiedHospital();
    const input = adminInput();
    await provisionHospitalAdmin(hospital.id, input);

    // Same phone -> User creation fails inside the transaction; no orphan user may remain.
    const duplicate = { ...adminInput(), phone: input.phone };
    await expect(provisionHospitalAdmin(hospital.id, duplicate)).rejects.toMatchObject({
      code: 'ACCOUNT_ALREADY_EXISTS',
    });

    const usersWithEmail = await prisma.user.count({ where: { email: duplicate.email } });
    expect(usersWithEmail).toBe(0);
  });
});

describe('listHospitals / getHospitalDetail', () => {
  it('lists created hospitals', async () => {
    const hospital = await createHospital(hospitalInput());

    const all = await listHospitals();

    expect(all.map((h) => h.id)).toContain(hospital.id);
  });

  it('returns detail with staff and never exposes passwordHash', async () => {
    const hospital = await createVerifiedHospital();
    await provisionHospitalAdmin(hospital.id, adminInput());

    const detail = await getHospitalDetail(hospital.id);

    expect(detail.staff).toHaveLength(1);
    expect(detail.staff[0]?.staffRole).toBe(HospitalStaffRole.ADMIN);
    expect(detail.staff[0]?.user).not.toHaveProperty('passwordHash');
    expect(JSON.stringify(detail)).not.toContain('passwordHash');
  });

  it('rejects a nonexistent hospital', async () => {
    await expect(getHospitalDetail(randomUUID())).rejects.toMatchObject({
      code: 'HOSPITAL_NOT_FOUND',
    });
  });
});
