import { randomUUID } from 'node:crypto';
import { UserRole, UserStatus, NotificationChannel, NotificationType } from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { AppError } from '../../../common/errors/app-error.js';
import { hashPassword } from '../../auth/index.js';
import {
  createOwnContact,
  deleteOwnContact,
  getOwnProfile,
  listOwnContacts,
  loadOnboardingPrincipalFromClaims,
  updateOwnContact,
  upsertOwnProfile,
} from './patient.service.js';

const TEST_PHONE_PREFIX = '+1559';

const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const createPatientUser = async (status: UserStatus = UserStatus.PENDING) =>
  prisma.user.create({
    data: {
      phone: randomTestPhone(),
      email: `test.${randomUUID()}@example.com`,
      passwordHash: await hashPassword('a-very-strong-passphrase'),
      role: UserRole.PATIENT,
      status,
      displayName: 'Patient Service Test User',
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

  const emergencies = await prisma.emergencyRequest.findMany({
    where: { patientId: { in: profileIds } },
    select: { id: true },
  });
  const emergencyIds = emergencies.map((e) => e.id);

  await prisma.notification.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.emergencyRequest.deleteMany({ where: { id: { in: emergencyIds } } });
  await prisma.emergencyContact.deleteMany({ where: { patientId: { in: profileIds } } });
  await prisma.patientProfile.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('loadOnboardingPrincipalFromClaims', () => {
  it('resolves a PENDING user', async () => {
    const user = await createPatientUser(UserStatus.PENDING);
    const principal = await loadOnboardingPrincipalFromClaims({ sub: user.id, jti: randomUUID() });

    expect(principal.userId).toBe(user.id);
  });

  it('rejects a suspended user', async () => {
    const user = await createPatientUser(UserStatus.SUSPENDED);

    await expect(
      loadOnboardingPrincipalFromClaims({ sub: user.id, jti: randomUUID() }),
    ).rejects.toMatchObject({
      code: 'INACTIVE_ACCOUNT',
    });
  });
});

describe('getOwnProfile / upsertOwnProfile', () => {
  it('returns null when no profile exists yet', async () => {
    const user = await createPatientUser();
    await expect(getOwnProfile(user.id)).resolves.toBeNull();
  });

  it('creates a profile on first upsert and updates it on the second', async () => {
    const user = await createPatientUser();

    const created = await upsertOwnProfile(user.id, { city: 'Springfield', gender: 'female' });
    expect(created.userId).toBe(user.id);
    expect(created.city).toBe('Springfield');

    const updated = await upsertOwnProfile(user.id, { city: 'Shelbyville' });
    expect(updated.id).toBe(created.id);
    expect(updated.city).toBe('Shelbyville');
    expect(updated.gender).toBe('female');
  });
});

describe('emergency contacts', () => {
  it('rejects creating a contact before a profile exists', async () => {
    const user = await createPatientUser();

    await expect(
      createOwnContact(user.id, { name: 'Jane', relationship: 'Sister', phone: '+15551230000' }),
    ).rejects.toMatchObject({ code: 'PATIENT_PROFILE_REQUIRED' });
  });

  it('makes the first contact primary automatically, regardless of input', async () => {
    const user = await createPatientUser();
    await upsertOwnProfile(user.id, {});

    const contact = await createOwnContact(user.id, {
      name: 'Jane',
      relationship: 'Sister',
      phone: '+15551230001',
      isPrimary: false,
    });

    expect(contact.isPrimary).toBe(true);
  });

  it('lets a second contact default to non-primary', async () => {
    const user = await createPatientUser();
    await upsertOwnProfile(user.id, {});
    await createOwnContact(user.id, {
      name: 'Jane',
      relationship: 'Sister',
      phone: '+15551230002',
    });

    const second = await createOwnContact(user.id, {
      name: 'Joe',
      relationship: 'Brother',
      phone: '+15551230003',
    });

    expect(second.isPrimary).toBe(false);
  });

  it('atomically swaps primary when a new contact is created as primary', async () => {
    const user = await createPatientUser();
    await upsertOwnProfile(user.id, {});
    const first = await createOwnContact(user.id, {
      name: 'Jane',
      relationship: 'Sister',
      phone: '+15551230004',
    });

    const second = await createOwnContact(user.id, {
      name: 'Joe',
      relationship: 'Brother',
      phone: '+15551230005',
      isPrimary: true,
    });

    const contacts = await listOwnContacts(user.id);
    const refreshedFirst = contacts.find((c) => c.id === first.id);

    expect(second.isPrimary).toBe(true);
    expect(refreshedFirst?.isPrimary).toBe(false);
  });

  it('atomically swaps primary when updating an existing contact to primary', async () => {
    const user = await createPatientUser();
    await upsertOwnProfile(user.id, {});
    const first = await createOwnContact(user.id, {
      name: 'Jane',
      relationship: 'Sister',
      phone: '+15551230006',
    });
    const second = await createOwnContact(user.id, {
      name: 'Joe',
      relationship: 'Brother',
      phone: '+15551230007',
    });

    const updatedSecond = await updateOwnContact(user.id, second.id, { isPrimary: true });

    const contacts = await listOwnContacts(user.id);
    const refreshedFirst = contacts.find((c) => c.id === first.id);

    expect(updatedSecond.isPrimary).toBe(true);
    expect(refreshedFirst?.isPrimary).toBe(false);
  });

  it('allows deleting contacts down to zero', async () => {
    const user = await createPatientUser();
    await upsertOwnProfile(user.id, {});
    const contact = await createOwnContact(user.id, {
      name: 'Jane',
      relationship: 'Sister',
      phone: '+15551230008',
    });

    await deleteOwnContact(user.id, contact.id);

    await expect(listOwnContacts(user.id)).resolves.toEqual([]);
  });

  it('rejects deleting a contact referenced by a Notification with a clean conflict error', async () => {
    const user = await createPatientUser();
    await upsertOwnProfile(user.id, {});
    const contact = await createOwnContact(user.id, {
      name: 'Jane',
      relationship: 'Sister',
      phone: '+15551230009',
    });

    const patientProfile = await prisma.patientProfile.findUniqueOrThrow({
      where: { userId: user.id },
    });
    const emergency = await prisma.emergencyRequest.create({
      data: {
        patientId: patientProfile.id,
        requestType: 'SOS',
        severity: 'UNKNOWN',
        currentStatus: 'CREATED',
      },
    });
    const notification = await prisma.notification.create({
      data: {
        emergencyId: emergency.id,
        emergencyContactId: contact.id,
        channel: NotificationChannel.SIMULATED_CONTACT,
        type: NotificationType.EMERGENCY_CREATED,
        title: 'Test notification',
      },
    });

    await expect(deleteOwnContact(user.id, contact.id)).rejects.toMatchObject({
      code: 'CONTACT_IN_USE',
    });

    await prisma.notification.delete({ where: { id: notification.id } });
    await prisma.emergencyRequest.delete({ where: { id: emergency.id } });
    await deleteOwnContact(user.id, contact.id);
  });

  it('rejects updating/deleting a contact that does not belong to the caller', async () => {
    const owner = await createPatientUser();
    await upsertOwnProfile(owner.id, {});
    const contact = await createOwnContact(owner.id, {
      name: 'Jane',
      relationship: 'Sister',
      phone: '+15551230010',
    });

    const attacker = await createPatientUser();
    await upsertOwnProfile(attacker.id, {});

    await expect(
      updateOwnContact(attacker.id, contact.id, { name: 'Hacked' }),
    ).rejects.toBeInstanceOf(AppError);
    await expect(deleteOwnContact(attacker.id, contact.id)).rejects.toBeInstanceOf(AppError);

    const stillThere = await listOwnContacts(owner.id);
    expect(stillThere).toHaveLength(1);
    expect(stillThere[0]?.name).toBe('Jane');
  });
});
