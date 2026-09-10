import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { EmergencyStatus, EmergencyType, Severity, UserRole, UserStatus } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { hashPassword, requireAuth, requireRole, signAccessToken } from '../../auth/index.js';
import {
  cancelEmergency,
  createEmergency,
  getEmergency,
  listEmergencies,
} from './emergency.controller.js';

const TEST_PHONE_PREFIX = '+1718';
const PASSWORD = 'a-very-strong-passphrase';

const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const randomKey = (): string => `k-${randomUUID().slice(0, 12)}`;

const buildRes = (): Response => {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

const jsonPayload = (res: Response): Record<string, unknown> =>
  (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as Record<
    string,
    unknown
  >;

const buildAuthHeaderReq = (authorization?: string): Request =>
  ({
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
  }) as unknown as Request;

const buildReq = (options: {
  body?: unknown;
  params?: Record<string, string>;
  userId?: string;
  role?: UserRole;
  idempotencyKey?: string;
}): Request =>
  ({
    body: options.body,
    params: options.params ?? {},
    header: (name: string) =>
      name.toLowerCase() === 'idempotency-key' ? options.idempotencyKey : undefined,
    user: options.userId
      ? { userId: options.userId, role: options.role ?? UserRole.PATIENT, jti: randomUUID() }
      : undefined,
    correlationId: 'test-correlation-id',
  }) as unknown as Request;

const createUser = async (role: UserRole, status: UserStatus, withProfile = true) => {
  const user = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      passwordHash: await hashPassword(PASSWORD),
      role,
      status,
      displayName: 'Controller Fixture',
      ...(withProfile && role === UserRole.PATIENT
        ? {
            patientProfile: {
              create: {
                allergies: 'FIXTURE-ALLERGY-MUST-NOT-LEAK',
                medicalSummary: 'FIXTURE-SUMMARY-MUST-NOT-LEAK',
              },
            },
          }
        : {}),
    },
    include: { patientProfile: true },
  });

  return user;
};

const createActivePatient = async () => createUser(UserRole.PATIENT, UserStatus.ACTIVE);

/** Creates one emergency through the controller and returns the parsed payload. */
const createThroughController = async (userId: string, body: unknown = {}) => {
  const res = buildRes();
  await createEmergency(buildReq({ userId, body, idempotencyKey: randomKey() }), res, vi.fn());
  return {
    res,
    emergency: (jsonPayload(res) as { emergency: { id: string } }).emergency,
  };
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

describe('emergency route authentication', () => {
  it('rejects an unauthenticated request', async () => {
    const next = vi.fn();
    await requireAuth(buildAuthHeaderReq(undefined), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });

  it('rejects a malformed authorization header', async () => {
    const next = vi.fn();
    await requireAuth(buildAuthHeaderReq('Token abc'), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MALFORMED_TOKEN' }));
  });

  it('rejects an unverifiable token', async () => {
    const next = vi.fn();
    await requireAuth(buildAuthHeaderReq('Bearer not-a-real-token'), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });

  it('admits an ACTIVE patient', async () => {
    const user = await createActivePatient();
    const token = signAccessToken({ userId: user.id, role: user.role });
    const req = buildAuthHeaderReq(`Bearer ${token}`);

    const next = vi.fn();
    await requireAuth(req, buildRes(), next);
    expect(next).toHaveBeenCalledWith();
  });

  it.each([UserStatus.PENDING, UserStatus.REJECTED, UserStatus.SUSPENDED, UserStatus.DEACTIVATED])(
    'rejects a %s patient with INACTIVE_ACCOUNT',
    async (status) => {
      const user = await createUser(UserRole.PATIENT, status);
      const token = signAccessToken({ userId: user.id, role: user.role });

      const next = vi.fn();
      await requireAuth(buildAuthHeaderReq(`Bearer ${token}`), buildRes(), next);

      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'INACTIVE_ACCOUNT', statusCode: 403 }),
      );
    },
  );
});

describe('emergency role authorization', () => {
  it.each([UserRole.DRIVER, UserRole.HOSPITAL_STAFF, UserRole.ADMIN])(
    'rejects a %s account',
    async (role) => {
      const user = await createUser(role, UserStatus.ACTIVE);
      const token = signAccessToken({ userId: user.id, role: user.role });
      const req = buildAuthHeaderReq(`Bearer ${token}`);

      const authNext = vi.fn();
      await requireAuth(req, buildRes(), authNext);
      expect(authNext).toHaveBeenCalledWith();

      const roleNext = vi.fn();
      requireRole(UserRole.PATIENT)(req, buildRes(), roleNext);
      expect(roleNext).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'INSUFFICIENT_ROLE', statusCode: 403 }),
      );
    },
  );

  it('admits a PATIENT account', () => {
    const next = vi.fn();
    requireRole(UserRole.PATIENT)(
      buildReq({ userId: randomUUID(), role: UserRole.PATIENT }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith();
  });
});

