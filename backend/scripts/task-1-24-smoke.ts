/**
 * Task 1.24 live HTTP smoke test — dispatch failure recovery, re-dispatch, escalation and timeouts.
 *
 * Temporary review helper, not part of the module: it lives outside src/, so it is neither
 * typechecked nor built (same treatment as prisma/seed-admin.ts). Delete it after review.
 *
 *   1. start the API in another terminal:  npm run dev --workspace=backend
 *   2. run:                                npm run smoke:task-1-24 --workspace=backend
 *
 * The timeout sections rely on the server's own periodic sweep: they move an assignment's
 * assignedAt into the past and wait (up to SMOKE_TIMEOUT_WAIT_SECONDS, default 60) for the running
 * API to cancel it. With the default DISPATCH_TIMEOUT_SWEEP_INTERVAL_SECONDS=15 that takes at most
 * one interval.
 *
 * Fixtures are prefixed SMOKE2424 (phones '+1925', licences 'L2424-'), chosen so they cannot
 * collide with the Task 1.16-1.23 smoke scripts or any service-test prefix.
 *
 * Determinism: hospitals sit at the exact pickup point (distance 0) and ambulances carry an
 * explicit createdAt. The driver pool is GLOBAL by design (DatabaseDesign.md sections 11 and
 * 12.3), so every driver here is dated more than a century into the past: that makes them the
 * oldest eligible rows in the database, which fixes selection and guarantees the script cannot
 * claim someone else's driver.
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
const TIMEOUT_WAIT_MS = Number(process.env.SMOKE_TIMEOUT_WAIT_SECONDS ?? 60) * 1000;
const PREFIX = 'SMOKE2424';
const PHONE_PREFIX = '+1925';
const LICENCE_PREFIX = 'L2424-';
const PASSWORD = 'a-very-strong-passphrase';
const PICKUP = { latitude: 46, longitude: 46 };

const prisma = new PrismaClient();

let passed = 0;
let failed = 0;
let counter = 0;

const nextPhone = (): string =>
  `${PHONE_PREFIX}${String(Date.now()).slice(-6)}${String(counter++).padStart(3, '0')}`;

/** More than a century in the past, so this script's drivers outrank every other driver. */
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

const createHospital = async (suffix: string): Promise<Hospital> =>
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

interface SmokeDriver {
  user: User;
  profile: DriverProfile;
  token: string;
}

