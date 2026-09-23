/**
 * Task 1.18 live HTTP smoke test.
 *
 * Start the API first: npm run dev --workspace=backend
 * Then run:        npx tsx backend/scripts/task-1-18-smoke.ts
 *
 * Fixtures are prefixed SMOKE1818 (phones '+1919') and removed in finally.
 *
 * The script is deterministic on any development database. The zero-match checks need a
 * database with no pre-existing eligible hospital, so they are SKIPPED — never failed — when
 * one already exists. The matching checks seed a hospital at the exact pickup coordinates
 * (distance 0), so its rank-1 position does not depend on what else is in the database.
 */
import { PrismaClient, HospitalStatus, UserRole, UserStatus } from '@prisma/client';
import bcrypt from 'bcrypt';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const PREFIX = 'SMOKE1818';
// Distinct from hospital-matching.service.test.ts, which owns '+1818': a shared prefix
// would make this script and that suite delete each other's fixtures.
const PHONE_PREFIX = '+1919';
const PASSWORD = 'a-very-strong-passphrase';
const prisma = new PrismaClient();

let passed = 0;
let failed = 0;
let skipped = 0;

const MAX_OFFERS = Number(process.env.HOSPITAL_MATCH_MAX_OFFERS ?? 3);

const skip = (name: string, why: string): void => {
  skipped += 1;
  console.log(`  SKIP  ${name} -> ${why}`);
};
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
    // A failed smoke assertion prints the status even when a body cannot be decoded.
  }
  return { status: response.status, body: json as any };
};

const createPatient = async () => {
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
  const login = await call('POST', '/api/v1/auth/login', undefined, { phone, password: PASSWORD });
  if (login.status !== 200) throw new Error(`patient login failed: ${login.status}`);
  return { user, token: login.body.accessToken as string };
};

const createEligibleHospital = async (suffix: string, latitude: number, longitude: number) =>
  prisma.hospital.create({
    data: {
      name: `${PREFIX} eligible ${suffix}`,
      registrationNumber: `${PREFIX}-${suffix}-${Date.now()}`,
      phone: '+15550000000',
      addressLine: '1 Smoke Test Street',
      city: 'Smoke City',
      state: 'SC',
      postalCode: '10001',
      latitude,
      longitude,
      status: HospitalStatus.VERIFIED,
      beds: { create: { bedCode: `${PREFIX}-${suffix}` } },
    },
  });

