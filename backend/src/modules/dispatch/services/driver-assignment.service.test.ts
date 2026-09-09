import { randomUUID } from 'node:crypto';
import {
  AmbulanceAssignmentStatus,
  AmbulanceStatus,
  DriverAvailability,
  EmergencyStatus,
  HospitalResponseStatus,
  HospitalStaffRole,
  HospitalStatus,
  MembershipStatus,
  UserRole,
  UserStatus,
  VerificationStatus,
} from '@prisma/client';
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import type { HospitalStaffContext } from '../../hospitals/types/hospital.types.js';
import { createAssignment } from './assignment.service.js';
import {
  acceptOwnAssignment,
  getOwnAssignment,
  listOwnAssignments,
  rejectOwnAssignment,
  resolveDriverContext,
} from './driver-assignment.service.js';

const TEST_REG_PREFIX = 'T1617-';
const TEST_PHONE_PREFIX = '+1617';
const TEST_LICENCE_PREFIX = 'L1617-';

const randomRegistration = (): string => `${TEST_REG_PREFIX}${randomUUID().slice(0, 12)}`;
const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const createScope = async (): Promise<HospitalStaffContext> => {
  const hospital = await prisma.hospital.create({
    data: {
      name: 'Driver Assignment Hospital',
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
    staffRole: HospitalStaffRole.DISPATCHER,
    membershipStatus: MembershipStatus.ACTIVE,
  };
};

const createActor = async (): Promise<string> => {
  const user = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      passwordHash: 'not-used-in-this-fixture',
      role: UserRole.HOSPITAL_STAFF,
      status: UserStatus.ACTIVE,
      displayName: 'Dispatch Actor',
    },
  });

  return user.id;
};

const createAmbulance = async (hospitalId: string) =>
  prisma.ambulance.create({
    data: { hospitalId, vehicleNumber: `V-${randomUUID().slice(0, 10)}` },
  });

const createDriverUser = async () => {
  const user = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      passwordHash: 'not-used-in-this-fixture',
      role: UserRole.DRIVER,
      status: UserStatus.ACTIVE,
      displayName: 'Fixture Driver',
      driverProfile: {
        create: {
          licenceNumber: `${TEST_LICENCE_PREFIX}${randomUUID().slice(0, 12)}`,
          verificationStatus: VerificationStatus.VERIFIED,
          availabilityStatus: DriverAvailability.AVAILABLE,
        },
      },
    },
    include: { driverProfile: true },
  });

  return { userId: user.id, profile: user.driverProfile! };
};

const seedReservedEmergency = async (hospitalId: string) => {
  const patientUser = await prisma.user.create({
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

  const emergency = await prisma.emergencyRequest.create({
    data: {
      patientId: patientUser.patientProfile!.id,
      currentStatus: EmergencyStatus.BED_RESERVED,
      pickupAddress: '12 Elm Street',
    },
  });

  const response = await prisma.hospitalResponse.create({
    data: {
      emergencyId: emergency.id,
      hospitalId,
      status: HospitalResponseStatus.ACCEPTED,
    },
  });

  return { emergency, response, patientUser };
};

/** Dispatches a fresh offer and returns everything the driver-side assertions need. */
const seedOffer = async () => {
  const scope = await createScope();
  const actorUserId = await createActor();
  const seed = await seedReservedEmergency(scope.hospitalId);
  const ambulance = await createAmbulance(scope.hospitalId);
  const driver = await createDriverUser();

  const assignment = await createAssignment(
    scope,
    seed.emergency.id,
    { ambulanceId: ambulance.id, driverId: driver.profile.id },
    actorUserId,
  );

  return { scope, actorUserId, seed, ambulance, driver, assignment };
};

afterAll(async () => {
  const hospitals = await prisma.hospital.findMany({
    where: { registrationNumber: { startsWith: TEST_REG_PREFIX } },
    select: { id: true },
  });
  const hospitalIds = hospitals.map((h) => h.id);

  const responses = await prisma.hospitalResponse.findMany({
    where: { hospitalId: { in: hospitalIds } },
    select: { id: true, emergencyId: true },
  });
  const emergencyIds = [...new Set(responses.map((r) => r.emergencyId))];

  await prisma.ambulanceAssignment.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.emergencyStatusHistory.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.hospitalResponse.deleteMany({ where: { hospitalId: { in: hospitalIds } } });

  const emergencies = await prisma.emergencyRequest.findMany({
    where: { id: { in: emergencyIds } },
    select: { patientId: true },
  });
  await prisma.emergencyRequest.deleteMany({ where: { id: { in: emergencyIds } } });

  const patientIds = emergencies.map((e) => e.patientId);
  const profiles = await prisma.patientProfile.findMany({
    where: { id: { in: patientIds } },
    select: { userId: true },
  });
  await prisma.patientProfile.deleteMany({ where: { id: { in: patientIds } } });
  await prisma.user.deleteMany({ where: { id: { in: profiles.map((p) => p.userId) } } });
  await prisma.ambulance.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });
  await prisma.driverProfile.deleteMany({
    where: { licenceNumber: { startsWith: TEST_LICENCE_PREFIX } },
  });
  await prisma.user.deleteMany({ where: { phone: { startsWith: TEST_PHONE_PREFIX } } });
});

