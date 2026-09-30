/**
 * Task 1.21 live HTTP smoke test — automatic ambulance assignment on hospital acceptance.
 *
 * Temporary review helper, not part of the module: it lives outside src/, so it is neither
 * typechecked nor built (same treatment as prisma/seed-admin.ts). Delete it after review.
 *
 *   1. start the API in another terminal:  npm run dev --workspace=backend
 *   2. run:                                npm run smoke:task-1-21 --workspace=backend
 *
 * Fixtures are prefixed SMOKE2121 (phones '+1922', licences 'L2121-'), chosen so they cannot
 * collide with the Task 1.18 ('SMOKE1818' / '+1919'), 1.19 ('SMOKE1919' / '+1920') or 1.20
 * ('SMOKE2020' / '+1921') smoke scripts, or with any service-test prefix.
 *
 * Determinism has two halves. Hospitals are seeded at the exact pickup point (distance 0) so
 * they fill all HOSPITAL_MATCH_MAX_OFFERS slots, and ambulances carry an explicit createdAt.
 * Drivers are different: the driver pool is GLOBAL by design (DatabaseDesign.md sections 11 and
 * 12.3), so every driver here is dated decades into the past. That makes this script's drivers
 * the oldest eligible rows in the database, which both fixes which driver is chosen and
 * guarantees the script can never claim a driver belonging to someone else.
 */
import {
  AmbulanceStatus,
  BedStatus,
  DriverAvailability,
  HospitalStatus,
  PrismaClient,
  UserRole,
  UserStatus,
  VerificationStatus,
} from '@prisma/client';
import type { Ambulance, DriverProfile, Hospital, User } from '@prisma/client';
import bcrypt from 'bcrypt';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const PREFIX = 'SMOKE2121';
const PHONE_PREFIX = '+1922';
const LICENCE_PREFIX = 'L2121-';
const PASSWORD = 'a-very-strong-passphrase';
const PICKUP = { latitude: 42, longitude: 42 };

const prisma = new PrismaClient();

let passed = 0;
let failed = 0;
let counter = 0;

const nextPhone = (): string =>
  `${PHONE_PREFIX}${String(Date.now()).slice(-6)}${String(counter++).padStart(3, '0')}`;

/** Decades in the past, so this script's drivers outrank every other eligible driver. */
const yearsAgo = (years: number): Date => new Date(Date.UTC(2000 - years, 0, 1, 0, 0, 0, 0));

const check = (name: string, condition: boolean, detail = ''): void => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
};

const call = async (
  method: string,
  path_: string,
  token?: string,
  body?: unknown,
  idempotencyKey?: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ status: number; body: any }> => {
  const response = await fetch(`${BASE_URL}${path_}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: unknown = null;
  try {
    json = await response.json();
  } catch {
    // A failed assertion still prints the status when the body cannot be decoded.
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { status: response.status, body: json as any };
};

const login = async (phone: string): Promise<string> => {
  const res = await call('POST', '/api/v1/auth/login', undefined, { phone, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed for ${phone}: ${res.status}`);
  return res.body.accessToken as string;
};

/** A verified hospital sitting exactly at the pickup point. Resources are added separately. */
const createEligibleHospital = async (suffix: string): Promise<Hospital> =>
  prisma.hospital.create({
    data: {
      name: `${PREFIX} ${suffix}`,
      registrationNumber: `${PREFIX}-${suffix}-${Date.now()}-${counter++}`,
      phone: '+15550000000',
      addressLine: '1 Smoke Test Street',
      city: 'Smoke City',
      state: 'SC',
      postalCode: '10001',
      latitude: PICKUP.latitude,
      longitude: PICKUP.longitude,
      status: HospitalStatus.VERIFIED,
    },
  });

const createBed = async (hospitalId: string, suffix: string) =>
  prisma.bed.create({
    data: {
      hospitalId,
      bedCode: `${PREFIX}-${suffix}-${counter++}`,
      status: BedStatus.AVAILABLE,
    },
  });

