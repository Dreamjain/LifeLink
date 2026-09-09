/**
 * Task 1.16 live HTTP smoke test.
 *
 * Temporary review helper, not part of the module: it is outside src/, so it is neither
 * typechecked nor built. Delete it after the review.
 *
 *   1. start the API in another terminal:  npm run dev --workspace=backend
 *   2. run:                                node backend/scripts/task-1-16-smoke.mjs
 *
 * Every fixture is prefixed SMOKE1616 and removed in the finally block, including after
 * a failure. Nothing else in the database is touched.
 */
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';

const BASE_URL = process.env.SMOKE_BASE_URL ?? 'http://localhost:3000';
const PREFIX = 'SMOKE1616';
const PHONE_PREFIX = '+1990';
const PASSWORD = 'a-very-strong-passphrase';

const prisma = new PrismaClient();

let passed = 0;
let failed = 0;
let phoneCounter = 0;

const nextPhone = () =>
  `${PHONE_PREFIX}${String(Date.now()).slice(-6)}${String(phoneCounter++).padStart(3, '0')}`;

const check = (name, condition, detail = '') => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${name}${detail ? ` -> ${detail}` : ''}`);
  }
};

const call = async (method, path, token, body) => {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, body: json };
};

const login = async (phone) => {
  const res = await call('POST', '/api/v1/auth/login', undefined, { phone, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed for ${phone}: ${res.status}`);
  return res.body.accessToken;
};

const createStaff = async (hospitalId, staffRole) => {
  const phone = nextPhone();
  const user = await prisma.user.create({
    data: {
      phone,
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      role: 'HOSPITAL_STAFF',
      status: 'ACTIVE',
      displayName: `${PREFIX} ${staffRole}`,
      hospitalMemberships: { create: { hospitalId, staffRole, status: 'ACTIVE' } },
    },
  });
  return { user, phone, token: await login(phone) };
};

const createDriver = async () => {
  const phone = nextPhone();
  const user = await prisma.user.create({
    data: {
      phone,
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      role: 'DRIVER',
      status: 'ACTIVE',
      displayName: `${PREFIX} driver`,
      driverProfile: {
        create: {
          licenceNumber: `${PREFIX}-${phone}`,
          verificationStatus: 'VERIFIED',
          availabilityStatus: 'AVAILABLE',
        },
      },
    },
    include: { driverProfile: true },
  });
  return { user, profile: user.driverProfile, phone, token: await login(phone) };
};

const createHospital = async (label) =>
  prisma.hospital.create({
    data: {
      name: `${PREFIX} ${label}`,
      registrationNumber: `${PREFIX}-${label}-${Date.now()}`,
      phone: '+15550000000',
      addressLine: '1 Main Street',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      status: 'VERIFIED',
    },
  });

const seedReservedEmergency = async (hospitalId) => {
  const patient = await prisma.user.create({
    data: {
      phone: nextPhone(),
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      role: 'PATIENT',
      status: 'ACTIVE',
      displayName: `${PREFIX} patient`,
      patientProfile: {
        create: {
          allergies: 'SMOKE-ALLERGY-MUST-NOT-LEAK',
          medicalSummary: 'SMOKE-SUMMARY-MUST-NOT-LEAK',
        },
      },
    },
    include: { patientProfile: true },
  });

  const emergency = await prisma.emergencyRequest.create({
    data: {
      patientId: patient.patientProfile.id,
      currentStatus: 'BED_RESERVED',
      pickupAddress: '12 Elm Street',
    },
  });

  await prisma.hospitalResponse.create({
    data: { emergencyId: emergency.id, hospitalId, status: 'ACCEPTED' },
  });

  return { patient, emergency };
};

const createAmbulance = (hospitalId) =>
  prisma.ambulance.create({
    data: {
      hospitalId,
      vehicleNumber: `${PREFIX}-${Date.now()}-${phoneCounter++}`,
      status: 'AVAILABLE',
    },
  });

