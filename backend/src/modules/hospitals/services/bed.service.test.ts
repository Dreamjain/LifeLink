import { randomUUID } from 'node:crypto';
import {
  BedStatus,
  BedType,
  HospitalStaffRole,
  HospitalStatus,
  MembershipStatus,
} from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import type { HospitalStaffContext } from '../types/hospital.types.js';
import { createBed, getBed, listBeds, transitionBedStatus, updateBed } from './bed.service.js';

const TEST_REG_PREFIX = 'T1572-';

const randomRegistration = (): string => `${TEST_REG_PREFIX}${randomUUID().slice(0, 12)}`;

const createHospitalScope = async (): Promise<HospitalStaffContext> => {
  const hospital = await prisma.hospital.create({
    data: {
      name: 'Bed Service Hospital',
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

  await prisma.bed.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });
});

describe('createBed', () => {
  it('creates a bed with the schema default status AVAILABLE', async () => {
    const scope = await createHospitalScope();

    const bed = await createBed(scope, { bedCode: 'GEN-01' });

    expect(bed.status).toBe(BedStatus.AVAILABLE);
    expect(bed.bedType).toBe(BedType.GENERAL);
    expect(bed.hospitalId).toBe(scope.hospitalId);
  });

  it('honours an explicit bedType', async () => {
    const scope = await createHospitalScope();

    const bed = await createBed(scope, { bedCode: 'ICU-01', bedType: BedType.ICU });

    expect(bed.bedType).toBe(BedType.ICU);
  });

  it('rejects a duplicate bedCode within the same hospital', async () => {
    const scope = await createHospitalScope();
    await createBed(scope, { bedCode: 'DUP-01' });

    await expect(createBed(scope, { bedCode: 'DUP-01' })).rejects.toMatchObject({
      code: 'BED_ALREADY_EXISTS',
    });
  });

  it('allows the same bedCode in a different hospital', async () => {
    const scopeA = await createHospitalScope();
    const scopeB = await createHospitalScope();
    await createBed(scopeA, { bedCode: 'SHARED-01' });

    const bedB = await createBed(scopeB, { bedCode: 'SHARED-01' });

    expect(bedB.hospitalId).toBe(scopeB.hospitalId);
  });
});

describe('listBeds / getBed', () => {
  it('lists only the caller hospital beds', async () => {
    const scopeA = await createHospitalScope();
    const scopeB = await createHospitalScope();
    const bedA = await createBed(scopeA, { bedCode: 'A-1' });
    const bedB = await createBed(scopeB, { bedCode: 'B-1' });

    const listedA = await listBeds(scopeA);

    expect(listedA.map((b) => b.id)).toContain(bedA.id);
    expect(listedA.map((b) => b.id)).not.toContain(bedB.id);
    listedA.forEach((b) => expect(b.hospitalId).toBe(scopeA.hospitalId));
  });

  it('reads a bed belonging to the caller hospital', async () => {
    const scope = await createHospitalScope();
    const bed = await createBed(scope, { bedCode: 'READ-01' });

    await expect(getBed(scope, bed.id)).resolves.toMatchObject({ id: bed.id });
  });

  it('does not disclose another hospital bed', async () => {
    const scopeA = await createHospitalScope();
    const scopeB = await createHospitalScope();
    const bedB = await createBed(scopeB, { bedCode: 'B-2' });

    await expect(getBed(scopeA, bedB.id)).rejects.toMatchObject({ code: 'BED_NOT_FOUND' });
  });

  it('rejects a nonexistent bed', async () => {
    const scope = await createHospitalScope();

    await expect(getBed(scope, randomUUID())).rejects.toMatchObject({ code: 'BED_NOT_FOUND' });
  });
});

