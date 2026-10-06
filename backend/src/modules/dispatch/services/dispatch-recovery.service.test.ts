import { randomUUID } from 'node:crypto';
import {
  AmbulanceAssignmentStatus,
  AmbulanceStatus,
  BedReservationStatus,
  BedStatus,
  DriverAvailability,
  EmergencyStatus,
  HospitalResponseStatus,
  HospitalStaffRole,
  HospitalStatus,
  MembershipStatus,
  TransitionActorType,
  UserRole,
  UserStatus,
  VerificationStatus,
} from '@prisma/client';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../../config/env.js';
import { prisma } from '../../../database/prisma.js';
import type { HospitalStaffContext } from '../../hospitals/types/hospital.types.js';
import {
  admitEmergency,
  completeEmergency,
  releaseReservation,
} from '../../hospitals/services/bed-reservation.service.js';
import { createAssignment, MAX_DISPATCH_ATTEMPTS } from './assignment.service.js';
import {
  acceptOwnAssignment,
  failOwnAssignment,
  rejectOwnAssignment,
  transitionOwnAssignment,
} from './driver-assignment.service.js';
import { recoverEmergencyDispatch } from './dispatch-recovery.service.js';
import {
  expireStaleAssignment,
  startDispatchTimeoutSweep,
  sweepStaleAssignments,
} from './dispatch-timeout.service.js';

const TEST_REG_PREFIX = 'T1624-';
const TEST_PHONE_PREFIX = '+1624';
const TEST_LICENCE_PREFIX = 'L1624-';

const randomRegistration = (): string => `${TEST_REG_PREFIX}${randomUUID().slice(0, 12)}`;
const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

/**
 * The DRIVER POOL IS GLOBAL by design (DatabaseDesign.md sections 11 and 12.3), and automatic
 * re-dispatch selects the oldest eligible driver. Every driver this file expects recovery to choose
 * is therefore dated well before any other suite's fixture driver (those use 1920 onwards), which
 * makes selection deterministic. Drivers left AVAILABLE are parked OFFLINE after every test so they
 * cannot be picked by another suite's dispatch.
 */
const ancient = (offset: number): Date => new Date(Date.UTC(1890 - offset, 0, 1));

const createScope = async (): Promise<HospitalStaffContext> => {
  const hospital = await prisma.hospital.create({
    data: {
      name: 'Dispatch Recovery Hospital',
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

/** createdAt is explicit so "the oldest AVAILABLE ambulance" is a fact of the fixture. */
const createAmbulance = async (hospitalId: string, minutesOld = 0) =>
  prisma.ambulance.create({
    data: {
      hospitalId,
      vehicleNumber: `V-${randomUUID().slice(0, 10)}`,
      createdAt: new Date(Date.now() - minutesOld * 60_000),
    },
  });

const createDriverUser = async (createdAt?: Date) => {
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
          ...(createdAt ? { createdAt } : {}),
        },
      },
    },
    include: { driverProfile: true },
  });

  return { userId: user.id, profile: user.driverProfile! };
};

/**
 * An emergency exactly as Task 1.20 leaves it: BED_RESERVED, with this hospital's ACCEPTED
 * response and an active reservation holding a RESERVED bed.
 */
const seedReservedEmergency = async (scope: HospitalStaffContext, withReservation = true) => {
  const patientUser = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      passwordHash: 'not-used-in-this-fixture',
      role: UserRole.PATIENT,
      status: UserStatus.ACTIVE,
      displayName: 'Fixture Patient',
      patientProfile: { create: {} },
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
      hospitalId: scope.hospitalId,
      status: HospitalResponseStatus.ACCEPTED,
    },
  });

  if (!withReservation) {
    return { emergency, response, bed: null, reservation: null };
  }

  const bed = await prisma.bed.create({
    data: {
      hospitalId: scope.hospitalId,
      bedCode: `B-${randomUUID().slice(0, 8)}`,
      status: BedStatus.RESERVED,
    },
  });

  const reservation = await prisma.bedReservation.create({
    data: {
      emergencyId: emergency.id,
      hospitalResponseId: response.id,
      bedId: bed.id,
      status: BedReservationStatus.RESERVED,
    },
  });

  return { emergency, response, bed, reservation };
};

interface ScenarioOptions {
  /** Unused ambulances the accepting hospital owns besides the first one. */
  spareAmbulances?: number;
  /** Ancient drivers available for automatic re-dispatch, oldest first. */
  spareDrivers?: number;
  withReservation?: boolean;
  /** Date the first driver so recovery would prefer them if they were not excluded. */
  ancientFirstDriver?: boolean;
}

/**
 * A reserved emergency dispatched once (attempt 1, explicitly chosen resources), plus the spare
 * resources a recovery may use. The first ambulance is the oldest, so recovery would pick it again
 * if exclusion did not work.
 */
const seedFirstAttempt = async (options: ScenarioOptions = {}) => {
  const scope = await createScope();
  const actorUserId = await createActor();
  const seed = await seedReservedEmergency(scope, options.withReservation ?? true);
  const firstAmbulance = await createAmbulance(scope.hospitalId, 120);
  const firstDriver = await createDriverUser(options.ancientFirstDriver ? ancient(50) : undefined);

  const spareAmbulances = [];
  for (let index = 0; index < (options.spareAmbulances ?? 0); index += 1) {
    spareAmbulances.push(await createAmbulance(scope.hospitalId, 60 - index));
  }

  const spareDrivers = [];
  for (let index = 0; index < (options.spareDrivers ?? 0); index += 1) {
    spareDrivers.push(await createDriverUser(ancient(10 - index)));
  }

  const assignment = await createAssignment(
    scope,
    seed.emergency.id,
    { ambulanceId: firstAmbulance.id, driverId: firstDriver.profile.id },
    actorUserId,
  );

  return {
    scope,
    actorUserId,
    seed,
    firstAmbulance,
    firstDriver,
    spareAmbulances,
    spareDrivers,
    assignment,
  };
};

