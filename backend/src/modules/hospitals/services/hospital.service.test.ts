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
import { hashPassword } from '../../auth/index.js';
import {
  createHospitalStaff,
  getOwnHospitalContext,
  listOwnHospitalStaff,
  resolveHospitalStaffContext,
} from './hospital.service.js';

const TEST_REG_PREFIX = 'T1568-';
const TEST_PHONE_PREFIX = '+1568';

const randomRegistration = (): string => `${TEST_REG_PREFIX}${randomUUID().slice(0, 12)}`;
const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const createHospitalRow = async (status: HospitalStatus = HospitalStatus.VERIFIED) =>
  prisma.hospital.create({
    data: {
      name: 'Scope Test Hospital',
      registrationNumber: randomRegistration(),
      phone: randomTestPhone(),
      email: `hospital.${randomUUID()}@example.com`,
      addressLine: '1 Main Street',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      status,
    },
  });

const createStaffMember = async (
  hospitalId: string,
  staffRole: HospitalStaffRole,
  membershipStatus: MembershipStatus = MembershipStatus.ACTIVE,
) => {
  const user = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      email: `staff.${randomUUID()}@example.com`,
      passwordHash: await hashPassword('a-very-strong-passphrase'),
      role: UserRole.HOSPITAL_STAFF,
      status: UserStatus.ACTIVE,
      displayName: 'Scope Test Staff',
      hospitalMemberships: { create: { hospitalId, staffRole, status: membershipStatus } },
    },
  });

  return user;
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

describe('resolveHospitalStaffContext', () => {
  it('resolves scope from the caller own active membership', async () => {
    const hospital = await createHospitalRow();
    const staff = await createStaffMember(hospital.id, HospitalStaffRole.ADMIN);

    const context = await resolveHospitalStaffContext(staff.id);

    expect(context.hospitalId).toBe(hospital.id);
    expect(context.staffRole).toBe(HospitalStaffRole.ADMIN);
  });

  it('denies a user with no membership', async () => {
    await expect(resolveHospitalStaffContext(randomUUID())).rejects.toMatchObject({
      code: 'HOSPITAL_SCOPE_DENIED',
    });
  });

  it.each([MembershipStatus.SUSPENDED, MembershipStatus.REMOVED])(
    'denies a user whose membership is %s',
    async (membershipStatus) => {
      const hospital = await createHospitalRow();
      const staff = await createStaffMember(hospital.id, HospitalStaffRole.ADMIN, membershipStatus);

      await expect(resolveHospitalStaffContext(staff.id)).rejects.toMatchObject({
        code: 'HOSPITAL_SCOPE_DENIED',
      });
    },
  );
});

describe('createHospitalStaff', () => {
  const staffInput = (staffRole: HospitalStaffRole) => ({
    phone: randomTestPhone(),
    email: `new.${randomUUID()}@example.com`,
    password: 'a-very-strong-passphrase',
    displayName: 'New Staff',
    staffRole: staffRole as 'DISPATCHER' | 'RECEPTIONIST' | 'CLINICAL_COORDINATOR',
  });

  it.each([
    HospitalStaffRole.DISPATCHER,
    HospitalStaffRole.RECEPTIONIST,
    HospitalStaffRole.CLINICAL_COORDINATOR,
  ])('creates a %s scoped to the caller hospital', async (staffRole) => {
    const hospital = await createHospitalRow();
    const admin = await createStaffMember(hospital.id, HospitalStaffRole.ADMIN);
    const context = await resolveHospitalStaffContext(admin.id);

    const membership = await createHospitalStaff(context, staffInput(staffRole));

    expect(membership.staffRole).toBe(staffRole);
    expect(membership.hospitalId).toBe(hospital.id);
    expect(membership.status).toBe(MembershipStatus.ACTIVE);
    expect(membership.user).not.toHaveProperty('passwordHash');

    const created = await prisma.user.findUniqueOrThrow({ where: { id: membership.user.id } });
    expect(created.role).toBe(UserRole.HOSPITAL_STAFF);
    expect(created.status).toBe(UserStatus.ACTIVE);
  });

  it('rejects a duplicate phone and leaves no orphan user (atomicity)', async () => {
    const hospital = await createHospitalRow();
    const admin = await createStaffMember(hospital.id, HospitalStaffRole.ADMIN);
    const context = await resolveHospitalStaffContext(admin.id);

    const first = staffInput(HospitalStaffRole.DISPATCHER);
    await createHospitalStaff(context, first);

    const duplicate = { ...staffInput(HospitalStaffRole.RECEPTIONIST), phone: first.phone };
    await expect(createHospitalStaff(context, duplicate)).rejects.toMatchObject({
      code: 'ACCOUNT_ALREADY_EXISTS',
    });

    expect(await prisma.user.count({ where: { email: duplicate.email } })).toBe(0);
  });

  it('always scopes new staff to the caller hospital, never to another hospital', async () => {
    const hospitalA = await createHospitalRow();
    const hospitalB = await createHospitalRow();
    const adminA = await createStaffMember(hospitalA.id, HospitalStaffRole.ADMIN);
    const contextA = await resolveHospitalStaffContext(adminA.id);

    const membership = await createHospitalStaff(
      contextA,
      staffInput(HospitalStaffRole.DISPATCHER),
    );

    expect(membership.hospitalId).toBe(hospitalA.id);
    expect(membership.hospitalId).not.toBe(hospitalB.id);

    const staffInB = await prisma.hospitalStaffMembership.count({
      where: { hospitalId: hospitalB.id },
    });
    expect(staffInB).toBe(0);
  });
});

describe('cross-hospital isolation (IDOR)', () => {
  it('staff A sees only hospital A context and staff, never hospital B', async () => {
    const hospitalA = await createHospitalRow();
    const hospitalB = await createHospitalRow();
    const staffA = await createStaffMember(hospitalA.id, HospitalStaffRole.ADMIN);
    const staffB = await createStaffMember(hospitalB.id, HospitalStaffRole.ADMIN);

    const contextA = await resolveHospitalStaffContext(staffA.id);
    const own = await getOwnHospitalContext(contextA);
    const staffList = await listOwnHospitalStaff(contextA);

    expect(own.hospital.id).toBe(hospitalA.id);
    expect(own.hospital.id).not.toBe(hospitalB.id);

    const listedUserIds = staffList.map((m) => m.user.id);
    expect(listedUserIds).toContain(staffA.id);
    expect(listedUserIds).not.toContain(staffB.id);
    staffList.forEach((m) => expect(m.hospitalId).toBe(hospitalA.id));
  });

  it('a forged context for another hospital cannot be produced from staff A identity', async () => {
    const hospitalA = await createHospitalRow();
    const hospitalB = await createHospitalRow();
    const staffA = await createStaffMember(hospitalA.id, HospitalStaffRole.ADMIN);

    // Scope is derived solely from the caller's membership row, so hospital B is unreachable.
    const context = await resolveHospitalStaffContext(staffA.id);

    expect(context.hospitalId).toBe(hospitalA.id);
    expect(context.hospitalId).not.toBe(hospitalB.id);
  });
});
