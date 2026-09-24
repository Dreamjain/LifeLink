import { randomUUID } from 'node:crypto';
import {
  AmbulanceStatus,
  AmbulanceType,
  HospitalStaffRole,
  HospitalStatus,
  MembershipStatus,
} from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import type { HospitalStaffContext } from '../types/hospital.types.js';
import {
  createAmbulance,
  getAmbulance,
  listAmbulances,
  transitionAmbulanceStatus,
  updateAmbulance,
} from './ambulance.service.js';

const TEST_REG_PREFIX = 'T1573-';
const TEST_VEHICLE_PREFIX = 'T1573-V';

const randomRegistration = (): string => `${TEST_REG_PREFIX}${randomUUID().slice(0, 12)}`;
const randomVehicle = (): string => `${TEST_VEHICLE_PREFIX}${randomUUID().slice(0, 8)}`;

const createHospitalScope = async (): Promise<HospitalStaffContext> => {
  const hospital = await prisma.hospital.create({
    data: {
      name: 'Ambulance Service Hospital',
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
    staffRole: HospitalStaffRole.ADMIN,
    membershipStatus: MembershipStatus.ACTIVE,
  };
};

afterAll(async () => {
  const hospitals = await prisma.hospital.findMany({
    where: { registrationNumber: { startsWith: TEST_REG_PREFIX } },
    select: { id: true },
  });
  const hospitalIds = hospitals.map((h) => h.id);

  // Task 1.18 matching is global, so an emergency owned by another suite can legitimately
  // hold an offer against a hospital created here. Detach those offers — and anything hanging
  // off them — so these hospitals can be deleted, while leaving the foreign emergencies
  // themselves completely untouched.
  const ownHospitalResponses = await prisma.hospitalResponse.findMany({
    where: { hospitalId: { in: hospitalIds } },
    select: { id: true },
  });
  const ownHospitalResponseIds = ownHospitalResponses.map((response) => response.id);
  await prisma.bedReservation.deleteMany({
    where: { hospitalResponseId: { in: ownHospitalResponseIds } },
  });
  await prisma.ambulanceAssignment.deleteMany({
    where: { hospitalResponseId: { in: ownHospitalResponseIds } },
  });
  await prisma.hospitalResponse.deleteMany({ where: { id: { in: ownHospitalResponseIds } } });

  await prisma.ambulance.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });
});

describe('createAmbulance', () => {
  it('creates an ambulance with schema defaults', async () => {
    const scope = await createHospitalScope();

    const ambulance = await createAmbulance(scope, { vehicleNumber: randomVehicle() });

    expect(ambulance.status).toBe(AmbulanceStatus.AVAILABLE);
    expect(ambulance.ambulanceType).toBe(AmbulanceType.BASIC_LIFE_SUPPORT);
    expect(ambulance.capabilities).toEqual([]);
    expect(ambulance.hospitalId).toBe(scope.hospitalId);
  });

  it('honours explicit type and capabilities', async () => {
    const scope = await createHospitalScope();

    const ambulance = await createAmbulance(scope, {
      vehicleNumber: randomVehicle(),
      ambulanceType: AmbulanceType.ADVANCED_LIFE_SUPPORT,
      capabilities: ['VENTILATOR', 'DEFIBRILLATOR'],
    });

    expect(ambulance.ambulanceType).toBe(AmbulanceType.ADVANCED_LIFE_SUPPORT);
    expect(ambulance.capabilities).toEqual(['VENTILATOR', 'DEFIBRILLATOR']);
  });

  it('rejects a duplicate vehicleNumber within the same hospital', async () => {
    const scope = await createHospitalScope();
    const vehicleNumber = randomVehicle();
    await createAmbulance(scope, { vehicleNumber });

    await expect(createAmbulance(scope, { vehicleNumber })).rejects.toMatchObject({
      code: 'AMBULANCE_ALREADY_EXISTS',
    });
  });

  it('rejects a vehicleNumber owned by another hospital without disclosing the owner', async () => {
    const scopeA = await createHospitalScope();
    const scopeB = await createHospitalScope();
    const vehicleNumber = randomVehicle();
    await createAmbulance(scopeA, { vehicleNumber });

    const attempt = createAmbulance(scopeB, { vehicleNumber });

    await expect(attempt).rejects.toMatchObject({ code: 'AMBULANCE_ALREADY_EXISTS' });
    await attempt.catch((error: unknown) => {
      const message = (error as { message: string }).message;
      expect(message).not.toContain(scopeA.hospitalId);
      expect(message.toLowerCase()).not.toContain('another hospital');
    });
  });
});

describe('listAmbulances / getAmbulance', () => {
  it('lists only the caller hospital ambulances', async () => {
    const scopeA = await createHospitalScope();
    const scopeB = await createHospitalScope();
    const ambA = await createAmbulance(scopeA, { vehicleNumber: randomVehicle() });
    const ambB = await createAmbulance(scopeB, { vehicleNumber: randomVehicle() });

    const listedA = await listAmbulances(scopeA);

    expect(listedA.map((a) => a.id)).toContain(ambA.id);
    expect(listedA.map((a) => a.id)).not.toContain(ambB.id);
    listedA.forEach((a) => expect(a.hospitalId).toBe(scopeA.hospitalId));
  });

  it('does not disclose another hospital ambulance', async () => {
    const scopeA = await createHospitalScope();
    const scopeB = await createHospitalScope();
    const ambB = await createAmbulance(scopeB, { vehicleNumber: randomVehicle() });

    await expect(getAmbulance(scopeA, ambB.id)).rejects.toMatchObject({
      code: 'AMBULANCE_NOT_FOUND',
    });
  });

  it('rejects a nonexistent ambulance', async () => {
    const scope = await createHospitalScope();

    await expect(getAmbulance(scope, randomUUID())).rejects.toMatchObject({
      code: 'AMBULANCE_NOT_FOUND',
    });
  });
});