type Scenario = Awaited<ReturnType<typeof seedFirstAttempt>>;

const walkTo = async (
  scenario: Scenario,
  through: 'START' | 'ARRIVE_PICKUP' | 'START_TRANSPORT',
): Promise<void> => {
  await acceptOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id);
  for (const step of ['START', 'ARRIVE_PICKUP', 'START_TRANSPORT'] as const) {
    await transitionOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id, step);
    if (step === through) break;
  }
};

const readEmergency = (emergencyId: string) =>
  prisma.emergencyRequest.findUniqueOrThrow({ where: { id: emergencyId } });

const readAttempts = (emergencyId: string) =>
  prisma.ambulanceAssignment.findMany({
    where: { emergencyId },
    orderBy: { attemptNumber: 'asc' },
  });

const readHistory = (emergencyId: string) =>
  prisma.emergencyStatusHistory.findMany({ where: { emergencyId } });

const LIVE = [
  AmbulanceAssignmentStatus.OFFERED,
  AmbulanceAssignmentStatus.ACCEPTED,
  AmbulanceAssignmentStatus.EN_ROUTE,
  AmbulanceAssignmentStatus.AT_PICKUP,
  AmbulanceAssignmentStatus.TRANSPORTING,
] as const;

/** Moves an assignment's offer time into the past so a timeout applies to it. */
const backdate = async (assignmentId: string, secondsAgo: number): Promise<void> => {
  await prisma.ambulanceAssignment.update({
    where: { id: assignmentId },
    data: { assignedAt: new Date(Date.now() - secondsAgo * 1000) },
  });
};

/** Asserts the hospital acceptance and the bed hold are exactly as Task 1.20 left them. */
const expectCapacityHeld = async (scenario: Scenario): Promise<void> => {
  const reservation = await prisma.bedReservation.findUniqueOrThrow({
    where: { id: scenario.seed.reservation!.id },
  });
  expect(reservation.status).toBe(BedReservationStatus.RESERVED);
  expect(reservation.releasedAt).toBeNull();
  expect(
    (await prisma.bed.findUniqueOrThrow({ where: { id: scenario.seed.bed!.id } })).status,
  ).toBe(BedStatus.RESERVED);
  expect(
    (await prisma.hospitalResponse.findUniqueOrThrow({ where: { id: scenario.seed.response.id } }))
      .status,
  ).toBe(HospitalResponseStatus.ACCEPTED);
};

afterEach(async () => {
  vi.useRealTimers();
  // Park this file's drivers so none of them stays selectable by another suite's dispatch.
  await prisma.driverProfile.updateMany({
    where: {
      licenceNumber: { startsWith: TEST_LICENCE_PREFIX },
      availabilityStatus: DriverAvailability.AVAILABLE,
    },
    data: { availabilityStatus: DriverAvailability.OFFLINE },
  });
});

afterAll(async () => {
  // Fixtures are resolved from this file's own prefixes only (same ownership rules as the
  // Task 1.16-1.23 suites: other suites' emergencies are never deleted from here).
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

  await prisma.emergencyStatusHistory.deleteMany({ where: { actorUserId: { in: userIds } } });
  await prisma.notification.deleteMany({ where: { recipientUserId: { in: userIds } } });
  await prisma.patientProfile.deleteMany({ where: { id: { in: profileIds } } });

  await prisma.ambulanceAssignment.deleteMany({ where: { driverId: { in: ownDriverIds } } });
  await prisma.ambulanceAssignment.deleteMany({ where: { ambulanceId: { in: ownAmbulanceIds } } });
  await prisma.driverProfile.deleteMany({ where: { id: { in: ownDriverIds } } });

  await prisma.bed.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.ambulance.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospitalStaffMembership.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });
});

