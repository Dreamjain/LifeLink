import { randomUUID } from 'node:crypto';
import {
  EmergencyStatus,
  EmergencyType,
  Severity,
  TransitionActorType,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { matchEmergencyToHospitals } from '../../hospitals/services/hospital-matching.service.js';
import { MAX_CLIENT_IDEMPOTENCY_KEY_LENGTH } from '../schemas/emergency.schema.js';
import {
  cancelOwnEmergency,
  createOwnEmergency,
  getOwnEmergency,
  listOwnEmergencies,
  namespaceIdempotencyKey,
  resolvePatientContext,
} from './emergency.service.js';

/**
 * Task 1.18 integrates hospital matching into SOS creation, and matching scans every eligible
 * hospital in the database. This suite owns Task 1.17 semantics and deliberately creates no
 * hospital fixtures, so matching is stubbed here: the assertions below must not depend on
 * whether another suite happens to have an eligible hospital in the shared test database.
 *
 * The real SOS -> matching integration is covered against controlled fixtures in
 * hospitals/services/hospital-matching.service.test.ts.
 */
vi.mock('../../hospitals/services/hospital-matching.service.js', () => ({
  matchEmergencyToHospitals: vi.fn(async (emergencyId: string) => ({
    emergencyId,
    matched: false,
    hospitalCount: 0,
    idempotentReplay: false,
  })),
}));

const TEST_PHONE_PREFIX = '+1717';

const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const randomKey = (): string => `k-${randomUUID().slice(0, 12)}`;

/** An ACTIVE patient with a profile carrying sentinel medical data that must never leak. */
const createPatient = async () => {
  const user = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      passwordHash: 'not-used-in-this-fixture',
      role: UserRole.PATIENT,
      status: UserStatus.ACTIVE,
      displayName: 'Fixture Patient',
      patientProfile: {
        create: {
          allergies: 'FIXTURE-ALLERGY-MUST-NOT-LEAK',
          medicalSummary: 'FIXTURE-SUMMARY-MUST-NOT-LEAK',
        },
      },
    },
    include: { patientProfile: true },
  });

  return { userId: user.id, phone: user.phone, profile: user.patientProfile! };
};

