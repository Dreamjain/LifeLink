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
import {
  autoAssignAmbulanceForReservedEmergency,
  createAssignment,
  getAssignment,
  listAssignments,
} from './assignment.service.js';

const TEST_REG_PREFIX = 'T1616-';
const TEST_PHONE_PREFIX = '+1616';
const TEST_LICENCE_PREFIX = 'L1616-';

const randomRegistration = (): string => `${TEST_REG_PREFIX}${randomUUID().slice(0, 12)}`;
const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const createScope = async (
  staffRole: HospitalStaffRole = HospitalStaffRole.DISPATCHER,
): Promise<HospitalStaffContext> => {
  const hospital = await prisma.hospital.create({
    data: {
      name: 'Assignment Service Hospital',
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

const createAmbulance = async (
  hospitalId: string,
  status: AmbulanceStatus = AmbulanceStatus.AVAILABLE,
) =>
  prisma.ambulance.create({
    data: { hospitalId, vehicleNumber: `V-${randomUUID().slice(0, 10)}`, status },
  });

const createDriver = async (
  options: {
    verificationStatus?: VerificationStatus;
    availabilityStatus?: DriverAvailability;
    userStatus?: UserStatus;
  } = {},
) => {
  const user = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      passwordHash: 'not-used-in-this-fixture',
      role: UserRole.DRIVER,
      status: options.userStatus ?? UserStatus.ACTIVE,
      displayName: 'Fixture Driver',
      driverProfile: {
        create: {
          licenceNumber: `${TEST_LICENCE_PREFIX}${randomUUID().slice(0, 12)}`,
          verificationStatus: options.verificationStatus ?? VerificationStatus.VERIFIED,
          availabilityStatus: options.availabilityStatus ?? DriverAvailability.AVAILABLE,
        },
      },
    },
    include: { driverProfile: true },
  });

  return user.driverProfile!;
};

/** Seeds an emergency the hospital has accepted and reserved a bed for (Task 1.15 output). */
const seedReservedEmergency = async (options: {
  hospitalId: string;
  emergencyStatus?: EmergencyStatus;
  responseStatus?: HospitalResponseStatus;
}) => {
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
      currentStatus: options.emergencyStatus ?? EmergencyStatus.BED_RESERVED,
      pickupAddress: '12 Elm Street',
    },
  });

  const response = await prisma.hospitalResponse.create({
    data: {
      emergencyId: emergency.id,
      hospitalId: options.hospitalId,
      status: options.responseStatus ?? HospitalResponseStatus.ACCEPTED,
    },
  });

  return { emergency, response, patientUser };
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

  // Task 1.21: an assignment can reach this file's resources from outside its own emergencies,
  // because the driver pool is global. AmbulanceAssignment references both the driver and the
  // vehicle with onDelete: Restrict, so detach by resource id before releasing either.
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