describe('recovery after a driver rejection', () => {
  it('re-dispatches as attempt 2 and keeps the hospital acceptance and the bed', async () => {
    const scenario = await seedFirstAttempt({ spareAmbulances: 1, spareDrivers: 1 });

    const rejected = await rejectOwnAssignment(
      scenario.firstDriver.userId,
      scenario.assignment.id,
      'Vehicle fault',
    );
    expect(rejected.status).toBe(AmbulanceAssignmentStatus.REJECTED);

    const attempts = await readAttempts(scenario.seed.emergency.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.status).toBe(AmbulanceAssignmentStatus.REJECTED);
    expect(attempts[0]!.rejectionReason).toBe('Vehicle fault');
    expect(attempts[1]!.attemptNumber).toBe(2);
    expect(attempts[1]!.status).toBe(AmbulanceAssignmentStatus.OFFERED);
    expect(attempts[1]!.ambulanceId).toBe(scenario.spareAmbulances[0]!.id);
    expect(attempts[1]!.driverId).toBe(scenario.spareDrivers[0]!.profile.id);
    expect(attempts[1]!.hospitalResponseId).toBe(scenario.seed.response.id);

    expect((await readEmergency(scenario.seed.emergency.id)).currentStatus).toBe(
      EmergencyStatus.PENDING_DRIVER_ACCEPTANCE,
    );
    expect(
      (await prisma.ambulance.findUniqueOrThrow({ where: { id: scenario.spareAmbulances[0]!.id } }))
        .status,
    ).toBe(AmbulanceStatus.OFFERED);
    expect(
      (
        await prisma.driverProfile.findUniqueOrThrow({
          where: { id: scenario.spareDrivers[0]!.profile.id },
        })
      ).availabilityStatus,
    ).toBe(DriverAvailability.BUSY);
    await expectCapacityHeld(scenario);
  });

  it('never re-selects an ambulance or driver the emergency already used', async () => {
    // The first ambulance is the hospital's oldest and the first driver is older than the spare,
    // so oldest-first selection would pick both again if they were not excluded.
    const scenario = await seedFirstAttempt({
      spareAmbulances: 1,
      spareDrivers: 1,
      ancientFirstDriver: true,
    });

    await rejectOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id, 'No fuel');

    expect(
      (await prisma.ambulance.findUniqueOrThrow({ where: { id: scenario.firstAmbulance.id } }))
        .status,
    ).toBe(AmbulanceStatus.AVAILABLE);
    expect(
      (
        await prisma.driverProfile.findUniqueOrThrow({
          where: { id: scenario.firstDriver.profile.id },
        })
      ).availabilityStatus,
    ).toBe(DriverAvailability.AVAILABLE);

    const attempts = await readAttempts(scenario.seed.emergency.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[1]!.ambulanceId).not.toBe(scenario.firstAmbulance.id);
    expect(attempts[1]!.driverId).not.toBe(scenario.firstDriver.profile.id);
    expect(attempts[1]!.ambulanceId).toBe(scenario.spareAmbulances[0]!.id);
    expect(attempts[1]!.driverId).toBe(scenario.spareDrivers[0]!.profile.id);
  });

  it('records every recovery transition as SYSTEM with no actor user', async () => {
    const scenario = await seedFirstAttempt({ spareAmbulances: 1, spareDrivers: 1 });

    await rejectOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id, 'Vehicle fault');

    const history = await readHistory(scenario.seed.emergency.id);
    const pairs = (from: EmergencyStatus, to: EmergencyStatus) =>
      history.filter((row) => row.fromStatus === from && row.toStatus === to);

    // Attempt 1 was a staff dispatch; attempt 2 was the system's.
    const staffDispatch = pairs(EmergencyStatus.BED_RESERVED, EmergencyStatus.AMBULANCE_ASSIGNED);
    expect(staffDispatch).toHaveLength(2);
    expect(staffDispatch.map((row) => row.actorType).sort()).toEqual(
      [TransitionActorType.HOSPITAL_STAFF, TransitionActorType.SYSTEM].sort(),
    );

    const systemRows = history.filter((row) => row.actorType === TransitionActorType.SYSTEM);
    expect(systemRows.map((row) => [row.fromStatus, row.toStatus]).sort()).toEqual(
      [
        [EmergencyStatus.PENDING_DRIVER_ACCEPTANCE, EmergencyStatus.BED_RESERVED],
        [EmergencyStatus.BED_RESERVED, EmergencyStatus.AMBULANCE_ASSIGNED],
        [EmergencyStatus.AMBULANCE_ASSIGNED, EmergencyStatus.PENDING_DRIVER_ACCEPTANCE],
      ].sort(),
    );
    expect(systemRows.every((row) => row.actorUserId === null)).toBe(true);

    const recoveryRow = pairs(
      EmergencyStatus.PENDING_DRIVER_ACCEPTANCE,
      EmergencyStatus.BED_RESERVED,
    );
    expect(recoveryRow).toHaveLength(1);
    expect(recoveryRow[0]!.reason).toContain('attempt 1');
    expect(recoveryRow[0]!.reason).toContain('rejected');
    // The driver's free-text reason never reaches the emergency history.
    expect(recoveryRow[0]!.reason).not.toContain('Vehicle fault');
  });
});

describe('recovery after a trip failure', () => {
  it.each([
    ['EN_ROUTE', 'START' as const, EmergencyStatus.DRIVER_EN_ROUTE],
    ['AT_PICKUP', 'ARRIVE_PICKUP' as const, EmergencyStatus.AT_PICKUP],
    ['TRANSPORTING', 'START_TRANSPORT' as const, EmergencyStatus.TRANSPORTING],
  ])('a failure from %s re-dispatches as attempt 2', async (_label, through, failedFromStatus) => {
    const scenario = await seedFirstAttempt({ spareAmbulances: 1, spareDrivers: 1 });
    await walkTo(scenario, through);

    const failed = await failOwnAssignment(
      scenario.firstDriver.userId,
      scenario.assignment.id,
      'Vehicle broke down.',
    );
    expect(failed.status).toBe(AmbulanceAssignmentStatus.FAILED);

    const attempts = await readAttempts(scenario.seed.emergency.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.status).toBe(AmbulanceAssignmentStatus.FAILED);
    expect(attempts[1]!.attemptNumber).toBe(2);
    expect(attempts[1]!.status).toBe(AmbulanceAssignmentStatus.OFFERED);
    expect(attempts[1]!.ambulanceId).toBe(scenario.spareAmbulances[0]!.id);
    expect(attempts[1]!.driverId).toBe(scenario.spareDrivers[0]!.profile.id);

    expect((await readEmergency(scenario.seed.emergency.id)).currentStatus).toBe(
      EmergencyStatus.PENDING_DRIVER_ACCEPTANCE,
    );

    const recoveryRows = (await readHistory(scenario.seed.emergency.id)).filter(
      (row) => row.fromStatus === failedFromStatus && row.toStatus === EmergencyStatus.BED_RESERVED,
    );
    expect(recoveryRows).toHaveLength(1);
    expect(recoveryRows[0]!.actorType).toBe(TransitionActorType.SYSTEM);
    expect(recoveryRows[0]!.actorUserId).toBeNull();

    // The failed vehicle and driver are back in their pools; the bed was never released.
    expect(
      (await prisma.ambulance.findUniqueOrThrow({ where: { id: scenario.firstAmbulance.id } }))
        .status,
    ).toBe(AmbulanceStatus.AVAILABLE);
    await expectCapacityHeld(scenario);
  });
});

