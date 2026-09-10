/**
 * Task 1.17 live HTTP smoke test.
 *
 * Temporary review helper, not part of the module: it lives outside src/, so it is neither
 * typechecked nor built (same treatment as prisma/seed-admin.ts). Delete it after review.
 *
 *   1. start the API in another terminal:  npm run dev --workspace=backend
 *   2. run:                                npx tsx backend/scripts/task-1-17-smoke.ts
 *
 * Every fixture is prefixed SMOKE1717 and removed in the finally block, including after a
 * failure. Nothing else in the database is touched.
 *
 * Authentication in this script:
 *   - ACTIVE users authenticate for real, through POST /api/v1/auth/login.
 *   - Inactive users (PENDING/REJECTED/SUSPENDED/DEACTIVATED) cannot log in by design —
 *     login rejects them with 403 INACTIVE_ACCOUNT (auth.service.ts). To prove that the
 *     EMERGENCY endpoint also rejects them, this script mints a genuine token for those
 *     fixtures with the production `signAccessToken` helper. The request then follows the
 *     real path: signature verified -> loadActivePrincipalFromClaims -> account-status
 *     check -> 403. Nothing about authentication is stubbed, weakened or bypassed.
 */
import { PrismaClient, UserRole, UserStatus } from '@prisma/client';
import type { User, PatientProfile } from '@prisma/client';
import bcrypt from 'bcrypt';
import { config as loadEnv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load backend/.env relative to this file so the script works from any working directory.
loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

// Imported after the environment is loaded: the JWT helper reads config at module load.
const { signAccessToken } = await import('../src/modules/auth/index.js');

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const PREFIX = 'SMOKE1717';
const PHONE_PREFIX = '+1991';
const PASSWORD = 'a-very-strong-passphrase';

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

interface CallResult {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

const call = async (
  method: string,
  path_: string,
  token?: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<CallResult> => {
  const res = await fetch(`${BASE_URL}${path_}`, {
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
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
};

const login = async (phone: string): Promise<string> => {
  const res = await call('POST', '/api/v1/auth/login', undefined, { phone, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed for ${phone}: ${res.status}`);
  return res.body.accessToken as string;
};

/**
 * ACTIVE fixtures authenticate through the real login endpoint. Inactive fixtures cannot —
 * that is the behaviour under test — so they receive a genuine signed token instead, which
 * is exactly what the account-status guard in requireAuth is meant to reject.
 */
const issueToken = async (user: User): Promise<string> =>
  user.status === UserStatus.ACTIVE
    ? login(user.phone)
    : signAccessToken({ userId: user.id, role: user.role });

const createPatient = async (
  options: { status?: UserStatus; withProfile?: boolean } = {},
): Promise<{
  user: User;
  phone: string;
  profile: PatientProfile | null;
  token: string;
}> => {
  const { status = UserStatus.ACTIVE, withProfile = true } = options;
  const phone = nextPhone();
  const user = await prisma.user.create({
    data: {
      phone,
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      role: UserRole.PATIENT,
      status,
      displayName: `${PREFIX} patient`,
      ...(withProfile
        ? {
            patientProfile: {
              create: {
                allergies: 'SMOKE-ALLERGY-MUST-NOT-LEAK',
                medicalSummary: 'SMOKE-SUMMARY-MUST-NOT-LEAK',
              },
            },
          }
        : {}),
    },
    include: { patientProfile: true },
  });

  return { user, phone, profile: user.patientProfile, token: await issueToken(user) };
};

const createNonPatient = async (role: UserRole): Promise<{ phone: string; token: string }> => {
  const phone = nextPhone();
  const user = await prisma.user.create({
    data: {
      phone,
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      role,
      status: UserStatus.ACTIVE,
      displayName: `${PREFIX} ${role}`,
    },
  });
  return { phone, token: await issueToken(user) };
};

const run = async (): Promise<void> => {
  console.log('\n1. active patient authentication');
  const patientA = await createPatient();
  const patientB = await createPatient();
  check('active patient login issues a token', Boolean(patientA.token));

  console.log('\n11. unauthorized access');
  check(
    'unauthenticated create is 401',
    (await call('POST', '/api/v1/patients/me/emergencies', undefined, {}, 'k1')).status === 401,
  );
  check(
    'unauthenticated list is 401',
    (await call('GET', '/api/v1/patients/me/emergencies')).status === 401,
  );
  check(
    'malformed token is 401',
    (await call('GET', '/api/v1/patients/me/emergencies', 'not-a-token')).status === 401,
  );

  const driver = await createNonPatient(UserRole.DRIVER);
  const staff = await createNonPatient(UserRole.HOSPITAL_STAFF);
  const admin = await createNonPatient(UserRole.ADMIN);
  check(
    'driver is 403',
    (await call('GET', '/api/v1/patients/me/emergencies', driver.token)).status === 403,
  );
  check(
    'hospital staff is 403',
    (await call('GET', '/api/v1/patients/me/emergencies', staff.token)).status === 403,
  );
  check(
    'system admin is 403',
    (await call('GET', '/api/v1/patients/me/emergencies', admin.token)).status === 403,
  );

  console.log('\n12. inactive patient rejection');
  for (const status of [
    UserStatus.PENDING,
    UserStatus.REJECTED,
    UserStatus.SUSPENDED,
    UserStatus.DEACTIVATED,
  ]) {
    const inactive = await createPatient({ status });

    // Login itself must still refuse the account: that guard is unchanged and re-asserted here.
    const loginRes = await call('POST', '/api/v1/auth/login', undefined, {
      phone: inactive.phone,
      password: PASSWORD,
    });
    check(
      `${status} patient cannot log in (403 INACTIVE_ACCOUNT)`,
      loginRes.status === 403 && loginRes.body?.error?.code === 'INACTIVE_ACCOUNT',
      `${loginRes.status} ${loginRes.body?.error?.code}`,
    );

    // With a validly signed token the request reaches the emergency endpoint, which must
    // still reject it on account status rather than on the token.
    const createRes = await call(
      'POST',
      '/api/v1/patients/me/emergencies',
      inactive.token,
      {},
      `k-${status}`,
    );
    check(
      `${status} patient create is 403 INACTIVE_ACCOUNT`,
      createRes.status === 403 && createRes.body?.error?.code === 'INACTIVE_ACCOUNT',
      `${createRes.status} ${createRes.body?.error?.code}`,
    );

    const listRes = await call('GET', '/api/v1/patients/me/emergencies', inactive.token);
    check(
      `${status} patient list is 403 INACTIVE_ACCOUNT`,
      listRes.status === 403 && listRes.body?.error?.code === 'INACTIVE_ACCOUNT',
      `${listRes.status} ${listRes.body?.error?.code}`,
    );

    check(
      `${status} patient created no emergency`,
      (await prisma.emergencyRequest.count({
        where: { patientId: inactive.profile!.id },
      })) === 0,
    );
  }

  const noProfile = await createPatient({ withProfile: false });
  const noProfileRes = await call(
    'POST',
    '/api/v1/patients/me/emergencies',
    noProfile.token,
    {},
    'k-noprofile',
  );
  check(
    'active patient without profile is 409 PATIENT_PROFILE_REQUIRED',
    noProfileRes.status === 409 && noProfileRes.body?.error?.code === 'PATIENT_PROFILE_REQUIRED',
    `${noProfileRes.status} ${noProfileRes.body?.error?.code}`,
  );

  console.log('\n2/3. emergency creation and CREATED status');
  const keyA = `sos-${Date.now()}`;
  const created = await call(
    'POST',
    '/api/v1/patients/me/emergencies',
    patientA.token,
    {
      description: 'Chest pain',
      pickupAddress: '12 Elm Street',
      pickupLatitude: 26.6,
      pickupLongitude: 74.03,
    },
    keyA,
  );
  check('create returns 201', created.status === 201, JSON.stringify(created.body));
  const emergencyId = created.body?.emergency?.id as string;
  check('status is CREATED', created.body?.emergency?.currentStatus === 'CREATED');
  check('requestType defaults to SOS', created.body?.emergency?.requestType === 'SOS');
  check('severity defaults to UNKNOWN', created.body?.emergency?.severity === 'UNKNOWN');
  check('idempotentReplay is false', created.body?.idempotentReplay === false);

  const history = await prisma.emergencyStatusHistory.findMany({ where: { emergencyId } });
  check('opening history row exists', history.length === 1);
  check('history actorType is PATIENT', history[0]?.actorType === 'PATIENT');
  check('history actorUserId is the patient', history[0]?.actorUserId === patientA.user.id);
  check('history fromStatus is null', history[0]?.fromStatus === null);

  console.log('\n4. idempotency replay');
  const replay = await call(
    'POST',
    '/api/v1/patients/me/emergencies',
    patientA.token,
    { description: 'ignored' },
    keyA,
  );
  check('replay returns 200', replay.status === 200, `${replay.status}`);
  check('replay returns the same emergency', replay.body?.emergency?.id === emergencyId);
  check('replay is flagged', replay.body?.idempotentReplay === true);
  check(
    'replay keeps the original description',
    replay.body?.emergency?.description === 'Chest pain',
  );
  check(
    'no duplicate emergency created',
    (await prisma.emergencyRequest.count({ where: { patientId: patientA.profile!.id } })) === 1,
  );

  const sharedKey = 'shared-client-key';
  const aShared = await call(
    'POST',
    '/api/v1/patients/me/emergencies',
    patientA.token,
    {},
    sharedKey,
  );
  const bShared = await call(
    'POST',
    '/api/v1/patients/me/emergencies',
    patientB.token,
    {},
    sharedKey,
  );
  check(
    'different patients may reuse a client key',
    aShared.status === 201 && bShared.status === 201,
    `${aShared.status}/${bShared.status}`,
  );
  check(
    'cross-patient keys do not collide',
    aShared.body?.emergency?.id !== bShared.body?.emergency?.id,
  );
  const storedB = await prisma.emergencyRequest.findUnique({
    where: { id: bShared.body.emergency.id },
  });
  check(
    'stored key is patient-namespaced',
    storedB?.idempotencyKey === `${patientB.profile!.id}:${sharedKey}`,
  );
  check('stored key fits the column', (storedB?.idempotencyKey?.length ?? 999) <= 128);

  const [raceOne, raceTwo] = await Promise.all([
    call('POST', '/api/v1/patients/me/emergencies', patientA.token, {}, 'race-key'),
    call('POST', '/api/v1/patients/me/emergencies', patientA.token, {}, 'race-key'),
  ]);
  const raceStatuses = [raceOne.status, raceTwo.status].sort();
  check(
    'concurrent duplicates yield one 201 and one 200',
    raceStatuses[0] === 200 && raceStatuses[1] === 201,
    raceStatuses.join(','),
  );
  check(
    'concurrent duplicates create exactly one record',
    (await prisma.emergencyRequest.count({
      where: { idempotencyKey: `${patientA.profile!.id}:race-key` },
    })) === 1,
  );

  console.log('\n5. patient list');
  const list = await call('GET', '/api/v1/patients/me/emergencies', patientA.token);
  check('list returns 200', list.status === 200);
  check(
    'list contains only own emergencies',
    list.body?.emergencies?.length === 3,
    `${list.body?.emergencies?.length}`,
  );

  console.log('\n6. patient single read');
  const read = await call(`GET`, `/api/v1/patients/me/emergencies/${emergencyId}`, patientA.token);
  check('read returns 200', read.status === 200);
  check('read returns the right emergency', read.body?.emergency?.id === emergencyId);

  console.log('\n7. cross-patient isolation');
  check(
    'other patient read is 404',
    (await call('GET', `/api/v1/patients/me/emergencies/${emergencyId}`, patientB.token)).status ===
      404,
  );
  check(
    'other patient cancel is 404',
    (
      await call(
        'POST',
        `/api/v1/patients/me/emergencies/${emergencyId}/cancel`,
        patientB.token,
        {},
      )
    ).status === 404,
  );

  console.log('\n8. strict validation');
  check(
    'missing Idempotency-Key is 400',
    (await call('POST', '/api/v1/patients/me/emergencies', patientA.token, {})).status === 400,
  );
  check(
    'malformed Idempotency-Key is 400',
    (await call('POST', '/api/v1/patients/me/emergencies', patientA.token, {}, 'has space'))
      .status === 400,
  );
  for (const field of [
    'patientId',
    'currentStatus',
    'id',
    'cancelledAt',
    'createdAt',
    'unknownField',
  ]) {
    check(
      `server-controlled field ${field} is rejected 400`,
      (
        await call(
          'POST',
          '/api/v1/patients/me/emergencies',
          patientA.token,
          { [field]: 'x' },
          `k-${field}`,
        )
      ).status === 400,
    );
  }
  check(
    'latitude 91 is rejected 400',
    (
      await call(
        'POST',
        '/api/v1/patients/me/emergencies',
        patientA.token,
        { pickupLatitude: 91 },
        'k-lat',
      )
    ).status === 400,
  );
  check(
    'longitude -181 is rejected 400',
    (
      await call(
        'POST',
        '/api/v1/patients/me/emergencies',
        patientA.token,
        { pickupLongitude: -181 },
        'k-lon',
      )
    ).status === 400,
  );
  check(
    'latitude 90 boundary is accepted',
    (
      await call(
        'POST',
        '/api/v1/patients/me/emergencies',
        patientA.token,
        { pickupLatitude: 90 },
        'k-lat90',
      )
    ).status === 201,
  );

  console.log('\n12b. response PII');
  for (const [label, payload] of [
    ['create', JSON.stringify(created.body)],
    ['list', JSON.stringify(list.body)],
    ['read', JSON.stringify(read.body)],
  ] as const) {
    check(`${label} payload hides allergies`, !payload.includes('SMOKE-ALLERGY-MUST-NOT-LEAK'));
    check(
      `${label} payload hides medical summary`,
      !payload.includes('SMOKE-SUMMARY-MUST-NOT-LEAK'),
    );
    check(`${label} payload hides passwordHash`, !payload.includes('passwordHash'));
    check(`${label} payload hides patientId`, !payload.includes('patientId'));
    check(`${label} payload hides idempotencyKey`, !payload.includes('idempotencyKey'));
    check(`${label} payload hides the patient phone`, !payload.includes(patientA.phone));
  }

  console.log('\n9/10. cancellation');
  const cancelled = await call(
    'POST',
    `/api/v1/patients/me/emergencies/${emergencyId}/cancel`,
    patientA.token,
    {},
  );
  check('cancel returns 200', cancelled.status === 200, JSON.stringify(cancelled.body));
  check('status is CANCELLED', cancelled.body?.emergency?.currentStatus === 'CANCELLED');
  check('cancelledAt is populated', Boolean(cancelled.body?.emergency?.cancelledAt));

  const cancelHistory = await prisma.emergencyStatusHistory.findMany({
    where: { emergencyId },
    orderBy: { occurredAt: 'asc' },
  });
  check('cancellation history appended', cancelHistory.length === 2);
  check('cancel history actorType is PATIENT', cancelHistory[1]?.actorType === 'PATIENT');
  check(
    'cancel history is CREATED -> CANCELLED',
    cancelHistory[1]?.fromStatus === 'CREATED' && cancelHistory[1]?.toStatus === 'CANCELLED',
  );
  check(
    'emergency row retained',
    (await prisma.emergencyRequest.findUnique({ where: { id: emergencyId } })) !== null,
  );

  check(
    'repeated cancellation is 409',
    (
      await call(
        'POST',
        `/api/v1/patients/me/emergencies/${emergencyId}/cancel`,
        patientA.token,
        {},
      )
    ).status === 409,
  );

  const laterState = await call(
    'POST',
    '/api/v1/patients/me/emergencies',
    patientA.token,
    {},
    'k-later',
  );
  await prisma.emergencyRequest.update({
    where: { id: laterState.body.emergency.id },
    data: { currentStatus: 'BED_RESERVED' },
  });
  const laterCancel = await call(
    'POST',
    `/api/v1/patients/me/emergencies/${laterState.body.emergency.id}/cancel`,
    patientA.token,
    {},
  );
  check('cancel from BED_RESERVED is 409', laterCancel.status === 409, `${laterCancel.status}`);
  check(
    'later-state emergency is untouched',
    (await prisma.emergencyRequest.findUnique({ where: { id: laterState.body.emergency.id } }))
      ?.cancelledAt === null,
  );
};

const cleanup = async (): Promise<number> => {
  const users = await prisma.user.findMany({
    where: { phone: { startsWith: PHONE_PREFIX } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);

  const profiles = await prisma.patientProfile.findMany({
    where: { userId: { in: userIds } },
    select: { id: true },
  });
  const profileIds = profiles.map((p) => p.id);

  const emergencies = await prisma.emergencyRequest.findMany({
    where: { patientId: { in: profileIds } },
    select: { id: true },
  });
  const emergencyIds = emergencies.map((e) => e.id);

  await prisma.emergencyStatusHistory.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.emergencyRequest.deleteMany({ where: { id: { in: emergencyIds } } });
  await prisma.patientProfile.deleteMany({ where: { id: { in: profileIds } } });
  const removed = await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  console.log(`\ncleanup: removed ${removed.count} users, ${emergencyIds.length} emergencies`);

  const residual =
    (await prisma.user.count({ where: { phone: { startsWith: PHONE_PREFIX } } })) +
    (await prisma.emergencyRequest.count({ where: { patientId: { in: profileIds } } }));
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