describe('createAssignment', () => {
  it('claims the ambulance and driver, creates the offer, and advances the emergency', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    const ambulance = await createAmbulance(scope.hospitalId);
    const driver = await createDriver();

    const assignment = await createAssignment(
      scope,
      seed.emergency.id,
      { ambulanceId: ambulance.id, driverId: driver.id },
      actorUserId,
    );

    expect(assignment.status).toBe(AmbulanceAssignmentStatus.OFFERED);
    expect(assignment.attemptNumber).toBe(1);
    expect(assignment.hospitalResponseId).toBe(seed.response.id);
    expect(assignment.respondedAt).toBeNull();

    const storedAmbulance = await prisma.ambulance.findUniqueOrThrow({
      where: { id: ambulance.id },
    });
    expect(storedAmbulance.status).toBe(AmbulanceStatus.OFFERED);

    const storedDriver = await prisma.driverProfile.findUniqueOrThrow({ where: { id: driver.id } });
    expect(storedDriver.availabilityStatus).toBe(DriverAvailability.BUSY);

    const emergency = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: seed.emergency.id },
    });
    expect(emergency.currentStatus).toBe(EmergencyStatus.PENDING_DRIVER_ACCEPTANCE);

    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: seed.emergency.id },
      orderBy: { occurredAt: 'asc' },
    });
    expect(history.map((row) => row.toStatus)).toEqual([
      EmergencyStatus.AMBULANCE_ASSIGNED,
      EmergencyStatus.PENDING_DRIVER_ACCEPTANCE,
    ]);
    expect(history.every((row) => row.actorUserId === actorUserId)).toBe(true);
  });

  it('exposes no patient profile data on the dispatch surface', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    const ambulance = await createAmbulance(scope.hospitalId);
    const driver = await createDriver();

    const assignment = await createAssignment(
      scope,
      seed.emergency.id,
      { ambulanceId: ambulance.id, driverId: driver.id },
      actorUserId,
    );

    const serialized = JSON.stringify(assignment);
    expect(serialized).not.toContain('FIXTURE-ALLERGY-MUST-NOT-LEAK');
    expect(serialized).not.toContain('FIXTURE-SUMMARY-MUST-NOT-LEAK');
    expect(serialized).not.toContain('passwordHash');
    expect(serialized).not.toContain(seed.patientUser.phone);
    expect(assignment.emergency).not.toHaveProperty('patient');
    expect(assignment.emergency).not.toHaveProperty('patientId');
  });

  it.each([
    EmergencyStatus.HOSPITAL_ACCEPTED,
    EmergencyStatus.PENDING_HOSPITAL_RESPONSE,
    EmergencyStatus.CANCELLED,
    EmergencyStatus.COMPLETED,
    EmergencyStatus.EXPIRED,
    EmergencyStatus.PENDING_DRIVER_ACCEPTANCE,
  ])('refuses to dispatch an emergency in %s', async (emergencyStatus) => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({ hospitalId: scope.hospitalId, emergencyStatus });
    const ambulance = await createAmbulance(scope.hospitalId);
    const driver = await createDriver();

    await expect(
      createAssignment(
        scope,
        seed.emergency.id,
        { ambulanceId: ambulance.id, driverId: driver.id },
        actorUserId,
      ),
    ).rejects.toMatchObject({ code: 'EMERGENCY_STATUS_CONFLICT', statusCode: 409 });
  });

  it('refuses an emergency this hospital has not accepted', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({
      hospitalId: scope.hospitalId,
      responseStatus: HospitalResponseStatus.PENDING,
    });
    const ambulance = await createAmbulance(scope.hospitalId);
    const driver = await createDriver();

    await expect(
      createAssignment(
        scope,
        seed.emergency.id,
        { ambulanceId: ambulance.id, driverId: driver.id },
        actorUserId,
      ),
    ).rejects.toMatchObject({ code: 'EMERGENCY_NOT_FOUND', statusCode: 404 });
  });

  it('refuses another hospital emergency without disclosing it', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const actorUserId = await createActor();
    const seedB = await seedReservedEmergency({ hospitalId: scopeB.hospitalId });
    const ambulanceA = await createAmbulance(scopeA.hospitalId);
    const driver = await createDriver();

    await expect(
      createAssignment(
        scopeA,
        seedB.emergency.id,
        { ambulanceId: ambulanceA.id, driverId: driver.id },
        actorUserId,
      ),
    ).rejects.toMatchObject({ code: 'EMERGENCY_NOT_FOUND', statusCode: 404 });

    const emergency = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: seedB.emergency.id },
    });
    expect(emergency.currentStatus).toBe(EmergencyStatus.BED_RESERVED);
  });

  it('refuses an ambulance belonging to another hospital without disclosing it', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const actorUserId = await createActor();
    const seedA = await seedReservedEmergency({ hospitalId: scopeA.hospitalId });
    const ambulanceB = await createAmbulance(scopeB.hospitalId);
    const driver = await createDriver();

    await expect(
      createAssignment(
        scopeA,
        seedA.emergency.id,
        { ambulanceId: ambulanceB.id, driverId: driver.id },
        actorUserId,
      ),
    ).rejects.toMatchObject({ code: 'AMBULANCE_NOT_FOUND', statusCode: 404 });

    const storedAmbulance = await prisma.ambulance.findUniqueOrThrow({
      where: { id: ambulanceB.id },
    });
    expect(storedAmbulance.status).toBe(AmbulanceStatus.AVAILABLE);
  });

  it.each([
    AmbulanceStatus.OUT_OF_SERVICE,
    AmbulanceStatus.INACTIVE,
    AmbulanceStatus.OFFERED,
    AmbulanceStatus.ASSIGNED,
    AmbulanceStatus.EN_ROUTE,
  ])('refuses an ambulance in %s', async (status) => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    const ambulance = await createAmbulance(scope.hospitalId, status);
    const driver = await createDriver();

    await expect(
      createAssignment(
        scope,
        seed.emergency.id,
        { ambulanceId: ambulance.id, driverId: driver.id },
        actorUserId,
      ),
    ).rejects.toMatchObject({ code: 'AMBULANCE_UNAVAILABLE', statusCode: 409 });
  });

  it.each([
    { label: 'unverified', options: { verificationStatus: VerificationStatus.PENDING } },
    { label: 'rejected', options: { verificationStatus: VerificationStatus.REJECTED } },
    { label: 'offline', options: { availabilityStatus: DriverAvailability.OFFLINE } },
    { label: 'busy', options: { availabilityStatus: DriverAvailability.BUSY } },
    { label: 'suspended', options: { availabilityStatus: DriverAvailability.SUSPENDED } },
    { label: 'inactive account', options: { userStatus: UserStatus.SUSPENDED } },
  ])('refuses a $label driver', async ({ options }) => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    const ambulance = await createAmbulance(scope.hospitalId);
    const driver = await createDriver(options);

    await expect(
      createAssignment(
        scope,
        seed.emergency.id,
        { ambulanceId: ambulance.id, driverId: driver.id },
        actorUserId,
      ),
    ).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE', statusCode: 409 });
  });

  it('refuses an unknown ambulance and an unknown driver', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    const ambulance = await createAmbulance(scope.hospitalId);
    const driver = await createDriver();

    await expect(
      createAssignment(
        scope,
        seed.emergency.id,
        { ambulanceId: randomUUID(), driverId: driver.id },
        actorUserId,
      ),
    ).rejects.toMatchObject({ code: 'AMBULANCE_NOT_FOUND', statusCode: 404 });

    await expect(
      createAssignment(
        scope,
        seed.emergency.id,
        { ambulanceId: ambulance.id, driverId: randomUUID() },
        actorUserId,
      ),
    ).rejects.toMatchObject({ code: 'DRIVER_NOT_FOUND', statusCode: 404 });
  });
});