describe('no unused ambulance or driver', () => {
  it('leaves the emergency at BED_RESERVED without escalating, and manual dispatch still works', async () => {
    const scenario = await seedFirstAttempt();

    await rejectOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id, 'Vehicle fault');

    const emergency = await readEmergency(scenario.seed.emergency.id);
    expect(emergency.currentStatus).toBe(EmergencyStatus.BED_RESERVED);
    expect(await readAttempts(scenario.seed.emergency.id)).toHaveLength(1);
    await expectCapacityHeld(scenario);
    expect(
      (await readHistory(scenario.seed.emergency.id)).some(
        (row) => row.toStatus === EmergencyStatus.ESCALATED,
      ),
    ).toBe(false);

    // The hospital's manual dispatch is the recovery path, and may reuse released resources.
    const otherDriver = await createDriverUser();
    const manual = await createAssignment(
      scenario.scope,
      scenario.seed.emergency.id,
      { ambulanceId: scenario.firstAmbulance.id, driverId: otherDriver.profile.id },
      scenario.actorUserId,
    );
    expect(manual.attemptNumber).toBe(2);
    expect(manual.emergency.currentStatus).toBe(EmergencyStatus.PENDING_DRIVER_ACCEPTANCE);
  });

  it('reports the outcome when recovery is invoked directly', async () => {
    const scenario = await seedFirstAttempt();
    await prisma.ambulanceAssignment.update({
      where: { id: scenario.assignment.id },
      data: { status: AmbulanceAssignmentStatus.REJECTED },
    });
    await prisma.ambulance.update({
      where: { id: scenario.firstAmbulance.id },
      data: { status: AmbulanceStatus.AVAILABLE },
    });

    const result = await recoverEmergencyDispatch(scenario.seed.emergency.id, 'DRIVER_REJECTED');

    expect(result.outcome).toBe('NO_AVAILABLE_RESOURCES');
    expect(result.dispatchReason).toBe('NO_AVAILABLE_AMBULANCE');
    expect(result.attemptsUsed).toBe(1);
  });
});

describe('attempt limit', () => {
  it(`escalates after ${MAX_DISPATCH_ATTEMPTS} attempts and keeps the reservation`, async () => {
    const scenario = await seedFirstAttempt({ spareAmbulances: 2, spareDrivers: 2 });

    await rejectOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id, 'One');
    let attempts = await readAttempts(scenario.seed.emergency.id);
    expect(attempts).toHaveLength(2);
    await rejectOwnAssignment(scenario.spareDrivers[0]!.userId, attempts[1]!.id, 'Two');
    attempts = await readAttempts(scenario.seed.emergency.id);
    expect(attempts).toHaveLength(3);
    expect(attempts[2]!.ambulanceId).toBe(scenario.spareAmbulances[1]!.id);
    expect(attempts[2]!.driverId).toBe(scenario.spareDrivers[1]!.profile.id);

    await rejectOwnAssignment(scenario.spareDrivers[1]!.userId, attempts[2]!.id, 'Three');

    attempts = await readAttempts(scenario.seed.emergency.id);
    expect(attempts).toHaveLength(MAX_DISPATCH_ATTEMPTS);
    expect(attempts.every((attempt) => attempt.status === AmbulanceAssignmentStatus.REJECTED)).toBe(
      true,
    );
    expect((await readEmergency(scenario.seed.emergency.id)).currentStatus).toBe(
      EmergencyStatus.ESCALATED,
    );
    await expectCapacityHeld(scenario);

    const escalation = (await readHistory(scenario.seed.emergency.id)).filter(
      (row) => row.toStatus === EmergencyStatus.ESCALATED,
    );
    expect(escalation).toHaveLength(1);
    expect(escalation[0]!.fromStatus).toBe(EmergencyStatus.BED_RESERVED);
    expect(escalation[0]!.actorType).toBe(TransitionActorType.SYSTEM);
    expect(escalation[0]!.actorUserId).toBeNull();

    // Every vehicle is back in service.
    const ambulances = await prisma.ambulance.findMany({
      where: { hospitalId: scenario.scope.hospitalId },
    });
    expect(ambulances.every((ambulance) => ambulance.status === AmbulanceStatus.AVAILABLE)).toBe(
      true,
    );

    // An escalated emergency is out of the automatic loop: recovery is a no-op, and a manual
    // dispatch is refused by the attempt cap before it could even reach the status check.
    expect(
      (await recoverEmergencyDispatch(scenario.seed.emergency.id, 'DRIVER_REJECTED')).outcome,
    ).toBe('NOT_RECOVERABLE');
    const lateDriver = await createDriverUser();
    await expect(
      createAssignment(
        scenario.scope,
        scenario.seed.emergency.id,
        { ambulanceId: scenario.firstAmbulance.id, driverId: lateDriver.profile.id },
        scenario.actorUserId,
      ),
    ).rejects.toMatchObject({ code: 'DISPATCH_ATTEMPTS_EXHAUSTED', statusCode: 409 });
    expect(
      (await prisma.ambulance.findUniqueOrThrow({ where: { id: scenario.firstAmbulance.id } }))
        .status,
    ).toBe(AmbulanceStatus.AVAILABLE);
  });

  it('createAssignment refuses a fourth row and releases what it claimed', async () => {
    const scope = await createScope();
    const actorUserId = await createActor();
    const seed = await seedReservedEmergency(scope);
    const usedAmbulance = await createAmbulance(scope.hospitalId);
    const usedDriver = await createDriverUser();

    for (let attemptNumber = 1; attemptNumber <= MAX_DISPATCH_ATTEMPTS; attemptNumber += 1) {
      await prisma.ambulanceAssignment.create({
        data: {
          emergencyId: seed.emergency.id,
          hospitalResponseId: seed.response.id,
          ambulanceId: usedAmbulance.id,
          driverId: usedDriver.profile.id,
          attemptNumber,
          status: AmbulanceAssignmentStatus.REJECTED,
        },
      });
    }

    const ambulance = await createAmbulance(scope.hospitalId);
    const driver = await createDriverUser();

    await expect(
      createAssignment(
        scope,
        seed.emergency.id,
        { ambulanceId: ambulance.id, driverId: driver.profile.id },
        actorUserId,
      ),
    ).rejects.toMatchObject({ code: 'DISPATCH_ATTEMPTS_EXHAUSTED', statusCode: 409 });

    expect((await prisma.ambulance.findUniqueOrThrow({ where: { id: ambulance.id } })).status).toBe(
      AmbulanceStatus.AVAILABLE,
    );
    expect(
      (await prisma.driverProfile.findUniqueOrThrow({ where: { id: driver.profile.id } }))
        .availabilityStatus,
    ).toBe(DriverAvailability.AVAILABLE);
    expect((await readEmergency(seed.emergency.id)).currentStatus).toBe(
      EmergencyStatus.BED_RESERVED,
    );
  });
});

