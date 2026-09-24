/**
 * Task 1.19 live HTTP smoke test — competing-offer withdrawal.
 *
 * Temporary review helper, not part of the module: it lives outside src/, so it is neither
 * typechecked nor built (same treatment as prisma/seed-admin.ts). Delete it after review.
 *
 *   1. start the API in another terminal:  npm run dev --workspace=backend
 *   2. run:                                npm run smoke:task-1-19 --workspace=backend
 *
 * Fixtures are prefixed SMOKE1919 (phones '+1920'), chosen so they cannot collide with the
 * Task 1.18 smoke script ('SMOKE1818' / '+1919') or hospital-matching.service.test.ts
 * ('T1818-' / '+1818'). Cleanup is ownership-scoped and runs in `finally`.
 *
 * The script is deterministic on any development database: it seeds three eligible hospitals
 * at the exact pickup point (distance 0) so they always occupy the offer list, and asserts
 * only against the hospitals it owns.
 */
import { HospitalStatus, PrismaClient, UserRole, UserStatus } from '@prisma/client';
import type { Hospital, User } from '@prisma/client';
import bcrypt from 'bcrypt';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const PREFIX = 'SMOKE1919';
const PHONE_PREFIX = '+1920';
const PASSWORD = 'a-very-strong-passphrase';
const PICKUP = { latitude: 40, longitude: 40 };

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

/** A verified hospital sitting exactly at the pickup point, with one available bed. */
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
      beds: { create: { bedCode: `${PREFIX}-${suffix}-${counter++}` } },
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

