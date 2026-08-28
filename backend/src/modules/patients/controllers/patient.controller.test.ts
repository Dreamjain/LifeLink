import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { UserRole, UserStatus } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { hashPassword } from '../../auth/index.js';
import type { AuthenticatedPrincipal } from '../../auth/index.js';
import {
  createContact,
  getProfile,
  listContacts,
  putProfile,
  updateContact,
} from './patient.controller.js';

const TEST_PHONE_PREFIX = '+1560';

const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const createPatientUser = async () =>
  prisma.user.create({
    data: {
      phone: randomTestPhone(),
      email: `test.${randomUUID()}@example.com`,
      passwordHash: await hashPassword('a-very-strong-passphrase'),
      role: UserRole.PATIENT,
      status: UserStatus.PENDING,
      displayName: 'Patient Controller Test User',
    },
  });

const buildRes = (): Response => {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  res.send = vi.fn().mockReturnValue(res);
  return res;
};

const buildReq = (
  body: unknown,
  user: AuthenticatedPrincipal | undefined,
  params: Record<string, string> = {},
): Request => ({ body, user, params, correlationId: 'test-correlation-id' }) as unknown as Request;

const jsonPayload = (res: Response): Record<string, unknown> =>
  (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as Record<
    string,
    unknown
  >;

const principalFor = (userId: string): AuthenticatedPrincipal => ({
  userId,
  role: UserRole.PATIENT,
  jti: randomUUID(),
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

describe('patient.controller getProfile', () => {
  it('returns { profile: null } when no profile exists', async () => {
    const user = await createPatientUser();
    const res = buildRes();

    await getProfile(buildReq(undefined, principalFor(user.id)), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(jsonPayload(res)).toEqual({ profile: null });
  });

  it('rejects an unauthenticated request', async () => {
    const next = vi.fn();
    await getProfile(buildReq(undefined, undefined), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });
});

describe('patient.controller putProfile', () => {
  it('upserts using ownership resolved from the principal, not the request body', async () => {
    const user = await createPatientUser();
    const res = buildRes();

    await putProfile(buildReq({ city: 'Springfield' }, principalFor(user.id)), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const payload = jsonPayload(res) as { profile: { userId: string; city: string } };
    expect(payload.profile.userId).toBe(user.id);
    expect(payload.profile.city).toBe('Springfield');
  });

  it('rejects an attempt to supply server-controlled fields', async () => {
    const user = await createPatientUser();
    const next = vi.fn();

    await putProfile(
      buildReq(
        { city: 'Springfield', id: 'attacker', userId: 'attacker', status: 'ACTIVE' },
        principalFor(user.id),
      ),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    await expect(
      prisma.patientProfile.findUnique({ where: { userId: user.id } }),
    ).resolves.toBeNull();
  });

  it('rejects invalid input', async () => {
    const user = await createPatientUser();
    const next = vi.fn();

    await putProfile(buildReq({ bloodGroup: 'NOT_REAL' }, principalFor(user.id)), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
  });
});

describe('patient.controller emergency contacts — ownership isolation (IDOR)', () => {
  it("cannot update or list another patient's contact by guessing its id", async () => {
    const owner = await createPatientUser();
    await putProfile(buildReq({}, principalFor(owner.id)), buildRes(), vi.fn());
    const createRes = buildRes();
    await createContact(
      buildReq(
        { name: 'Jane', relationship: 'Sister', phone: '+15559990001' },
        principalFor(owner.id),
      ),
      createRes,
      vi.fn(),
    );
    const created = jsonPayload(createRes) as { contact: { id: string } };

    const attacker = await createPatientUser();
    await putProfile(buildReq({}, principalFor(attacker.id)), buildRes(), vi.fn());

    const attackNext = vi.fn();
    await updateContact(
      buildReq({ name: 'Hacked' }, principalFor(attacker.id), { contactId: created.contact.id }),
      buildRes(),
      attackNext,
    );
    expect(attackNext).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RESOURCE_NOT_FOUND' }),
    );

    const attackerListRes = buildRes();
    await listContacts(buildReq(undefined, principalFor(attacker.id)), attackerListRes, vi.fn());
    expect(jsonPayload(attackerListRes)).toEqual({ contacts: [] });

    const ownerListRes = buildRes();
    await listContacts(buildReq(undefined, principalFor(owner.id)), ownerListRes, vi.fn());
    const ownerContacts = jsonPayload(ownerListRes) as { contacts: { name: string }[] };
    expect(ownerContacts.contacts).toHaveLength(1);
    expect(ownerContacts.contacts[0]?.name).toBe('Jane');
  });
});

describe('patient.controller createContact', () => {
  it('rejects creation before a profile exists', async () => {
    const user = await createPatientUser();
    const next = vi.fn();

    await createContact(
      buildReq(
        { name: 'Jane', relationship: 'Sister', phone: '+15559990002' },
        principalFor(user.id),
      ),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'PATIENT_PROFILE_REQUIRED' }),
    );
  });
});
