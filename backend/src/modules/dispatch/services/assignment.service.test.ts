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
import { createAssignment, getAssignment, listAssignments } from './assignment.service.js';

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
  await prisma.driverProfile.deleteMany({
    where: { licenceNumber: { startsWith: TEST_LICENCE_PREFIX } },
  });

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