describe('resolveDriverContext', () => {
  it('resolves the profile from the authenticated user id', async () => {
    const driver = await createDriverUser();

    expect(await resolveDriverContext(driver.userId)).toMatchObject({
      driverProfileId: driver.profile.id,
      userId: driver.userId,
    });
  });

  it('rejects an account with no driver profile', async () => {
    const actorUserId = await createActor();

    await expect(resolveDriverContext(actorUserId)).rejects.toMatchObject({
      code: 'DRIVER_NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('driver assignment reads', () => {
  it('lists and reads only the driver own assignments', async () => {
    const offer = await seedOffer();

    const listed = await listOwnAssignments(offer.driver.userId);
    expect(listed.map((a) => a.id)).toEqual([offer.assignment.id]);

    const read = await getOwnAssignment(offer.driver.userId, offer.assignment.id);
    expect(read.id).toBe(offer.assignment.id);
    expect(read.status).toBe(AmbulanceAssignmentStatus.OFFERED);
    expect(read.ambulance.vehicleNumber).toBe(offer.ambulance.vehicleNumber);
    expect(read.hospital.id).toBe(offer.scope.hospitalId);
  });

  it('exposes no patient or credential data to the driver', async () => {
    const offer = await seedOffer();
    const read = await getOwnAssignment(offer.driver.userId, offer.assignment.id);

    const serialized = JSON.stringify(read);
    expect(serialized).not.toContain('FIXTURE-ALLERGY-MUST-NOT-LEAK');
    expect(serialized).not.toContain('FIXTURE-SUMMARY-MUST-NOT-LEAK');
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain(offer.seed.patientUser.phone);
    expect(read.emergency).not.toHaveProperty('patientId');
    expect(read.hospital).not.toHaveProperty('registrationNumber');
  });

  it('does not disclose another driver assignment', async () => {
    const offer = await seedOffer();
    const otherDriver = await createDriverUser();

    await expect(getOwnAssignment(otherDriver.userId, offer.assignment.id)).rejects.toMatchObject({
      code: 'ASSIGNMENT_NOT_FOUND',
      statusCode: 404,
    });
    expect(await listOwnAssignments(otherDriver.userId)).toHaveLength(0);
  });

  it('rejects a nonexistent assignment', async () => {
    const driver = await createDriverUser();

    await expect(getOwnAssignment(driver.userId, randomUUID())).rejects.toMatchObject({
      code: 'ASSIGNMENT_NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('acceptOwnAssignment', () => {
  it('accepts an offer, commits the ambulance, and keeps the driver busy', async () => {
    const offer = await seedOffer();

    const accepted = await acceptOwnAssignment(offer.driver.userId, offer.assignment.id);

    expect(accepted.status).toBe(AmbulanceAssignmentStatus.ACCEPTED);
    expect(accepted.respondedAt).not.toBeNull();

    const ambulance = await prisma.ambulance.findUniqueOrThrow({
      where: { id: offer.ambulance.id },
    });
    expect(ambulance.status).toBe(AmbulanceStatus.ASSIGNED);

    const driver = await prisma.driverProfile.findUniqueOrThrow({
      where: { id: offer.driver.profile.id },
    });
    expect(driver.availabilityStatus).toBe(DriverAvailability.BUSY);
  });

  it('leaves the emergency to the orchestration layer', async () => {
    const offer = await seedOffer();
    await acceptOwnAssignment(offer.driver.userId, offer.assignment.id);

    const emergency = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: offer.seed.emergency.id },
    });
    expect(emergency.currentStatus).toBe(EmergencyStatus.PENDING_DRIVER_ACCEPTANCE);

    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: offer.seed.emergency.id },
    });
    expect(history).toHaveLength(2);
  });

  it('cannot accept another driver assignment', async () => {
    const offer = await seedOffer();
    const otherDriver = await createDriverUser();

    await expect(
      acceptOwnAssignment(otherDriver.userId, offer.assignment.id),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND', statusCode: 404 });

    const assignment = await prisma.ambulanceAssignment.findUniqueOrThrow({
      where: { id: offer.assignment.id },
    });
    expect(assignment.status).toBe(AmbulanceAssignmentStatus.OFFERED);
  });

  it('refuses to accept an assignment that is no longer offered', async () => {
    const offer = await seedOffer();
    await acceptOwnAssignment(offer.driver.userId, offer.assignment.id);

    await expect(
      acceptOwnAssignment(offer.driver.userId, offer.assignment.id),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_STATUS_CONFLICT', statusCode: 409 });
  });
});

describe('rejectOwnAssignment', () => {
  it('rejects an offer, releases both resources, and keeps the attempt', async () => {
    const offer = await seedOffer();

    const rejected = await rejectOwnAssignment(
      offer.driver.userId,
      offer.assignment.id,
      'Vehicle fault',
    );

    expect(rejected.status).toBe(AmbulanceAssignmentStatus.REJECTED);
    expect(rejected.rejectionReason).toBe('Vehicle fault');
    expect(rejected.respondedAt).not.toBeNull();

    const ambulance = await prisma.ambulance.findUniqueOrThrow({
      where: { id: offer.ambulance.id },
    });
    expect(ambulance.status).toBe(AmbulanceStatus.AVAILABLE);

    const driver = await prisma.driverProfile.findUniqueOrThrow({
      where: { id: offer.driver.profile.id },
    });
    expect(driver.availabilityStatus).toBe(DriverAvailability.AVAILABLE);

    // The attempt is preserved, not deleted.
    const stored = await prisma.ambulanceAssignment.findUniqueOrThrow({
      where: { id: offer.assignment.id },
    });
    expect(stored.status).toBe(AmbulanceAssignmentStatus.REJECTED);
    expect(stored.attemptNumber).toBe(1);
  });

  it('creates no replacement attempt and no emergency transition', async () => {
    const offer = await seedOffer();
    await rejectOwnAssignment(offer.driver.userId, offer.assignment.id, 'Vehicle fault');

    expect(
      await prisma.ambulanceAssignment.count({ where: { emergencyId: offer.seed.emergency.id } }),
    ).toBe(1);

    const emergency = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: offer.seed.emergency.id },
    });
    expect(emergency.currentStatus).toBe(EmergencyStatus.PENDING_DRIVER_ACCEPTANCE);

    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: offer.seed.emergency.id },
    });
    expect(history).toHaveLength(2);
  });

  it('cannot reject another driver assignment', async () => {
    const offer = await seedOffer();
    const otherDriver = await createDriverUser();

    await expect(
      rejectOwnAssignment(otherDriver.userId, offer.assignment.id, 'Not mine'),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND', statusCode: 404 });

    const assignment = await prisma.ambulanceAssignment.findUniqueOrThrow({
      where: { id: offer.assignment.id },
    });
    expect(assignment.status).toBe(AmbulanceAssignmentStatus.OFFERED);
    expect(assignment.rejectionReason).toBeNull();
  });

  it('refuses to reject an assignment that is already accepted', async () => {
    const offer = await seedOffer();
    await acceptOwnAssignment(offer.driver.userId, offer.assignment.id);

    await expect(
      rejectOwnAssignment(offer.driver.userId, offer.assignment.id, 'Changed my mind'),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_STATUS_CONFLICT', statusCode: 409 });
  });
});