describe('missing reservation', () => {
  it('stops safely after a rejection when the emergency holds no reservation', async () => {
    const scenario = await seedFirstAttempt({ withReservation: false });
    const historyBefore = (await readHistory(scenario.seed.emergency.id)).length;

    await rejectOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id, 'Vehicle fault');

    expect((await readEmergency(scenario.seed.emergency.id)).currentStatus).toBe(
      EmergencyStatus.PENDING_DRIVER_ACCEPTANCE,
    );
    expect(await readAttempts(scenario.seed.emergency.id)).toHaveLength(1);
    expect((await readHistory(scenario.seed.emergency.id)).length).toBe(historyBefore);

    expect(
      (await recoverEmergencyDispatch(scenario.seed.emergency.id, 'DRIVER_REJECTED')).outcome,
    ).toBe('RESERVATION_MISSING');
  });

  it('stops safely after a failure when the reservation was released mid-trip', async () => {
    const scenario = await seedFirstAttempt({ spareAmbulances: 1, spareDrivers: 1 });
    await walkTo(scenario, 'START');
    // The pre-existing hazard (not fixed by 1.24): a hospital may release the bed mid-trip.
    await releaseReservation(
      scenario.scope,
      scenario.seed.reservation!.id,
      scenario.actorUserId,
      'Bed needed elsewhere',
    );

    await failOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id, 'Breakdown.');

    expect((await readEmergency(scenario.seed.emergency.id)).currentStatus).toBe(
      EmergencyStatus.DRIVER_EN_ROUTE,
    );
    expect(await readAttempts(scenario.seed.emergency.id)).toHaveLength(1);
    // The spare resources were never claimed.
    expect(
      (await prisma.ambulance.findUniqueOrThrow({ where: { id: scenario.spareAmbulances[0]!.id } }))
        .status,
    ).toBe(AmbulanceStatus.AVAILABLE);
  });
});

describe('idempotency and races', () => {
  /** Ends attempt 1 as a committed rejection without running recovery, as if recovery crashed. */
  const rejectWithoutRecovery = async (scenario: Scenario): Promise<void> => {
    await prisma.$transaction([
      prisma.ambulanceAssignment.update({
        where: { id: scenario.assignment.id },
        data: { status: AmbulanceAssignmentStatus.REJECTED, rejectionReason: 'Fixture' },
      }),
      prisma.ambulance.update({
        where: { id: scenario.firstAmbulance.id },
        data: { status: AmbulanceStatus.AVAILABLE },
      }),
      prisma.driverProfile.update({
        where: { id: scenario.firstDriver.profile.id },
        data: { availabilityStatus: DriverAvailability.AVAILABLE },
      }),
    ]);
  };

  /** Exactly one replacement attempt, exactly one recovery transition, consistent state. */
  const expectSingleReplacement = async (scenario: Scenario): Promise<void> => {
    const attempts = await readAttempts(scenario.seed.emergency.id);
    expect(attempts).toHaveLength(2);
    expect(attempts.filter((attempt) => LIVE.includes(attempt.status as never))).toHaveLength(1);
    expect(attempts[1]!.status).toBe(AmbulanceAssignmentStatus.OFFERED);
    expect((await readEmergency(scenario.seed.emergency.id)).currentStatus).toBe(
      EmergencyStatus.PENDING_DRIVER_ACCEPTANCE,
    );
    const backToReserved = (await readHistory(scenario.seed.emergency.id)).filter(
      (row) =>
        row.toStatus === EmergencyStatus.BED_RESERVED &&
        row.actorType === TransitionActorType.SYSTEM,
    );
    expect(backToReserved).toHaveLength(1);
    await expectCapacityHeld(scenario);
  };

  it.each([1, 2, 3])('run %i: two concurrent recoveries create one replacement', async () => {
    const scenario = await seedFirstAttempt({ spareAmbulances: 2, spareDrivers: 2 });
    await rejectWithoutRecovery(scenario);

    const results = await Promise.all([
      recoverEmergencyDispatch(scenario.seed.emergency.id, 'DRIVER_REJECTED'),
      recoverEmergencyDispatch(scenario.seed.emergency.id, 'DRIVER_REJECTED'),
    ]);

    expect(results.filter((result) => result.outcome === 'REDISPATCHED')).toHaveLength(1);
    expect(
      results.every((result) =>
        [
          'REDISPATCHED',
          'RECOVERY_CONFLICT',
          'NOT_RECOVERABLE',
          'DISPATCH_ALREADY_ACTIVE',
        ].includes(result.outcome),
      ),
    ).toBe(true);
    await expectSingleReplacement(scenario);

    // A later duplicate is a no-op too.
    expect(
      (await recoverEmergencyDispatch(scenario.seed.emergency.id, 'DRIVER_REJECTED')).outcome,
    ).toBe('DISPATCH_ALREADY_ACTIVE');
    await expectSingleReplacement(scenario);
  });

  it.each([1, 2, 3])('run %i: a rejection racing a recovery creates one replacement', async () => {
    const scenario = await seedFirstAttempt({ spareAmbulances: 2, spareDrivers: 2 });

    const [rejection] = await Promise.allSettled([
      rejectOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id, 'Race'),
      recoverEmergencyDispatch(scenario.seed.emergency.id, 'DRIVER_REJECTED'),
    ]);

    expect(rejection.status).toBe('fulfilled');
    await expectSingleReplacement(scenario);
  });

  it.each([1, 2, 3])('run %i: a failure racing a recovery creates one replacement', async () => {
    const scenario = await seedFirstAttempt({ spareAmbulances: 2, spareDrivers: 2 });
    await walkTo(scenario, 'ARRIVE_PICKUP');

    const [failure] = await Promise.allSettled([
      failOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id, 'Race'),
      recoverEmergencyDispatch(scenario.seed.emergency.id, 'TRIP_FAILED'),
    ]);

    expect(failure.status).toBe('fulfilled');
    await expectSingleReplacement(scenario);
  });

  it('does nothing while the original attempt is still live', async () => {
    const scenario = await seedFirstAttempt({ spareAmbulances: 1, spareDrivers: 1 });

    const result = await recoverEmergencyDispatch(scenario.seed.emergency.id, 'DRIVER_REJECTED');

    expect(result.outcome).toBe('DISPATCH_ALREADY_ACTIVE');
    expect(await readAttempts(scenario.seed.emergency.id)).toHaveLength(1);
    expect((await readEmergency(scenario.seed.emergency.id)).currentStatus).toBe(
      EmergencyStatus.PENDING_DRIVER_ACCEPTANCE,
    );
  });
});

