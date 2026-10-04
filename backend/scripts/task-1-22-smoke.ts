/**
 * Task 1.22 live HTTP smoke test — driver trip / transport lifecycle.
 *
 * Temporary review helper, not part of the module: it lives outside src/, so it is neither
 * typechecked nor built (same treatment as prisma/seed-admin.ts). Delete it after review.
 *
 *   1. start the API in another terminal:  npm run dev --workspace=backend
 *   2. run:                                npm run smoke:task-1-22 --workspace=backend
 *
 * Fixtures are prefixed SMOKE2222 (phones '+1923', licences 'L2222-'), chosen so they cannot
 * collide with the Task 1.18-1.21 smoke scripts or any service-test prefix.
 *
 * Determinism has two halves. Hospitals sit at the exact pickup point (distance 0) so they fill
 * the offer slots, and ambulances carry an explicit createdAt. Drivers are different: the driver
 * pool is GLOBAL by design (DatabaseDesign.md sections 11 and 12.3), so every driver here is
 * dated decades into the past. That makes this script's drivers the oldest eligible rows in the
 * database, which both fixes which driver is chosen and guarantees the script can never claim a
 * driver belonging to someone else.
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
const PREFIX = 'SMOKE2222';
const PHONE_PREFIX = '+1923';
const LICENCE_PREFIX = 'L2222-';
const PASSWORD = 'a-very-strong-passphrase';
const PICKUP = { latitude: 44, longitude: 44 };

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
    data: { hospitalId, bedCode: `${PREFIX}-${suffix}-${counter++}`, status: BedStatus.AVAILABLE },
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
  return sos.body?.emergency?.id as string;
};

/** Reads the four rows a trip step touches, straight from the database. */
const readState = async (assignmentId: string, ambulanceId: string, driverProfileId: string) => {
  const assignment = await prisma.ambulanceAssignment.findUniqueOrThrow({
    where: { id: assignmentId },
  });
  return {
    assignment,
    emergency: await prisma.emergencyRequest.findUniqueOrThrow({
      where: { id: assignment.emergencyId },
    }),
    ambulance: await prisma.ambulance.findUniqueOrThrow({ where: { id: ambulanceId } }),
    driver: await prisma.driverProfile.findUniqueOrThrow({ where: { id: driverProfileId } }),
  };
};

const tripStep = async (token: string, assignmentId: string, action: string) =>
  call('POST', `/api/v1/drivers/me/assignments/${assignmentId}/status`, token, { action });