/** createdAt is explicit so "the oldest AVAILABLE ambulance" is a fact of the fixture. */
const createAmbulance = async (
  hospitalId: string,
  suffix: string,
  minutesOld: number,
): Promise<Ambulance> =>
  prisma.ambulance.create({
    data: {
      hospitalId,
      vehicleNumber: `${PREFIX}-${suffix}-${counter++}`,
      status: AmbulanceStatus.AVAILABLE,
      createdAt: new Date(Date.now() - minutesOld * 60_000),
    },
  });

const createDispatcher = async (hospitalId: string): Promise<{ user: User; token: string }> => {
  const phone = nextPhone();
  const user = await prisma.user.create({
    data: {
      phone,
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      role: UserRole.HOSPITAL_STAFF,
      status: UserStatus.ACTIVE,
      displayName: `${PREFIX} dispatcher`,
      hospitalMemberships: { create: { hospitalId, staffRole: 'DISPATCHER', status: 'ACTIVE' } },
    },
  });
  return { user, token: await login(phone) };
};

const createDriver = async (
  years: number,
): Promise<{ user: User; profile: DriverProfile; token: string }> => {
  const phone = nextPhone();
  const user = await prisma.user.create({
    data: {
      phone,
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      role: UserRole.DRIVER,
      status: UserStatus.ACTIVE,
      displayName: `${PREFIX} driver`,
      driverProfile: {
        create: {
          licenceNumber: `${LICENCE_PREFIX}${Date.now()}-${counter++}`,
          verificationStatus: VerificationStatus.VERIFIED,
          availabilityStatus: DriverAvailability.AVAILABLE,
          createdAt: yearsAgo(years),
        },
      },
    },
    include: { driverProfile: true },
  });
  return { user, profile: user.driverProfile!, token: await login(phone) };
};

const createPatient = async (): Promise<{ user: User; token: string }> => {
  const phone = nextPhone();
  const user = await prisma.user.create({
    data: {
      phone,
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      role: UserRole.PATIENT,
      status: UserStatus.ACTIVE,
      displayName: `${PREFIX} patient`,
      patientProfile: { create: {} },
    },
  });
  return { user, token: await login(phone) };
};

const raiseSos = async (token: string): Promise<string> => {
  const sos = await call(
    'POST',
    '/api/v1/patients/me/emergencies',
    token,
    { pickupLatitude: PICKUP.latitude, pickupLongitude: PICKUP.longitude },
    `sos-${Date.now()}-${counter++}`,
  );
  check('SOS returns 201', sos.status === 201, JSON.stringify(sos.body));
  check(
    'matched emergency is PENDING_HOSPITAL_RESPONSE',
    sos.body?.emergency?.currentStatus === 'PENDING_HOSPITAL_RESPONSE',
    sos.body?.emergency?.currentStatus,
  );
  return sos.body?.emergency?.id as string;
};