const createPatientWithoutProfile = async () => {
  const user = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      passwordHash: 'not-used-in-this-fixture',
      role: UserRole.PATIENT,
      status: UserStatus.ACTIVE,
      displayName: 'Profileless Patient',
    },
  });

  return user.id;
};

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

  await prisma.emergencyStatusHistory.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.emergencyRequest.deleteMany({ where: { id: { in: emergencyIds } } });
  await prisma.patientProfile.deleteMany({ where: { id: { in: profileIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('resolvePatientContext', () => {
  it('resolves the profile from the authenticated user id', async () => {
    const patient = await createPatient();

    expect(await resolvePatientContext(patient.userId)).toMatchObject({
      patientProfileId: patient.profile.id,
      userId: patient.userId,
    });
  });

  it('requires a patient profile', async () => {
    const userId = await createPatientWithoutProfile();

    await expect(resolvePatientContext(userId)).rejects.toMatchObject({
      code: 'PATIENT_PROFILE_REQUIRED',
      statusCode: 409,
    });
  });
});

describe('createOwnEmergency', () => {
  it('creates at CREATED with the schema defaults and an opening history row', async () => {
    const patient = await createPatient();

    const result = await createOwnEmergency(patient.userId, {}, randomKey());

    expect(result.idempotentReplay).toBe(false);
    expect(result.emergency.currentStatus).toBe(EmergencyStatus.CREATED);
    expect(result.emergency.requestType).toBe(EmergencyType.SOS);
    expect(result.emergency.severity).toBe(Severity.UNKNOWN);
    expect(result.emergency.cancelledAt).toBeNull();
    expect(result.emergency.completedAt).toBeNull();

    const stored = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: result.emergency.id },
    });
    expect(stored.patientId).toBe(patient.profile.id);

    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: result.emergency.id },
    });
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      fromStatus: null,
      toStatus: EmergencyStatus.CREATED,
      actorType: TransitionActorType.PATIENT,
      actorUserId: patient.userId,
    });
  });

  it('persists the patient-supplied fields', async () => {
    const patient = await createPatient();

    const result = await createOwnEmergency(
      patient.userId,
      {
        requestType: EmergencyType.AMBULANCE_REQUEST,
        severity: Severity.CRITICAL,
        description: 'Chest pain',
        pickupAddress: '12 Elm Street',
        pickupLatitude: 26.6,
        pickupLongitude: -74.03,
      },
      randomKey(),
    );

    expect(result.emergency).toMatchObject({
      requestType: EmergencyType.AMBULANCE_REQUEST,
      severity: Severity.CRITICAL,
      description: 'Chest pain',
      pickupAddress: '12 Elm Street',
    });
    expect(Number(result.emergency.pickupLatitude)).toBeCloseTo(26.6, 5);
    expect(Number(result.emergency.pickupLongitude)).toBeCloseTo(-74.03, 5);
  });

  it('derives patientId from the authenticated user and never exposes it', async () => {
    const patient = await createPatient();
    const result = await createOwnEmergency(patient.userId, {}, randomKey());

    expect(result.emergency).not.toHaveProperty('patientId');
    expect(result.emergency).not.toHaveProperty('idempotencyKey');
  });

  it('requires a patient profile before creating', async () => {
    const userId = await createPatientWithoutProfile();

    await expect(createOwnEmergency(userId, {}, randomKey())).rejects.toMatchObject({
      code: 'PATIENT_PROFILE_REQUIRED',
      statusCode: 409,
    });
  });

  it('allows a patient to hold more than one active emergency', async () => {
    const patient = await createPatient();

    const first = await createOwnEmergency(patient.userId, {}, randomKey());
    const second = await createOwnEmergency(patient.userId, {}, randomKey());

    expect(first.emergency.id).not.toBe(second.emergency.id);
    expect(await prisma.emergencyRequest.count({ where: { patientId: patient.profile.id } })).toBe(
      2,
    );
  });
  it('runs hospital matching exactly once for a newly created emergency', async () => {
    const patient = await createPatient();
    vi.mocked(matchEmergencyToHospitals).mockClear();

    const result = await createOwnEmergency(patient.userId, {}, randomKey());

    expect(matchEmergencyToHospitals).toHaveBeenCalledTimes(1);
    expect(matchEmergencyToHospitals).toHaveBeenCalledWith(result.emergency.id);
  });

  it('keeps a valid SOS when hospital matching fails', async () => {
    const patient = await createPatient();
    vi.mocked(matchEmergencyToHospitals).mockRejectedValueOnce(new Error('matching unavailable'));

    const result = await createOwnEmergency(patient.userId, {}, randomKey());

    // Matching runs after the creation transaction commits, so its failure must not roll
    // back the emergency or its opening history row.
    expect(result.emergency.currentStatus).toBe(EmergencyStatus.CREATED);
    expect(await prisma.emergencyRequest.count({ where: { patientId: patient.profile.id } })).toBe(
      1,
    );
    expect(
      await prisma.emergencyStatusHistory.count({ where: { emergencyId: result.emergency.id } }),
    ).toBe(1);
  });
});