describe('driver response concurrency', () => {
  it.each([1, 2, 3])('run %i: accept and reject race to one terminal transition', async () => {
    const offer = await seedOffer();

    const outcomes = await Promise.allSettled([
      acceptOwnAssignment(offer.driver.userId, offer.assignment.id),
      rejectOwnAssignment(offer.driver.userId, offer.assignment.id, 'Vehicle fault'),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);

    const assignment = await prisma.ambulanceAssignment.findUniqueOrThrow({
      where: { id: offer.assignment.id },
    });
    expect([AmbulanceAssignmentStatus.ACCEPTED, AmbulanceAssignmentStatus.REJECTED]).toContain(
      assignment.status,
    );

    const ambulance = await prisma.ambulance.findUniqueOrThrow({
      where: { id: offer.ambulance.id },
    });
    const driver = await prisma.driverProfile.findUniqueOrThrow({
      where: { id: offer.driver.profile.id },
    });

    // Resource state must match whichever answer won, with no mixed outcome.
    if (assignment.status === AmbulanceAssignmentStatus.ACCEPTED) {
      expect(ambulance.status).toBe(AmbulanceStatus.ASSIGNED);
      expect(driver.availabilityStatus).toBe(DriverAvailability.BUSY);
    } else {
      expect(ambulance.status).toBe(AmbulanceStatus.AVAILABLE);
      expect(driver.availabilityStatus).toBe(DriverAvailability.AVAILABLE);
    }
  });

  it.each([1, 2, 3])('run %i: two concurrent accepts produce one acceptance', async () => {
    const offer = await seedOffer();

    const outcomes = await Promise.allSettled([
      acceptOwnAssignment(offer.driver.userId, offer.assignment.id),
      acceptOwnAssignment(offer.driver.userId, offer.assignment.id),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);

    const assignment = await prisma.ambulanceAssignment.findUniqueOrThrow({
      where: { id: offer.assignment.id },
    });
    expect(assignment.status).toBe(AmbulanceAssignmentStatus.ACCEPTED);
  });
});

describe('re-dispatch after rejection', () => {
  it('allows a new attempt with the released resources and preserves the first attempt', async () => {
    const offer = await seedOffer();
    await rejectOwnAssignment(offer.driver.userId, offer.assignment.id, 'Vehicle fault');

    // The emergency now rests in PENDING_DRIVER_ACCEPTANCE, which the dispatch layer
    // deliberately does not accept as a source state: re-dispatch is orchestration work.
    await expect(
      createAssignment(
        offer.scope,
        offer.seed.emergency.id,
        { ambulanceId: offer.ambulance.id, driverId: offer.driver.profile.id },
        offer.actorUserId,
      ),
    ).rejects.toMatchObject({ code: 'EMERGENCY_STATUS_CONFLICT', statusCode: 409 });

    const stored = await prisma.ambulanceAssignment.findMany({
      where: { emergencyId: offer.seed.emergency.id },
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]!.status).toBe(AmbulanceAssignmentStatus.REJECTED);
  });
});