describe('assignment creation rollback', () => {
  it('rolls back the ambulance claim when the driver claim fails', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    const ambulance = await createAmbulance(scope.hospitalId);
    const driver = await createDriver({ availabilityStatus: DriverAvailability.OFFLINE });

    await expect(
      createAssignment(
        scope,
        seed.emergency.id,
        { ambulanceId: ambulance.id, driverId: driver.id },
        actorUserId,
      ),
    ).rejects.toMatchObject({ code: 'DRIVER_UNAVAILABLE' });

    const storedAmbulance = await prisma.ambulance.findUniqueOrThrow({
      where: { id: ambulance.id },
    });
    expect(storedAmbulance.status).toBe(AmbulanceStatus.AVAILABLE);
  });

  it('leaves no partial state when the emergency transition fails', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({
      hospitalId: scope.hospitalId,
      emergencyStatus: EmergencyStatus.HOSPITAL_ACCEPTED,
    });
    const ambulance = await createAmbulance(scope.hospitalId);
    const driver = await createDriver();

    await expect(
      createAssignment(
        scope,
        seed.emergency.id,
        { ambulanceId: ambulance.id, driverId: driver.id },
        actorUserId,
      ),
    ).rejects.toMatchObject({ code: 'EMERGENCY_STATUS_CONFLICT' });

    const storedAmbulance = await prisma.ambulance.findUniqueOrThrow({
      where: { id: ambulance.id },
    });
    expect(storedAmbulance.status).toBe(AmbulanceStatus.AVAILABLE);

    const storedDriver = await prisma.driverProfile.findUniqueOrThrow({ where: { id: driver.id } });
    expect(storedDriver.availabilityStatus).toBe(DriverAvailability.AVAILABLE);

    const emergency = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: seed.emergency.id },
    });
    expect(emergency.currentStatus).toBe(EmergencyStatus.HOSPITAL_ACCEPTED);

    expect(
      await prisma.ambulanceAssignment.count({ where: { emergencyId: seed.emergency.id } }),
    ).toBe(0);
    expect(
      await prisma.emergencyStatusHistory.count({ where: { emergencyId: seed.emergency.id } }),
    ).toBe(0);
  });
});