const createDriver = async (years: number): Promise<SmokeDriver> => {
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

/** Raises an SOS and has `hospital` accept it, which holds a bed and dispatches attempt 1. */
const raiseAndAccept = async (
  hospital: Hospital,
  staffToken: string,
): Promise<{ emergencyId: string }> => {
  const patient = await createPatient();
  const emergencyId = await raiseSos(patient.token);
  const offer = await prisma.hospitalResponse.findFirstOrThrow({
    where: { emergencyId, hospitalId: hospital.id },
  });
  const accepted = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${offer.id}/accept`,
    staffToken,
    {},
  );
  check('acceptance returns 200', accepted.status === 200, JSON.stringify(accepted.body));
  return { emergencyId };
};

const attemptsOf = (emergencyId: string) =>
  prisma.ambulanceAssignment.findMany({
    where: { emergencyId },
    orderBy: { attemptNumber: 'asc' },
  });

const emergencyStatus = async (emergencyId: string): Promise<string> =>
  (await prisma.emergencyRequest.findUniqueOrThrow({ where: { id: emergencyId } })).currentStatus;

const ambulanceStatus = async (id: string): Promise<string> =>
  (await prisma.ambulance.findUniqueOrThrow({ where: { id } })).status;

const driverStatus = async (id: string): Promise<string> =>
  (await prisma.driverProfile.findUniqueOrThrow({ where: { id } })).availabilityStatus;

const reservationStatuses = async (emergencyId: string): Promise<string[]> =>
  (await prisma.bedReservation.findMany({ where: { emergencyId } })).map((row) => row.status);

const systemRows = async (emergencyId: string) =>
  prisma.emergencyStatusHistory.findMany({
    where: { emergencyId, actorType: 'SYSTEM', toStatus: { in: ['BED_RESERVED', 'ESCALATED'] } },
  });

const tripStep = async (token: string, assignmentId: string, action: string) =>
  call('POST', `/api/v1/drivers/me/assignments/${assignmentId}/status`, token, { action });

/** Moves an assignment's offer time into the past so the running server's sweep reclaims it. */
const backdate = async (assignmentId: string): Promise<void> => {
  await prisma.ambulanceAssignment.update({
    where: { id: assignmentId },
    data: { assignedAt: new Date(Date.now() - 60 * 60 * 1000) },
  });
};

const waitForStatus = async (assignmentId: string, status: string): Promise<boolean> => {
  const deadline = Date.now() + TIMEOUT_WAIT_MS;
  while (Date.now() < deadline) {
    const row = await prisma.ambulanceAssignment.findUniqueOrThrow({ where: { id: assignmentId } });
    if (row.status === status) return true;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return false;
};

/** Recovery runs as a follow-up of the cancelled assignment; give it a moment to commit. */
const waitForEmergency = async (emergencyId: string, status: string): Promise<boolean> => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if ((await emergencyStatus(emergencyId)) === status) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
};

const run = async (): Promise<void> => {
  console.log('\n1. seed hospitals, fleet and drivers');
  const transport = await createHospital('transport');
  const solo = await createHospital('solo');
  const bystander = await createHospital('bystander'); // no beds: never offered, never used

  await createBed(transport.id, 'bed-t1');
  await createBed(transport.id, 'bed-t2');
  await createBed(solo.id, 'bed-s1');

  const tA1 = await createAmbulance(transport.id, 'amb-t1', 240);
  const tA2 = await createAmbulance(transport.id, 'amb-t2', 180);
  const tA3 = await createAmbulance(transport.id, 'amb-t3', 120);
  const sA1 = await createAmbulance(solo.id, 'amb-s1', 240);
  const bystanderAmbulance = await createAmbulance(bystander.id, 'amb-b1', 10_000);

  const transportStaff = await createDispatcher(transport.id);
  const soloStaff = await createDispatcher(solo.id);

  // Oldest first: d1 is always the preferred driver unless it is busy or excluded.
  const d1 = await createDriver(130);
  const d2 = await createDriver(129);
  const d3 = await createDriver(128);
  const d4 = await createDriver(127);

  console.log('\n2. attempt 1: SOS -> acceptance -> automatic bed + ambulance');
  const { emergencyId: e1 } = await raiseAndAccept(transport, transportStaff.token);
  let attempts = await attemptsOf(e1);
  check('one attempt exists', attempts.length === 1, `${attempts.length}`);
  check('attempt 1 uses the oldest ambulance', attempts[0]?.ambulanceId === tA1.id);
  check('attempt 1 uses the oldest driver', attempts[0]?.driverId === d1.profile.id);
  check(
    'emergency is PENDING_DRIVER_ACCEPTANCE',
    (await emergencyStatus(e1)) === 'PENDING_DRIVER_ACCEPTANCE',
  );

  console.log('\n3. driver rejection -> automatic re-dispatch as attempt 2');
  const rejected = await call(
    'POST',
    `/api/v1/drivers/me/assignments/${attempts[0]!.id}/reject`,
    d1.token,
    { rejectionReason: 'Vehicle fault' },
  );
  check('rejection returns 200', rejected.status === 200, JSON.stringify(rejected.body));
  check('the rejected attempt is REJECTED', rejected.body?.assignment?.status === 'REJECTED');
  attempts = await attemptsOf(e1);
  check('a second attempt exists', attempts.length === 2, `${attempts.length}`);
  check('attempt 2 has attemptNumber 2', attempts[1]?.attemptNumber === 2);
  check('attempt 2 is OFFERED', attempts[1]?.status === 'OFFERED', attempts[1]?.status);
  check('attempt 2 excludes the used ambulance', attempts[1]?.ambulanceId === tA2.id);
  check('attempt 2 excludes the rejecting driver', attempts[1]?.driverId === d2.profile.id);
  check(
    'emergency is PENDING_DRIVER_ACCEPTANCE again',
    (await emergencyStatus(e1)) === 'PENDING_DRIVER_ACCEPTANCE',
  );
  check('the rejected ambulance is AVAILABLE', (await ambulanceStatus(tA1.id)) === 'AVAILABLE');
  check('the rejecting driver is AVAILABLE', (await driverStatus(d1.profile.id)) === 'AVAILABLE');
  check(
    'the reservation is still RESERVED',
    JSON.stringify(await reservationStatuses(e1)) === JSON.stringify(['RESERVED']),
  );
  let recoveryRows = await systemRows(e1);
  check(
    'one SYSTEM recovery row PENDING_DRIVER_ACCEPTANCE -> BED_RESERVED',
    recoveryRows.length === 1 &&
      recoveryRows[0]!.fromStatus === 'PENDING_DRIVER_ACCEPTANCE' &&
      recoveryRows[0]!.actorUserId === null,
    JSON.stringify(recoveryRows.map((row) => [row.fromStatus, row.toStatus, row.actorUserId])),
  );
  check(
    'the re-dispatch transitions are SYSTEM with no actor',
    (await prisma.emergencyStatusHistory.count({
      where: {
        emergencyId: e1,
        actorType: 'SYSTEM',
        actorUserId: null,
        toStatus: { in: ['AMBULANCE_ASSIGNED', 'PENDING_DRIVER_ACCEPTANCE'] },
      },
    })) === 2,
  );

  console.log('\n4. trip failure at AT_PICKUP -> automatic re-dispatch as attempt 3');
  const attempt2 = attempts[1]!;
  await call('POST', `/api/v1/drivers/me/assignments/${attempt2.id}/accept`, d2.token, {});
  check('START returns 200', (await tripStep(d2.token, attempt2.id, 'START')).status === 200);
  check(
    'ARRIVE_PICKUP returns 200',
    (await tripStep(d2.token, attempt2.id, 'ARRIVE_PICKUP')).status === 200,
  );
  const failedTrip = await call(
    'POST',
    `/api/v1/drivers/me/assignments/${attempt2.id}/fail`,
    d2.token,
    { failureReason: 'Engine failure at pickup.' },
  );
  check('FAIL returns 200', failedTrip.status === 200, JSON.stringify(failedTrip.body));
  attempts = await attemptsOf(e1);
  check('a third attempt exists', attempts.length === 3, `${attempts.length}`);
  check('attempt 2 is FAILED', attempts[1]?.status === 'FAILED');
  check('attempt 3 uses the last unused ambulance', attempts[2]?.ambulanceId === tA3.id);
  check(
    'attempt 3 skips both used drivers',
    attempts[2]?.driverId === d3.profile.id,
    attempts[2]?.driverId,
  );
  check('the failed ambulance is AVAILABLE', (await ambulanceStatus(tA2.id)) === 'AVAILABLE');
  recoveryRows = await systemRows(e1);
  check(
    'the failure recovery row leaves AT_PICKUP as SYSTEM',
    recoveryRows.some((row) => row.fromStatus === 'AT_PICKUP' && row.actorUserId === null),
  );

  console.log('\n5. attempt 3 offer timeout -> attempts exhausted -> ESCALATED');
  const attempt3 = attempts[2]!;
  await backdate(attempt3.id);
  check(
    "the server's sweep cancelled the stale offer",
    await waitForStatus(attempt3.id, 'CANCELLED'),
  );
  check(
    'the emergency is ESCALATED',
    await waitForEmergency(e1, 'ESCALATED'),
    await emergencyStatus(e1),
  );
  const cancelled = await prisma.ambulanceAssignment.findUniqueOrThrow({
    where: { id: attempt3.id },
  });
  check(
    'the cancellation reason names the timeout',
    cancelled.rejectionReason?.includes('timed out') === true,
  );
  check('endedAt is set on the cancelled offer', cancelled.endedAt !== null);
  check('the timed-out ambulance is AVAILABLE', (await ambulanceStatus(tA3.id)) === 'AVAILABLE');
  check('the timed-out driver is AVAILABLE', (await driverStatus(d3.profile.id)) === 'AVAILABLE');
  check('still exactly three attempts', (await attemptsOf(e1)).length === 3);
  check(
    'the reservation is kept on escalation',
    JSON.stringify(await reservationStatuses(e1)) === JSON.stringify(['RESERVED']),
  );
  check(
    'the hospital acceptance is kept',
    (
      await prisma.hospitalResponse.findFirstOrThrow({
        where: { emergencyId: e1, hospitalId: transport.id },
      })
    ).status === 'ACCEPTED',
  );
  const escalation = await prisma.emergencyStatusHistory.findFirst({
    where: { emergencyId: e1, toStatus: 'ESCALATED' },
  });
  check(
    'escalation is BED_RESERVED -> ESCALATED by SYSTEM',
    escalation?.fromStatus === 'BED_RESERVED' &&
      escalation.actorType === 'SYSTEM' &&
      escalation.actorUserId === null,
  );
  const lateAccept = await call(
    'POST',
    `/api/v1/drivers/me/assignments/${attempt3.id}/accept`,
    d3.token,
    {},
  );
  check('accepting the timed-out offer is 409', lateAccept.status === 409, `${lateAccept.status}`);
  const fourth = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${e1}/assignments`,
    transportStaff.token,
    { ambulanceId: tA1.id, driverId: d4.profile.id },
  );
  check('a fourth manual dispatch is 409', fourth.status === 409, `${fourth.status}`);
  check(
    'the refusal is DISPATCH_ATTEMPTS_EXHAUSTED',
    fourth.body?.error?.code === 'DISPATCH_ATTEMPTS_EXHAUSTED',
    fourth.body?.error?.code,
  );
  check(
    'the refused dispatch released the ambulance',
    (await ambulanceStatus(tA1.id)) === 'AVAILABLE',
  );

  console.log('\n6. accepted-but-never-started timeout -> no unused ambulance -> BED_RESERVED');
  const { emergencyId: e2 } = await raiseAndAccept(solo, soloStaff.token);
  attempts = await attemptsOf(e2);
  check('attempt 1 uses the solo ambulance', attempts[0]?.ambulanceId === sA1.id);
  const e2Driver = [d1, d2, d3, d4].find((driver) => driver.profile.id === attempts[0]?.driverId);
  check("attempt 1 went to one of this script's drivers", e2Driver !== undefined);
  const accepted2 = await call(
    'POST',
    `/api/v1/drivers/me/assignments/${attempts[0]!.id}/accept`,
    e2Driver!.token,
    {},
  );
  check('the driver accepts', accepted2.status === 200, `${accepted2.status}`);
  await backdate(attempts[0]!.id);
  check(
    "the server's sweep cancelled the accepted-but-idle trip",
    await waitForStatus(attempts[0]!.id, 'CANCELLED'),
  );
  check(
    'the emergency rests at BED_RESERVED',
    await waitForEmergency(e2, 'BED_RESERVED'),
    await emergencyStatus(e2),
  );
  check('no replacement without an unused ambulance', (await attemptsOf(e2)).length === 1);
  check('the solo ambulance is AVAILABLE again', (await ambulanceStatus(sA1.id)) === 'AVAILABLE');
  check(
    'it did not escalate',
    (await prisma.emergencyStatusHistory.count({
      where: { emergencyId: e2, toStatus: 'ESCALATED' },
    })) === 0,
  );
  check(
    "the bystander hospital's ambulance was never used",
    (await ambulanceStatus(bystanderAmbulance.id)) === 'AVAILABLE' &&
      (await prisma.ambulanceAssignment.count({
        where: { ambulanceId: bystanderAmbulance.id },
      })) === 0,
  );

  console.log('\n7. manual dispatch recovers it, then the full 1.22 trip and 1.23 admission');
  const manual = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${e2}/assignments`,
    soloStaff.token,
    { ambulanceId: sA1.id, driverId: d4.profile.id },
  );
  check('manual dispatch returns 201', manual.status === 201, JSON.stringify(manual.body));
  check('manual dispatch is attempt 2', manual.body?.assignment?.attemptNumber === 2);
  const manualId = manual.body?.assignment?.id as string;
  await call('POST', `/api/v1/drivers/me/assignments/${manualId}/accept`, d4.token, {});
  for (const action of ['START', 'ARRIVE_PICKUP', 'START_TRANSPORT', 'ARRIVE_HOSPITAL']) {
    const step = await tripStep(d4.token, manualId, action);
    check(`${action} returns 200`, step.status === 200, `${step.status}`);
  }
  check('the emergency is AT_HOSPITAL', (await emergencyStatus(e2)) === 'AT_HOSPITAL');
  const admitted = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${e2}/admit`,
    soloStaff.token,
    {},
  );
  check('admission returns 200', admitted.status === 200, JSON.stringify(admitted.body));
  check('the reservation is CONSUMED', admitted.body?.reservation?.status === 'CONSUMED');
  const completed = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${e2}/complete`,
    soloStaff.token,
    {},
  );
  check('completion returns 200', completed.status === 200, JSON.stringify(completed.body));
  check('the emergency is COMPLETED', (await emergencyStatus(e2)) === 'COMPLETED');

  console.log('\n8. concurrent duplicate rejections -> exactly one replacement');
  const { emergencyId: e3 } = await raiseAndAccept(transport, transportStaff.token);
  attempts = await attemptsOf(e3);
  check('attempt 1 exists', attempts.length === 1, `${attempts.length}`);
  const e3Driver = [d1, d2, d3, d4].find((driver) => driver.profile.id === attempts[0]?.driverId)!;
  const duplicateRejects = await Promise.all([
    call('POST', `/api/v1/drivers/me/assignments/${attempts[0]!.id}/reject`, e3Driver.token, {
      rejectionReason: 'Duplicate one',
    }),
    call('POST', `/api/v1/drivers/me/assignments/${attempts[0]!.id}/reject`, e3Driver.token, {
      rejectionReason: 'Duplicate two',
    }),
  ]);
  check(
    'one rejection succeeds and one is 409',
    JSON.stringify(duplicateRejects.map((res) => res.status).sort()) === JSON.stringify([200, 409]),
    JSON.stringify(duplicateRejects.map((res) => res.status)),
  );
  attempts = await attemptsOf(e3);
  check('exactly two attempts exist', attempts.length === 2, `${attempts.length}`);
  check(
    'exactly one live attempt',
    attempts.filter((attempt) => attempt.status === 'OFFERED').length === 1,
  );
  check(
    'exactly one recovery row',
    (await systemRows(e3)).filter((row) => row.toStatus === 'BED_RESERVED').length === 1,
  );

  console.log('\n9. reservation released mid-trip -> failure recovery stops safely');
  const replacement = attempts[1]!;
  const e3Driver2 = [d1, d2, d3, d4].find((driver) => driver.profile.id === replacement.driverId)!;
  await call(
    'POST',
    `/api/v1/drivers/me/assignments/${replacement.id}/accept`,
    e3Driver2.token,
    {},
  );
  await tripStep(e3Driver2.token, replacement.id, 'START');
  const reservation = await prisma.bedReservation.findFirstOrThrow({
    where: { emergencyId: e3, status: 'RESERVED' },
  });
  const released = await call(
    'POST',
    `/api/v1/hospitals/me/reservations/${reservation.id}/release`,
    transportStaff.token,
    { releaseReason: 'Bed needed elsewhere' },
  );
  check('the hospital released the bed mid-trip', released.status === 200, `${released.status}`);
  const failedNoBed = await call(
    'POST',
    `/api/v1/drivers/me/assignments/${replacement.id}/fail`,
    e3Driver2.token,
    { failureReason: 'Breakdown.' },
  );
  check('FAIL still returns 200', failedNoBed.status === 200, `${failedNoBed.status}`);
  check(
    'the emergency is left at DRIVER_EN_ROUTE',
    (await emergencyStatus(e3)) === 'DRIVER_EN_ROUTE',
  );
  check('no replacement attempt without a reservation', (await attemptsOf(e3)).length === 2);
};

/**
 * Ownership-scoped: this script deletes only rows it created, using the same detach-then-delete
 * order as the Task 1.22 and 1.23 smoke scripts.
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