describe('cross-hospital isolation', () => {
  it("never dispatches another hospital's ambulance, even an older available one", async () => {
    const otherScope = await createScope();
    const otherAmbulance = await createAmbulance(otherScope.hospitalId, 10_000);
    const scenario = await seedFirstAttempt({ spareDrivers: 1 });

    await rejectOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id, 'Vehicle fault');

    // The accepting hospital has no unused ambulance of its own, so nothing is dispatched.
    expect((await readEmergency(scenario.seed.emergency.id)).currentStatus).toBe(
      EmergencyStatus.BED_RESERVED,
    );
    expect(await readAttempts(scenario.seed.emergency.id)).toHaveLength(1);
    expect(
      (await prisma.ambulance.findUniqueOrThrow({ where: { id: otherAmbulance.id } })).status,
    ).toBe(AmbulanceStatus.AVAILABLE);
    expect(
      await prisma.ambulanceAssignment.count({ where: { ambulanceId: otherAmbulance.id } }),
    ).toBe(0);
  });

  it("uses the accepting hospital's own spare and its accepted response", async () => {
    const otherScope = await createScope();
    const otherAmbulance = await createAmbulance(otherScope.hospitalId, 10_000);
    const scenario = await seedFirstAttempt({ spareAmbulances: 1, spareDrivers: 1 });

    await rejectOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id, 'Vehicle fault');

    const attempts = await readAttempts(scenario.seed.emergency.id);
    expect(attempts[1]!.ambulanceId).toBe(scenario.spareAmbulances[0]!.id);
    expect(attempts[1]!.hospitalResponseId).toBe(scenario.seed.response.id);
    expect(
      (await prisma.ambulance.findUniqueOrThrow({ where: { id: otherAmbulance.id } })).status,
    ).toBe(AmbulanceStatus.AVAILABLE);
  });

  it('a driver cannot end, and so cannot trigger recovery for, another driver assignment', async () => {
    const scenario = await seedFirstAttempt({ spareAmbulances: 1, spareDrivers: 1 });
    const stranger = await createDriverUser();

    await expect(
      rejectOwnAssignment(stranger.userId, scenario.assignment.id, 'Not mine'),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_NOT_FOUND', statusCode: 404 });

    expect(await readAttempts(scenario.seed.emergency.id)).toHaveLength(1);
    expect((await readEmergency(scenario.seed.emergency.id)).currentStatus).toBe(
      EmergencyStatus.PENDING_DRIVER_ACCEPTANCE,
    );
  });
});

