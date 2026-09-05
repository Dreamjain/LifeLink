import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import {
  AmbulanceStatus,
  BedStatus,
  HospitalStaffRole,
  HospitalStatus,
  MembershipStatus,
  UserRole,
  UserStatus,
} from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { hashPassword, requireAuth, requireRole, signAccessToken } from '../../auth/index.js';
import { requireHospitalStaffRole } from '../middleware/hospital-scope.middleware.js';
import type { HospitalStaffContext } from '../types/hospital.types.js';
import { changeBedStatus, createBed, getBed, listBeds, updateBed } from './bed.controller.js';
import {
  changeAmbulanceStatus,
  createAmbulance,
  getAmbulance,
  listAmbulances,
  updateAmbulance,
} from './ambulance.controller.js';

const TEST_REG_PREFIX = 'T1574-';
const TEST_PHONE_PREFIX = '+1574';

const randomRegistration = (): string => `${TEST_REG_PREFIX}${randomUUID().slice(0, 12)}`;
const randomVehicle = (): string => `T1574-V${randomUUID().slice(0, 8)}`;
const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const buildRes = (): Response => {
  const res = {} as Response;
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
};

const buildAuthHeaderReq = (authorization?: string): Request =>
  ({
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
  }) as unknown as Request;

const jsonPayload = (res: Response): Record<string, unknown> =>
  (res.json as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0] as Record<
    string,
    unknown
  >;

const buildReq = (options: {
  body?: unknown;
  params?: Record<string, string>;
  scope?: HospitalStaffContext;
}): Request =>
  ({
    body: options.body,
    params: options.params ?? {},
    hospitalStaff: options.scope,
    user: { userId: randomUUID(), role: UserRole.HOSPITAL_STAFF, jti: randomUUID() },
    correlationId: 'test-correlation-id',
  }) as unknown as Request;

const createScope = async (
  staffRole: HospitalStaffRole = HospitalStaffRole.ADMIN,
): Promise<HospitalStaffContext> => {
  const hospital = await prisma.hospital.create({
    data: {
      name: 'Resource Controller Hospital',
      registrationNumber: randomRegistration(),
      phone: '+15550000000',
      addressLine: '1 Main Street',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      status: HospitalStatus.VERIFIED,
    },
  });

  return {
    membershipId: randomUUID(),
    hospitalId: hospital.id,
    staffRole,
    membershipStatus: MembershipStatus.ACTIVE,
  };
};

const createUser = async (role: UserRole) =>
  prisma.user.create({
    data: {
      phone: randomTestPhone(),
      email: `u.${randomUUID()}@example.com`,
      passwordHash: await hashPassword('a-very-strong-passphrase'),
      role,
      status: UserStatus.ACTIVE,
      displayName: 'Resource Role Matrix User',
    },
  });

afterAll(async () => {
  const hospitals = await prisma.hospital.findMany({
    where: { registrationNumber: { startsWith: TEST_REG_PREFIX } },
    select: { id: true },
  });
  const hospitalIds = hospitals.map((h) => h.id);

  await prisma.bed.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.ambulance.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });
  await prisma.user.deleteMany({ where: { phone: { startsWith: TEST_PHONE_PREFIX } } });
});

describe('hospital resource route authorization', () => {
  it('rejects an unauthenticated request', async () => {
    const next = vi.fn();
    await requireAuth(buildAuthHeaderReq(undefined), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });

  it.each([UserRole.PATIENT, UserRole.DRIVER, UserRole.ADMIN])(
    'rejects a %s account (system ADMIN is not hospital staff)',
    async (role) => {
      const user = await createUser(role);
      const token = signAccessToken({ userId: user.id, role: user.role });
      const req = buildAuthHeaderReq(`Bearer ${token}`);

      const authNext = vi.fn();
      await requireAuth(req, buildRes(), authNext);
      expect(authNext).toHaveBeenCalledWith();

      const roleNext = vi.fn();
      requireRole(UserRole.HOSPITAL_STAFF)(req, buildRes(), roleNext);
      expect(roleNext).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_ROLE' }));
    },
  );

  it('allows every active staff role through the write gate only for hospital ADMIN', async () => {
    const allowed = vi.fn();
    requireHospitalStaffRole(HospitalStaffRole.ADMIN)(
      buildReq({ scope: await createScope(HospitalStaffRole.ADMIN) }),
      buildRes(),
      allowed,
    );
    expect(allowed).toHaveBeenCalledWith();

    for (const staffRole of [
      HospitalStaffRole.DISPATCHER,
      HospitalStaffRole.RECEPTIONIST,
      HospitalStaffRole.CLINICAL_COORDINATOR,
    ]) {
      const denied = vi.fn();
      requireHospitalStaffRole(HospitalStaffRole.ADMIN)(
        buildReq({ scope: await createScope(staffRole) }),
        buildRes(),
        denied,
      );
      expect(denied).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'INSUFFICIENT_HOSPITAL_ROLE' }),
      );
    }
  });
});