const run = async (): Promise<void> => {
  console.log('\n1. zero eligible hospitals');
  const existingEligibleHospitals = await prisma.hospital.count({
    where: { status: HospitalStatus.VERIFIED, beds: { some: { status: 'AVAILABLE' } } },
  });
  const pristine = existingEligibleHospitals === 0;

  if (pristine) {
    const zeroPatient = await createPatient();
    const zero = await call(
      'POST',
      '/api/v1/patients/me/emergencies',
      zeroPatient.token,
      { pickupLatitude: 10, pickupLongitude: 10 },
      'zero-match',
    );
    check('zero-match SOS returns 201', zero.status === 201, `${zero.status}`);
    const zeroEmergencyId = zero.body?.emergency?.id as string;
    check(
      'zero-match emergency remains CREATED',
      zero.body?.emergency?.currentStatus === 'CREATED',
    );
    check(
      'zero-match creates no responses',
      (await prisma.hospitalResponse.count({ where: { emergencyId: zeroEmergencyId } })) === 0,
    );
  } else {
    // Not a failure: zero-match behaviour is asserted against controlled fixtures in
    // hospital-matching.service.test.ts. This database simply is not in a zero-match state.
    skip(
      'zero-match checks',
      `database already has ${existingEligibleHospitals} eligible hospital(s)`,
    );
  }

  console.log('\n2. active patient SOS matching');
  // Exactly at the pickup point: distance 0, so no pre-existing hospital can outrank it.
  const nearHospital = await createEligibleHospital('near', 10, 10);
  const farHospital = await createEligibleHospital('far', 10.2, 10);
  const ineligibleHospital = await prisma.hospital.create({
    data: {
      name: `${PREFIX} ineligible`,
      registrationNumber: `${PREFIX}-ineligible-${Date.now()}`,
      phone: '+15550000001',
      addressLine: '2 Smoke Test Street',
      city: 'Smoke City',
      state: 'SC',
      postalCode: '10002',
      status: HospitalStatus.PENDING_VERIFICATION,
      beds: { create: { bedCode: `${PREFIX}-ineligible` } },
    },
  });
  const patient = await createPatient();
  check('active patient authentication returns a token', Boolean(patient.token));
  const created = await call(
    'POST',
    '/api/v1/patients/me/emergencies',
    patient.token,
    { pickupLatitude: 10, pickupLongitude: 10, description: 'Smoke SOS' },
    'matched-sos',
  );
  const emergencyId = created.body?.emergency?.id as string;
  check('matched SOS returns 201', created.status === 201, `${created.status}`);
  check(
    'matched emergency reaches PENDING_HOSPITAL_RESPONSE',
    created.body?.emergency?.currentStatus === 'PENDING_HOSPITAL_RESPONSE',
  );
  const responses = await prisma.hospitalResponse.findMany({
    where: { emergencyId },
    orderBy: { rank: 'asc' },
  });
  check(
    'offers are created and bounded by HOSPITAL_MATCH_MAX_OFFERS',
    responses.length >= 1 && responses.length <= MAX_OFFERS,
    `${responses.length} offers, limit ${MAX_OFFERS}`,
  );
  check(
    'responses are PENDING',
    responses.every((response) => response.status === 'PENDING'),
  );
  check(
    'the hospital at the pickup point is ranked first',
    responses[0]?.hospitalId === nearHospital.id,
  );
  check(
    'ineligible hospital is excluded',
    !responses.some((response) => response.hospitalId === ineligibleHospital.id),
  );
  if (pristine) {
    check(
      'both seeded eligible hospitals receive an offer in distance order',
      responses.length === 2 && responses[1]?.hospitalId === farHospital.id,
      `${responses.length} offers`,
    );
  } else {
    skip('exact offer set', 'other eligible hospitals exist in this database');
  }
  const history = await prisma.emergencyStatusHistory.findMany({
    where: { emergencyId },
    orderBy: { occurredAt: 'asc' },
  });
  check(
    'system history records both matching transitions',
    history.length === 3 &&
      history[1]?.fromStatus === 'CREATED' &&
      history[1]?.toStatus === 'SEARCHING_HOSPITAL' &&
      history[2]?.fromStatus === 'SEARCHING_HOSPITAL' &&
      history[2]?.toStatus === 'PENDING_HOSPITAL_RESPONSE' &&
      history[1]?.actorType === 'SYSTEM' &&
      history[2]?.actorType === 'SYSTEM',
  );

  const replay = await call(
    'POST',
    '/api/v1/patients/me/emergencies',
    patient.token,
    { description: 'ignored on replay' },
    'matched-sos',
  );
  check('idempotent SOS replay returns 200', replay.status === 200, `${replay.status}`);
  check(
    'idempotent SOS replay returns the same emergency',
    replay.body?.emergency?.id === emergencyId,
  );
  check(
    'idempotent replay creates no duplicate hospital responses',
    (await prisma.hospitalResponse.count({ where: { emergencyId } })) === responses.length,
  );
};

const cleanup = async (): Promise<number> => {
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: PHONE_PREFIX } },
    select: { id: true, patientProfile: { select: { id: true } } },
  });
  const profileIds = users.flatMap((user) => (user.patientProfile ? [user.patientProfile.id] : []));
  const emergencies = await prisma.emergencyRequest.findMany({
    where: { patientId: { in: profileIds } },
    select: { id: true },
  });
  const emergencyIds = emergencies.map((emergency) => emergency.id);
  const hospitals = await prisma.hospital.findMany({
    where: { registrationNumber: { startsWith: PREFIX } },
    select: { id: true },
  });
  const hospitalIds = hospitals.map((hospital) => hospital.id);

  await prisma.emergencyStatusHistory.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.hospitalResponse.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.emergencyRequest.deleteMany({ where: { id: { in: emergencyIds } } });
  await prisma.patientProfile.deleteMany({ where: { id: { in: profileIds } } });
  await prisma.user.deleteMany({ where: { id: { in: users.map((user) => user.id) } } });
  await prisma.bed.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });

  const residual =
    (await prisma.user.count({ where: { phone: { startsWith: PHONE_PREFIX } } })) +
    (await prisma.hospital.count({ where: { registrationNumber: { startsWith: PREFIX } } }));
  console.log(`\nresidual smoke rows: ${residual}`);
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

console.log(
  `\npassed: ${passed}   failed: ${failed}   skipped: ${skipped}   residual fixtures: ${residual}`,
);
process.exit(failed === 0 && residual === 0 ? 0 : 1);