describe('dispatch timeouts', () => {
  it('cancels an unanswered offer, releases both resources and re-dispatches', async () => {
    const scenario = await seedFirstAttempt({ spareAmbulances: 1, spareDrivers: 1 });
    await backdate(scenario.assignment.id, env.DRIVER_OFFER_TIMEOUT_SECONDS + 5);

    const outcome = await expireStaleAssignment(scenario.assignment.id);

    expect(outcome.expired).toBe(true);
    expect(outcome.recovery?.outcome).toBe('REDISPATCHED');
    expect(outcome.recovery?.trigger).toBe('OFFER_TIMEOUT');

    const attempts = await readAttempts(scenario.seed.emergency.id);
    expect(attempts[0]!.status).toBe(AmbulanceAssignmentStatus.CANCELLED);
    expect(attempts[0]!.endedAt).not.toBeNull();
    expect(attempts[0]!.respondedAt).toBeNull();
    expect(attempts[0]!.rejectionReason).toContain('timed out');
    expect(attempts[1]!.attemptNumber).toBe(2);
    expect(attempts[1]!.ambulanceId).toBe(scenario.spareAmbulances[0]!.id);

    expect(
      (await prisma.ambulance.findUniqueOrThrow({ where: { id: scenario.firstAmbulance.id } }))
        .status,
    ).toBe(AmbulanceStatus.AVAILABLE);
    expect(
      (
        await prisma.driverProfile.findUniqueOrThrow({
          where: { id: scenario.firstDriver.profile.id },
        })
      ).availabilityStatus,
    ).toBe(DriverAvailability.AVAILABLE);
    await expectCapacityHeld(scenario);
  });

  it('cancels an accepted offer whose trip never started', async () => {
    const scenario = await seedFirstAttempt();
    await acceptOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id);
    await backdate(scenario.assignment.id, env.DRIVER_ACCEPTED_TIMEOUT_SECONDS + 5);

    const outcome = await expireStaleAssignment(scenario.assignment.id);

    expect(outcome.expired).toBe(true);
    expect(outcome.recovery?.trigger).toBe('ACCEPTED_TIMEOUT');
    // The hospital's only ambulance is the one that timed out, so recovery stops at BED_RESERVED.
    expect(outcome.recovery?.outcome).toBe('NO_AVAILABLE_RESOURCES');

    const stored = await prisma.ambulanceAssignment.findUniqueOrThrow({
      where: { id: scenario.assignment.id },
    });
    expect(stored.status).toBe(AmbulanceAssignmentStatus.CANCELLED);
    expect(stored.respondedAt).not.toBeNull();
    expect(stored.startedAt).toBeNull();
    expect(
      (await prisma.ambulance.findUniqueOrThrow({ where: { id: scenario.firstAmbulance.id } }))
        .status,
    ).toBe(AmbulanceStatus.AVAILABLE);
    expect(
      (
        await prisma.driverProfile.findUniqueOrThrow({
          where: { id: scenario.firstDriver.profile.id },
        })
      ).availabilityStatus,
    ).toBe(DriverAvailability.AVAILABLE);
    expect((await readEmergency(scenario.seed.emergency.id)).currentStatus).toBe(
      EmergencyStatus.BED_RESERVED,
    );
    await expectCapacityHeld(scenario);
  });

  it('leaves offers and accepted trips alone until their own timeout has passed', async () => {
    const offered = await seedFirstAttempt();
    expect((await expireStaleAssignment(offered.assignment.id)).expired).toBe(false);

    // Past the offer timeout but not the longer accepted timeout.
    const accepted = await seedFirstAttempt();
    await acceptOwnAssignment(accepted.firstDriver.userId, accepted.assignment.id);
    await backdate(accepted.assignment.id, env.DRIVER_OFFER_TIMEOUT_SECONDS + 5);
    expect((await expireStaleAssignment(accepted.assignment.id)).expired).toBe(false);

    expect(
      (await prisma.ambulanceAssignment.findUniqueOrThrow({ where: { id: offered.assignment.id } }))
        .status,
    ).toBe(AmbulanceAssignmentStatus.OFFERED);
    expect(
      (
        await prisma.ambulanceAssignment.findUniqueOrThrow({
          where: { id: accepted.assignment.id },
        })
      ).status,
    ).toBe(AmbulanceAssignmentStatus.ACCEPTED);
  });

  it('never times out a trip that is under way', async () => {
    const scenario = await seedFirstAttempt();
    await walkTo(scenario, 'START');
    await backdate(scenario.assignment.id, 24 * 60 * 60);

    expect((await expireStaleAssignment(scenario.assignment.id)).expired).toBe(false);
    expect(
      (
        await prisma.ambulanceAssignment.findUniqueOrThrow({
          where: { id: scenario.assignment.id },
        })
      ).status,
    ).toBe(AmbulanceAssignmentStatus.EN_ROUTE);
  });

  it('a repeated expiry of the same assignment is a no-op', async () => {
    const scenario = await seedFirstAttempt();
    await backdate(scenario.assignment.id, env.DRIVER_OFFER_TIMEOUT_SECONDS + 5);

    const [first, second] = await Promise.all([
      expireStaleAssignment(scenario.assignment.id),
      expireStaleAssignment(scenario.assignment.id),
    ]);

    expect([first.expired, second.expired].filter(Boolean)).toHaveLength(1);
    expect(await readAttempts(scenario.seed.emergency.id)).toHaveLength(1);
    expect((await readEmergency(scenario.seed.emergency.id)).currentStatus).toBe(
      EmergencyStatus.BED_RESERVED,
    );
  });

  it.each([1, 2, 3])('run %i: a timeout racing the driver accepting has one winner', async () => {
    const scenario = await seedFirstAttempt();
    // Past the offer timeout only, so an offer accepted first is not stale as an accepted trip.
    await backdate(scenario.assignment.id, env.DRIVER_OFFER_TIMEOUT_SECONDS + 5);

    const [accept, expiry] = await Promise.allSettled([
      acceptOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id),
      expireStaleAssignment(scenario.assignment.id),
    ]);

    const stored = await prisma.ambulanceAssignment.findUniqueOrThrow({
      where: { id: scenario.assignment.id },
    });
    const ambulance = await prisma.ambulance.findUniqueOrThrow({
      where: { id: scenario.firstAmbulance.id },
    });
    const driver = await prisma.driverProfile.findUniqueOrThrow({
      where: { id: scenario.firstDriver.profile.id },
    });
    const emergency = await readEmergency(scenario.seed.emergency.id);

    expect(expiry.status).toBe('fulfilled');
    const expired = expiry.status === 'fulfilled' && expiry.value.expired;

    if (accept.status === 'fulfilled') {
      expect(expired).toBe(false);
      expect(stored.status).toBe(AmbulanceAssignmentStatus.ACCEPTED);
      expect(ambulance.status).toBe(AmbulanceStatus.ASSIGNED);
      expect(driver.availabilityStatus).toBe(DriverAvailability.BUSY);
      expect(emergency.currentStatus).toBe(EmergencyStatus.PENDING_DRIVER_ACCEPTANCE);
    } else {
      expect(accept.reason).toMatchObject({ code: 'ASSIGNMENT_STATUS_CONFLICT', statusCode: 409 });
      expect(expired).toBe(true);
      expect(stored.status).toBe(AmbulanceAssignmentStatus.CANCELLED);
      expect(ambulance.status).toBe(AmbulanceStatus.AVAILABLE);
      expect(driver.availabilityStatus).toBe(DriverAvailability.AVAILABLE);
      expect(emergency.currentStatus).toBe(EmergencyStatus.BED_RESERVED);
    }
  });

  it.each([1, 2, 3])('run %i: a timeout racing START has one winner', async () => {
    const scenario = await seedFirstAttempt();
    await acceptOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id);
    await backdate(scenario.assignment.id, env.DRIVER_ACCEPTED_TIMEOUT_SECONDS + 5);

    const [start, expiry] = await Promise.allSettled([
      transitionOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id, 'START'),
      expireStaleAssignment(scenario.assignment.id),
    ]);

    const stored = await prisma.ambulanceAssignment.findUniqueOrThrow({
      where: { id: scenario.assignment.id },
    });
    const ambulance = await prisma.ambulance.findUniqueOrThrow({
      where: { id: scenario.firstAmbulance.id },
    });
    const emergency = await readEmergency(scenario.seed.emergency.id);

    expect(expiry.status).toBe('fulfilled');
    const expired = expiry.status === 'fulfilled' && expiry.value.expired;

    if (start.status === 'fulfilled') {
      expect(expired).toBe(false);
      expect(stored.status).toBe(AmbulanceAssignmentStatus.EN_ROUTE);
      expect(ambulance.status).toBe(AmbulanceStatus.EN_ROUTE);
      expect(emergency.currentStatus).toBe(EmergencyStatus.DRIVER_EN_ROUTE);
    } else {
      expect(start.reason).toMatchObject({ code: 'ASSIGNMENT_STATUS_CONFLICT', statusCode: 409 });
      expect(expired).toBe(true);
      expect(stored.status).toBe(AmbulanceAssignmentStatus.CANCELLED);
      expect(ambulance.status).toBe(AmbulanceStatus.AVAILABLE);
      expect(emergency.currentStatus).toBe(EmergencyStatus.BED_RESERVED);
    }
  });

  it('a driver action on a timed-out offer is refused', async () => {
    const scenario = await seedFirstAttempt();
    await backdate(scenario.assignment.id, env.DRIVER_OFFER_TIMEOUT_SECONDS + 5);
    await expireStaleAssignment(scenario.assignment.id);

    await expect(
      acceptOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_STATUS_CONFLICT', statusCode: 409 });
    await expect(
      rejectOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id, 'Too late'),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_STATUS_CONFLICT', statusCode: 409 });
  });

  it('the sweep expires stale assignments it finds', async () => {
    // `now` is set decades back so the sweep's cutoff can only match this test's own row, never
    // a live fixture of another suite running in parallel.
    const now = new Date(Date.UTC(1990, 0, 1));
    const scenario = await seedFirstAttempt();
    await prisma.ambulanceAssignment.update({
      where: { id: scenario.assignment.id },
      data: { assignedAt: new Date(Date.UTC(1980, 0, 1)) },
    });

    const result = await sweepStaleAssignments(now);

    expect(result.expired).toBe(1);
    expect(
      (
        await prisma.ambulanceAssignment.findUniqueOrThrow({
          where: { id: scenario.assignment.id },
        })
      ).status,
    ).toBe(AmbulanceAssignmentStatus.CANCELLED);
    expect((await sweepStaleAssignments(now)).expired).toBe(0);
  });

  it('the timer runs one sweep at a time and stops cleanly', async () => {
    vi.useFakeTimers();
    let release: () => void = () => undefined;
    const sweep = vi.fn(
      () =>
        new Promise<{ candidates: number; expired: number }>((resolve) => {
          release = () => resolve({ candidates: 0, expired: 0 });
        }),
    );

    const stop = startDispatchTimeoutSweep({ intervalMs: 1_000, sweep });

    await vi.advanceTimersByTimeAsync(3_500);
    expect(sweep).toHaveBeenCalledTimes(1); // still running: later ticks are skipped

    release();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sweep).toHaveBeenCalledTimes(2);

    release();
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});

