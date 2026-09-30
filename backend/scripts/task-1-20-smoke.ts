/**
 * Task 1.20 live HTTP smoke test — bed reservation on hospital acceptance.
 *
 * Temporary review helper, not part of the module: it lives outside src/, so it is neither
 * typechecked nor built (same treatment as prisma/seed-admin.ts). Delete it after review.
 *
 *   1. start the API in another terminal:  npm run dev --workspace=backend
 *   2. run:                                npm run smoke:task-1-20 --workspace=backend
 *
 * Fixtures are prefixed SMOKE2020 (phones '+1921'), chosen so they cannot collide with the
 * Task 1.18 smoke script ('SMOKE1818' / '+1919'), the Task 1.19 one ('SMOKE1919' / '+1920')
 * or any service test prefix. Cleanup is ownership-scoped and runs in `finally`.
 *
 * Determinism: three eligible hospitals are seeded at the exact pickup point (distance 0), so
 * they fill all HOSPITAL_MATCH_MAX_OFFERS (default 3) slots, and every assertion is made
 * against hospitals this script owns.
 */
import { BedStatus, HospitalStatus, PrismaClient, UserRole, UserStatus } from '@prisma/client';
import type { Hospital, User } from '@prisma/client';
import bcrypt from 'bcrypt';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const PREFIX = 'SMOKE2020';
const PHONE_PREFIX = '+1921';
const PASSWORD = 'a-very-strong-passphrase';
const PICKUP = { latitude: 41, longitude: 41 };

const prisma = new PrismaClient();

let passed = 0;
let failed = 0;
let counter = 0;

const nextPhone = (): string =>
  `${PHONE_PREFIX}${String(Date.now()).slice(-6)}${String(counter++).padStart(3, '0')}`;

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

/** A verified hospital sitting exactly at the pickup point. Beds are added separately. */
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

/**
 * createdAt is explicit so "the oldest AVAILABLE bed" is a fact of the fixture rather than a
 * race between two inserts landing in the same millisecond.
 */
