import { randomUUID } from 'node:crypto';
import { UserRole, UserStatus } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { hashPassword } from '../../auth/index.js';
import {
  approvePatient,
  getPatientVerificationDetail,
  listPendingPatients,
  rejectPatient,
} from './admin-patient.service.js';

const TEST_PHONE_PREFIX = '+1561';

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
      displayName: 'Admin Service Test User',
    },
  });

const createProfile = async (
  userId: string,
  overrides: { allergies?: string; medicalSummary?: string } = {},
) =>
  prisma.patientProfile.create({
    data: {
      userId,
      city: 'Springfield',
      allergies: overrides.allergies,
      medicalSummary: overrides.medicalSummary,
    },
  });

const createContact = async (patientId: string, isPrimary = false) =>
  prisma.emergencyContact.create({
    data: {
      patientId,
      name: 'Jane Contact',
      relationship: 'Sister',
      phone: '+15551239999',
      isPrimary,
    },
  });

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

describe('listPendingPatients', () => {
  it('returns only PENDING PATIENT users, with correct completeness flags, and excludes everything else', async () => {
    const readyPatient = await createUser(UserRole.PATIENT, UserStatus.PENDING);
    const readyProfile = await createProfile(readyPatient.id);
    await createContact(readyProfile.id, true);
    await createContact(readyProfile.id, false);

    const noContactsPatient = await createUser(UserRole.PATIENT, UserStatus.PENDING);
    await createProfile(noContactsPatient.id);

    const noProfilePatient = await createUser(UserRole.PATIENT, UserStatus.PENDING);

    const activePatient = await createUser(UserRole.PATIENT, UserStatus.ACTIVE);
    const rejectedPatient = await createUser(UserRole.PATIENT, UserStatus.REJECTED);
    const pendingDriver = await createUser(UserRole.DRIVER, UserStatus.PENDING);

    const list = await listPendingPatients();
    const ids = list.map((p) => p.id);

    expect(ids).toContain(readyPatient.id);
    expect(ids).toContain(noContactsPatient.id);
    expect(ids).toContain(noProfilePatient.id);
    expect(ids).not.toContain(activePatient.id);
    expect(ids).not.toContain(rejectedPatient.id);
    expect(ids).not.toContain(pendingDriver.id);

    const readyEntry = list.find((p) => p.id === readyPatient.id);
    expect(readyEntry).toMatchObject({ hasProfile: true, contactCount: 2 });
    expect(readyEntry).not.toHaveProperty('passwordHash');

    const noContactsEntry = list.find((p) => p.id === noContactsPatient.id);
    expect(noContactsEntry).toMatchObject({ hasProfile: true, contactCount: 0 });

    const noProfileEntry = list.find((p) => p.id === noProfilePatient.id);
    expect(noProfileEntry).toMatchObject({ hasProfile: false, contactCount: 0 });
  });
});

describe('getPatientVerificationDetail', () => {
  it('returns profile and contacts, excluding allergies/medicalSummary from the profile view', async () => {
    const patient = await createUser(UserRole.PATIENT, UserStatus.PENDING);
    const profile = await createProfile(patient.id, {
      allergies: 'peanuts',
      medicalSummary: 'asthma',
    });
    await createContact(profile.id, true);

    const detail = await getPatientVerificationDetail(patient.id);

    expect(detail.status).toBe(UserStatus.PENDING);
    expect(detail.profile).not.toBeNull();
    expect(detail.profile).not.toHaveProperty('allergies');
    expect(detail.profile).not.toHaveProperty('medicalSummary');
    expect(detail.contacts).toHaveLength(1);
    expect(detail.isReadyForApproval).toBe(true);
  });

  it('returns profile: null and isReadyForApproval: false when no profile exists', async () => {
    const patient = await createUser(UserRole.PATIENT, UserStatus.PENDING);

    const detail = await getPatientVerificationDetail(patient.id);

    expect(detail.profile).toBeNull();
    expect(detail.contacts).toEqual([]);
    expect(detail.isReadyForApproval).toBe(false);
  });

  it('rejects a nonexistent user id', async () => {
    await expect(getPatientVerificationDetail(randomUUID())).rejects.toMatchObject({
      code: 'PATIENT_NOT_FOUND',
    });
  });

  it('does not expose a non-PATIENT user through this endpoint', async () => {
    const driver = await createUser(UserRole.DRIVER, UserStatus.PENDING);

    await expect(getPatientVerificationDetail(driver.id)).rejects.toMatchObject({
      code: 'PATIENT_NOT_FOUND',
    });
  });
});