describe('Task 1.22 and 1.23 regression after recovery', () => {
  it('a re-dispatched trip completes, and the patient is admitted and completed', async () => {
    const scenario = await seedFirstAttempt({ spareAmbulances: 1, spareDrivers: 1 });
    await walkTo(scenario, 'START_TRANSPORT');
    await failOwnAssignment(scenario.firstDriver.userId, scenario.assignment.id, 'Breakdown.');

    const attempts = await readAttempts(scenario.seed.emergency.id);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]!.id).toBe(scenario.assignment.id);
    expect(attempts[0]!.status).toBe(AmbulanceAssignmentStatus.FAILED);

    const replacement = attempts[1]!;
    expect(replacement.attemptNumber).toBe(2);
    expect(replacement.status).toBe(AmbulanceAssignmentStatus.OFFERED);
    expect(replacement.driverId).not.toBe(scenario.firstDriver.profile.id);

    // Recovery selects the oldest eligible driver from the GLOBAL pool, so the replacement's
    // driver is read from the assignment itself rather than assumed to be this scenario's spare.
    const replacementDriver = await prisma.driverProfile.findUniqueOrThrow({
      where: { id: replacement.driverId },
      select: { userId: true },
    });

    await acceptOwnAssignment(replacementDriver.userId, replacement.id);
    for (const step of ['START', 'ARRIVE_PICKUP', 'START_TRANSPORT', 'ARRIVE_HOSPITAL'] as const) {
      await transitionOwnAssignment(replacementDriver.userId, replacement.id, step);
    }

    expect(
      (await prisma.ambulanceAssignment.findUniqueOrThrow({ where: { id: replacement.id } }))
        .status,
    ).toBe(AmbulanceAssignmentStatus.COMPLETED);
    expect((await readEmergency(scenario.seed.emergency.id)).currentStatus).toBe(
      EmergencyStatus.AT_HOSPITAL,
    );

    const admission = await admitEmergency(
      scenario.scope,
      scenario.seed.emergency.id,
      scenario.actorUserId,
    );
    expect(admission.emergency.currentStatus).toBe(EmergencyStatus.ADMITTED);
    expect(admission.reservation.status).toBe(BedReservationStatus.CONSUMED);
    expect(
      (await prisma.bed.findUniqueOrThrow({ where: { id: scenario.seed.bed!.id } })).status,
    ).toBe(BedStatus.OCCUPIED);

    const completed = await completeEmergency(
      scenario.scope,
      scenario.seed.emergency.id,
      scenario.actorUserId,
    );
    expect(completed.currentStatus).toBe(EmergencyStatus.COMPLETED);

    // Completion never triggers recovery.
    expect(
      (await recoverEmergencyDispatch(scenario.seed.emergency.id, 'TRIP_FAILED')).outcome,
    ).toBe('NOT_RECOVERABLE');
    expect(await readAttempts(scenario.seed.emergency.id)).toHaveLength(2);
  });
});