const createBed = async (hospitalId: string, suffix: string, minutesOld: number) =>
  prisma.bed.create({
    data: {
      hospitalId,
      bedCode: `${PREFIX}-${suffix}-${counter++}`,
      status: BedStatus.AVAILABLE,
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
  console.log('\n1. seed three eligible hospitals at the pickup point');
  const winner = await createEligibleHospital('winner');
  const bystander = await createEligibleHospital('bystander');
  const dry = await createEligibleHospital('dry');
  const ownedHospitalIds = [winner.id, bystander.id, dry.id];

  // The winner holds two beds so the "oldest AVAILABLE bed" rule is observable.
  const winnerOldBed = await createBed(winner.id, 'winner-old', 60);
  const winnerNewBed = await createBed(winner.id, 'winner-new', 5);
  await createBed(bystander.id, 'bystander', 30);
  const dryBed = await createBed(dry.id, 'dry', 30);

  const winnerStaff = await createDispatcher(winner.id);
  const dryStaff = await createDispatcher(dry.id);
  const patientOne = await createPatient();

  console.log('\n2. first SOS and acceptance by a hospital that has capacity');
  const emergencyOneId = await raiseSos(patientOne.token);

  const offersOne = await prisma.hospitalResponse.findMany({
    where: { emergencyId: emergencyOneId, hospitalId: { in: ownedHospitalIds } },
  });
  check(
    'all three owned hospitals received an offer',
    offersOne.length === 3,
    `${offersOne.length} owned offers`,
  );
  const winnerOffer = offersOne.find((offer) => offer.hospitalId === winner.id);
  const bystanderOffer = offersOne.find((offer) => offer.hospitalId === bystander.id);
  check('the accepting hospital holds an offer', Boolean(winnerOffer));

  const accepted = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${winnerOffer?.id}/accept`,
    winnerStaff.token,
    {},
  );
  check('acceptance returns 200', accepted.status === 200, JSON.stringify(accepted.body));
  check('accepted offer is ACCEPTED', accepted.body?.response?.status === 'ACCEPTED');
  check(
    'the acceptance response already reports BED_RESERVED',
    accepted.body?.response?.emergency?.currentStatus === 'BED_RESERVED',
    accepted.body?.response?.emergency?.currentStatus,
  );

  console.log('\n3. the reservation the acceptance created');
  const reservations = await prisma.bedReservation.findMany({
    where: { emergencyId: emergencyOneId },
  });
  check(
    'exactly one reservation exists for the emergency',
    reservations.length === 1,
    `${reservations.length} reservations`,
  );
  const autoReservation = reservations[0];
  check('reservation status is RESERVED', autoReservation?.status === 'RESERVED');
  check(
    'the oldest available bed was taken',
    autoReservation?.bedId === winnerOldBed.id,
    `${autoReservation?.bedId}`,
  );
  check(
    'reservation is linked to the accepted response',
    autoReservation?.hospitalResponseId === winnerOffer?.id,
  );
  check(
    'the accepting staff member is recorded as the reserver',
    autoReservation?.reservedByUserId === winnerStaff.user.id,
    `${autoReservation?.reservedByUserId}`,
  );

  check(
    'the taken bed is RESERVED',
    (await prisma.bed.findUniqueOrThrow({ where: { id: winnerOldBed.id } })).status === 'RESERVED',
  );
  check(
    'the newer bed is untouched',
    (await prisma.bed.findUniqueOrThrow({ where: { id: winnerNewBed.id } })).status === 'AVAILABLE',
  );

  const listed = await call('GET', '/api/v1/hospitals/me/reservations', winnerStaff.token);
  check('reservations list returns 200', listed.status === 200, `${listed.status}`);
  check(
    'the automatic reservation is visible through the existing read API',
    Array.isArray(listed.body?.reservations) &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listed.body.reservations.some((entry: any) => entry.id === autoReservation?.id),
  );

  console.log('\n4. Task 1.19 withdrawal is unchanged');
  check(
    'the sibling PENDING offer became WITHDRAWN',
    (await prisma.hospitalResponse.findUniqueOrThrow({ where: { id: bystanderOffer!.id } }))
      .status === 'WITHDRAWN',
  );
  check(
    'no owned offer is left PENDING',
    (await prisma.hospitalResponse.count({
      where: {
        emergencyId: emergencyOneId,
        hospitalId: { in: ownedHospitalIds },
        status: 'PENDING',
      },
    })) === 0,
  );

  console.log('\n5. status history records acceptance and reservation separately');
  const history = await prisma.emergencyStatusHistory.findMany({
    where: { emergencyId: emergencyOneId },
    orderBy: { occurredAt: 'asc' },
  });
  // A patient-initiated SOS that is matched, accepted and bed-reserved produces five rows:
  //   [0] null -> CREATED                                 (Task 1.17, actorType PATIENT)
  //   [1] CREATED -> SEARCHING_HOSPITAL                   (Task 1.18, actorType SYSTEM)
  //   [2] SEARCHING_HOSPITAL -> PENDING_HOSPITAL_RESPONSE (Task 1.18, actorType SYSTEM)
  //   [3] PENDING_HOSPITAL_RESPONSE -> HOSPITAL_ACCEPTED  (Task 1.19, actorType HOSPITAL_STAFF)
  //   [4] HOSPITAL_ACCEPTED -> BED_RESERVED               (Task 1.20, actorType HOSPITAL_STAFF)
  check(
    'the emergency has five history rows after acceptance',
    history.length === 5,
    `${history.length} rows`,
  );
  const acceptanceRow = history[3];
  const reservationRow = history[4];
  check(
    'row 4 is PENDING_HOSPITAL_RESPONSE -> HOSPITAL_ACCEPTED',
    acceptanceRow?.fromStatus === 'PENDING_HOSPITAL_RESPONSE' &&
      acceptanceRow?.toStatus === 'HOSPITAL_ACCEPTED',
    `${acceptanceRow?.fromStatus} -> ${acceptanceRow?.toStatus}`,
  );
  check(
    'row 5 is HOSPITAL_ACCEPTED -> BED_RESERVED',
    reservationRow?.fromStatus === 'HOSPITAL_ACCEPTED' &&
      reservationRow?.toStatus === 'BED_RESERVED',
    `${reservationRow?.fromStatus} -> ${reservationRow?.toStatus}`,
  );
  check(
    'the reservation row is attributed to the accepting staff member',
    reservationRow?.actorType === 'HOSPITAL_STAFF' &&
      reservationRow?.actorUserId === winnerStaff.user.id,
    `${reservationRow?.actorType} / ${reservationRow?.actorUserId}`,
  );

  console.log('\n6. the manual reservation API is unchanged');
  const duplicateManual = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${winnerOffer?.id}/reservations`,
    winnerStaff.token,
    { bedId: winnerNewBed.id },
  );
  check(
    'manually reserving a second bed is 409',
    duplicateManual.status === 409,
    `${duplicateManual.status}`,
  );
  check(
    'the conflict is BED_RESERVATION_CONFLICT',
    duplicateManual.body?.error?.code === 'BED_RESERVATION_CONFLICT',
    duplicateManual.body?.error?.code,
  );

  const released = await call(
    'POST',
    `/api/v1/hospitals/me/reservations/${autoReservation?.id}/release`,
    winnerStaff.token,
    { releaseReason: 'Bed withdrawn for deep cleaning.' },
  );
  check(
    'releasing the automatic reservation is 200',
    released.status === 200,
    `${released.status}`,
  );
  check(
    'the emergency returns to HOSPITAL_ACCEPTED',
    (await prisma.emergencyRequest.findUniqueOrThrow({ where: { id: emergencyOneId } }))
      .currentStatus === 'HOSPITAL_ACCEPTED',
  );
  check(
    'the released bed is AVAILABLE again',
    (await prisma.bed.findUniqueOrThrow({ where: { id: winnerOldBed.id } })).status === 'AVAILABLE',
  );

  const manual = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${winnerOffer?.id}/reservations`,
    winnerStaff.token,
    { bedId: winnerNewBed.id },
  );
  check(
    'a manual reservation still returns 201',
    manual.status === 201,
    JSON.stringify(manual.body),
  );
  check('the manually chosen bed is honoured', manual.body?.reservation?.bedId === winnerNewBed.id);
  check(
    'the emergency is BED_RESERVED again',
    (await prisma.emergencyRequest.findUniqueOrThrow({ where: { id: emergencyOneId } }))
      .currentStatus === 'BED_RESERVED',
  );

  console.log('\n7. acceptance with no available bed');
  const patientTwo = await createPatient();
  const emergencyTwoId = await raiseSos(patientTwo.token);

  const dryOffer = await prisma.hospitalResponse.findFirstOrThrow({
    where: { emergencyId: emergencyTwoId, hospitalId: dry.id },
  });
  // The hospital's only bed goes out of service between the offer and the decision.
  await prisma.bed.updateMany({
    where: { hospitalId: dry.id },
    data: { status: BedStatus.OUT_OF_SERVICE },
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
    'the emergency stays HOSPITAL_ACCEPTED when no bed is free',
    acceptedDry.body?.response?.emergency?.currentStatus === 'HOSPITAL_ACCEPTED',
    acceptedDry.body?.response?.emergency?.currentStatus,
  );
  check(
    'the acceptance is not rolled back in the database',
    (await prisma.hospitalResponse.findUniqueOrThrow({ where: { id: dryOffer.id } })).status ===
      'ACCEPTED',
  );
  check(
    'no reservation row is invented',
    (await prisma.bedReservation.count({ where: { emergencyId: emergencyTwoId } })) === 0,
  );
  check(
    'the emergency has four history rows',
    (await prisma.emergencyStatusHistory.count({ where: { emergencyId: emergencyTwoId } })) === 4,
  );
  check(
    'no bed of the accepting hospital was touched',
    (await prisma.bed.count({
      where: { hospitalId: dry.id, status: { not: BedStatus.OUT_OF_SERVICE } },
    })) === 0,
  );

  console.log('\n8. the manual endpoint is the recovery path');
  await prisma.bed.update({ where: { id: dryBed.id }, data: { status: BedStatus.AVAILABLE } });
  const recovery = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${dryOffer.id}/reservations`,
    dryStaff.token,
    { bedId: dryBed.id },
  );
  check(
    'the recovery reservation returns 201',
    recovery.status === 201,
    JSON.stringify(recovery.body),
  );
  check(
    'the emergency reaches BED_RESERVED',
    (await prisma.emergencyRequest.findUniqueOrThrow({ where: { id: emergencyTwoId } }))
      .currentStatus === 'BED_RESERVED',
  );
};

/**
 * Ownership-scoped: this script deletes only rows it created. Offers that global Task 1.18
 * matching attached from another suite's emergency to a hospital created here are detached,
 * but those emergencies are left untouched. The detach runs twice — once up front and again
 * immediately before the beds and hospitals are deleted — because a VERIFIED hospital with an
 * AVAILABLE bed stays globally eligible for matching until its last bed is gone.
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

  await prisma.ambulance.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospitalStaffMembership.deleteMany({ where: { hospitalId: { in: hospitalIds } } });

  await detachOwnHospitalResponses();
  await prisma.bed.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  const residual =
    (await prisma.user.count({ where: { phone: { startsWith: PHONE_PREFIX } } })) +
    (await prisma.hospital.count({ where: { registrationNumber: { startsWith: PREFIX } } }));
  console.log(`\ncleanup: removed ${userIds.length} users and ${hospitalIds.length} hospitals`);
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