describe('approvePatient', () => {
  it('activates a PENDING patient with a profile and at least one contact', async () => {
    const patient = await createUser(UserRole.PATIENT, UserStatus.PENDING);
    const profile = await createProfile(patient.id);
    await createContact(profile.id, true);

    const result = await approvePatient(patient.id);

    expect(result.status).toBe(UserStatus.ACTIVE);
    expect(result).not.toHaveProperty('passwordHash');
  });

  it('rejects approval when no profile exists', async () => {
    const patient = await createUser(UserRole.PATIENT, UserStatus.PENDING);

    await expect(approvePatient(patient.id)).rejects.toMatchObject({
      code: 'PATIENT_NOT_READY_FOR_APPROVAL',
    });
  });

  it('rejects approval when there are zero emergency contacts', async () => {
    const patient = await createUser(UserRole.PATIENT, UserStatus.PENDING);
    await createProfile(patient.id);

    await expect(approvePatient(patient.id)).rejects.toMatchObject({
      code: 'PATIENT_NOT_READY_FOR_APPROVAL',
    });
  });

  it('rejects approval of an already-ACTIVE patient', async () => {
    const patient = await createUser(UserRole.PATIENT, UserStatus.ACTIVE);

    await expect(approvePatient(patient.id)).rejects.toMatchObject({
      code: 'PATIENT_STATUS_CONFLICT',
    });
  });

  it('rejects approval of a REJECTED patient', async () => {
    const patient = await createUser(UserRole.PATIENT, UserStatus.REJECTED);

    await expect(approvePatient(patient.id)).rejects.toMatchObject({
      code: 'PATIENT_STATUS_CONFLICT',
    });
  });

  it('rejects approval of a non-PATIENT account', async () => {
    const driver = await createUser(UserRole.DRIVER, UserStatus.PENDING);

    await expect(approvePatient(driver.id)).rejects.toMatchObject({ code: 'PATIENT_NOT_FOUND' });
  });

  it('rejects approval of a nonexistent patient', async () => {
    await expect(approvePatient(randomUUID())).rejects.toMatchObject({ code: 'PATIENT_NOT_FOUND' });
  });
});

describe('rejectPatient', () => {
  it('rejects a PENDING patient to REJECTED', async () => {
    const patient = await createUser(UserRole.PATIENT, UserStatus.PENDING);

    const result = await rejectPatient(patient.id);

    expect(result.status).toBe(UserStatus.REJECTED);
  });

  it('cannot reject a non-PENDING patient', async () => {
    const patient = await createUser(UserRole.PATIENT, UserStatus.ACTIVE);

    await expect(rejectPatient(patient.id)).rejects.toMatchObject({
      code: 'PATIENT_STATUS_CONFLICT',
    });
  });

  it('rejects a nonexistent patient cleanly', async () => {
    await expect(rejectPatient(randomUUID())).rejects.toMatchObject({ code: 'PATIENT_NOT_FOUND' });
  });
});

describe('concurrent approve/reject race safety', () => {
  it('lets exactly one of a concurrent approve+reject pair win', async () => {
    const patient = await createUser(UserRole.PATIENT, UserStatus.PENDING);
    const profile = await createProfile(patient.id);
    await createContact(profile.id, true);

    const [approveResult, rejectResult] = await Promise.allSettled([
      approvePatient(patient.id),
      rejectPatient(patient.id),
    ]);

    const outcomes = [approveResult, rejectResult];
    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === 'rejected') {
      expect(rejected[0].reason).toMatchObject({ code: 'PATIENT_STATUS_CONFLICT' });
    }

    const finalUser = await prisma.user.findUniqueOrThrow({ where: { id: patient.id } });
    expect([UserStatus.ACTIVE, UserStatus.REJECTED]).toContain(finalUser.status);
  });
});
