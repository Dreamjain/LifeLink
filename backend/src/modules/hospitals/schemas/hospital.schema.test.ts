import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error.js';
import {
  parseCreateHospitalInput,
  parseCreateHospitalStaffInput,
  parseHospitalIdParam,
  parseProvisionHospitalAdminInput,
  parseRejectHospitalInput,
  parseVerifyHospitalInput,
} from './hospital.schema.js';

const validHospital = {
  name: 'Central General Hospital',
  registrationNumber: 'REG-0001',
  phone: '+15551230000',
  email: 'contact@hospital.example.com',
  addressLine: '1 Main Street',
  city: 'Springfield',
  state: 'IL',
  postalCode: '62701',
};

const validStaff = {
  phone: '+15551230001',
  password: 'a-very-strong-passphrase',
  displayName: 'Dispatch Dana',
  staffRole: 'DISPATCHER',
};

describe('parseCreateHospitalInput', () => {
  it('accepts a valid hospital', () => {
    expect(() => parseCreateHospitalInput(validHospital)).not.toThrow();
  });

  it('accepts optional coordinates and capabilities', () => {
    const result = parseCreateHospitalInput({
      ...validHospital,
      latitude: 39.78,
      longitude: -89.65,
      capabilities: ['TRAUMA', 'CARDIAC'],
    });

    expect(result.latitude).toBe(39.78);
    expect(result.capabilities).toEqual(['TRAUMA', 'CARDIAC']);
  });

  it.each([
    ['latitude above range', { latitude: 91 }],
    ['latitude below range', { latitude: -91 }],
    ['longitude above range', { longitude: 181 }],
    ['longitude below range', { longitude: -181 }],
  ])('rejects %s', (_label, override) => {
    expect(() => parseCreateHospitalInput({ ...validHospital, ...override })).toThrow(AppError);
  });

  it('rejects a missing registration number', () => {
    const withoutRegistration = {
      name: validHospital.name,
      phone: validHospital.phone,
      addressLine: validHospital.addressLine,
      city: validHospital.city,
      state: validHospital.state,
      postalCode: validHospital.postalCode,
    };

    expect(() => parseCreateHospitalInput(withoutRegistration)).toThrow(AppError);
  });

  it.each([
    ['status', { status: 'VERIFIED' }],
    ['id', { id: randomUUID() }],
    ['createdAt', { createdAt: '2020-01-01' }],
    ['updatedAt', { updatedAt: '2020-01-01' }],
  ])('rejects a client-supplied %s field', (_label, injected) => {
    expect(() => parseCreateHospitalInput({ ...validHospital, ...injected })).toThrow(AppError);
  });
});

describe('parseProvisionHospitalAdminInput', () => {
  const valid = {
    phone: '+15551230002',
    password: 'a-very-strong-passphrase',
    displayName: 'Hospital Admin',
  };

  it('accepts a valid payload', () => {
    expect(() => parseProvisionHospitalAdminInput(valid)).not.toThrow();
  });

  it('rejects a short password', () => {
    expect(() => parseProvisionHospitalAdminInput({ ...valid, password: 'short' })).toThrow(
      AppError,
    );
  });

  it.each([
    ['role', { role: 'ADMIN' }],
    ['status', { status: 'ACTIVE' }],
    ['staffRole', { staffRole: 'DISPATCHER' }],
    ['hospitalId', { hospitalId: randomUUID() }],
    ['membershipStatus', { membershipStatus: 'ACTIVE' }],
  ])('rejects a client-supplied %s field', (_label, injected) => {
    expect(() => parseProvisionHospitalAdminInput({ ...valid, ...injected })).toThrow(AppError);
  });
});

describe('parseCreateHospitalStaffInput', () => {
  it.each(['DISPATCHER', 'RECEPTIONIST', 'CLINICAL_COORDINATOR'])(
    'accepts the assignable %s staff role',
    (staffRole) => {
      expect(() => parseCreateHospitalStaffInput({ ...validStaff, staffRole })).not.toThrow();
    },
  );

  it('rejects an attempt to create a hospital ADMIN', () => {
    expect(() => parseCreateHospitalStaffInput({ ...validStaff, staffRole: 'ADMIN' })).toThrow(
      AppError,
    );
  });

  it('rejects a UserRole value smuggled into staffRole', () => {
    expect(() =>
      parseCreateHospitalStaffInput({ ...validStaff, staffRole: 'HOSPITAL_STAFF' }),
    ).toThrow(AppError);
  });

  it.each([
    ['role', { role: 'ADMIN' }],
    ['status', { status: 'ACTIVE' }],
    ['membershipStatus', { membershipStatus: 'ACTIVE' }],
    ['hospitalId', { hospitalId: randomUUID() }],
    ['userId', { userId: randomUUID() }],
  ])('rejects a client-supplied %s field', (_label, injected) => {
    expect(() => parseCreateHospitalStaffInput({ ...validStaff, ...injected })).toThrow(AppError);
  });
});

describe('parseHospitalIdParam / verify / reject', () => {
  it('accepts a valid uuid', () => {
    expect(() => parseHospitalIdParam(randomUUID())).not.toThrow();
  });

  it('rejects a non-uuid', () => {
    expect(() => parseHospitalIdParam('not-a-uuid')).toThrow(AppError);
  });

  it('verify accepts an empty body and rejects injected status', () => {
    expect(() => parseVerifyHospitalInput({})).not.toThrow();
    expect(() => parseVerifyHospitalInput({ status: 'VERIFIED' })).toThrow(AppError);
  });

  it('reject accepts an optional reason and rejects injected status', () => {
    expect(parseRejectHospitalInput({ reason: 'Incomplete registration.' }).reason).toBe(
      'Incomplete registration.',
    );
    expect(() => parseRejectHospitalInput({ status: 'REJECTED' })).toThrow(AppError);
  });
});