describe('dispatch concurrency', () => {
  it.each([1, 2, 3])('run %i: two emergencies race for the same ambulance', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seedOne = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    const seedTwo = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    const ambulance = await createAmbulance(scope.hospitalId);
    const driverOne = await createDriver();
    const driverTwo = await createDriver();

    const outcomes = await Promise.allSettled([
      createAssignment(
        scope,
        seedOne.emergency.id,
        { ambulanceId: ambulance.id, driverId: driverOne.id },
        actorUserId,
      ),
      createAssignment(
        scope,
        seedTwo.emergency.id,
        { ambulanceId: ambulance.id, driverId: driverTwo.id },
        actorUserId,
      ),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);

    expect(await prisma.ambulanceAssignment.count({ where: { ambulanceId: ambulance.id } })).toBe(
      1,
    );

    const storedAmbulance = await prisma.ambulance.findUniqueOrThrow({
      where: { id: ambulance.id },
    });
    expect(storedAmbulance.status).toBe(AmbulanceStatus.OFFERED);
  });

  it.each([1, 2, 3])('run %i: two emergencies race for the same driver', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seedOne = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    const seedTwo = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    const ambulanceOne = await createAmbulance(scope.hospitalId);
    const ambulanceTwo = await createAmbulance(scope.hospitalId);
    const driver = await createDriver();

    const outcomes = await Promise.allSettled([
      createAssignment(
        scope,
        seedOne.emergency.id,
        { ambulanceId: ambulanceOne.id, driverId: driver.id },
        actorUserId,
      ),
      createAssignment(
        scope,
        seedTwo.emergency.id,
        { ambulanceId: ambulanceTwo.id, driverId: driver.id },
        actorUserId,
      ),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);

    expect(await prisma.ambulanceAssignment.count({ where: { driverId: driver.id } })).toBe(1);

    const storedDriver = await prisma.driverProfile.findUniqueOrThrow({ where: { id: driver.id } });
    expect(storedDriver.availabilityStatus).toBe(DriverAvailability.BUSY);

    // The losing ambulance must have been released by the rollback.
    const ambulances = await prisma.ambulance.findMany({
      where: { id: { in: [ambulanceOne.id, ambulanceTwo.id] } },
      select: { status: true },
    });
    expect(ambulances.filter((a) => a.status === AmbulanceStatus.AVAILABLE)).toHaveLength(1);
    expect(ambulances.filter((a) => a.status === AmbulanceStatus.OFFERED)).toHaveLength(1);
  });

  it.each([1, 2, 3])('run %i: two dispatchers race for the same emergency', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    const ambulanceOne = await createAmbulance(scope.hospitalId);
    const ambulanceTwo = await createAmbulance(scope.hospitalId);
    const driverOne = await createDriver();
    const driverTwo = await createDriver();

    const outcomes = await Promise.allSettled([
      createAssignment(
        scope,
        seed.emergency.id,
        { ambulanceId: ambulanceOne.id, driverId: driverOne.id },
        actorUserId,
      ),
      createAssignment(
        scope,
        seed.emergency.id,
        { ambulanceId: ambulanceTwo.id, driverId: driverTwo.id },
        actorUserId,
      ),
    ]);

    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((o) => o.status === 'rejected')).toHaveLength(1);

    expect(
      await prisma.ambulanceAssignment.count({ where: { emergencyId: seed.emergency.id } }),
    ).toBe(1);

    const emergency = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: seed.emergency.id },
    });
    expect(emergency.currentStatus).toBe(EmergencyStatus.PENDING_DRIVER_ACCEPTANCE);

    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: seed.emergency.id },
    });
    expect(history).toHaveLength(2);
  });
});

describe('listAssignments / getAssignment', () => {
  it('lists and reads only the caller hospital assignments', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    const ambulance = await createAmbulance(scope.hospitalId);
    const driver = await createDriver();

    const created = await createAssignment(
      scope,
      seed.emergency.id,
      { ambulanceId: ambulance.id, driverId: driver.id },
      actorUserId,
    );

    const listed = await listAssignments(scope);
    expect(listed.map((a) => a.id)).toEqual([created.id]);
    expect((await getAssignment(scope, created.id)).id).toBe(created.id);
  });

  it('does not disclose another hospital assignment', async () => {
    const scopeA = await createScope();
    const scopeB = await createScope();
    const actorUserId = await createActor();
    const seedB = await seedReservedEmergency({ hospitalId: scopeB.hospitalId });
    const ambulanceB = await createAmbulance(scopeB.hospitalId);
    const driver = await createDriver();

    const created = await createAssignment(
      scopeB,
      seedB.emergency.id,
      { ambulanceId: ambulanceB.id, driverId: driver.id },
      actorUserId,
    );

    await expect(getAssignment(scopeA, created.id)).rejects.toMatchObject({
      code: 'ASSIGNMENT_NOT_FOUND',
      statusCode: 404,
    });
    expect(await listAssignments(scopeA)).toHaveLength(0);
  });

  it('rejects a nonexistent assignment', async () => {
    const scope = await createScope();

    await expect(getAssignment(scope, randomUUID())).rejects.toMatchObject({
      code: 'ASSIGNMENT_NOT_FOUND',
      statusCode: 404,
    });
  });
});

