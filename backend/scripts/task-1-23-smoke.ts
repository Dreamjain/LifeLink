/**
 * Task 1.23 live HTTP smoke test — hospital admission and emergency completion.
 *
 * Temporary review helper, not part of the module: it lives outside src/, so it is neither
 * typechecked nor built (same treatment as prisma/seed-admin.ts). Delete it after review.
 *
 *   1. start the API in another terminal:  npm run dev --workspace=backend
 *   2. run:                                npm run smoke:task-1-23 --workspace=backend
 *
 * Fixtures are prefixed SMOKE2323 (phones '+1924', licences 'L2323-'), chosen so they cannot
 * collide with the Task 1.18-1.22 smoke scripts or any service-test prefix.
 *
 * This script does NOT invent an artificial AT_HOSPITAL emergency: it drives the real Task 1.17
 * to 1.22 chain over HTTP and then admits and completes what arrives, so Task 1.23 is exercised
 * against the state its only upstream actually produces.
 *
 * Determinism: hospitals sit at the exact pickup point (distance 0) and the ambulance carries an
 * explicit createdAt. The driver pool is GLOBAL by design (DatabaseDesign.md sections 11 and
 * 12.3), so the driver here is dated decades into the past — that makes it the oldest eligible
 * row in the database, which fixes selection and guarantees the script cannot claim someone
 * else's driver.
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
import type { DriverProfile, Hospital, User } from '@prisma/client';
import bcrypt from 'bcrypt';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const PREFIX = 'SMOKE2323';
const PHONE_PREFIX = '+1924';
const LICENCE_PREFIX = 'L2323-';
const PASSWORD = 'a-very-strong-passphrase';
const PICKUP = { latitude: 45, longitude: 45 };

const prisma = new PrismaClient();

let passed = 0;
let failed = 0;
let counter = 0;

const nextPhone = (): string =>
  `${PHONE_PREFIX}${String(Date.now()).slice(-6)}${String(counter++).padStart(3, '0')}`;

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

const createAmbulance = async (hospitalId: string, suffix: string, minutesOld: number) =>
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

const run = async (): Promise<void> => {
  console.log('\n1. seed two eligible hospitals, a vehicle, a driver and a patient');
  const care = await createEligibleHospital('care');
  const other = await createEligibleHospital('other');
  await createBed(care.id, 'bed-care');
  await createBed(other.id, 'bed-other');
  const ambulance = await createAmbulance(care.id, 'amb-care', 90);

  const careStaff = await createDispatcher(care.id);
  const otherStaff = await createDispatcher(other.id);
  const driver = await createDriver(70);
  const patient = await createPatient();

  console.log('\n2. drive the Task 1.17-1.22 chain to AT_HOSPITAL');
  const sos = await call(
    'POST',
    '/api/v1/patients/me/emergencies',
    patient.token,
    { pickupLatitude: PICKUP.latitude, pickupLongitude: PICKUP.longitude },
    `sos-${Date.now()}-${counter++}`,
  );
  check('SOS returns 201', sos.status === 201, JSON.stringify(sos.body));
  const emergencyId = sos.body?.emergency?.id as string;

  const careOffer = await prisma.hospitalResponse.findFirstOrThrow({
    where: { emergencyId, hospitalId: care.id },
  });
  const accepted = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${careOffer.id}/accept`,
    careStaff.token,
    {},
  );
  check('acceptance returns 200', accepted.status === 200, JSON.stringify(accepted.body));
  check(
    'automatic bed reservation and dispatch ran',
    accepted.body?.response?.emergency?.currentStatus === 'PENDING_DRIVER_ACCEPTANCE',
    accepted.body?.response?.emergency?.currentStatus,
  );

  const assignment = await prisma.ambulanceAssignment.findFirstOrThrow({ where: { emergencyId } });
  const reservation = await prisma.bedReservation.findFirstOrThrow({ where: { emergencyId } });

  await call('POST', `/api/v1/drivers/me/assignments/${assignment.id}/accept`, driver.token, {});
  for (const action of ['START', 'ARRIVE_PICKUP', 'START_TRANSPORT', 'ARRIVE_HOSPITAL']) {
    const step = await call(
      'POST',
      `/api/v1/drivers/me/assignments/${assignment.id}/status`,
      driver.token,
      { action },
    );
    check(`trip step ${action} returns 200`, step.status === 200, JSON.stringify(step.body));
  }

  const arrived = await prisma.emergencyRequest.findUniqueOrThrow({ where: { id: emergencyId } });
  check(
    'the emergency is AT_HOSPITAL',
    arrived.currentStatus === 'AT_HOSPITAL',
    arrived.currentStatus,
  );
  check('completedAt is null before admission', arrived.completedAt === null);
  check(
    'the bed is still RESERVED',
    (await prisma.bed.findUniqueOrThrow({ where: { id: reservation.bedId } })).status ===
      'RESERVED',
  );
  check(
    'the reservation is still RESERVED',
    (await prisma.bedReservation.findUniqueOrThrow({ where: { id: reservation.id } })).status ===
      'RESERVED',
  );
  check(
    'the vehicle and driver were already released by Task 1.22',
    (await prisma.ambulance.findUniqueOrThrow({ where: { id: ambulance.id } })).status ===
      'AVAILABLE' &&
      (await prisma.driverProfile.findUniqueOrThrow({ where: { id: driver.profile.id } }))
        .availabilityStatus === 'AVAILABLE',
  );
  check(
    'eleven history rows at AT_HOSPITAL',
    (await prisma.emergencyStatusHistory.count({ where: { emergencyId } })) === 11,
    `${await prisma.emergencyStatusHistory.count({ where: { emergencyId } })} rows`,
  );

  console.log('\n3. a skipped transition and a foreign hospital are both refused');
  const skipped = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${emergencyId}/complete`,
    careStaff.token,
    {},
  );
  check('completing from AT_HOSPITAL is 409', skipped.status === 409, `${skipped.status}`);
  check(
    'the skip conflict is EMERGENCY_STATUS_CONFLICT',
    skipped.body?.error?.code === 'EMERGENCY_STATUS_CONFLICT',
    skipped.body?.error?.code,
  );

  const foreignAdmit = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${emergencyId}/admit`,
    otherStaff.token,
    {},
  );
  check("another hospital's admit is 404", foreignAdmit.status === 404, `${foreignAdmit.status}`);
  check(
    'the foreign error is EMERGENCY_NOT_FOUND',
    foreignAdmit.body?.error?.code === 'EMERGENCY_NOT_FOUND',
    foreignAdmit.body?.error?.code,
  );
  check(
    'the refused attempts changed nothing',
    (await prisma.emergencyRequest.findUniqueOrThrow({ where: { id: emergencyId } }))
      .currentStatus === 'AT_HOSPITAL',
  );

  console.log('\n4. admission');
  const admitted = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${emergencyId}/admit`,
    careStaff.token,
    {},
  );
  check('admission returns 200', admitted.status === 200, JSON.stringify(admitted.body));
  check('the emergency is ADMITTED', admitted.body?.emergency?.currentStatus === 'ADMITTED');
  check('the reservation is CONSUMED', admitted.body?.reservation?.status === 'CONSUMED');

  const afterAdmit = await prisma.emergencyRequest.findUniqueOrThrow({
    where: { id: emergencyId },
  });
  check('the stored emergency is ADMITTED', afterAdmit.currentStatus === 'ADMITTED');
  check('completedAt is still null after admission', afterAdmit.completedAt === null);
  check(
    'the bed is OCCUPIED',
    (await prisma.bed.findUniqueOrThrow({ where: { id: reservation.bedId } })).status ===
      'OCCUPIED',
  );
  check(
    'the reservation is CONSUMED in the database',
    (await prisma.bedReservation.findUniqueOrThrow({ where: { id: reservation.id } })).status ===
      'CONSUMED',
  );

  console.log('\n5. duplicate admission and release are both refused');
  const duplicateAdmit = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${emergencyId}/admit`,
    careStaff.token,
    {},
  );
  check('a duplicate admission is 409', duplicateAdmit.status === 409, `${duplicateAdmit.status}`);
  check(
    'the duplicate conflict is RESERVATION_STATUS_CONFLICT',
    duplicateAdmit.body?.error?.code === 'RESERVATION_STATUS_CONFLICT',
    duplicateAdmit.body?.error?.code,
  );

  const release = await call(
    'POST',
    `/api/v1/hospitals/me/reservations/${reservation.id}/release`,
    careStaff.token,
    {},
  );
  check(
    'releasing a CONSUMED reservation is still 409',
    release.status === 409,
    `${release.status}`,
  );
  check(
    'the bed stays OCCUPIED',
    (await prisma.bed.findUniqueOrThrow({ where: { id: reservation.bedId } })).status ===
      'OCCUPIED',
  );

  const foreignComplete = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${emergencyId}/complete`,
    otherStaff.token,
    {},
  );
  check(
    "another hospital's complete is 404",
    foreignComplete.status === 404,
    `${foreignComplete.status}`,
  );

  console.log('\n6. completion');
  const completed = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${emergencyId}/complete`,
    careStaff.token,
    {},
  );
  check('completion returns 200', completed.status === 200, JSON.stringify(completed.body));
  check('the emergency is COMPLETED', completed.body?.emergency?.currentStatus === 'COMPLETED');

  const afterComplete = await prisma.emergencyRequest.findUniqueOrThrow({
    where: { id: emergencyId },
  });
  check('the stored emergency is COMPLETED', afterComplete.currentStatus === 'COMPLETED');
  check('completedAt is populated', afterComplete.completedAt !== null);
  check('cancelledAt is untouched', afterComplete.cancelledAt === null);
  check(
    'the bed is still OCCUPIED after completion',
    (await prisma.bed.findUniqueOrThrow({ where: { id: reservation.bedId } })).status ===
      'OCCUPIED',
  );
  check(
    'the reservation is still CONSUMED after completion',
    (await prisma.bedReservation.findUniqueOrThrow({ where: { id: reservation.id } })).status ===
      'CONSUMED',
  );

  console.log('\n7. duplicate completion is refused and completedAt is not rewritten');
  const duplicateComplete = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${emergencyId}/complete`,
    careStaff.token,
    {},
  );
  check(
    'a duplicate completion is 409',
    duplicateComplete.status === 409,
    `${duplicateComplete.status}`,
  );
  check(
    'the duplicate conflict is EMERGENCY_STATUS_CONFLICT',
    duplicateComplete.body?.error?.code === 'EMERGENCY_STATUS_CONFLICT',
    duplicateComplete.body?.error?.code,
  );
  const unchanged = await prisma.emergencyRequest.findUniqueOrThrow({ where: { id: emergencyId } });
  check(
    'completedAt is unchanged by the refused duplicate',
    unchanged.completedAt?.getTime() === afterComplete.completedAt?.getTime(),
  );

  console.log('\n8. status history');
  const history = await prisma.emergencyStatusHistory.findMany({
    where: { emergencyId },
    orderBy: { occurredAt: 'asc' },
  });
  //  [0]-[6]  Tasks 1.17-1.21, up to PENDING_DRIVER_ACCEPTANCE
  //  [7]-[10] Task 1.22 driver trip, up to AT_HOSPITAL
  // [11] AT_HOSPITAL -> ADMITTED    (Task 1.23, HOSPITAL_STAFF)
  // [12] ADMITTED -> COMPLETED      (Task 1.23, HOSPITAL_STAFF)
  check('the emergency has thirteen history rows', history.length === 13, `${history.length} rows`);
  const admissionRow = history[11];
  const completionRow = history[12];
  check(
    'row 12 is AT_HOSPITAL -> ADMITTED',
    admissionRow?.fromStatus === 'AT_HOSPITAL' && admissionRow?.toStatus === 'ADMITTED',
    `${admissionRow?.fromStatus} -> ${admissionRow?.toStatus}`,
  );
  check(
    'row 13 is ADMITTED -> COMPLETED',
    completionRow?.fromStatus === 'ADMITTED' && completionRow?.toStatus === 'COMPLETED',
    `${completionRow?.fromStatus} -> ${completionRow?.toStatus}`,
  );
  check(
    'both Task 1.23 rows are HOSPITAL_STAFF transitions by the admitting staff member',
    admissionRow?.actorType === 'HOSPITAL_STAFF' &&
      completionRow?.actorType === 'HOSPITAL_STAFF' &&
      admissionRow?.actorUserId === careStaff.user.id &&
      completionRow?.actorUserId === careStaff.user.id,
    `${admissionRow?.actorType} / ${completionRow?.actorType}`,
  );
  check(
    'exactly one admission row and one completion row exist',
    history.filter((row) => row.toStatus === 'ADMITTED').length === 1 &&
      history.filter((row) => row.toStatus === 'COMPLETED').length === 1,
  );

  console.log('\n9. the patient sees the finished emergency');
  const patientView = await call(
    'GET',
    `/api/v1/patients/me/emergencies/${emergencyId}`,
    patient.token,
  );
  check('the patient read returns 200', patientView.status === 200, `${patientView.status}`);
  check(
    'the patient sees COMPLETED with a completedAt',
    patientView.body?.emergency?.currentStatus === 'COMPLETED' &&
      Boolean(patientView.body?.emergency?.completedAt),
    JSON.stringify(patientView.body?.emergency),
  );
};

/**
 * Ownership-scoped: this script deletes only rows it created. Offers that global Task 1.18
 * matching attached from another suite's emergency to a hospital created here are detached, but
 * those emergencies are left untouched. The detach runs twice — once up front and again
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