describe('updateAmbulance', () => {
  it('updates descriptive fields without touching status', async () => {
    const scope = await createHospitalScope();
    const ambulance = await createAmbulance(scope, { vehicleNumber: randomVehicle() });

    const updated = await updateAmbulance(scope, ambulance.id, {
      ambulanceType: AmbulanceType.PATIENT_TRANSPORT,
      capabilities: ['STRETCHER'],
    });

    expect(updated.ambulanceType).toBe(AmbulanceType.PATIENT_TRANSPORT);
    expect(updated.capabilities).toEqual(['STRETCHER']);
    expect(updated.status).toBe(AmbulanceStatus.AVAILABLE);
  });

  it('cannot update another hospital ambulance', async () => {
    const scopeA = await createHospitalScope();
    const scopeB = await createHospitalScope();
    const ambB = await createAmbulance(scopeB, { vehicleNumber: randomVehicle() });

    await expect(
      updateAmbulance(scopeA, ambB.id, { ambulanceType: AmbulanceType.PATIENT_TRANSPORT }),
    ).rejects.toMatchObject({ code: 'AMBULANCE_NOT_FOUND' });

    const untouched = await prisma.ambulance.findUniqueOrThrow({ where: { id: ambB.id } });
    expect(untouched.ambulanceType).toBe(AmbulanceType.BASIC_LIFE_SUPPORT);
  });
});

describe('transitionAmbulanceStatus', () => {
  it('moves AVAILABLE to OUT_OF_SERVICE and back', async () => {
    const scope = await createHospitalScope();
    const ambulance = await createAmbulance(scope, { vehicleNumber: randomVehicle() });

    const out = await transitionAmbulanceStatus(scope, ambulance.id, 'MARK_OUT_OF_SERVICE');
    expect(out.status).toBe(AmbulanceStatus.OUT_OF_SERVICE);

    const back = await transitionAmbulanceStatus(scope, ambulance.id, 'RETURN_TO_SERVICE');
    expect(back.status).toBe(AmbulanceStatus.AVAILABLE);
  });

  it('retires an AVAILABLE ambulance to INACTIVE', async () => {
    const scope = await createHospitalScope();
    const ambulance = await createAmbulance(scope, { vehicleNumber: randomVehicle() });

    const retired = await transitionAmbulanceStatus(scope, ambulance.id, 'RETIRE');

    expect(retired.status).toBe(AmbulanceStatus.INACTIVE);
  });

  it('cannot retire an OUT_OF_SERVICE ambulance (only AVAILABLE -> INACTIVE)', async () => {
    const scope = await createHospitalScope();
    const ambulance = await createAmbulance(scope, { vehicleNumber: randomVehicle() });
    await transitionAmbulanceStatus(scope, ambulance.id, 'MARK_OUT_OF_SERVICE');

    await expect(transitionAmbulanceStatus(scope, ambulance.id, 'RETIRE')).rejects.toMatchObject({
      code: 'AMBULANCE_STATUS_CONFLICT',
    });
  });

  it.each([AmbulanceStatus.OFFERED, AmbulanceStatus.ASSIGNED, AmbulanceStatus.EN_ROUTE])(
    'refuses to transition a workflow-owned %s ambulance',
    async (workflowStatus) => {
      const scope = await createHospitalScope();
      const ambulance = await createAmbulance(scope, { vehicleNumber: randomVehicle() });
      // Simulates the future dispatch workflow owning this state.
      await prisma.ambulance.update({
        where: { id: ambulance.id },
        data: { status: workflowStatus },
      });

      await expect(
        transitionAmbulanceStatus(scope, ambulance.id, 'MARK_OUT_OF_SERVICE'),
      ).rejects.toMatchObject({ code: 'AMBULANCE_STATUS_CONFLICT' });

      const unchanged = await prisma.ambulance.findUniqueOrThrow({ where: { id: ambulance.id } });
      expect(unchanged.status).toBe(workflowStatus);
    },
  );

  it('cannot transition another hospital ambulance', async () => {
    const scopeA = await createHospitalScope();
    const scopeB = await createHospitalScope();
    const ambB = await createAmbulance(scopeB, { vehicleNumber: randomVehicle() });

    await expect(
      transitionAmbulanceStatus(scopeA, ambB.id, 'MARK_OUT_OF_SERVICE'),
    ).rejects.toMatchObject({ code: 'AMBULANCE_NOT_FOUND' });

    const untouched = await prisma.ambulance.findUniqueOrThrow({ where: { id: ambB.id } });
    expect(untouched.status).toBe(AmbulanceStatus.AVAILABLE);
  });

  it('lets exactly one of two concurrent competing transitions win', async () => {
    const scope = await createHospitalScope();
    const ambulance = await createAmbulance(scope, { vehicleNumber: randomVehicle() });

    const outcomes = await Promise.allSettled([
      transitionAmbulanceStatus(scope, ambulance.id, 'MARK_OUT_OF_SERVICE'),
      transitionAmbulanceStatus(scope, ambulance.id, 'RETIRE'),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === 'rejected') {
      expect(rejected[0].reason).toMatchObject({ code: 'AMBULANCE_STATUS_CONFLICT' });
    }

    const final = await prisma.ambulance.findUniqueOrThrow({ where: { id: ambulance.id } });
    expect([AmbulanceStatus.OUT_OF_SERVICE, AmbulanceStatus.INACTIVE]).toContain(final.status);
  });
});