describe('bed controller', () => {
  it('creates a bed and returns AVAILABLE', async () => {
    const scope = await createScope();
    const res = buildRes();

    await createBed(buildReq({ body: { bedCode: 'C-1' }, scope }), res, vi.fn());

    expect(res.status).toHaveBeenCalledWith(201);
    const payload = jsonPayload(res) as { bed: { status: string; hospitalId: string } };
    expect(payload.bed.status).toBe(BedStatus.AVAILABLE);
    expect(payload.bed.hospitalId).toBe(scope.hospitalId);
  });

  it.each([
    ['status', { status: 'OUT_OF_SERVICE' }],
    ['hospitalId', { hospitalId: randomUUID() }],
    ['id', { id: randomUUID() }],
  ])('rejects an injected %s and creates nothing', async (_label, injected) => {
    const scope = await createScope();
    const next = vi.fn();

    await createBed(buildReq({ body: { bedCode: 'INJ-1', ...injected }, scope }), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(await prisma.bed.count({ where: { hospitalId: scope.hospitalId } })).toBe(0);
  });

  it('lists, reads, updates and transitions within scope', async () => {
    const scope = await createScope();
    const createRes = buildRes();
    await createBed(buildReq({ body: { bedCode: 'FLOW-1' }, scope }), createRes, vi.fn());
    const bedId = (jsonPayload(createRes) as { bed: { id: string } }).bed.id;

    const listRes = buildRes();
    await listBeds(buildReq({ scope }), listRes, vi.fn());
    expect((jsonPayload(listRes) as { beds: unknown[] }).beds).toHaveLength(1);

    const getRes = buildRes();
    await getBed(buildReq({ params: { bedId }, scope }), getRes, vi.fn());
    expect((jsonPayload(getRes) as { bed: { id: string } }).bed.id).toBe(bedId);

    const patchRes = buildRes();
    await updateBed(
      buildReq({ params: { bedId }, body: { bedCode: 'FLOW-2' }, scope }),
      patchRes,
      vi.fn(),
    );
    expect((jsonPayload(patchRes) as { bed: { bedCode: string } }).bed.bedCode).toBe('FLOW-2');

    const statusRes = buildRes();
    await changeBedStatus(
      buildReq({ params: { bedId }, body: { action: 'MARK_OUT_OF_SERVICE' }, scope }),
      statusRes,
      vi.fn(),
    );
    expect((jsonPayload(statusRes) as { bed: { status: string } }).bed.status).toBe(
      BedStatus.OUT_OF_SERVICE,
    );
  });

  it('rejects a raw status body on the transition endpoint', async () => {
    const scope = await createScope();
    const createRes = buildRes();
    await createBed(buildReq({ body: { bedCode: 'RAW-1' }, scope }), createRes, vi.fn());
    const bedId = (jsonPayload(createRes) as { bed: { id: string } }).bed.id;

    const next = vi.fn();
    await changeBedStatus(
      buildReq({ params: { bedId }, body: { status: 'RESERVED' }, scope }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    const unchanged = await prisma.bed.findUniqueOrThrow({ where: { id: bedId } });
    expect(unchanged.status).toBe(BedStatus.AVAILABLE);
  });

  it('cannot reach another hospital bed through the controller', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const createRes = buildRes();
    await createBed(buildReq({ body: { bedCode: 'B-ONLY' }, scope: scopeB }), createRes, vi.fn());
    const bedIdB = (jsonPayload(createRes) as { bed: { id: string } }).bed.id;

    for (const handler of [getBed, updateBed, changeBedStatus]) {
      const next = vi.fn();
      await handler(
        buildReq({
          params: { bedId: bedIdB },
          body: { bedCode: 'HACKED', action: 'MARK_OUT_OF_SERVICE' },
          scope: scopeA,
        }),
        buildRes(),
        next,
      );
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: expect.any(Number) }),
      );
    }

    const untouched = await prisma.bed.findUniqueOrThrow({ where: { id: bedIdB } });
    expect(untouched.bedCode).toBe('B-ONLY');
    expect(untouched.status).toBe(BedStatus.AVAILABLE);
  });

  it('rejects a request with no resolved hospital scope', async () => {
    const next = vi.fn();
    await listBeds(buildReq({}), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'HOSPITAL_SCOPE_DENIED' }));
  });
});

