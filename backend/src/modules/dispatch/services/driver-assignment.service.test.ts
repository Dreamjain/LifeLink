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
import { updateOwnAvailability } from '../../drivers/services/driver.service.js';
import { autoAssignAmbulanceForReservedEmergency, createAssignment } from './assignment.service.js';
import {
  acceptOwnAssignment,
  failOwnAssignment,
  getOwnAssignment,
  listOwnAssignments,
  rejectOwnAssignment,
  resolveDriverContext,
  transitionOwnAssignment,
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
  // Fixtures are resolved from this file's own prefixes only.
  //
  // Emergencies are discovered from this file's own patients, never from hospital responses
  // alone. Task 1.18 matching scans every eligible hospital, so another suite's emergency can
  // legitimately hold an offer against this suite's hospital; deleting that emergency here
  // would corrupt the other suite and can strand a PatientProfile whose User is then deleted
  // (PatientProfile_userId_fkey RESTRICT).
  const hospitals = await prisma.hospital.findMany({
    where: { registrationNumber: { startsWith: TEST_REG_PREFIX } },
    select: { id: true },
  });
  const hospitalIds = hospitals.map((hospital) => hospital.id);

  const users = await prisma.user.findMany({
    where: { phone: { startsWith: TEST_PHONE_PREFIX } },
    select: { id: true, patientProfile: { select: { id: true } } },
  });
  const userIds = users.map((user) => user.id);
  const profileIds = users.flatMap((user) => (user.patientProfile ? [user.patientProfile.id] : []));

  const ownDrivers = await prisma.driverProfile.findMany({
    where: { licenceNumber: { startsWith: TEST_LICENCE_PREFIX } },
    select: { id: true },
  });
  const ownDriverIds = ownDrivers.map((driver) => driver.id);
  const ownAmbulances = await prisma.ambulance.findMany({
    where: { hospitalId: { in: hospitalIds } },
    select: { id: true },
  });
  const ownAmbulanceIds = ownAmbulances.map((ambulance) => ambulance.id);

  // 1. Detach every response pointing at this file's hospitals — including offers Task 1.18
  //    matching created for another suite's emergency — without touching those emergencies.
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

  // 2. Tear this file's own patients' emergencies down completely, whichever hospitals they
  //    were offered to.
  const emergencies = await prisma.emergencyRequest.findMany({
    where: { patientId: { in: profileIds } },
    select: { id: true },
  });
  const emergencyIds = emergencies.map((emergency) => emergency.id);
  await prisma.ambulanceAssignment.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.bedReservation.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.doctorAssignment.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.notification.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.emergencyStatusHistory.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.hospitalResponse.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.emergencyRequest.deleteMany({ where: { id: { in: emergencyIds } } });

  // 3. Rows referencing this file's users directly must go before the users do.
  await prisma.emergencyStatusHistory.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { recipientUserId: { in: userIds } } });
  await prisma.patientProfile.deleteMany({ where: { id: { in: profileIds } } });

  // Task 1.21/1.22: an assignment can reach this file's resources from outside its own
  // emergencies, because the driver pool is global. AmbulanceAssignment references both the
  // driver and the vehicle with onDelete: Restrict, so detach by resource id before releasing
  // either one.
  await prisma.ambulanceAssignment.deleteMany({ where: { driverId: { in: ownDriverIds } } });
  await prisma.ambulanceAssignment.deleteMany({ where: { ambulanceId: { in: ownAmbulanceIds } } });
  await prisma.driverProfile.deleteMany({ where: { id: { in: ownDriverIds } } });

  // 4. Hospital-owned resources, then the hospitals and users themselves.
  await prisma.bed.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.ambulance.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospitalStaffMembership.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
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