describe('idempotency', () => {
  it('replays the same emergency for a repeated key', async () => {
    const patient = await createPatient();
    const key = randomKey();

    const first = await createOwnEmergency(patient.userId, { description: 'first' }, key);
    const replay = await createOwnEmergency(patient.userId, { description: 'ignored' }, key);

    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.emergency.id).toBe(first.emergency.id);
    // The replay returns the original record, not the retried payload.
    expect(replay.emergency.description).toBe('first');

    expect(await prisma.emergencyRequest.count({ where: { patientId: patient.profile.id } })).toBe(
      1,
    );
    expect(
      await prisma.emergencyStatusHistory.count({ where: { emergencyId: first.emergency.id } }),
    ).toBe(1);
  });

  it('lets two different patients use the same client key without collision', async () => {
    const patientA = await createPatient();
    const patientB = await createPatient();
    const sharedKey = 'sos-1';

    const a = await createOwnEmergency(patientA.userId, {}, sharedKey);
    const b = await createOwnEmergency(patientB.userId, {}, sharedKey);

    expect(b.idempotentReplay).toBe(false);
    expect(b.emergency.id).not.toBe(a.emergency.id);

    const storedA = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: a.emergency.id },
    });
    const storedB = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: b.emergency.id },
    });
    expect(storedA.idempotencyKey).toBe(namespaceIdempotencyKey(patientA.profile.id, sharedKey));
    expect(storedB.idempotencyKey).toBe(namespaceIdempotencyKey(patientB.profile.id, sharedKey));
  });

  it('stores a namespaced key that fits the column at maximum length', async () => {
    const patient = await createPatient();
    const key = 'k'.repeat(MAX_CLIENT_IDEMPOTENCY_KEY_LENGTH);

    const result = await createOwnEmergency(patient.userId, {}, key);

    const stored = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: result.emergency.id },
    });
    expect(stored.idempotencyKey).toBe(namespaceIdempotencyKey(patient.profile.id, key));
    expect(stored.idempotencyKey!.length).toBeLessThanOrEqual(128);
  });

  it.each([1, 2, 3])(
    'run %i: concurrent duplicate submissions create exactly one emergency',
    async () => {
      const patient = await createPatient();
      const key = randomKey();

      const outcomes = await Promise.all([
        createOwnEmergency(patient.userId, {}, key),
        createOwnEmergency(patient.userId, {}, key),
      ]);

      // Both callers succeed; exactly one of them created the record.
      expect(outcomes.filter((o) => o.idempotentReplay === false)).toHaveLength(1);
      expect(outcomes.filter((o) => o.idempotentReplay === true)).toHaveLength(1);
      expect(outcomes[0]!.emergency.id).toBe(outcomes[1]!.emergency.id);

      expect(
        await prisma.emergencyRequest.count({ where: { patientId: patient.profile.id } }),
      ).toBe(1);
      expect(
        await prisma.emergencyStatusHistory.count({
          where: { emergencyId: outcomes[0]!.emergency.id },
        }),
      ).toBe(1);
    },
  );
});