describe('ambulance controller', () => {
  it('creates an ambulance and returns AVAILABLE', async () => {
    const scope = await createScope();
    const res = buildRes();

    await createAmbulance(
      buildReq({ body: { vehicleNumber: randomVehicle() }, scope }),
      res,
      vi.fn(),
    );

    expect(res.status).toHaveBeenCalledWith(201);
    const payload = jsonPayload(res) as { ambulance: { status: string; hospitalId: string } };
    expect(payload.ambulance.status).toBe(AmbulanceStatus.AVAILABLE);
    expect(payload.ambulance.hospitalId).toBe(scope.hospitalId);
  });

  it.each([
    ['status', { status: 'EN_ROUTE' }],
    ['hospitalId', { hospitalId: randomUUID() }],
  ])('rejects an injected %s and creates nothing', async (_label, injected) => {
    const scope = await createScope();
    const next = vi.fn();

    await createAmbulance(
      buildReq({ body: { vehicleNumber: randomVehicle(), ...injected }, scope }),
      buildRes(),
      next,
    );

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
    expect(await prisma.ambulance.count({ where: { hospitalId: scope.hospitalId } })).toBe(0);
  });

  it('lists, reads, updates, and runs the full transition set', async () => {
    const scope = await createScope();
    const createRes = buildRes();
    await createAmbulance(
      buildReq({ body: { vehicleNumber: randomVehicle() }, scope }),
      createRes,
      vi.fn(),
    );
    const ambulanceId = (jsonPayload(createRes) as { ambulance: { id: string } }).ambulance.id;

    const listRes = buildRes();
    await listAmbulances(buildReq({ scope }), listRes, vi.fn());
    expect((jsonPayload(listRes) as { ambulances: unknown[] }).ambulances).toHaveLength(1);

    const getRes = buildRes();
    await getAmbulance(buildReq({ params: { ambulanceId }, scope }), getRes, vi.fn());
    expect((jsonPayload(getRes) as { ambulance: { id: string } }).ambulance.id).toBe(ambulanceId);

    const patchRes = buildRes();
    await updateAmbulance(
      buildReq({ params: { ambulanceId }, body: { capabilities: ['OXYGEN'] }, scope }),
      patchRes,
      vi.fn(),
    );
    expect(
      (jsonPayload(patchRes) as { ambulance: { capabilities: string[] } }).ambulance.capabilities,
    ).toEqual(['OXYGEN']);

    const outRes = buildRes();
    await changeAmbulanceStatus(
      buildReq({ params: { ambulanceId }, body: { action: 'MARK_OUT_OF_SERVICE' }, scope }),
      outRes,
      vi.fn(),
    );
    expect((jsonPayload(outRes) as { ambulance: { status: string } }).ambulance.status).toBe(
      AmbulanceStatus.OUT_OF_SERVICE,
    );

    const backRes = buildRes();
    await changeAmbulanceStatus(
      buildReq({ params: { ambulanceId }, body: { action: 'RETURN_TO_SERVICE' }, scope }),
      backRes,
      vi.fn(),
    );
    expect((jsonPayload(backRes) as { ambulance: { status: string } }).ambulance.status).toBe(
      AmbulanceStatus.AVAILABLE,
    );

    const retireRes = buildRes();
    await changeAmbulanceStatus(
      buildReq({ params: { ambulanceId }, body: { action: 'RETIRE' }, scope }),
      retireRes,
      vi.fn(),
    );
    expect((jsonPayload(retireRes) as { ambulance: { status: string } }).ambulance.status).toBe(
      AmbulanceStatus.INACTIVE,
    );
  });

  it.each(['OFFERED', 'ASSIGNED', 'EN_ROUTE'])(
    'rejects the workflow-owned action %s',
    async (action) => {
      const scope = await createScope();
      const createRes = buildRes();
      await createAmbulance(
        buildReq({ body: { vehicleNumber: randomVehicle() }, scope }),
        createRes,
        vi.fn(),
      );
      const ambulanceId = (jsonPayload(createRes) as { ambulance: { id: string } }).ambulance.id;

      const next = vi.fn();
      await changeAmbulanceStatus(
        buildReq({ params: { ambulanceId }, body: { action }, scope }),
        buildRes(),
        next,
      );

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'VALIDATION_ERROR' }));
      const unchanged = await prisma.ambulance.findUniqueOrThrow({ where: { id: ambulanceId } });
      expect(unchanged.status).toBe(AmbulanceStatus.AVAILABLE);
    },
  );

  it('cannot reach another hospital ambulance through the controller', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const createRes = buildRes();
    await createAmbulance(
      buildReq({ body: { vehicleNumber: randomVehicle() }, scope: scopeB }),
      createRes,
      vi.fn(),
    );
    const ambulanceIdB = (jsonPayload(createRes) as { ambulance: { id: string } }).ambulance.id;

    for (const handler of [getAmbulance, updateAmbulance, changeAmbulanceStatus]) {
      const next = vi.fn();
      await handler(
        buildReq({
          params: { ambulanceId: ambulanceIdB },
          body: { capabilities: ['HACKED'], action: 'MARK_OUT_OF_SERVICE' },
          scope: scopeA,
        }),
        buildRes(),
        next,
      );
      expect(next).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: expect.any(Number) }),
      );
    }

    const untouched = await prisma.ambulance.findUniqueOrThrow({ where: { id: ambulanceIdB } });
    expect(untouched.capabilities).toEqual([]);
    expect(untouched.status).toBe(AmbulanceStatus.AVAILABLE);
  });
});