describe('updateBed', () => {
  it('updates descriptive fields', async () => {
    const scope = await createHospitalScope();
    const bed = await createBed(scope, { bedCode: 'UPD-01' });

    const updated = await updateBed(scope, bed.id, {
      bedCode: 'UPD-02',
      bedType: BedType.ISOLATION,
    });

    expect(updated.bedCode).toBe('UPD-02');
    expect(updated.bedType).toBe(BedType.ISOLATION);
    expect(updated.status).toBe(BedStatus.AVAILABLE);
  });

  it('cannot update another hospital bed', async () => {
    const scopeA = await createHospitalScope();
    const scopeB = await createHospitalScope();
    const bedB = await createBed(scopeB, { bedCode: 'B-3' });

    await expect(updateBed(scopeA, bedB.id, { bedCode: 'HACKED' })).rejects.toMatchObject({
      code: 'BED_NOT_FOUND',
    });

    const untouched = await prisma.bed.findUniqueOrThrow({ where: { id: bedB.id } });
    expect(untouched.bedCode).toBe('B-3');
  });

  it('rejects renaming to a bedCode already used in the same hospital', async () => {
    const scope = await createHospitalScope();
    await createBed(scope, { bedCode: 'TAKEN' });
    const other = await createBed(scope, { bedCode: 'FREE' });

    await expect(updateBed(scope, other.id, { bedCode: 'TAKEN' })).rejects.toMatchObject({
      code: 'BED_ALREADY_EXISTS',
    });
  });
});

describe('transitionBedStatus', () => {
  it('moves AVAILABLE to OUT_OF_SERVICE and back', async () => {
    const scope = await createHospitalScope();
    const bed = await createBed(scope, { bedCode: 'TR-01' });

    const out = await transitionBedStatus(scope, bed.id, 'MARK_OUT_OF_SERVICE');
    expect(out.status).toBe(BedStatus.OUT_OF_SERVICE);

    const back = await transitionBedStatus(scope, bed.id, 'RETURN_TO_SERVICE');
    expect(back.status).toBe(BedStatus.AVAILABLE);
  });

  it('rejects marking an already OUT_OF_SERVICE bed out of service', async () => {
    const scope = await createHospitalScope();
    const bed = await createBed(scope, { bedCode: 'TR-02' });
    await transitionBedStatus(scope, bed.id, 'MARK_OUT_OF_SERVICE');

    await expect(transitionBedStatus(scope, bed.id, 'MARK_OUT_OF_SERVICE')).rejects.toMatchObject({
      code: 'BED_STATUS_CONFLICT',
    });
  });

  it('refuses to return a workflow-owned RESERVED bed to service', async () => {
    const scope = await createHospitalScope();
    const bed = await createBed(scope, { bedCode: 'TR-03' });
    // Simulates the future reservation workflow owning this state.
    await prisma.bed.update({ where: { id: bed.id }, data: { status: BedStatus.RESERVED } });

    await expect(transitionBedStatus(scope, bed.id, 'MARK_OUT_OF_SERVICE')).rejects.toMatchObject({
      code: 'BED_STATUS_CONFLICT',
    });
    await expect(transitionBedStatus(scope, bed.id, 'RETURN_TO_SERVICE')).rejects.toMatchObject({
      code: 'BED_STATUS_CONFLICT',
    });

    const unchanged = await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } });
    expect(unchanged.status).toBe(BedStatus.RESERVED);
  });

  it('cannot transition another hospital bed', async () => {
    const scopeA = await createHospitalScope();
    const scopeB = await createHospitalScope();
    const bedB = await createBed(scopeB, { bedCode: 'B-4' });

    await expect(transitionBedStatus(scopeA, bedB.id, 'MARK_OUT_OF_SERVICE')).rejects.toMatchObject(
      {
        code: 'BED_NOT_FOUND',
      },
    );

    const untouched = await prisma.bed.findUniqueOrThrow({ where: { id: bedB.id } });
    expect(untouched.status).toBe(BedStatus.AVAILABLE);
  });

  it('lets exactly one of two concurrent competing transitions win', async () => {
    const scope = await createHospitalScope();
    const bed = await createBed(scope, { bedCode: 'RACE-01' });

    const outcomes = await Promise.allSettled([
      transitionBedStatus(scope, bed.id, 'MARK_OUT_OF_SERVICE'),
      transitionBedStatus(scope, bed.id, 'MARK_OUT_OF_SERVICE'),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(rejected).toHaveLength(1);
    if (rejected[0]?.status === 'rejected') {
      expect(rejected[0].reason).toMatchObject({ code: 'BED_STATUS_CONFLICT' });
    }

    const final = await prisma.bed.findUniqueOrThrow({ where: { id: bed.id } });
    expect(final.status).toBe(BedStatus.OUT_OF_SERVICE);
  });
});