describe('ownership reads', () => {
  it('lists and reads only the caller own emergencies', async () => {
    const patient = await createPatient();
    const created = await createOwnEmergency(patient.userId, {}, randomKey());

    const listed = await listOwnEmergencies(patient.userId);
    expect(listed.map((e) => e.id)).toEqual([created.emergency.id]);

    expect((await getOwnEmergency(patient.userId, created.emergency.id)).id).toBe(
      created.emergency.id,
    );
  });

  it('does not disclose another patient emergency', async () => {
    const patientA = await createPatient();
    const patientB = await createPatient();
    const created = await createOwnEmergency(patientA.userId, {}, randomKey());

    await expect(getOwnEmergency(patientB.userId, created.emergency.id)).rejects.toMatchObject({
      code: 'EMERGENCY_NOT_FOUND',
      statusCode: 404,
    });
    expect(await listOwnEmergencies(patientB.userId)).toHaveLength(0);
  });

  it('rejects a nonexistent emergency', async () => {
    const patient = await createPatient();

    await expect(getOwnEmergency(patient.userId, randomUUID())).rejects.toMatchObject({
      code: 'EMERGENCY_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('exposes no patient profile or credential data', async () => {
    const patient = await createPatient();
    const created = await createOwnEmergency(patient.userId, {}, randomKey());
    const read = await getOwnEmergency(patient.userId, created.emergency.id);

    const serialized = JSON.stringify(read);
    expect(serialized).not.toContain('FIXTURE-ALLERGY-MUST-NOT-LEAK');
    expect(serialized).not.toContain('FIXTURE-SUMMARY-MUST-NOT-LEAK');
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain(patient.phone);
    expect(read).not.toHaveProperty('patientId');
    expect(read).not.toHaveProperty('patient');
    expect(read).not.toHaveProperty('idempotencyKey');
  });
});

describe('cancelOwnEmergency', () => {
  it('cancels a CREATED emergency, stamps cancelledAt and appends history', async () => {
    const patient = await createPatient();
    const created = await createOwnEmergency(patient.userId, {}, randomKey());

    const cancelled = await cancelOwnEmergency(patient.userId, created.emergency.id);

    expect(cancelled.currentStatus).toBe(EmergencyStatus.CANCELLED);
    expect(cancelled.cancelledAt).not.toBeNull();

    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: created.emergency.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(history).toHaveLength(2);
    expect(history[1]).toMatchObject({
      fromStatus: EmergencyStatus.CREATED,
      toStatus: EmergencyStatus.CANCELLED,
      actorType: TransitionActorType.PATIENT,
      actorUserId: patient.userId,
    });

    // The row is retained, never deleted.
    expect(
      await prisma.emergencyRequest.findUnique({ where: { id: created.emergency.id } }),
    ).not.toBeNull();
  });

  it('refuses a repeated cancellation', async () => {
    const patient = await createPatient();
    const created = await createOwnEmergency(patient.userId, {}, randomKey());
    await cancelOwnEmergency(patient.userId, created.emergency.id);

    await expect(cancelOwnEmergency(patient.userId, created.emergency.id)).rejects.toMatchObject({
      code: 'EMERGENCY_STATUS_CONFLICT',
      statusCode: 409,
    });

    expect(
      await prisma.emergencyStatusHistory.count({ where: { emergencyId: created.emergency.id } }),
    ).toBe(2);
  });

  it.each([
    EmergencyStatus.PENDING_HOSPITAL_RESPONSE,
    EmergencyStatus.HOSPITAL_ACCEPTED,
    EmergencyStatus.BED_RESERVED,
    EmergencyStatus.AMBULANCE_ASSIGNED,
    EmergencyStatus.PENDING_DRIVER_ACCEPTANCE,
  ])('refuses to cancel from %s', async (currentStatus) => {
    const patient = await createPatient();
    const created = await createOwnEmergency(patient.userId, {}, randomKey());
    await prisma.emergencyRequest.update({
      where: { id: created.emergency.id },
      data: { currentStatus },
    });

    await expect(cancelOwnEmergency(patient.userId, created.emergency.id)).rejects.toMatchObject({
      code: 'EMERGENCY_STATUS_CONFLICT',
      statusCode: 409,
    });

    const stored = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: created.emergency.id },
    });
    expect(stored.currentStatus).toBe(currentStatus);
    expect(stored.cancelledAt).toBeNull();
  });

  it('cannot cancel another patient emergency and reports it as not found', async () => {
    const patientA = await createPatient();
    const patientB = await createPatient();
    const created = await createOwnEmergency(patientA.userId, {}, randomKey());

    await expect(cancelOwnEmergency(patientB.userId, created.emergency.id)).rejects.toMatchObject({
      code: 'EMERGENCY_NOT_FOUND',
      statusCode: 404,
    });

    const stored = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: created.emergency.id },
    });
    expect(stored.currentStatus).toBe(EmergencyStatus.CREATED);
    expect(stored.cancelledAt).toBeNull();
  });

  it('rejects cancelling a nonexistent emergency', async () => {
    const patient = await createPatient();

    await expect(cancelOwnEmergency(patient.userId, randomUUID())).rejects.toMatchObject({
      code: 'EMERGENCY_NOT_FOUND',
      statusCode: 404,
    });
  });

  it.each([1, 2, 3])('run %i: concurrent cancellations yield one transition', async () => {
    const patient = await createPatient();
    const created = await createOwnEmergency(patient.userId, {}, randomKey());

    const outcomes = await Promise.allSettled([
      cancelOwnEmergency(patient.userId, created.emergency.id),
      cancelOwnEmergency(patient.userId, created.emergency.id),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);

    expect(
      await prisma.emergencyStatusHistory.count({
        where: { emergencyId: created.emergency.id, toStatus: EmergencyStatus.CANCELLED },
      }),
    ).toBe(1);
  });
});