const run = async (): Promise<void> => {
  console.log('\n1. seed three eligible hospitals and raise an SOS');
  const winner = await createEligibleHospital('winner');
  const loserOne = await createEligibleHospital('loser-one');
  const loserTwo = await createEligibleHospital('loser-two');
  const ownedHospitalIds = [winner.id, loserOne.id, loserTwo.id];

  const winnerStaff = await createDispatcher(winner.id);
  const loserStaff = await createDispatcher(loserOne.id);
  const patient = await createPatient();

  const sos = await call(
    'POST',
    '/api/v1/patients/me/emergencies',
    patient.token,
    { pickupLatitude: PICKUP.latitude, pickupLongitude: PICKUP.longitude },
    `sos-${Date.now()}`,
  );
  check('SOS returns 201', sos.status === 201, JSON.stringify(sos.body));
  const emergencyId = sos.body?.emergency?.id as string;
  check(
    'matched emergency is PENDING_HOSPITAL_RESPONSE',
    sos.body?.emergency?.currentStatus === 'PENDING_HOSPITAL_RESPONSE',
    sos.body?.emergency?.currentStatus,
  );

  console.log('\n2. multiple PENDING offers exist');
  const ownedOffers = await prisma.hospitalResponse.findMany({
    where: { emergencyId, hospitalId: { in: ownedHospitalIds } },
  });
  check(
    'all three owned hospitals received an offer',
    ownedOffers.length === 3,
    `${ownedOffers.length} owned offers`,
  );
  check(
    'every owned offer starts PENDING',
    ownedOffers.every((offer) => offer.status === 'PENDING'),
  );
  const winnerOffer = ownedOffers.find((offer) => offer.hospitalId === winner.id);
  const loserOneOffer = ownedOffers.find((offer) => offer.hospitalId === loserOne.id);
  const loserTwoOffer = ownedOffers.find((offer) => offer.hospitalId === loserTwo.id);
  check('the winning hospital holds an offer', Boolean(winnerOffer));

  console.log('\n3. a sibling hospital rejects before the acceptance');
  const rejected = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${loserOneOffer?.id}/reject`,
    loserStaff.token,
    { rejectionReason: 'No ICU capacity.' },
  );
  check('sibling rejection returns 200', rejected.status === 200, `${rejected.status}`);
  check('sibling offer is REJECTED', rejected.body?.response?.status === 'REJECTED');

  console.log('\n4. authorized hospital accepts its own offer');
  const accepted = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${winnerOffer?.id}/accept`,
    winnerStaff.token,
    {},
  );
  check('acceptance returns 200', accepted.status === 200, JSON.stringify(accepted.body));
  check('accepted offer is ACCEPTED', accepted.body?.response?.status === 'ACCEPTED');

  console.log('\n5. lifecycle effects');
  const storedWinner = await prisma.hospitalResponse.findUniqueOrThrow({
    where: { id: winnerOffer!.id },
  });
  check('accepted offer stays ACCEPTED in the database', storedWinner.status === 'ACCEPTED');
  check(
    'accepted offer records the responding staff member',
    storedWinner.responseByUserId === winnerStaff.user.id,
  );

  const storedLoserTwo = await prisma.hospitalResponse.findUniqueOrThrow({
    where: { id: loserTwoOffer!.id },
  });
  check(
    'PENDING sibling became WITHDRAWN',
    storedLoserTwo.status === 'WITHDRAWN',
    storedLoserTwo.status,
  );
  check('withdrawn sibling has no responder', storedLoserTwo.responseByUserId === null);
  check('withdrawn sibling has no respondedAt', storedLoserTwo.respondedAt === null);
  check('withdrawn sibling has no rejectionReason', storedLoserTwo.rejectionReason === null);

  const storedLoserOne = await prisma.hospitalResponse.findUniqueOrThrow({
    where: { id: loserOneOffer!.id },
  });
  check('already REJECTED sibling stays REJECTED', storedLoserOne.status === 'REJECTED');
  check('rejected sibling keeps its reason', storedLoserOne.rejectionReason === 'No ICU capacity.');

  check(
    'no owned offer is left PENDING',
    (await prisma.hospitalResponse.count({
      where: { emergencyId, hospitalId: { in: ownedHospitalIds }, status: 'PENDING' },
    })) === 0,
  );

  const emergency = await prisma.emergencyRequest.findUniqueOrThrow({ where: { id: emergencyId } });
  check('emergency is HOSPITAL_ACCEPTED', emergency.currentStatus === 'HOSPITAL_ACCEPTED');

  const history = await prisma.emergencyStatusHistory.findMany({
    where: { emergencyId },
    orderBy: { occurredAt: 'asc' },
  });
  // A patient-initiated SOS that is matched and then accepted produces four rows:
  //   [0] null -> CREATED                                (Task 1.17, actorType PATIENT)
  //   [1] CREATED -> SEARCHING_HOSPITAL                  (Task 1.18, actorType SYSTEM)
  //   [2] SEARCHING_HOSPITAL -> PENDING_HOSPITAL_RESPONSE (Task 1.18, actorType SYSTEM)
  //   [3] PENDING_HOSPITAL_RESPONSE -> HOSPITAL_ACCEPTED  (Task 1.19, actorType HOSPITAL_STAFF)
  // Sibling withdrawals add none, so Task 1.19 contributes exactly row [3].
  check(
    'the emergency has four history rows after acceptance',
    history.length === 4,
    `${history.length} rows`,
  );

  const openingRow = history[0];
  check(
    'opening row is null -> CREATED by the patient',
    openingRow?.fromStatus === null &&
      openingRow?.toStatus === 'CREATED' &&
      openingRow?.actorType === 'PATIENT',
    `${openingRow?.fromStatus} -> ${openingRow?.toStatus} (${openingRow?.actorType})`,
  );
  check(
    'both matching rows are SYSTEM transitions',
    history[1]?.fromStatus === 'CREATED' &&
      history[1]?.toStatus === 'SEARCHING_HOSPITAL' &&
      history[1]?.actorType === 'SYSTEM' &&
      history[2]?.fromStatus === 'SEARCHING_HOSPITAL' &&
      history[2]?.toStatus === 'PENDING_HOSPITAL_RESPONSE' &&
      history[2]?.actorType === 'SYSTEM',
  );

  const acceptanceRow = history[3];
  check(
    'acceptance history is PENDING_HOSPITAL_RESPONSE -> HOSPITAL_ACCEPTED',
    acceptanceRow?.fromStatus === 'PENDING_HOSPITAL_RESPONSE' &&
      acceptanceRow?.toStatus === 'HOSPITAL_ACCEPTED',
    `${acceptanceRow?.fromStatus} -> ${acceptanceRow?.toStatus}`,
  );
  check(
    'acceptance history actorType is HOSPITAL_STAFF',
    acceptanceRow?.actorType === 'HOSPITAL_STAFF',
    `${acceptanceRow?.actorType}`,
  );
  check(
    'acceptance history records the accepting staff member',
    acceptanceRow?.actorUserId === winnerStaff.user.id,
  );

  console.log('\n6. duplicate and post-withdrawal decisions');
  const duplicate = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${winnerOffer?.id}/accept`,
    winnerStaff.token,
    {},
  );
  check('duplicate acceptance is 409', duplicate.status === 409, `${duplicate.status}`);
  check(
    'duplicate acceptance reports a response status conflict',
    duplicate.body?.error?.code === 'HOSPITAL_RESPONSE_STATUS_CONFLICT',
    duplicate.body?.error?.code,
  );
  check(
    'the emergency still has exactly one accepted offer',
    (await prisma.hospitalResponse.count({ where: { emergencyId, status: 'ACCEPTED' } })) === 1,
  );
  check(
    'a duplicate acceptance adds no history row',
    (await prisma.emergencyStatusHistory.count({ where: { emergencyId } })) === history.length,
  );

  const loserTwoStaff = await createDispatcher(loserTwo.id);
  const acceptWithdrawn = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${loserTwoOffer?.id}/accept`,
    loserTwoStaff.token,
    {},
  );
  check(
    'accepting a WITHDRAWN offer is 409',
    acceptWithdrawn.status === 409,
    `${acceptWithdrawn.status}`,
  );
  const rejectWithdrawn = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${loserTwoOffer?.id}/reject`,
    loserTwoStaff.token,
    { rejectionReason: 'Too late.' },
  );
  check(
    'rejecting a WITHDRAWN offer is 409',
    rejectWithdrawn.status === 409,
    `${rejectWithdrawn.status}`,
  );

  console.log('\n7. ownership isolation is unchanged');
  const crossHospital = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${winnerOffer?.id}/accept`,
    loserStaff.token,
    {},
  );
  check("another hospital's offer is 404", crossHospital.status === 404, `${crossHospital.status}`);
  const unauthenticated = await call(
    'POST',
    `/api/v1/hospitals/me/responses/${winnerOffer?.id}/accept`,
    undefined,
    {},
  );
  check('unauthenticated acceptance is 401', unauthenticated.status === 401);
  check(
    'patient cannot accept an offer',
    (
      await call(
        'POST',
        `/api/v1/hospitals/me/responses/${winnerOffer?.id}/accept`,
        patient.token,
        {},
      )
    ).status === 403,
  );
};

/**
 * Ownership-scoped: this script deletes only rows it created. Offers that global Task 1.18
 * matching attached from another suite's emergency to a hospital created here are detached,
 * but those emergencies are left untouched.
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

  await prisma.bed.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.ambulance.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospitalStaffMembership.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
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