const run = async (): Promise<void> => {
  console.log('\n1. seed three eligible hospitals, a fleet, and drivers');
  const dispatcherHospital = await createEligibleHospital('dispatcher');
  const bystander = await createEligibleHospital('bystander');
  const dry = await createEligibleHospital('dry');
  const ownedHospitalIds = [dispatcherHospital.id, bystander.id, dry.id];

  await createBed(dispatcherHospital.id, 'bed-dispatcher');
  await createBed(bystander.id, 'bed-bystander');
  await createBed(dry.id, 'bed-dry');

  // Two vehicles at the accepting hospital, so "oldest AVAILABLE" is observable.
  const oldestAmbulance = await createAmbulance(dispatcherHospital.id, 'amb-old', 90);
  const newerAmbulance = await createAmbulance(dispatcherHospital.id, 'amb-new', 5);

  const dispatcherStaff = await createDispatcher(dispatcherHospital.id);
  const dryStaff = await createDispatcher(dry.id);
  const primaryDriver = await createDriver(70);
  const recoveryDriver = await createDriver(65);
  const spareDriver = await createDriver(60);
  const patientOne = await createPatient();

  console.log('\n2. SOS, matching, acceptance');
  const emergencyOneId = await raiseSos(patientOne.token);

  const offersOne = await prisma.hospitalResponse.findMany({
    where: { emergencyId: emergencyOneId, hospitalId: { in: ownedHospitalIds } },
  });
  check(
    'all three owned hospitals received an offer',
    offersOne.length === 3,
    `${offersOne.length} owned offers`,
  );
  const acceptedOffer = offersOne.find((offer) => offer.hospitalId === dispatcherHospital.id);
  const bystanderOffer = offersOne.find((offer) => offer.hospitalId === bystander.id);
  check('the accepting hospital holds an offer', Boolean(acceptedOffer));

  const accepted = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${acceptedOffer?.id}/accept`,
    dispatcherStaff.token,
    {},
  );
  check('acceptance returns 200', accepted.status === 200, JSON.stringify(accepted.body));
  check('accepted offer is ACCEPTED', accepted.body?.response?.status === 'ACCEPTED');
  check(
    'the acceptance response already reports PENDING_DRIVER_ACCEPTANCE',
    accepted.body?.response?.emergency?.currentStatus === 'PENDING_DRIVER_ACCEPTANCE',
    accepted.body?.response?.emergency?.currentStatus,
  );

  console.log('\n3. the bed the acceptance reserved (Task 1.20 still holds)');
  const reservations = await prisma.bedReservation.findMany({
    where: { emergencyId: emergencyOneId },
  });
  check('exactly one reservation exists', reservations.length === 1, `${reservations.length}`);
  check('the reservation is still RESERVED', reservations[0]?.status === 'RESERVED');

  console.log('\n4. the assignment the acceptance created');
  const assignments = await prisma.ambulanceAssignment.findMany({
    where: { emergencyId: emergencyOneId },
  });
  check('exactly one assignment exists', assignments.length === 1, `${assignments.length}`);
  const assignment = assignments[0];
  check('assignment status is OFFERED', assignment?.status === 'OFFERED', assignment?.status);
  check('assignment attemptNumber is 1', assignment?.attemptNumber === 1);
  check(
    'assignment is linked to the accepted response',
    assignment?.hospitalResponseId === acceptedOffer?.id,
  );
  check(
    'the oldest available ambulance was taken',
    assignment?.ambulanceId === oldestAmbulance.id,
    `${assignment?.ambulanceId}`,
  );
  check(
    'the oldest eligible driver was taken',
    assignment?.driverId === primaryDriver.profile.id,
    `${assignment?.driverId}`,
  );
  check('assignment has no driver response yet', assignment?.respondedAt === null);

  check(
    'the taken ambulance is OFFERED',
    (await prisma.ambulance.findUniqueOrThrow({ where: { id: oldestAmbulance.id } })).status ===
      'OFFERED',
  );
  check(
    'the newer ambulance is untouched',
    (await prisma.ambulance.findUniqueOrThrow({ where: { id: newerAmbulance.id } })).status ===
      'AVAILABLE',
  );
  check(
    'the taken driver is BUSY',
    (await prisma.driverProfile.findUniqueOrThrow({ where: { id: primaryDriver.profile.id } }))
      .availabilityStatus === 'BUSY',
  );
  check(
    'the untaken drivers stay AVAILABLE',
    (await prisma.driverProfile.count({
      where: {
        id: { in: [recoveryDriver.profile.id, spareDriver.profile.id] },
        availabilityStatus: DriverAvailability.AVAILABLE,
      },
    })) === 2,
  );

  console.log('\n5. Task 1.19 withdrawal is unchanged');
  check(
    'the sibling PENDING offer became WITHDRAWN',
    (await prisma.hospitalResponse.findUniqueOrThrow({ where: { id: bystanderOffer!.id } }))
      .status === 'WITHDRAWN',
  );

  console.log('\n6. status history records the whole chain');
  const history = await prisma.emergencyStatusHistory.findMany({
    where: { emergencyId: emergencyOneId },
    orderBy: { occurredAt: 'asc' },
  });
  // A patient-initiated SOS that is matched, accepted, bed-reserved and dispatched produces
  // seven rows:
  //   [0] null -> CREATED                                    (Task 1.17, actorType PATIENT)
  //   [1] CREATED -> SEARCHING_HOSPITAL                      (Task 1.18, actorType SYSTEM)
  //   [2] SEARCHING_HOSPITAL -> PENDING_HOSPITAL_RESPONSE    (Task 1.18, actorType SYSTEM)
  //   [3] PENDING_HOSPITAL_RESPONSE -> HOSPITAL_ACCEPTED     (Task 1.19, HOSPITAL_STAFF)
  //   [4] HOSPITAL_ACCEPTED -> BED_RESERVED                  (Task 1.20, HOSPITAL_STAFF)
  //   [5] BED_RESERVED -> AMBULANCE_ASSIGNED                 (Task 1.21, HOSPITAL_STAFF)
  //   [6] AMBULANCE_ASSIGNED -> PENDING_DRIVER_ACCEPTANCE    (Task 1.21, HOSPITAL_STAFF)
  // Sibling withdrawals and the driver's own answer add none.
  check(
    'the emergency has seven history rows after dispatch',
    history.length === 7,
    `${history.length} rows`,
  );
  const assignedRow = history[5];
  const pendingRow = history[6];
  check(
    'row 6 is BED_RESERVED -> AMBULANCE_ASSIGNED',
    assignedRow?.fromStatus === 'BED_RESERVED' && assignedRow?.toStatus === 'AMBULANCE_ASSIGNED',
    `${assignedRow?.fromStatus} -> ${assignedRow?.toStatus}`,
  );
  check(
    'row 7 is AMBULANCE_ASSIGNED -> PENDING_DRIVER_ACCEPTANCE',
    pendingRow?.fromStatus === 'AMBULANCE_ASSIGNED' &&
      pendingRow?.toStatus === 'PENDING_DRIVER_ACCEPTANCE',
    `${pendingRow?.fromStatus} -> ${pendingRow?.toStatus}`,
  );
  check(
    'both dispatch rows are HOSPITAL_STAFF transitions by the accepting staff member',
    assignedRow?.actorType === 'HOSPITAL_STAFF' &&
      pendingRow?.actorType === 'HOSPITAL_STAFF' &&
      assignedRow?.actorUserId === dispatcherStaff.user.id &&
      pendingRow?.actorUserId === dispatcherStaff.user.id,
    `${assignedRow?.actorType} / ${pendingRow?.actorType}`,
  );

  console.log('\n7. the assignment is readable by both sides');
  const hospitalView = await call('GET', '/api/v1/hospitals/me/assignments', dispatcherStaff.token);
  check('hospital assignment list returns 200', hospitalView.status === 200);
  check(
    'the assignment is visible to the dispatching hospital',
    Array.isArray(hospitalView.body?.assignments) &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      hospitalView.body.assignments.some((entry: any) => entry.id === assignment?.id),
  );

  const driverView = await call('GET', '/api/v1/drivers/me/assignments', primaryDriver.token);
  check('driver assignment list returns 200', driverView.status === 200);
  check(
    'the assignment is visible to the offered driver',
    Array.isArray(driverView.body?.assignments) &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      driverView.body.assignments.some((entry: any) => entry.id === assignment?.id),
  );

  console.log('\n8. the driver accepts');
  const driverAccept = await call(
    'POST',
    `/api/v1/drivers/me/assignments/${assignment?.id}/accept`,
    primaryDriver.token,
    {},
  );
  check(
    'driver acceptance returns 200',
    driverAccept.status === 200,
    JSON.stringify(driverAccept.body),
  );
  check('assignment is ACCEPTED', driverAccept.body?.assignment?.status === 'ACCEPTED');
  check(
    'the ambulance is committed as ASSIGNED',
    (await prisma.ambulance.findUniqueOrThrow({ where: { id: oldestAmbulance.id } })).status ===
      'ASSIGNED',
  );
  check(
    'the driver stays BUSY',
    (await prisma.driverProfile.findUniqueOrThrow({ where: { id: primaryDriver.profile.id } }))
      .availabilityStatus === 'BUSY',
  );

  console.log('\n9. acceptance at a hospital with no available vehicle');
  const patientTwo = await createPatient();
  const emergencyTwoId = await raiseSos(patientTwo.token);

  const dryOffer = await prisma.hospitalResponse.findFirstOrThrow({
    where: { emergencyId: emergencyTwoId, hospitalId: dry.id },
  });
  const acceptedDry = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${dryOffer.id}/accept`,
    dryStaff.token,
    {},
  );
  check(
    'acceptance still returns 200',
    acceptedDry.status === 200,
    JSON.stringify(acceptedDry.body),
  );
  check('the offer is ACCEPTED', acceptedDry.body?.response?.status === 'ACCEPTED');
  check(
    'the emergency rests at BED_RESERVED when no vehicle is free',
    acceptedDry.body?.response?.emergency?.currentStatus === 'BED_RESERVED',
    acceptedDry.body?.response?.emergency?.currentStatus,
  );
  check(
    'the bed is still held',
    (await prisma.bedReservation.count({
      where: { emergencyId: emergencyTwoId, status: 'RESERVED' },
    })) === 1,
  );
  check(
    'no assignment row is invented',
    (await prisma.ambulanceAssignment.count({ where: { emergencyId: emergencyTwoId } })) === 0,
  );
  check(
    'the emergency has five history rows',
    (await prisma.emergencyStatusHistory.count({ where: { emergencyId: emergencyTwoId } })) === 5,
  );

  console.log('\n10. the manual dispatch endpoint is the recovery path');
  const recoveryAmbulance = await createAmbulance(dry.id, 'amb-recovery', 40);
  const spareAmbulance = await createAmbulance(dry.id, 'amb-spare', 20);

  const manual = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${emergencyTwoId}/assignments`,
    dryStaff.token,
    { ambulanceId: recoveryAmbulance.id, driverId: recoveryDriver.profile.id },
  );
  check('manual dispatch returns 201', manual.status === 201, JSON.stringify(manual.body));
  check(
    'the manually chosen ambulance is honoured',
    manual.body?.assignment?.ambulanceId === recoveryAmbulance.id,
  );
  check(
    'the manually chosen driver is honoured',
    manual.body?.assignment?.driverId === recoveryDriver.profile.id,
  );
  check('manual assignment attemptNumber is 1', manual.body?.assignment?.attemptNumber === 1);
  check(
    'the emergency now reaches PENDING_DRIVER_ACCEPTANCE',
    (await prisma.emergencyRequest.findUniqueOrThrow({ where: { id: emergencyTwoId } }))
      .currentStatus === 'PENDING_DRIVER_ACCEPTANCE',
  );

  console.log('\n11. dispatching an already-dispatched emergency is refused');
  const duplicate = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${emergencyTwoId}/assignments`,
    dryStaff.token,
    { ambulanceId: spareAmbulance.id, driverId: spareDriver.profile.id },
  );
  check('duplicate manual dispatch is 409', duplicate.status === 409, `${duplicate.status}`);
  check(
    'the conflict is EMERGENCY_STATUS_CONFLICT',
    duplicate.body?.error?.code === 'EMERGENCY_STATUS_CONFLICT',
    duplicate.body?.error?.code,
  );
  check(
    'the refused attempt released the spare ambulance',
    (await prisma.ambulance.findUniqueOrThrow({ where: { id: spareAmbulance.id } })).status ===
      'AVAILABLE',
  );
  check(
    'the refused attempt released the spare driver',
    (await prisma.driverProfile.findUniqueOrThrow({ where: { id: spareDriver.profile.id } }))
      .availabilityStatus === 'AVAILABLE',
  );
  check(
    'the emergency still has exactly one assignment',
    (await prisma.ambulanceAssignment.count({ where: { emergencyId: emergencyTwoId } })) === 1,
  );
};