describe('create emergency controller', () => {
  it('creates an emergency and returns 201', async () => {
    const patient = await createActivePatient();
    const { res, emergency } = await createThroughController(patient.id);

    expect(res.status).toHaveBeenCalledWith(201);
    expect(emergency).toMatchObject({
      currentStatus: EmergencyStatus.CREATED,
      requestType: EmergencyType.SOS,
      severity: Severity.UNKNOWN,
    });
    expect(jsonPayload(res)).toMatchObject({ idempotentReplay: false });
  });

  it('returns 200 on an idempotent replay', async () => {
    const patient = await createActivePatient();
    const key = randomKey();

    const firstRes = buildRes();
    await createEmergency(
      buildReq({ userId: patient.id, body: {}, idempotencyKey: key }),
      firstRes,
      vi.fn(),
    );
    const replayRes = buildRes();
    await createEmergency(
      buildReq({ userId: patient.id, body: {}, idempotencyKey: key }),
      replayRes,
      vi.fn(),
    );

    expect(firstRes.status).toHaveBeenCalledWith(201);
    expect(replayRes.status).toHaveBeenCalledWith(200);
    expect(jsonPayload(replayRes)).toMatchObject({ idempotentReplay: true });
    expect((jsonPayload(replayRes) as { emergency: { id: string } }).emergency.id).toBe(
      (jsonPayload(firstRes) as { emergency: { id: string } }).emergency.id,
    );
  });

  it('requires the Idempotency-Key header', async () => {
    const patient = await createActivePatient();
    const next = vi.fn();

    await createEmergency(buildReq({ userId: patient.id, body: {} }), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('rejects a malformed Idempotency-Key header', async () => {
    const patient = await createActivePatient();
    const next = vi.fn();

    await createEmergency(
      buildReq({ userId: patient.id, body: {}, idempotencyKey: 'has space' }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it.each(['patientId', 'currentStatus', 'id', 'cancelledAt', 'createdAt'])(
    'rejects the server-controlled field %s',
    async (field) => {
      const patient = await createActivePatient();
      const next = vi.fn();

      await createEmergency(
        buildReq({
          userId: patient.id,
          body: { [field]: randomUUID() },
          idempotencyKey: randomKey(),
        }),
        buildRes(),
        next,
      );

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    },
  );

  it('rejects an out-of-range coordinate', async () => {
    const patient = await createActivePatient();
    const next = vi.fn();

    await createEmergency(
      buildReq({
        userId: patient.id,
        body: { pickupLatitude: 91 },
        idempotencyKey: randomKey(),
      }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('returns 409 for an ACTIVE patient with no profile', async () => {
    const user = await createUser(UserRole.PATIENT, UserStatus.ACTIVE, false);
    const next = vi.fn();

    await createEmergency(
      buildReq({ userId: user.id, body: {}, idempotencyKey: randomKey() }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PATIENT_PROFILE_REQUIRED', statusCode: 409 }),
    );
  });

  it('rejects a request with no authenticated principal', async () => {
    const next = vi.fn();
    await createEmergency(buildReq({ body: {} }), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });
});

describe('read and cancel controllers', () => {
  it('lists and reads the patient own emergency', async () => {
    const patient = await createActivePatient();
    const { emergency } = await createThroughController(patient.id);

    const listRes = buildRes();
    await listEmergencies(buildReq({ userId: patient.id }), listRes, vi.fn());
    expect(listRes.status).toHaveBeenCalledWith(200);

    const readRes = buildRes();
    await getEmergency(
      buildReq({ userId: patient.id, params: { emergencyId: emergency.id } }),
      readRes,
      vi.fn(),
    );
    expect(readRes.status).toHaveBeenCalledWith(200);
  });

  it('does not disclose another patient emergency on read or cancel', async () => {
    const patientA = await createActivePatient();
    const patientB = await createActivePatient();
    const { emergency } = await createThroughController(patientA.id);

    const readNext = vi.fn();
    await getEmergency(
      buildReq({ userId: patientB.id, params: { emergencyId: emergency.id } }),
      buildRes(),
      readNext,
    );
    expect(readNext).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EMERGENCY_NOT_FOUND', statusCode: 404 }),
    );

    const cancelNext = vi.fn();
    await cancelEmergency(
      buildReq({ userId: patientB.id, params: { emergencyId: emergency.id }, body: {} }),
      buildRes(),
      cancelNext,
    );
    expect(cancelNext).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EMERGENCY_NOT_FOUND', statusCode: 404 }),
    );
  });

  it('cancels the patient own emergency', async () => {
    const patient = await createActivePatient();
    const { emergency } = await createThroughController(patient.id);

    const res = buildRes();
    await cancelEmergency(
      buildReq({ userId: patient.id, params: { emergencyId: emergency.id }, body: {} }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(jsonPayload(res)).toMatchObject({
      emergency: { currentStatus: EmergencyStatus.CANCELLED },
    });
  });

  it('rejects a client-supplied field on cancel', async () => {
    const patient = await createActivePatient();
    const { emergency } = await createThroughController(patient.id);
    const next = vi.fn();

    await cancelEmergency(
      buildReq({
        userId: patient.id,
        params: { emergencyId: emergency.id },
        body: { currentStatus: EmergencyStatus.COMPLETED },
      }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('rejects an invalid emergency id param', async () => {
    const patient = await createActivePatient();
    const next = vi.fn();

    await getEmergency(
      buildReq({ userId: patient.id, params: { emergencyId: 'not-a-uuid' } }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });

  it('returns no patient or credential data in any payload', async () => {
    const patient = await createActivePatient();
    const { res: createRes, emergency } = await createThroughController(patient.id);

    const listRes = buildRes();
    await listEmergencies(buildReq({ userId: patient.id }), listRes, vi.fn());

    const readRes = buildRes();
    await getEmergency(
      buildReq({ userId: patient.id, params: { emergencyId: emergency.id } }),
      readRes,
      vi.fn(),
    );

    for (const [label, res] of [
      ['create', createRes],
      ['list', listRes],
      ['read', readRes],
    ] as const) {
      const serialized = JSON.stringify(jsonPayload(res));
      expect(serialized, label).not.toContain('FIXTURE-ALLERGY-MUST-NOT-LEAK');
      expect(serialized, label).not.toContain('FIXTURE-SUMMARY-MUST-NOT-LEAK');
      expect(serialized, label).not.toContain('passwordHash');
      expect(serialized, label).not.toContain(patient.phone);
      expect(serialized, label).not.toContain('patientId');
      expect(serialized, label).not.toContain('idempotencyKey');
    }
  });
});