const run = async () => {
  const hospitalA = await createHospital('A');
  const hospitalB = await createHospital('B');

  console.log('\n1. authentication');
  const dispatcher = await createStaff(hospitalA.id, 'DISPATCHER');
  const hospitalAdmin = await createStaff(hospitalA.id, 'ADMIN');
  const coordinator = await createStaff(hospitalA.id, 'CLINICAL_COORDINATOR');
  const receptionist = await createStaff(hospitalA.id, 'RECEPTIONIST');
  const staffB = await createStaff(hospitalB.id, 'DISPATCHER');
  check('staff login issues a token', Boolean(dispatcher.token));

  const systemAdminPhone = nextPhone();
  await prisma.user.create({
    data: {
      phone: systemAdminPhone,
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      role: 'ADMIN',
      status: 'ACTIVE',
      displayName: `${PREFIX} system admin`,
    },
  });
  const systemAdminToken = await login(systemAdminPhone);

  const patientPhone = nextPhone();
  await prisma.user.create({
    data: {
      phone: patientPhone,
      passwordHash: await bcrypt.hash(PASSWORD, 12),
      role: 'PATIENT',
      status: 'ACTIVE',
      displayName: `${PREFIX} plain patient`,
      patientProfile: { create: {} },
    },
  });
  const patientToken = await login(patientPhone);

  const driver = await createDriver();
  const otherDriver = await createDriver();

  console.log('\n2. hospital staff authorization');
  check(
    'unauthenticated read is 401',
    (await call('GET', '/api/v1/hospitals/me/assignments')).status === 401,
  );
  check(
    'patient is 403',
    (await call('GET', '/api/v1/hospitals/me/assignments', patientToken)).status === 403,
  );
  check(
    'driver is 403',
    (await call('GET', '/api/v1/hospitals/me/assignments', driver.token)).status === 403,
  );
  check(
    'system ADMIN is 403',
    (await call('GET', '/api/v1/hospitals/me/assignments', systemAdminToken)).status === 403,
  );
  check(
    'receptionist may read',
    (await call('GET', '/api/v1/hospitals/me/assignments', receptionist.token)).status === 200,
  );

  const seedA = await seedReservedEmergency(hospitalA.id);
  const ambulanceA = await createAmbulance(hospitalA.id);
  const receptionistWrite = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${seedA.emergency.id}/assignments`,
    receptionist.token,
    { ambulanceId: ambulanceA.id, driverId: driver.profile.id },
  );
  check(
    'receptionist write is 403',
    receptionistWrite.status === 403,
    `got ${receptionistWrite.status}`,
  );

  console.log('\n3. driver authorization');
  check(
    'unauthenticated driver read is 401',
    (await call('GET', '/api/v1/drivers/me/assignments')).status === 401,
  );
  check(
    'staff on driver route is 403',
    (await call('GET', '/api/v1/drivers/me/assignments', dispatcher.token)).status === 403,
  );

  console.log('\n4. assignment creation');
  const created = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${seedA.emergency.id}/assignments`,
    dispatcher.token,
    { ambulanceId: ambulanceA.id, driverId: driver.profile.id },
  );
  check('dispatch returns 201', created.status === 201, JSON.stringify(created.body));
  const assignmentId = created.body?.assignment?.id;
  check('assignment is OFFERED', created.body?.assignment?.status === 'OFFERED');
  check(
    'ambulance claimed OFFERED',
    (await prisma.ambulance.findUnique({ where: { id: ambulanceA.id } }))?.status === 'OFFERED',
  );
  check(
    'driver claimed BUSY',
    (await prisma.driverProfile.findUnique({ where: { id: driver.profile.id } }))
      ?.availabilityStatus === 'BUSY',
  );
  check(
    'emergency is PENDING_DRIVER_ACCEPTANCE',
    (await prisma.emergencyRequest.findUnique({ where: { id: seedA.emergency.id } }))
      ?.currentStatus === 'PENDING_DRIVER_ACCEPTANCE',
  );

  const rejectedFields = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${seedA.emergency.id}/assignments`,
    dispatcher.token,
    { ambulanceId: ambulanceA.id, driverId: driver.profile.id, hospitalId: hospitalB.id },
  );
  check('server-controlled field is rejected 400', rejectedFields.status === 400);

  console.log('\n5. driver assignment visibility');
  const driverList = await call('GET', '/api/v1/drivers/me/assignments', driver.token);
  check(
    'driver sees own assignment',
    driverList.status === 200 && driverList.body.assignments.length === 1,
  );

  console.log('\n6. driver ownership isolation');
  check(
    'other driver read is 404',
    (await call('GET', `/api/v1/drivers/me/assignments/${assignmentId}`, otherDriver.token))
      .status === 404,
  );
  check(
    'other driver accept is 404',
    (
      await call(
        'POST',
        `/api/v1/drivers/me/assignments/${assignmentId}/accept`,
        otherDriver.token,
        {},
      )
    ).status === 404,
  );
  check(
    'other driver reject is 404',
    (
      await call(
        'POST',
        `/api/v1/drivers/me/assignments/${assignmentId}/reject`,
        otherDriver.token,
        {
          rejectionReason: 'not mine',
        },
      )
    ).status === 404,
  );

  console.log('\n10. cross-hospital isolation');
  check(
    'hospital B cannot read hospital A assignment',
    (await call('GET', `/api/v1/hospitals/me/assignments/${assignmentId}`, staffB.token)).status ===
      404,
  );
  const ambulanceB = await createAmbulance(hospitalB.id);
  const seedB = await seedReservedEmergency(hospitalB.id);
  check(
    'hospital A cannot use hospital B ambulance',
    (
      await call(
        'POST',
        `/api/v1/hospitals/me/emergencies/${seedA.emergency.id}/assignments`,
        hospitalAdmin.token,
        {
          ambulanceId: ambulanceB.id,
          driverId: otherDriver.profile.id,
        },
      )
    ).status === 404,
  );
  check(
    'hospital A cannot use hospital B emergency',
    (
      await call(
        'POST',
        `/api/v1/hospitals/me/emergencies/${seedB.emergency.id}/assignments`,
        hospitalAdmin.token,
        {
          ambulanceId: ambulanceA.id,
          driverId: otherDriver.profile.id,
        },
      )
    ).status === 404,
  );

  console.log('\n12. response PII');
  const driverRead = await call(
    'GET',
    `/api/v1/drivers/me/assignments/${assignmentId}`,
    driver.token,
  );
  const hospitalRead = await call(
    'GET',
    `/api/v1/hospitals/me/assignments/${assignmentId}`,
    dispatcher.token,
  );
  for (const [label, payload] of [
    ['driver', JSON.stringify(driverRead.body)],
    ['hospital', JSON.stringify(hospitalRead.body)],
  ]) {
    check(`${label} payload hides allergies`, !payload.includes('SMOKE-ALLERGY-MUST-NOT-LEAK'));
    check(
      `${label} payload hides medical summary`,
      !payload.includes('SMOKE-SUMMARY-MUST-NOT-LEAK'),
    );
    check(`${label} payload hides passwordHash`, !payload.includes('passwordHash'));
    check(`${label} payload hides patient phone`, !payload.includes(seedA.patient.phone));
  }

  console.log('\n7/11. driver accept and concurrency');
  const [acceptOne, acceptTwo] = await Promise.all([
    call('POST', `/api/v1/drivers/me/assignments/${assignmentId}/accept`, driver.token, {}),
    call('POST', `/api/v1/drivers/me/assignments/${assignmentId}/accept`, driver.token, {}),
  ]);
  const acceptStatuses = [acceptOne.status, acceptTwo.status].sort();
  check(
    'concurrent accepts yield one 200 and one 409',
    acceptStatuses[0] === 200 && acceptStatuses[1] === 409,
    acceptStatuses.join(','),
  );
  check(
    'ambulance committed ASSIGNED',
    (await prisma.ambulance.findUnique({ where: { id: ambulanceA.id } }))?.status === 'ASSIGNED',
  );

  console.log('\n9. invalid transitions');
  check(
    'reject after accept is 409',
    (
      await call('POST', `/api/v1/drivers/me/assignments/${assignmentId}/reject`, driver.token, {
        rejectionReason: 'too late',
      })
    ).status === 409,
  );
  check(
    'dispatch on an already dispatched emergency is 409',
    (
      await call(
        'POST',
        `/api/v1/hospitals/me/emergencies/${seedA.emergency.id}/assignments`,
        dispatcher.token,
        {
          ambulanceId: (await createAmbulance(hospitalA.id)).id,
          driverId: otherDriver.profile.id,
        },
      )
    ).status === 409,
  );

  console.log('\n8. driver reject on a fresh offer');
  const seedC = await seedReservedEmergency(hospitalA.id);
  const ambulanceC = await createAmbulance(hospitalA.id);
  const offerC = await call(
    'POST',
    `/api/v1/hospitals/me/emergencies/${seedC.emergency.id}/assignments`,
    coordinator.token,
    { ambulanceId: ambulanceC.id, driverId: otherDriver.profile.id },
  );
  check('clinical coordinator may dispatch', offerC.status === 201, JSON.stringify(offerC.body));
  const rejectRes = await call(
    'POST',
    `/api/v1/drivers/me/assignments/${offerC.body.assignment.id}/reject`,
    otherDriver.token,
    { rejectionReason: 'Vehicle fault' },
  );
  check(
    'reject returns 200 REJECTED',
    rejectRes.status === 200 && rejectRes.body.assignment.status === 'REJECTED',
  );
  check(
    'reject requires a reason (400)',
    (
      await call(
        'POST',
        `/api/v1/drivers/me/assignments/${offerC.body.assignment.id}/reject`,
        otherDriver.token,
        {},
      )
    ).status === 400,
  );
  check(
    'rejected attempt is preserved',
    (await prisma.ambulanceAssignment.findUnique({ where: { id: offerC.body.assignment.id } }))
      ?.status === 'REJECTED',
  );
  check(
    'ambulance released AVAILABLE',
    (await prisma.ambulance.findUnique({ where: { id: ambulanceC.id } }))?.status === 'AVAILABLE',
  );
  check(
    'driver released AVAILABLE',
    (await prisma.driverProfile.findUnique({ where: { id: otherDriver.profile.id } }))
      ?.availabilityStatus === 'AVAILABLE',
  );

  console.log('\n11. concurrent dispatch for the same ambulance');
  const seedD = await seedReservedEmergency(hospitalA.id);
  const seedE = await seedReservedEmergency(hospitalA.id);
  const sharedAmbulance = await createAmbulance(hospitalA.id);
  const driverD = await createDriver();
  const driverE = await createDriver();
  const [raceOne, raceTwo] = await Promise.all([
    call(
      'POST',
      `/api/v1/hospitals/me/emergencies/${seedD.emergency.id}/assignments`,
      dispatcher.token,
      {
        ambulanceId: sharedAmbulance.id,
        driverId: driverD.profile.id,
      },
    ),
    call(
      'POST',
      `/api/v1/hospitals/me/emergencies/${seedE.emergency.id}/assignments`,
      dispatcher.token,
      {
        ambulanceId: sharedAmbulance.id,
        driverId: driverE.profile.id,
      },
    ),
  ]);
  const raceStatuses = [raceOne.status, raceTwo.status].sort();
  check(
    'same-ambulance race yields one 201 and one 409',
    raceStatuses[0] === 201 && raceStatuses[1] === 409,
    raceStatuses.join(','),
  );
  check(
    'only one assignment exists for the contended ambulance',
    (await prisma.ambulanceAssignment.count({ where: { ambulanceId: sharedAmbulance.id } })) === 1,
  );
};

const cleanup = async () => {
  const hospitals = await prisma.hospital.findMany({
    where: { name: { startsWith: PREFIX } },
    select: { id: true },
  });
  const hospitalIds = hospitals.map((h) => h.id);

  const responses = await prisma.hospitalResponse.findMany({
    where: { hospitalId: { in: hospitalIds } },
    select: { id: true, emergencyId: true },
  });
  const emergencyIds = [...new Set(responses.map((r) => r.emergencyId))];

  await prisma.ambulanceAssignment.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.emergencyStatusHistory.deleteMany({ where: { emergencyId: { in: emergencyIds } } });
  await prisma.hospitalResponse.deleteMany({ where: { hospitalId: { in: hospitalIds } } });

  const emergencies = await prisma.emergencyRequest.findMany({
    where: { id: { in: emergencyIds } },
    select: { patientId: true },
  });
  await prisma.emergencyRequest.deleteMany({ where: { id: { in: emergencyIds } } });

  const patientIds = emergencies.map((e) => e.patientId);
  const patientProfiles = await prisma.patientProfile.findMany({
    where: { id: { in: patientIds } },
    select: { userId: true },
  });
  await prisma.patientProfile.deleteMany({ where: { id: { in: patientIds } } });
  await prisma.user.deleteMany({ where: { id: { in: patientProfiles.map((p) => p.userId) } } });

  await prisma.ambulance.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospitalStaffMembership.deleteMany({ where: { hospitalId: { in: hospitalIds } } });
  await prisma.hospital.deleteMany({ where: { id: { in: hospitalIds } } });
  await prisma.driverProfile.deleteMany({ where: { licenceNumber: { startsWith: PREFIX } } });

  const leftoverProfiles = await prisma.patientProfile.findMany({
    where: { user: { phone: { startsWith: PHONE_PREFIX } } },
    select: { id: true },
  });
  await prisma.patientProfile.deleteMany({
    where: { id: { in: leftoverProfiles.map((p) => p.id) } },
  });
  const removed = await prisma.user.deleteMany({ where: { phone: { startsWith: PHONE_PREFIX } } });

  console.log(`\ncleanup: removed ${hospitalIds.length} hospitals and ${removed.count} users`);

  const residual =
    (await prisma.user.count({ where: { phone: { startsWith: PHONE_PREFIX } } })) +
    (await prisma.hospital.count({ where: { name: { startsWith: PREFIX } } })) +
    (await prisma.driverProfile.count({ where: { licenceNumber: { startsWith: PREFIX } } }));
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