/**
 * Ownership-scoped: this script deletes only rows it created. Offers that global Task 1.18
 * matching attached from another suite's emergency to a hospital created here are detached,
 * but those emergencies are left untouched. The detach runs twice — once up front and again
 * immediately before the resources are released — because a VERIFIED hospital with an
 * AVAILABLE bed stays globally eligible for matching until its last bed is gone.
 *
 * AmbulanceAssignment references the ambulance and the driver with onDelete: Restrict, and the
 * driver pool is global, so assignments are also detached by resource id before either resource
 * is deleted.
 */
const cleanup = async (): Promise<number> => {
  const hospitals = await prisma.hospital.findMany({
    where: { registrationNumber: { startsWith: PREFIX } },
    select: { id: true },
  });
  const hospitalIds = hospitals.map((hospital) => hospital.id);
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: PHONE_PREFIX } },
    select: { id: true, patientProfile: { select: { id: true } } },
  });
  const userIds = users.map((user) => user.id);
  const profileIds = users.flatMap((user) => (user.patientProfile ? [user.patientProfile.id] : []));

  const ownDrivers = await prisma.driverProfile.findMany({
    where: { licenceNumber: { startsWith: LICENCE_PREFIX } },
    select: { id: true },
  });
  const ownDriverIds = ownDrivers.map((driver) => driver.id);
  const ownAmbulances = await prisma.ambulance.findMany({
    where: { hospitalId: { in: hospitalIds } },
    select: { id: true },
  });
  const ownAmbulanceIds = ownAmbulances.map((ambulance) => ambulance.id);

  const detachOwnHospitalResponses = async (): Promise<void> => {
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
  };

  await detachOwnHospitalResponses();

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

  await prisma.hospitalStaffMembership.deleteMany({ where: { hospitalId: { in: hospitalIds } } });

  await detachOwnHospitalResponses();
  await prisma.ambulanceAssignment.deleteMany({ where: { driverId: { in: ownDriverIds } } });
  await prisma.ambulanceAssignment.deleteMany({ where: { ambulanceId: { in: ownAmbulanceIds } } });
  await prisma.driverProfile.deleteMany({ where: { id: { in: ownDriverIds } } });
  await prisma.ambulance.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.bed.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  const residual =
    (await prisma.user.count({ where: { phone: { startsWith: PHONE_PREFIX } } })) +
    (await prisma.hospital.count({ where: { registrationNumber: { startsWith: PREFIX } } })) +
    (await prisma.driverProfile.count({
      where: { licenceNumber: { startsWith: LICENCE_PREFIX } },
    }));
  console.log(
    `\ncleanup: removed ${userIds.length} users, ${hospitalIds.length} hospitals, ${ownDriverIds.length} drivers`,
  );
  console.log(`residual smoke rows: ${residual}`);
  return residual;
};

let residual = -1;
try {
  await run();
} catch (error) {
  failed += 1;
  console.error('\nsmoke run threw:', error);
} finally {
  try {
    residual = await cleanup();
  } catch (error) {
    console.error('cleanup failed:', error);
  }
  await prisma.$disconnect();
}

console.log(`\npassed: ${passed}   failed: ${failed}   residual fixtures: ${residual}`);
process.exit(failed === 0 && residual === 0 ? 0 : 1);