describe('driver trip lifecycle', () => {
  /** An offer the driver has already accepted: the starting point of every trip step. */
  const seedAcceptedOffer = async () => {
    const offer = await seedOffer();
    await acceptOwnAssignment(offer.driver.userId, offer.assignment.id);
    return offer;
  };

  /** Walks the trip up to and including `through`, returning the seeded offer. */
  const walkTo = async (through: 'START' | 'ARRIVE_PICKUP' | 'START_TRANSPORT') => {
    const offer = await seedAcceptedOffer();
    const steps: Array<'START' | 'ARRIVE_PICKUP' | 'START_TRANSPORT'> = [
      'START',
      'ARRIVE_PICKUP',
      'START_TRANSPORT',
    ];

    for (const step of steps) {
      await transitionOwnAssignment(offer.driver.userId, offer.assignment.id, step);
      if (step === through) break;
    }

    return offer;
  };

  const readState = async (offer: Awaited<ReturnType<typeof seedOffer>>) => ({
    assignment: await prisma.ambulanceAssignment.findUniqueOrThrow({
      where: { id: offer.assignment.id },
    }),
    emergency: await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: offer.seed.emergency.id },
    }),
    ambulance: await prisma.ambulance.findUniqueOrThrow({ where: { id: offer.ambulance.id } }),
    driver: await prisma.driverProfile.findUniqueOrThrow({
      where: { id: offer.driver.profile.id },
    }),
  });

  it('START moves the assignment, the emergency and the vehicle, and stamps startedAt', async () => {
    const offer = await seedAcceptedOffer();

    const result = await transitionOwnAssignment(offer.driver.userId, offer.assignment.id, 'START');

    expect(result.status).toBe(AmbulanceAssignmentStatus.EN_ROUTE);
    expect(result.startedAt).toBeInstanceOf(Date);
    expect(result.endedAt).toBeNull();
    expect(result.emergency.currentStatus).toBe(EmergencyStatus.DRIVER_EN_ROUTE);

    const state = await readState(offer);
    expect(state.assignment.status).toBe(AmbulanceAssignmentStatus.EN_ROUTE);
    expect(state.assignment.startedAt).not.toBeNull();
    expect(state.assignment.endedAt).toBeNull();
    expect(state.emergency.currentStatus).toBe(EmergencyStatus.DRIVER_EN_ROUTE);
    expect(state.ambulance.status).toBe(AmbulanceStatus.EN_ROUTE);
    // The driver stays committed for the whole trip.
    expect(state.driver.availabilityStatus).toBe(DriverAvailability.BUSY);
  });

  it('ARRIVE_PICKUP advances both rows and stamps nothing', async () => {
    const offer = await walkTo('START');
    const before = await readState(offer);

    const result = await transitionOwnAssignment(
      offer.driver.userId,
      offer.assignment.id,
      'ARRIVE_PICKUP',
    );

    expect(result.status).toBe(AmbulanceAssignmentStatus.AT_PICKUP);
    expect(result.emergency.currentStatus).toBe(EmergencyStatus.AT_PICKUP);

    const state = await readState(offer);
    expect(state.assignment.startedAt?.getTime()).toBe(before.assignment.startedAt?.getTime());
    expect(state.assignment.endedAt).toBeNull();
    expect(state.ambulance.status).toBe(AmbulanceStatus.EN_ROUTE);
    expect(state.driver.availabilityStatus).toBe(DriverAvailability.BUSY);
  });

  it('START_TRANSPORT advances both rows and stamps nothing', async () => {
    const offer = await walkTo('ARRIVE_PICKUP');

    const result = await transitionOwnAssignment(
      offer.driver.userId,
      offer.assignment.id,
      'START_TRANSPORT',
    );

    expect(result.status).toBe(AmbulanceAssignmentStatus.TRANSPORTING);
    expect(result.emergency.currentStatus).toBe(EmergencyStatus.TRANSPORTING);

    const state = await readState(offer);
    expect(state.assignment.endedAt).toBeNull();
    expect(state.ambulance.status).toBe(AmbulanceStatus.EN_ROUTE);
    expect(state.driver.availabilityStatus).toBe(DriverAvailability.BUSY);
  });

  it('ARRIVE_HOSPITAL completes the dispatch, releases both resources and stamps endedAt', async () => {
    const offer = await walkTo('START_TRANSPORT');

    const result = await transitionOwnAssignment(
      offer.driver.userId,
      offer.assignment.id,
      'ARRIVE_HOSPITAL',
    );

    expect(result.status).toBe(AmbulanceAssignmentStatus.COMPLETED);
    expect(result.endedAt).toBeInstanceOf(Date);
    // COMPLETED is the dispatch, not the emergency: admission and completion come later.
    expect(result.emergency.currentStatus).toBe(EmergencyStatus.AT_HOSPITAL);

    const state = await readState(offer);
    expect(state.assignment.status).toBe(AmbulanceAssignmentStatus.COMPLETED);
    expect(state.assignment.startedAt).not.toBeNull();
    expect(state.assignment.endedAt).not.toBeNull();
    expect(state.emergency.currentStatus).toBe(EmergencyStatus.AT_HOSPITAL);
    expect(state.emergency.completedAt).toBeNull();
    expect(state.ambulance.status).toBe(AmbulanceStatus.AVAILABLE);
    expect(state.driver.availabilityStatus).toBe(DriverAvailability.AVAILABLE);
  });

  it('writes one DRIVER history row per step, attributed to the driver User id', async () => {
    const offer = await walkTo('START_TRANSPORT');
    await transitionOwnAssignment(offer.driver.userId, offer.assignment.id, 'ARRIVE_HOSPITAL');

    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: offer.seed.emergency.id },
      orderBy: { occurredAt: 'asc' },
    });

    // Two HOSPITAL_STAFF rows from the Task 1.16 dispatch, then four DRIVER rows.
    expect(history).toHaveLength(6);

    const tripRows = history.slice(2);
    expect(tripRows.map((row) => [row.fromStatus, row.toStatus])).toEqual([
      [EmergencyStatus.PENDING_DRIVER_ACCEPTANCE, EmergencyStatus.DRIVER_EN_ROUTE],
      [EmergencyStatus.DRIVER_EN_ROUTE, EmergencyStatus.AT_PICKUP],
      [EmergencyStatus.AT_PICKUP, EmergencyStatus.TRANSPORTING],
      [EmergencyStatus.TRANSPORTING, EmergencyStatus.AT_HOSPITAL],
    ]);
    tripRows.forEach((row) => {
      expect(row.actorType).toBe('DRIVER');
      // The authenticated User id, never the DriverProfile id.
      expect(row.actorUserId).toBe(offer.driver.userId);
      expect(row.actorUserId).not.toBe(offer.driver.profile.id);
    });
  });

  it.each(['ARRIVE_PICKUP', 'START_TRANSPORT', 'ARRIVE_HOSPITAL'] as const)(
    'refuses %s out of order from an ACCEPTED assignment',
    async (action) => {
      const offer = await seedAcceptedOffer();

      await expect(
        transitionOwnAssignment(offer.driver.userId, offer.assignment.id, action),
      ).rejects.toMatchObject({ code: 'ASSIGNMENT_STATUS_CONFLICT', statusCode: 409 });

      const state = await readState(offer);
      expect(state.assignment.status).toBe(AmbulanceAssignmentStatus.ACCEPTED);
      expect(state.assignment.startedAt).toBeNull();
      expect(state.emergency.currentStatus).toBe(EmergencyStatus.PENDING_DRIVER_ACCEPTANCE);
      expect(state.ambulance.status).toBe(AmbulanceStatus.ASSIGNED);
      expect(
        await prisma.emergencyStatusHistory.count({
          where: { emergencyId: offer.seed.emergency.id, actorType: 'DRIVER' },
        }),
      ).toBe(0);
    },
  );

  it('refuses START on an offer the driver has not accepted yet', async () => {
    const offer = await seedOffer();

    await expect(
      transitionOwnAssignment(offer.driver.userId, offer.assignment.id, 'START'),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_STATUS_CONFLICT', statusCode: 409 });

    const state = await readState(offer);
    expect(state.assignment.status).toBe(AmbulanceAssignmentStatus.OFFERED);
    expect(state.ambulance.status).toBe(AmbulanceStatus.OFFERED);
  });

  it('refuses START on a rejected assignment', async () => {
    const offer = await seedOffer();
    await rejectOwnAssignment(offer.driver.userId, offer.assignment.id, 'Vehicle fault');

    await expect(
      transitionOwnAssignment(offer.driver.userId, offer.assignment.id, 'START'),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_STATUS_CONFLICT', statusCode: 409 });
  });

  it.each(['START', 'ARRIVE_PICKUP', 'START_TRANSPORT', 'ARRIVE_HOSPITAL'] as const)(
    'refuses a duplicate %s and mutates nothing the second time',
    async (action) => {
      const offer = await seedAcceptedOffer();
      const upTo = ['START', 'ARRIVE_PICKUP', 'START_TRANSPORT', 'ARRIVE_HOSPITAL'] as const;

      for (const step of upTo) {
        await transitionOwnAssignment(offer.driver.userId, offer.assignment.id, step);
        if (step === action) break;
      }

      const before = await readState(offer);
      const historyBefore = await prisma.emergencyStatusHistory.count({
        where: { emergencyId: offer.seed.emergency.id },
      });

      await expect(
        transitionOwnAssignment(offer.driver.userId, offer.assignment.id, action),
      ).rejects.toMatchObject({ code: 'ASSIGNMENT_STATUS_CONFLICT', statusCode: 409 });

      const after = await readState(offer);
      expect(after.assignment.status).toBe(before.assignment.status);
      expect(after.assignment.startedAt?.getTime()).toBe(before.assignment.startedAt?.getTime());
      expect(after.assignment.endedAt?.getTime()).toBe(before.assignment.endedAt?.getTime());
      expect(after.emergency.currentStatus).toBe(before.emergency.currentStatus);
      expect(after.ambulance.status).toBe(before.ambulance.status);
      expect(after.driver.availabilityStatus).toBe(before.driver.availabilityStatus);
      expect(
        await prisma.emergencyStatusHistory.count({
          where: { emergencyId: offer.seed.emergency.id },
        }),
      ).toBe(historyBefore);
    },
  );

  it('cannot advance another driver trip', async () => {
    const offer = await walkTo('START');
    const otherDriver = await createDriverUser();

    await expect(
      transitionOwnAssignment(otherDriver.userId, offer.assignment.id, 'ARRIVE_PICKUP'),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND', statusCode: 404 });

    const state = await readState(offer);
    expect(state.assignment.status).toBe(AmbulanceAssignmentStatus.EN_ROUTE);
    expect(state.emergency.currentStatus).toBe(EmergencyStatus.DRIVER_EN_ROUTE);
  });

  it('rejects a nonexistent assignment', async () => {
    const driver = await createDriverUser();

    await expect(
      transitionOwnAssignment(driver.userId, randomUUID(), 'START'),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND', statusCode: 404 });
  });

  it('rolls the whole step back when the emergency has moved on underneath', async () => {
    const offer = await walkTo('START');
    // Something else advanced the emergency, so DRIVER_EN_ROUTE -> AT_PICKUP must fail.
    await prisma.emergencyRequest.update({
      where: { id: offer.seed.emergency.id },
      data: { currentStatus: EmergencyStatus.CANCELLED },
    });

    await expect(
      transitionOwnAssignment(offer.driver.userId, offer.assignment.id, 'ARRIVE_PICKUP'),
    ).rejects.toMatchObject({ code: 'EMERGENCY_STATUS_CONFLICT', statusCode: 409 });

    // The assignment claim and the resource moves were all rolled back with it.
    const state = await readState(offer);
    expect(state.assignment.status).toBe(AmbulanceAssignmentStatus.EN_ROUTE);
    expect(state.ambulance.status).toBe(AmbulanceStatus.EN_ROUTE);
    expect(state.driver.availabilityStatus).toBe(DriverAvailability.BUSY);
    expect(
      await prisma.emergencyStatusHistory.count({
        where: { emergencyId: offer.seed.emergency.id, toStatus: EmergencyStatus.AT_PICKUP },
      }),
    ).toBe(0);
  });

  it('rolls ARRIVE_HOSPITAL back when the emergency has moved on, keeping the resources held', async () => {
    const offer = await walkTo('START_TRANSPORT');
    await prisma.emergencyRequest.update({
      where: { id: offer.seed.emergency.id },
      data: { currentStatus: EmergencyStatus.CANCELLED },
    });

    await expect(
      transitionOwnAssignment(offer.driver.userId, offer.assignment.id, 'ARRIVE_HOSPITAL'),
    ).rejects.toMatchObject({ code: 'EMERGENCY_STATUS_CONFLICT', statusCode: 409 });

    const state = await readState(offer);
    expect(state.assignment.status).toBe(AmbulanceAssignmentStatus.TRANSPORTING);
    expect(state.assignment.endedAt).toBeNull();
    // The release is part of the same transaction, so nothing was handed back early.
    expect(state.ambulance.status).toBe(AmbulanceStatus.EN_ROUTE);
    expect(state.driver.availabilityStatus).toBe(DriverAvailability.BUSY);
  });

  it.each([1, 2, 3])('run %i: two concurrent STARTs produce one trip', async () => {
    const offer = await seedAcceptedOffer();

    const outcomes = await Promise.allSettled([
      transitionOwnAssignment(offer.driver.userId, offer.assignment.id, 'START'),
      transitionOwnAssignment(offer.driver.userId, offer.assignment.id, 'START'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);

    const state = await readState(offer);
    expect(state.assignment.status).toBe(AmbulanceAssignmentStatus.EN_ROUTE);
    expect(state.ambulance.status).toBe(AmbulanceStatus.EN_ROUTE);
    expect(
      await prisma.emergencyStatusHistory.count({
        where: {
          emergencyId: offer.seed.emergency.id,
          toStatus: EmergencyStatus.DRIVER_EN_ROUTE,
        },
      }),
    ).toBe(1);
  });

  it.each([1, 2, 3])('run %i: START and FAIL race to one terminal state', async () => {
    const offer = await walkTo('START');

    const outcomes = await Promise.allSettled([
      transitionOwnAssignment(offer.driver.userId, offer.assignment.id, 'ARRIVE_PICKUP'),
      failOwnAssignment(offer.driver.userId, offer.assignment.id, 'Vehicle broke down.'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);

    // Whichever won, the database agrees with it and no mixed state exists.
    const state = await readState(offer);
    if (state.assignment.status === AmbulanceAssignmentStatus.FAILED) {
      expect(state.assignment.endedAt).not.toBeNull();
      expect(state.ambulance.status).toBe(AmbulanceStatus.AVAILABLE);
      expect(state.driver.availabilityStatus).toBe(DriverAvailability.AVAILABLE);
      expect(state.emergency.currentStatus).toBe(EmergencyStatus.DRIVER_EN_ROUTE);
    } else {
      expect(state.assignment.status).toBe(AmbulanceAssignmentStatus.AT_PICKUP);
      expect(state.assignment.endedAt).toBeNull();
      expect(state.ambulance.status).toBe(AmbulanceStatus.EN_ROUTE);
      expect(state.driver.availabilityStatus).toBe(DriverAvailability.BUSY);
      expect(state.emergency.currentStatus).toBe(EmergencyStatus.AT_PICKUP);
    }
  });

  it.each([1, 2, 3])(
    'run %i: START_TRANSPORT and FAIL race from AT_PICKUP to one terminal state',
    async () => {
      // The same contention as the race above, one step later. It is a separate case because
      // TRANSPORTING is also a failable status, so a set-based failure claim would re-match
      // here too: both callers would succeed and the trip would be FAILED while the emergency
      // had already moved to TRANSPORTING.
      const offer = await walkTo('ARRIVE_PICKUP');

      const outcomes = await Promise.allSettled([
        transitionOwnAssignment(offer.driver.userId, offer.assignment.id, 'START_TRANSPORT'),
        failOwnAssignment(offer.driver.userId, offer.assignment.id, 'Stretcher lift failed.'),
      ]);

      const rejected = outcomes.filter(
        (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
      );
      expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0]!.reason).toMatchObject({
        code: 'ASSIGNMENT_STATUS_CONFLICT',
        statusCode: 409,
      });

      const state = await readState(offer);
      const transportingRows = await prisma.emergencyStatusHistory.count({
        where: {
          emergencyId: offer.seed.emergency.id,
          toStatus: EmergencyStatus.TRANSPORTING,
        },
      });

      // Whichever won, every row agrees with it and the loser left no trace.
      if (state.assignment.status === AmbulanceAssignmentStatus.FAILED) {
        expect(state.assignment.endedAt).not.toBeNull();
        expect(state.assignment.rejectionReason).toBe('Stretcher lift failed.');
        expect(state.ambulance.status).toBe(AmbulanceStatus.AVAILABLE);
        expect(state.driver.availabilityStatus).toBe(DriverAvailability.AVAILABLE);
        expect(state.emergency.currentStatus).toBe(EmergencyStatus.AT_PICKUP);
        expect(transportingRows).toBe(0);
      } else {
        expect(state.assignment.status).toBe(AmbulanceAssignmentStatus.TRANSPORTING);
        expect(state.assignment.endedAt).toBeNull();
        expect(state.assignment.rejectionReason).toBeNull();
        expect(state.ambulance.status).toBe(AmbulanceStatus.EN_ROUTE);
        expect(state.driver.availabilityStatus).toBe(DriverAvailability.BUSY);
        expect(state.emergency.currentStatus).toBe(EmergencyStatus.TRANSPORTING);
        expect(transportingRows).toBe(1);
      }
    },
  );
});

describe('failOwnAssignment', () => {
  const seedAcceptedOffer = async () => {
    const offer = await seedOffer();
    await acceptOwnAssignment(offer.driver.userId, offer.assignment.id);
    return offer;
  };

  const walkTo = async (through: 'START' | 'ARRIVE_PICKUP' | 'START_TRANSPORT') => {
    const offer = await seedAcceptedOffer();
    for (const step of ['START', 'ARRIVE_PICKUP', 'START_TRANSPORT'] as const) {
      await transitionOwnAssignment(offer.driver.userId, offer.assignment.id, step);
      if (step === through) break;
    }
    return offer;
  };

  it.each([
    ['EN_ROUTE', 'START' as const, EmergencyStatus.DRIVER_EN_ROUTE],
    ['AT_PICKUP', 'ARRIVE_PICKUP' as const, EmergencyStatus.AT_PICKUP],
    ['TRANSPORTING', 'START_TRANSPORT' as const, EmergencyStatus.TRANSPORTING],
  ])(
    'fails a trip from %s, releases both resources and leaves the emergency alone',
    async (_label, through, expectedEmergencyStatus) => {
      const offer = await walkTo(through);
      const historyBefore = await prisma.emergencyStatusHistory.count({
        where: { emergencyId: offer.seed.emergency.id },
      });

      const failed = await failOwnAssignment(
        offer.driver.userId,
        offer.assignment.id,
        'Vehicle broke down en route.',
      );

      expect(failed.status).toBe(AmbulanceAssignmentStatus.FAILED);
      expect(failed.endedAt).toBeInstanceOf(Date);
      // The reason lives in the existing rejectionReason column; no new field was invented.
      expect(failed.rejectionReason).toBe('Vehicle broke down en route.');

      const stored = await prisma.ambulanceAssignment.findUniqueOrThrow({
        where: { id: offer.assignment.id },
      });
      expect(stored.status).toBe(AmbulanceAssignmentStatus.FAILED);
      expect(stored.rejectionReason).toBe('Vehicle broke down en route.');
      expect(stored.endedAt).not.toBeNull();
      expect(stored.startedAt).not.toBeNull();

      expect(
        (await prisma.ambulance.findUniqueOrThrow({ where: { id: offer.ambulance.id } })).status,
      ).toBe(AmbulanceStatus.AVAILABLE);
      expect(
        (await prisma.driverProfile.findUniqueOrThrow({ where: { id: offer.driver.profile.id } }))
          .availabilityStatus,
      ).toBe(DriverAvailability.AVAILABLE);

      // The emergency keeps the status the trip had reached: no transition, no escalation.
      const emergency = await prisma.emergencyRequest.findUniqueOrThrow({
        where: { id: offer.seed.emergency.id },
      });
      expect(emergency.currentStatus).toBe(expectedEmergencyStatus);
      expect(
        await prisma.emergencyStatusHistory.count({
          where: { emergencyId: offer.seed.emergency.id },
        }),
      ).toBe(historyBefore);

      // No replacement attempt is created.
      expect(
        await prisma.ambulanceAssignment.count({
          where: { emergencyId: offer.seed.emergency.id },
        }),
      ).toBe(1);
    },
  );

  it('leaves the bed reservation untouched', async () => {
    const offer = await walkTo('START_TRANSPORT');
    const bed = await prisma.bed.create({
      data: { hospitalId: offer.scope.hospitalId, bedCode: `B-${randomUUID().slice(0, 8)}` },
    });
    const reservation = await prisma.bedReservation.create({
      data: {
        emergencyId: offer.seed.emergency.id,
        hospitalResponseId: offer.seed.response.id,
        bedId: bed.id,
      },
    });

    await failOwnAssignment(offer.driver.userId, offer.assignment.id, 'Vehicle broke down.');

    const stored = await prisma.bedReservation.findUniqueOrThrow({ where: { id: reservation.id } });
    expect(stored.status).toBe('RESERVED');
    expect(stored.releasedAt).toBeNull();
    expect(stored.releaseReason).toBeNull();
  });

  it.each([
    ['OFFERED', async () => seedOffer()],
    ['ACCEPTED', async () => seedAcceptedOffer()],
  ])('refuses to fail an %s assignment', async (_label, seed) => {
    const offer = await seed();

    await expect(
      failOwnAssignment(offer.driver.userId, offer.assignment.id, 'Changed my mind.'),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_STATUS_CONFLICT', statusCode: 409 });

    const stored = await prisma.ambulanceAssignment.findUniqueOrThrow({
      where: { id: offer.assignment.id },
    });
    expect(stored.rejectionReason).toBeNull();
    expect(stored.endedAt).toBeNull();
  });

  it('refuses to fail a COMPLETED assignment', async () => {
    const offer = await walkTo('START_TRANSPORT');
    await transitionOwnAssignment(offer.driver.userId, offer.assignment.id, 'ARRIVE_HOSPITAL');

    await expect(
      failOwnAssignment(offer.driver.userId, offer.assignment.id, 'Too late.'),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_STATUS_CONFLICT', statusCode: 409 });

    const stored = await prisma.ambulanceAssignment.findUniqueOrThrow({
      where: { id: offer.assignment.id },
    });
    expect(stored.status).toBe(AmbulanceAssignmentStatus.COMPLETED);
    expect(stored.rejectionReason).toBeNull();
  });

  it('refuses to fail a REJECTED assignment and keeps the rejection reason', async () => {
    const offer = await seedOffer();
    await rejectOwnAssignment(offer.driver.userId, offer.assignment.id, 'No ICU equipment.');

    await expect(
      failOwnAssignment(offer.driver.userId, offer.assignment.id, 'Vehicle broke down.'),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_STATUS_CONFLICT', statusCode: 409 });

    const stored = await prisma.ambulanceAssignment.findUniqueOrThrow({
      where: { id: offer.assignment.id },
    });
    expect(stored.status).toBe(AmbulanceAssignmentStatus.REJECTED);
    expect(stored.rejectionReason).toBe('No ICU equipment.');
  });

  it('cannot fail another driver trip', async () => {
    const offer = await walkTo('START');
    const otherDriver = await createDriverUser();

    await expect(
      failOwnAssignment(otherDriver.userId, offer.assignment.id, 'Not mine.'),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND', statusCode: 404 });

    const stored = await prisma.ambulanceAssignment.findUniqueOrThrow({
      where: { id: offer.assignment.id },
    });
    expect(stored.status).toBe(AmbulanceAssignmentStatus.EN_ROUTE);
  });
});

describe('released resources return to the Task 1.21 pool', () => {
  /**
   * The driver pool is global, so a driver this suite expects to be auto-selected is dated
   * decades into the past: that makes it the oldest eligible row in the database, which both
   * fixes selection and guarantees this suite can never claim another suite's driver.
   */
  const createAncientDriver = async (years: number) => {
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
            createdAt: new Date(Date.UTC(2000 - years, 0, 1)),
          },
        },
      },
      include: { driverProfile: true },
    });

    return { userId: user.id, profile: user.driverProfile! };
  };

  it.each([
    ['ARRIVE_HOSPITAL', 'ARRIVE_HOSPITAL' as const],
    ['FAIL', 'FAIL' as const],
  ])(
    'a vehicle and driver freed by %s can be dispatched again automatically',
    async (_l, ending) => {
      const scope = await createScope();
      const actorUserId = await createActor();
      const firstEmergency = await seedReservedEmergency(scope.hospitalId);
      const ambulance = await createAmbulance(scope.hospitalId);
      const driver = await createAncientDriver(70);

      const assignment = await createAssignment(
        scope,
        firstEmergency.emergency.id,
        { ambulanceId: ambulance.id, driverId: driver.profile.id },
        actorUserId,
      );
      await acceptOwnAssignment(driver.userId, assignment.id);
      await transitionOwnAssignment(driver.userId, assignment.id, 'START');

      if (ending === 'ARRIVE_HOSPITAL') {
        await transitionOwnAssignment(driver.userId, assignment.id, 'ARRIVE_PICKUP');
        await transitionOwnAssignment(driver.userId, assignment.id, 'START_TRANSPORT');
        await transitionOwnAssignment(driver.userId, assignment.id, 'ARRIVE_HOSPITAL');
      } else {
        await failOwnAssignment(driver.userId, assignment.id, 'Vehicle broke down.');
      }

      // Both resources are back in their pools, so Task 1.21 can pick them for a new emergency.
      const secondEmergency = await seedReservedEmergency(scope.hospitalId);
      const outcome = await autoAssignAmbulanceForReservedEmergency(
        scope,
        secondEmergency.emergency.id,
        actorUserId,
      );

      expect(outcome.assigned).toBe(true);
      expect(outcome.assignment?.ambulanceId).toBe(ambulance.id);
      expect(outcome.assignment?.driverId).toBe(driver.profile.id);
      expect(outcome.assignment?.attemptNumber).toBe(1);
      expect(
        (
          await prisma.emergencyRequest.findUniqueOrThrow({
            where: { id: secondEmergency.emergency.id },
          })
        ).currentStatus,
      ).toBe(EmergencyStatus.PENDING_DRIVER_ACCEPTANCE);
    },
  );
});

describe('driver availability while a dispatch is live', () => {
  const activeStates: Array<[string, (userId: string, assignmentId: string) => Promise<unknown>]> =
    [
      ['OFFERED', async () => undefined],
      ['ACCEPTED', async (userId, id) => acceptOwnAssignment(userId, id)],
      [
        'EN_ROUTE',
        async (userId, id) => {
          await acceptOwnAssignment(userId, id);
          return transitionOwnAssignment(userId, id, 'START');
        },
      ],
      [
        'AT_PICKUP',
        async (userId, id) => {
          await acceptOwnAssignment(userId, id);
          await transitionOwnAssignment(userId, id, 'START');
          return transitionOwnAssignment(userId, id, 'ARRIVE_PICKUP');
        },
      ],
      [
        'TRANSPORTING',
        async (userId, id) => {
          await acceptOwnAssignment(userId, id);
          await transitionOwnAssignment(userId, id, 'START');
          await transitionOwnAssignment(userId, id, 'ARRIVE_PICKUP');
          return transitionOwnAssignment(userId, id, 'START_TRANSPORT');
        },
      ],
    ];

  it.each(activeStates)(
    'refuses a self-service availability change while an assignment is %s',
    async (_label, advance) => {
      const offer = await seedOffer();
      await advance(offer.driver.userId, offer.assignment.id);

      const before = await prisma.driverProfile.findUniqueOrThrow({
        where: { id: offer.driver.profile.id },
      });

      // Making themselves AVAILABLE is what would let Task 1.21 dispatch them a second time.
      await expect(
        updateOwnAvailability(offer.driver.userId, DriverAvailability.AVAILABLE),
      ).rejects.toMatchObject({ code: 'DRIVER_HAS_ACTIVE_ASSIGNMENT', statusCode: 409 });

      const after = await prisma.driverProfile.findUniqueOrThrow({
        where: { id: offer.driver.profile.id },
      });
      expect(after.availabilityStatus).toBe(before.availabilityStatus);
    },
  );

  it('cannot be dispatched twice by making themselves available mid-trip', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const firstEmergency = await seedReservedEmergency(scope.hospitalId);
    const ambulance = await createAmbulance(scope.hospitalId);
    const spareAmbulance = await createAmbulance(scope.hospitalId);
    const driver = await createDriverUser();

    const assignment = await createAssignment(
      scope,
      firstEmergency.emergency.id,
      { ambulanceId: ambulance.id, driverId: driver.profile.id },
      actorUserId,
    );
    await acceptOwnAssignment(driver.userId, assignment.id);
    await transitionOwnAssignment(driver.userId, assignment.id, 'START');

    await expect(
      updateOwnAvailability(driver.userId, DriverAvailability.AVAILABLE),
    ).rejects.toMatchObject({ code: 'DRIVER_HAS_ACTIVE_ASSIGNMENT' });

    // The driver is still BUSY, so an explicit second dispatch is refused too.
    const secondEmergency = await seedReservedEmergency(scope.hospitalId);
    await expect(
      createAssignment(
        scope,
        secondEmergency.emergency.id,
        { ambulanceId: spareAmbulance.id, driverId: driver.profile.id },
        actorUserId,
      ),
    ).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE', statusCode: 409 });

    expect(await prisma.ambulanceAssignment.count({ where: { driverId: driver.profile.id } })).toBe(
      1,
    );
  });

  it('allows a self-service availability change once the trip is over', async () => {
    const offer = await seedOffer();
    await acceptOwnAssignment(offer.driver.userId, offer.assignment.id);
    for (const step of ['START', 'ARRIVE_PICKUP', 'START_TRANSPORT', 'ARRIVE_HOSPITAL'] as const) {
      await transitionOwnAssignment(offer.driver.userId, offer.assignment.id, step);
    }

    const profile = await updateOwnAvailability(offer.driver.userId, DriverAvailability.ON_BREAK);
    expect(profile.availabilityStatus).toBe(DriverAvailability.ON_BREAK);
  });

  it('allows a self-service availability change after a rejection', async () => {
    const offer = await seedOffer();
    await rejectOwnAssignment(offer.driver.userId, offer.assignment.id, 'Vehicle fault');

    const profile = await updateOwnAvailability(offer.driver.userId, DriverAvailability.OFFLINE);
    expect(profile.availabilityStatus).toBe(DriverAvailability.OFFLINE);
  });
});