const run = async (): Promise<void> => {
  console.log('\n1. seed hospitals, fleet and drivers');
  const transport = await createEligibleHospital('transport');
  const bystander = await createEligibleHospital('bystander');

  // Two beds at the transport hospital: one for the happy path, one for the final re-dispatch.
  await createBed(transport.id, 'bed-transport-1');
  await createBed(transport.id, 'bed-transport-2');
  await createBed(bystander.id, 'bed-bystander');

  const oldestAmbulance = await createAmbulance(transport.id, 'amb-old', 90);
  const newerAmbulance = await createAmbulance(transport.id, 'amb-new', 5);
  const bystanderAmbulance = await createAmbulance(bystander.id, 'amb-bystander', 30);

  const transportStaff = await createDispatcher(transport.id);
  const bystanderStaff = await createDispatcher(bystander.id);
  const driver = await createDriver(70);
  const otherDriver = await createDriver(60);
  const patientOne = await createPatient();

  console.log('\n2. SOS -> matching -> acceptance -> automatic bed + ambulance');
  const emergencyOneId = await raiseSos(patientOne.token);

  const offersOne = await prisma.hospitalResponse.findMany({
    where: { emergencyId: emergencyOneId, hospitalId: { in: [transport.id, bystander.id] } },
  });
  check('both owned hospitals received an offer', offersOne.length === 2, `${offersOne.length}`);
  const transportOffer = offersOne.find((offer) => offer.hospitalId === transport.id);

  const accepted = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${transportOffer?.id}/accept`,
    transportStaff.token,
    {},
  );
  check('acceptance returns 200', accepted.status === 200, JSON.stringify(accepted.body));
  check(
    'automatic dispatch left the emergency at PENDING_DRIVER_ACCEPTANCE',
    accepted.body?.response?.emergency?.currentStatus === 'PENDING_DRIVER_ACCEPTANCE',
    accepted.body?.response?.emergency?.currentStatus,
  );

  const assignment = await prisma.ambulanceAssignment.findFirstOrThrow({
    where: { emergencyId: emergencyOneId },
  });
  check('the oldest ambulance was dispatched', assignment.ambulanceId === oldestAmbulance.id);
  check('the oldest driver was dispatched', assignment.driverId === driver.profile.id);
  check(
    'the bed is held',
    (await prisma.bedReservation.count({
      where: { emergencyId: emergencyOneId, status: 'RESERVED' },
    })) === 1,
  );

  console.log('\n3. driver accepts');
  const driverAccept = await call(
    'POST',
    `/api/v1/drivers/me/assignments/${assignment.id}/accept`,
    driver.token,
    {},
  );
  check(
    'driver acceptance returns 200',
    driverAccept.status === 200,
    JSON.stringify(driverAccept.body),
  );
  let state = await readState(assignment.id, oldestAmbulance.id, driver.profile.id);
  check('assignment is ACCEPTED', state.assignment.status === 'ACCEPTED');
  check('ambulance is ASSIGNED', state.ambulance.status === 'ASSIGNED');
  check('driver is BUSY', state.driver.availabilityStatus === 'BUSY');
  check('startedAt is not set yet', state.assignment.startedAt === null);

  console.log('\n4. out-of-order and cross-driver guards');
  const outOfOrder = await tripStep(driver.token, assignment.id, 'ARRIVE_PICKUP');
  check('ARRIVE_PICKUP before START is 409', outOfOrder.status === 409, `${outOfOrder.status}`);
  check(
    'the conflict is ASSIGNMENT_STATUS_CONFLICT',
    outOfOrder.body?.error?.code === 'ASSIGNMENT_STATUS_CONFLICT',
    outOfOrder.body?.error?.code,
  );
  state = await readState(assignment.id, oldestAmbulance.id, driver.profile.id);
  check('the refused action mutated nothing', state.assignment.status === 'ACCEPTED');

  const crossDriver = await tripStep(otherDriver.token, assignment.id, 'START');
  check("another driver's assignment is 404", crossDriver.status === 404, `${crossDriver.status}`);
  check(
    'the cross-driver error is ASSIGNMENT_NOT_FOUND',
    crossDriver.body?.error?.code === 'ASSIGNMENT_NOT_FOUND',
    crossDriver.body?.error?.code,
  );

  console.log('\n5. START');
  const started = await tripStep(driver.token, assignment.id, 'START');
  check('START returns 200', started.status === 200, JSON.stringify(started.body));
  check('assignment is EN_ROUTE', started.body?.assignment?.status === 'EN_ROUTE');
  check(
    'emergency is DRIVER_EN_ROUTE',
    started.body?.assignment?.emergency?.currentStatus === 'DRIVER_EN_ROUTE',
    started.body?.assignment?.emergency?.currentStatus,
  );
  state = await readState(assignment.id, oldestAmbulance.id, driver.profile.id);
  check('ambulance is EN_ROUTE', state.ambulance.status === 'EN_ROUTE', state.ambulance.status);
  check('driver is still BUSY', state.driver.availabilityStatus === 'BUSY');
  check('startedAt is now set', state.assignment.startedAt !== null);
  check('endedAt is still null', state.assignment.endedAt === null);
  const startedAt = state.assignment.startedAt;
  check(
    'the newer ambulance was never touched',
    (await prisma.ambulance.findUniqueOrThrow({ where: { id: newerAmbulance.id } })).status ===
      'AVAILABLE',
  );

  console.log('\n6. availability guard while the trip is live');
  const selfAvailable = await call('PATCH', '/api/v1/drivers/me/availability', driver.token, {
    availabilityStatus: 'AVAILABLE',
  });
  check(
    'self-service availability change is 409',
    selfAvailable.status === 409,
    `${selfAvailable.status}`,
  );
  check(
    'the conflict is DRIVER_HAS_ACTIVE_ASSIGNMENT',
    selfAvailable.body?.error?.code === 'DRIVER_HAS_ACTIVE_ASSIGNMENT',
    selfAvailable.body?.error?.code,
  );
  check(
    'the driver is still BUSY',
    (await prisma.driverProfile.findUniqueOrThrow({ where: { id: driver.profile.id } }))
      .availabilityStatus === 'BUSY',
  );

  console.log('\n7. ARRIVE_PICKUP');
  const atPickup = await tripStep(driver.token, assignment.id, 'ARRIVE_PICKUP');
  check('ARRIVE_PICKUP returns 200', atPickup.status === 200, JSON.stringify(atPickup.body));
  check('assignment is AT_PICKUP', atPickup.body?.assignment?.status === 'AT_PICKUP');
  check(
    'emergency is AT_PICKUP',
    atPickup.body?.assignment?.emergency?.currentStatus === 'AT_PICKUP',
    atPickup.body?.assignment?.emergency?.currentStatus,
  );
  state = await readState(assignment.id, oldestAmbulance.id, driver.profile.id);
  check('ambulance stays EN_ROUTE', state.ambulance.status === 'EN_ROUTE');
  check('driver stays BUSY', state.driver.availabilityStatus === 'BUSY');
  check('startedAt is unchanged', state.assignment.startedAt?.getTime() === startedAt?.getTime());
  check('endedAt is still null', state.assignment.endedAt === null);

  console.log('\n8. START_TRANSPORT');
  const transporting = await tripStep(driver.token, assignment.id, 'START_TRANSPORT');
  check(
    'START_TRANSPORT returns 200',
    transporting.status === 200,
    JSON.stringify(transporting.body),
  );
  check('assignment is TRANSPORTING', transporting.body?.assignment?.status === 'TRANSPORTING');
  check(
    'emergency is TRANSPORTING',
    transporting.body?.assignment?.emergency?.currentStatus === 'TRANSPORTING',
    transporting.body?.assignment?.emergency?.currentStatus,
  );
  state = await readState(assignment.id, oldestAmbulance.id, driver.profile.id);
  check('ambulance stays EN_ROUTE', state.ambulance.status === 'EN_ROUTE');
  check('driver stays BUSY', state.driver.availabilityStatus === 'BUSY');
  check('endedAt is still null', state.assignment.endedAt === null);

  console.log('\n9. ARRIVE_HOSPITAL');
  const arrived = await tripStep(driver.token, assignment.id, 'ARRIVE_HOSPITAL');
  check('ARRIVE_HOSPITAL returns 200', arrived.status === 200, JSON.stringify(arrived.body));
  check('assignment is COMPLETED', arrived.body?.assignment?.status === 'COMPLETED');
  check(
    'emergency is AT_HOSPITAL, not COMPLETED',
    arrived.body?.assignment?.emergency?.currentStatus === 'AT_HOSPITAL',
    arrived.body?.assignment?.emergency?.currentStatus,
  );
  state = await readState(assignment.id, oldestAmbulance.id, driver.profile.id);
  check('endedAt is now set', state.assignment.endedAt !== null);
  check('startedAt is unchanged', state.assignment.startedAt?.getTime() === startedAt?.getTime());
  check(
    'the ambulance is AVAILABLE again',
    state.ambulance.status === 'AVAILABLE',
    state.ambulance.status,
  );
  check(
    'the driver is AVAILABLE again',
    state.driver.availabilityStatus === 'AVAILABLE',
    state.driver.availabilityStatus,
  );
  check('the emergency is not marked completed', state.emergency.completedAt === null);
  check(
    'the bed reservation is untouched by Task 1.22',
    (await prisma.bedReservation.count({
      where: { emergencyId: emergencyOneId, status: 'RESERVED' },
    })) === 1,
  );

  console.log('\n10. status history');
  const history = await prisma.emergencyStatusHistory.findMany({
    where: { emergencyId: emergencyOneId },
    orderBy: { occurredAt: 'asc' },
  });
  //  [0] null -> CREATED                                  (1.17, PATIENT)
  //  [1] CREATED -> SEARCHING_HOSPITAL                     (1.18, SYSTEM)
  //  [2] SEARCHING_HOSPITAL -> PENDING_HOSPITAL_RESPONSE   (1.18, SYSTEM)
  //  [3] PENDING_HOSPITAL_RESPONSE -> HOSPITAL_ACCEPTED    (1.19, HOSPITAL_STAFF)
  //  [4] HOSPITAL_ACCEPTED -> BED_RESERVED                 (1.20, HOSPITAL_STAFF)
  //  [5] BED_RESERVED -> AMBULANCE_ASSIGNED                (1.21, HOSPITAL_STAFF)
  //  [6] AMBULANCE_ASSIGNED -> PENDING_DRIVER_ACCEPTANCE   (1.21, HOSPITAL_STAFF)
  //  [7] PENDING_DRIVER_ACCEPTANCE -> DRIVER_EN_ROUTE      (1.22, DRIVER)
  //  [8] DRIVER_EN_ROUTE -> AT_PICKUP                      (1.22, DRIVER)
  //  [9] AT_PICKUP -> TRANSPORTING                          (1.22, DRIVER)
  // [10] TRANSPORTING -> AT_HOSPITAL                        (1.22, DRIVER)
  check('the emergency has eleven history rows', history.length === 11, `${history.length} rows`);
  const tripRows = history.slice(7);
  check(
    'the four trip rows are the expected transitions',
    JSON.stringify(tripRows.map((row) => [row.fromStatus, row.toStatus])) ===
      JSON.stringify([
        ['PENDING_DRIVER_ACCEPTANCE', 'DRIVER_EN_ROUTE'],
        ['DRIVER_EN_ROUTE', 'AT_PICKUP'],
        ['AT_PICKUP', 'TRANSPORTING'],
        ['TRANSPORTING', 'AT_HOSPITAL'],
      ]),
    JSON.stringify(tripRows.map((row) => [row.fromStatus, row.toStatus])),
  );
  check(
    'all four trip rows have actorType DRIVER',
    tripRows.every((row) => row.actorType === 'DRIVER'),
    tripRows.map((row) => row.actorType).join(','),
  );
  check(
    "all four trip rows record the driver's User id, not their DriverProfile id",
    tripRows.every((row) => row.actorUserId === driver.user.id) &&
      tripRows.every((row) => row.actorUserId !== driver.profile.id),
  );

  console.log('\n11. duplicate action after completion');
  const duplicate = await tripStep(driver.token, assignment.id, 'ARRIVE_HOSPITAL');
  check('a duplicate ARRIVE_HOSPITAL is 409', duplicate.status === 409, `${duplicate.status}`);
  check(
    'the duplicate conflict is ASSIGNMENT_STATUS_CONFLICT',
    duplicate.body?.error?.code === 'ASSIGNMENT_STATUS_CONFLICT',
    duplicate.body?.error?.code,
  );
  const failCompleted = await call(
    'POST',
    `/api/v1/drivers/me/assignments/${assignment.id}/fail`,
    driver.token,
    { failureReason: 'Too late.' },
  );
  check(
    'failing a COMPLETED assignment is 409',
    failCompleted.status === 409,
    `${failCompleted.status}`,
  );

  console.log('\n12. a second dispatch reuses the released driver, then fails');
  const patientTwo = await createPatient();
  const emergencyTwoId = await raiseSos(patientTwo.token);
  const bystanderOffer = await prisma.hospitalResponse.findFirstOrThrow({
    where: { emergencyId: emergencyTwoId, hospitalId: bystander.id },
  });
  const acceptedTwo = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${bystanderOffer.id}/accept`,
    bystanderStaff.token,
    {},
  );
  check(
    'second acceptance returns 200',
    acceptedTwo.status === 200,
    JSON.stringify(acceptedTwo.body),
  );
  check(
    'the released driver was dispatched again automatically',
    acceptedTwo.body?.response?.emergency?.currentStatus === 'PENDING_DRIVER_ACCEPTANCE',
    acceptedTwo.body?.response?.emergency?.currentStatus,
  );
  const secondAssignment = await prisma.ambulanceAssignment.findFirstOrThrow({
    where: { emergencyId: emergencyTwoId },
  });
  check('the same driver was reused', secondAssignment.driverId === driver.profile.id);
  check(
    "the bystander hospital's own ambulance was used",
    secondAssignment.ambulanceId === bystanderAmbulance.id,
  );

  await call(
    'POST',
    `/api/v1/drivers/me/assignments/${secondAssignment.id}/accept`,
    driver.token,
    {},
  );
  const startedTwo = await tripStep(driver.token, secondAssignment.id, 'START');
  check('second trip START returns 200', startedTwo.status === 200, `${startedTwo.status}`);

  const failedTrip = await call(
    'POST',
    `/api/v1/drivers/me/assignments/${secondAssignment.id}/fail`,
    driver.token,
    { failureReason: 'Vehicle broke down en route.' },
  );
  check('FAIL returns 200', failedTrip.status === 200, JSON.stringify(failedTrip.body));
  check('assignment is FAILED', failedTrip.body?.assignment?.status === 'FAILED');
  check(
    'the failure reason is stored in rejectionReason',
    failedTrip.body?.assignment?.rejectionReason === 'Vehicle broke down en route.',
    failedTrip.body?.assignment?.rejectionReason,
  );
  const failState = await readState(secondAssignment.id, bystanderAmbulance.id, driver.profile.id);
  check('endedAt is set on failure', failState.assignment.endedAt !== null);
  check(
    'the ambulance is released',
    failState.ambulance.status === 'AVAILABLE',
    failState.ambulance.status,
  );
  check('the driver is released', failState.driver.availabilityStatus === 'AVAILABLE');
  check(
    'the emergency status is unchanged by the failure',
    failState.emergency.currentStatus === 'DRIVER_EN_ROUTE',
    failState.emergency.currentStatus,
  );
  check(
    'the bed stays RESERVED after a failed trip',
    (await prisma.bedReservation.count({
      where: { emergencyId: emergencyTwoId, status: 'RESERVED' },
    })) === 1,
  );
  check(
    'no replacement assignment is created',
    (await prisma.ambulanceAssignment.count({ where: { emergencyId: emergencyTwoId } })) === 1,
  );

  console.log('\n13. resources freed by the failure are selectable again');
  const patientThree = await createPatient();
  const emergencyThreeId = await raiseSos(patientThree.token);
  const transportOfferThree = await prisma.hospitalResponse.findFirstOrThrow({
    where: { emergencyId: emergencyThreeId, hospitalId: transport.id },
  });
  const acceptedThree = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${transportOfferThree.id}/accept`,
    transportStaff.token,
    {},
  );
  check(
    'third acceptance returns 200',
    acceptedThree.status === 200,
    JSON.stringify(acceptedThree.body),
  );
  check(
    'a third automatic dispatch succeeded with the recycled resources',
    acceptedThree.body?.response?.emergency?.currentStatus === 'PENDING_DRIVER_ACCEPTANCE',
    acceptedThree.body?.response?.emergency?.currentStatus,
  );
  const thirdAssignment = await prisma.ambulanceAssignment.findFirstOrThrow({
    where: { emergencyId: emergencyThreeId },
  });
  check('the recycled driver was selected', thirdAssignment.driverId === driver.profile.id);
  check(
    'a recycled ambulance was selected',
    [oldestAmbulance.id, newerAmbulance.id].includes(thirdAssignment.ambulanceId),
    thirdAssignment.ambulanceId,
  );

  console.log('\n14. availability self-service works once nothing is live');
  await call('POST', `/api/v1/drivers/me/assignments/${thirdAssignment.id}/reject`, driver.token, {
    rejectionReason: 'Ending the smoke run.',
  });
  const offline = await call('PATCH', '/api/v1/drivers/me/availability', driver.token, {
    availabilityStatus: 'OFFLINE',
  });
  check('availability change is allowed again', offline.status === 200, `${offline.status}`);
  check(
    'the driver is OFFLINE',
    offline.body?.driverProfile?.availabilityStatus === 'OFFLINE',
    JSON.stringify(offline.body),
  );
};

/**
 * Ownership-scoped: this script deletes only rows it created. Offers that global Task 1.18
 * matching attached from another suite's emergency to a hospital created here are detached,
 * but those emergencies are left untouched. The detach runs twice — once up front and again
 * immediately before the resources are released — because a VERIFIED hospital with an AVAILABLE
 * bed stays globally eligible for matching until its last bed is gone.
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