describe('autoAssignAmbulanceForReservedEmergency', () => {
  /**
   * Ambulances are hospital-owned, so "oldest AVAILABLE" is a local ordering this file
   * controls outright. The DRIVER POOL IS GLOBAL by design (DatabaseDesign.md sections 11
   * and 12.3), so every driver this file expects to be chosen is dated decades into the past:
   * that makes it the oldest eligible row in the whole database, which both makes selection
   * deterministic and guarantees this suite can never claim a driver owned by another suite.
   */
  const yearsAgo = (years: number): Date => new Date(Date.UTC(2000 - years, 0, 1, 0, 0, 0, 0));

  const createAgedAmbulance = async (
    hospitalId: string,
    minutesOld: number,
    status: AmbulanceStatus = AmbulanceStatus.AVAILABLE,
  ) =>
    prisma.ambulance.create({
      data: {
        hospitalId,
        vehicleNumber: `V-${randomUUID().slice(0, 10)}`,
        status,
        createdAt: new Date(Date.now() - minutesOld * 60_000),
      },
    });

  interface IneligibleDriverOptions {
    verificationStatus?: VerificationStatus;
    availabilityStatus?: DriverAvailability;
    userStatus?: UserStatus;
  }

  const createAgedDriver = async (createdAt: Date, options: IneligibleDriverOptions = {}) => {
    const user = await prisma.user.create({
      data: {
        phone: randomTestPhone(),
        passwordHash: 'not-used-in-this-fixture',
        role: UserRole.DRIVER,
        status: options.userStatus ?? UserStatus.ACTIVE,
        displayName: 'Fixture Driver',
        driverProfile: {
          create: {
            licenceNumber: `${TEST_LICENCE_PREFIX}${randomUUID().slice(0, 12)}`,
            verificationStatus: options.verificationStatus ?? VerificationStatus.VERIFIED,
            availabilityStatus: options.availabilityStatus ?? DriverAvailability.AVAILABLE,
            createdAt,
          },
        },
      },
      include: { driverProfile: true },
    });

    return user.driverProfile!;
  };

  it('selects the oldest available ambulance and the oldest eligible driver', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    const oldestAmbulance = await createAgedAmbulance(scope.hospitalId, 90);
    const newerAmbulance = await createAgedAmbulance(scope.hospitalId, 10);
    const oldestDriver = await createAgedDriver(yearsAgo(60));
    const newerDriver = await createAgedDriver(yearsAgo(50));

    const outcome = await autoAssignAmbulanceForReservedEmergency(
      scope,
      seed.emergency.id,
      actorUserId,
    );

    expect(outcome.assigned).toBe(true);
    expect(outcome.attempts).toBe(1);
    expect(outcome.reason).toBeUndefined();
    expect(outcome.assignment?.ambulanceId).toBe(oldestAmbulance.id);
    expect(outcome.assignment?.driverId).toBe(oldestDriver.id);
    expect(outcome.assignment?.status).toBe(AmbulanceAssignmentStatus.OFFERED);
    expect(outcome.assignment?.attemptNumber).toBe(1);
    expect(outcome.assignment?.hospitalResponseId).toBe(seed.response.id);
    expect(outcome.assignment?.emergencyId).toBe(seed.emergency.id);
    expect(outcome.assignment?.respondedAt).toBeNull();

    // Only the chosen pair is claimed.
    expect(
      (await prisma.ambulance.findUniqueOrThrow({ where: { id: oldestAmbulance.id } })).status,
    ).toBe(AmbulanceStatus.OFFERED);
    expect(
      (await prisma.ambulance.findUniqueOrThrow({ where: { id: newerAmbulance.id } })).status,
    ).toBe(AmbulanceStatus.AVAILABLE);
    expect(
      (await prisma.driverProfile.findUniqueOrThrow({ where: { id: oldestDriver.id } }))
        .availabilityStatus,
    ).toBe(DriverAvailability.BUSY);
    expect(
      (await prisma.driverProfile.findUniqueOrThrow({ where: { id: newerDriver.id } }))
        .availabilityStatus,
    ).toBe(DriverAvailability.AVAILABLE);

    const emergency = await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: seed.emergency.id },
    });
    expect(emergency.currentStatus).toBe(EmergencyStatus.PENDING_DRIVER_ACCEPTANCE);

    const history = await prisma.emergencyStatusHistory.findMany({
      where: { emergencyId: seed.emergency.id },
    });
    expect(history).toHaveLength(2);
    const assigned = history.find((entry) => entry.toStatus === EmergencyStatus.AMBULANCE_ASSIGNED);
    const pending = history.find(
      (entry) => entry.toStatus === EmergencyStatus.PENDING_DRIVER_ACCEPTANCE,
    );
    expect(assigned).toMatchObject({
      fromStatus: EmergencyStatus.BED_RESERVED,
      actorUserId,
      actorType: 'HOSPITAL_STAFF',
    });
    expect(pending).toMatchObject({
      fromStatus: EmergencyStatus.AMBULANCE_ASSIGNED,
      actorUserId,
      actorType: 'HOSPITAL_STAFF',
    });
    expect(pending!.occurredAt.getTime()).toBeGreaterThanOrEqual(assigned!.occurredAt.getTime());
  });

  it.each([
    AmbulanceStatus.OFFERED,
    AmbulanceStatus.ASSIGNED,
    AmbulanceStatus.EN_ROUTE,
    AmbulanceStatus.OUT_OF_SERVICE,
    AmbulanceStatus.INACTIVE,
  ])('skips an older %s ambulance in favour of an available one', async (ambulanceStatus) => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    // The ineligible vehicle is the oldest, so it would win if the status filter were missing.
    const ineligible = await createAgedAmbulance(scope.hospitalId, 90, ambulanceStatus);
    const available = await createAgedAmbulance(scope.hospitalId, 10);
    await createAgedDriver(yearsAgo(60));

    const outcome = await autoAssignAmbulanceForReservedEmergency(
      scope,
      seed.emergency.id,
      actorUserId,
    );

    expect(outcome.assigned).toBe(true);
    expect(outcome.assignment?.ambulanceId).toBe(available.id);
    expect(
      (await prisma.ambulance.findUniqueOrThrow({ where: { id: ineligible.id } })).status,
    ).toBe(ambulanceStatus);
  });

  it('never selects an ambulance belonging to another hospital', async () => {
    const scope = await createScope();
    const foreign = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    // The other hospital's vehicle is far older, so only ownership can keep it out.
    const foreignAmbulance = await createAgedAmbulance(foreign.hospitalId, 5_000);
    const ownAmbulance = await createAgedAmbulance(scope.hospitalId, 10);
    await createAgedDriver(yearsAgo(60));

    const outcome = await autoAssignAmbulanceForReservedEmergency(
      scope,
      seed.emergency.id,
      actorUserId,
    );

    expect(outcome.assigned).toBe(true);
    expect(outcome.assignment?.ambulanceId).toBe(ownAmbulance.id);
    expect(
      (await prisma.ambulance.findUniqueOrThrow({ where: { id: foreignAmbulance.id } })).status,
    ).toBe(AmbulanceStatus.AVAILABLE);
  });

  const ineligibleDriverCases: Array<[string, IneligibleDriverOptions]> = [
    ['unverified', { verificationStatus: VerificationStatus.PENDING }],
    ['rejected', { verificationStatus: VerificationStatus.REJECTED }],
    ['offline', { availabilityStatus: DriverAvailability.OFFLINE }],
    ['busy', { availabilityStatus: DriverAvailability.BUSY }],
    ['on break', { availabilityStatus: DriverAvailability.ON_BREAK }],
    ['suspended-profile', { availabilityStatus: DriverAvailability.SUSPENDED }],
    ['suspended-account', { userStatus: UserStatus.SUSPENDED }],
    ['deactivated-account', { userStatus: UserStatus.DEACTIVATED }],
    ['pending-account', { userStatus: UserStatus.PENDING }],
  ];

  it.each(ineligibleDriverCases)(
    'skips an older %s driver in favour of an eligible one',
    async (_label, driverOptions) => {
      const scope = await createScope();
      const actorUserId = await createActor();
      const seed = await seedReservedEmergency({ hospitalId: scope.hospitalId });
      await createAgedAmbulance(scope.hospitalId, 10);
      // The ineligible driver is older, so it would win if the eligibility filter were missing.
      const ineligible = await createAgedDriver(yearsAgo(80), driverOptions);
      const eligible = await createAgedDriver(yearsAgo(60));

      const outcome = await autoAssignAmbulanceForReservedEmergency(
        scope,
        seed.emergency.id,
        actorUserId,
      );

      expect(outcome.assigned).toBe(true);
      expect(outcome.assignment?.driverId).toBe(eligible.id);
      const untouched = await prisma.driverProfile.findUniqueOrThrow({
        where: { id: ineligible.id },
      });
      expect(untouched.availabilityStatus).toBe(
        driverOptions.availabilityStatus ?? DriverAvailability.AVAILABLE,
      );
    },
  );

  it('reports NO_AVAILABLE_AMBULANCE without claiming a driver', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    const driver = await createAgedDriver(yearsAgo(60));

    const outcome = await autoAssignAmbulanceForReservedEmergency(
      scope,
      seed.emergency.id,
      actorUserId,
    );

    expect(outcome).toMatchObject({
      assigned: false,
      assignment: null,
      reason: 'NO_AVAILABLE_AMBULANCE',
      attempts: 0,
    });

    // Finding no vehicle is a normal outcome: nothing moves and nothing is recorded as failed.
    expect(
      (await prisma.driverProfile.findUniqueOrThrow({ where: { id: driver.id } }))
        .availabilityStatus,
    ).toBe(DriverAvailability.AVAILABLE);
    expect(
      (await prisma.emergencyRequest.findUniqueOrThrow({ where: { id: seed.emergency.id } }))
        .currentStatus,
    ).toBe(EmergencyStatus.BED_RESERVED);
    expect(
      await prisma.ambulanceAssignment.count({ where: { emergencyId: seed.emergency.id } }),
    ).toBe(0);
    expect(
      await prisma.emergencyStatusHistory.count({ where: { emergencyId: seed.emergency.id } }),
    ).toBe(0);
  });

  it('reports NO_AVAILABLE_AMBULANCE when every vehicle is busy or out of service', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({ hospitalId: scope.hospitalId });
    await createAgedAmbulance(scope.hospitalId, 90, AmbulanceStatus.ASSIGNED);
    await createAgedAmbulance(scope.hospitalId, 60, AmbulanceStatus.OUT_OF_SERVICE);
    await createAgedDriver(yearsAgo(60));

    const outcome = await autoAssignAmbulanceForReservedEmergency(
      scope,
      seed.emergency.id,
      actorUserId,
    );

    expect(outcome.assigned).toBe(false);
    expect(outcome.reason).toBe('NO_AVAILABLE_AMBULANCE');
  });

  it('propagates a status conflict and releases both resources when the emergency has moved on', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    // The emergency never reached BED_RESERVED, so createAssignment's transition must fail.
    const seed = await seedReservedEmergency({
      hospitalId: scope.hospitalId,
      emergencyStatus: EmergencyStatus.HOSPITAL_ACCEPTED,
    });
    const ambulance = await createAgedAmbulance(scope.hospitalId, 10);
    const driver = await createAgedDriver(yearsAgo(60));

    await expect(
      autoAssignAmbulanceForReservedEmergency(scope, seed.emergency.id, actorUserId),
    ).rejects.toMatchObject({ code: 'EMERGENCY_STATUS_CONFLICT' });

    // Not contention, so it is never retried; the rolled-back transaction released both claims.
    expect((await prisma.ambulance.findUniqueOrThrow({ where: { id: ambulance.id } })).status).toBe(
      AmbulanceStatus.AVAILABLE,
    );
    expect(
      (await prisma.driverProfile.findUniqueOrThrow({ where: { id: driver.id } }))
        .availabilityStatus,
    ).toBe(DriverAvailability.AVAILABLE);
    expect(
      await prisma.ambulanceAssignment.count({ where: { emergencyId: seed.emergency.id } }),
    ).toBe(0);
    expect(
      (await prisma.emergencyRequest.findUniqueOrThrow({ where: { id: seed.emergency.id } }))
        .currentStatus,
    ).toBe(EmergencyStatus.HOSPITAL_ACCEPTED);
  });

  it('propagates a missing accepted response instead of trying another pair', async () => {
    const scope = await createScope();
    const other = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency({ hospitalId: other.hospitalId });
    const ambulance = await createAgedAmbulance(scope.hospitalId, 10);
    await createAgedDriver(yearsAgo(60));

    await expect(
      autoAssignAmbulanceForReservedEmergency(scope, seed.emergency.id, actorUserId),
    ).rejects.toMatchObject({ code: 'EMERGENCY_NOT_FOUND' });

    expect((await prisma.ambulance.findUniqueOrThrow({ where: { id: ambulance.id } })).status).toBe(
      AmbulanceStatus.AVAILABLE,
    );
  });

  it.each([1, 2, 3])(
    'run %i: concurrent dispatches retry past contention without double-booking',
    async () => {
      const scope = await createScope();
      const actorUserId = await createActor();
      const seedOne = await seedReservedEmergency({ hospitalId: scope.hospitalId });
      const seedTwo = await seedReservedEmergency({ hospitalId: scope.hospitalId });
      // Two of each, so a caller that loses the oldest pair has somewhere to retry to.
      const ambulances = [
        await createAgedAmbulance(scope.hospitalId, 90),
        await createAgedAmbulance(scope.hospitalId, 60),
      ];
      const drivers = [await createAgedDriver(yearsAgo(70)), await createAgedDriver(yearsAgo(65))];
      const ambulanceIds = ambulances.map((ambulance) => ambulance.id);
      const driverIds = drivers.map((driver) => driver.id);

      const outcomes = await Promise.all([
        autoAssignAmbulanceForReservedEmergency(scope, seedOne.emergency.id, actorUserId),
        autoAssignAmbulanceForReservedEmergency(scope, seedTwo.emergency.id, actorUserId),
      ]);

      // Asserted on the observed outcome rather than a predicted one: how many callers win
      // depends on interleaving, but these invariants hold for every interleaving.
      const winners = outcomes.filter((outcome) => outcome.assigned);
      const heldAmbulanceIds = winners.map((outcome) => outcome.assignment!.ambulanceId);
      const heldDriverIds = winners.map((outcome) => outcome.assignment!.driverId);

      expect(new Set(heldAmbulanceIds).size).toBe(heldAmbulanceIds.length);
      expect(new Set(heldDriverIds).size).toBe(heldDriverIds.length);
      heldAmbulanceIds.forEach((id) => expect(ambulanceIds).toContain(id));
      // Ancient fixtures make this suite's own drivers the only ones reachable here.
      heldDriverIds.forEach((id) => expect(driverIds).toContain(id));
      winners.forEach((outcome) => {
        expect(outcome.attempts).toBeGreaterThanOrEqual(1);
        expect(outcome.attempts).toBeLessThanOrEqual(3);
        expect(outcome.reason).toBeUndefined();
      });
      outcomes
        .filter((outcome) => !outcome.assigned)
        .forEach((outcome) => {
          expect(outcome.assignment).toBeNull();
          expect([
            'NO_AVAILABLE_AMBULANCE',
            'NO_AVAILABLE_DRIVER',
            'CONTENTION_EXHAUSTED',
          ]).toContain(outcome.reason);
        });

      // The database agrees with what the callers were told.
      expect(
        await prisma.ambulanceAssignment.count({
          where: {
            emergencyId: { in: [seedOne.emergency.id, seedTwo.emergency.id] },
            status: AmbulanceAssignmentStatus.OFFERED,
          },
        }),
      ).toBe(winners.length);
      expect(
        await prisma.ambulance.count({
          where: { id: { in: ambulanceIds }, status: AmbulanceStatus.OFFERED },
        }),
      ).toBe(winners.length);
      expect(
        await prisma.driverProfile.count({
          where: { id: { in: driverIds }, availabilityStatus: DriverAvailability.BUSY },
        }),
      ).toBe(winners.length);
      expect(
        await prisma.emergencyRequest.count({
          where: {
            id: { in: [seedOne.emergency.id, seedTwo.emergency.id] },
            currentStatus: EmergencyStatus.PENDING_DRIVER_ACCEPTANCE,
          },
        }),
      ).toBe(winners.length);
    },
  );
});
