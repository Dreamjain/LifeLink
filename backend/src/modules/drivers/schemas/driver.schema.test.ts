import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error.js';
import { parseRegisterDriverInput, parseUpdateAvailabilityInput } from './driver.schema.js';

const validRegistration = {
  phone: '+15551230000',
  email: 'driver@example.com',
  password: 'a-very-strong-passphrase',
  displayName: 'Test Driver',
  licenceNumber: 'DL-12345678',
};

describe('driver.schema parseRegisterDriverInput', () => {
  it('accepts a valid driver application', () => {
    expect(parseRegisterDriverInput(validRegistration)).toEqual(validRegistration);
  });

  it('accepts an application without an email', () => {
    expect(() =>
      parseRegisterDriverInput({
        phone: validRegistration.phone,
        password: validRegistration.password,
        displayName: validRegistration.displayName,
        licenceNumber: validRegistration.licenceNumber,
      }),
    ).not.toThrow();
  });

  it('rejects a missing licence number', () => {
    expect(() =>
      parseRegisterDriverInput({
        phone: validRegistration.phone,
        password: validRegistration.password,
        displayName: validRegistration.displayName,
      }),
    ).toThrow(AppError);
  });

  it('rejects a licence number longer than the schema column', () => {
    expect(() =>
      parseRegisterDriverInput({ ...validRegistration, licenceNumber: 'X'.repeat(81) }),
    ).toThrow(AppError);
  });

  it('rejects a short password', () => {
    expect(() => parseRegisterDriverInput({ ...validRegistration, password: 'short' })).toThrow(
      AppError,
    );
  });

  it('rejects an invalid phone number', () => {
    expect(() => parseRegisterDriverInput({ ...validRegistration, phone: 'not-a-phone' })).toThrow(
      AppError,
    );
  });

  it.each([
    ['role', { role: 'ADMIN' }],
    ['status', { status: 'ACTIVE' }],
    ['verificationStatus', { verificationStatus: 'VERIFIED' }],
    ['availabilityStatus', { availabilityStatus: 'AVAILABLE' }],
    ['passwordHash', { passwordHash: 'attacker-supplied' }],
    ['id', { id: 'attacker-supplied' }],
    ['userId', { userId: 'attacker-supplied' }],
    ['createdAt', { createdAt: '2020-01-01' }],
  ])('rejects a client-supplied %s field', (_label, injected) => {
    expect(() => parseRegisterDriverInput({ ...validRegistration, ...injected })).toThrow(AppError);
  });
});

describe('driver.schema parseUpdateAvailabilityInput', () => {
  it.each(['OFFLINE', 'AVAILABLE', 'BUSY', 'ON_BREAK', 'SUSPENDED'])(
    'accepts the %s availability value',
    (availabilityStatus) => {
      expect(parseUpdateAvailabilityInput({ availabilityStatus })).toEqual({ availabilityStatus });
    },
  );

  it('rejects an unknown availability value', () => {
    expect(() => parseUpdateAvailabilityInput({ availabilityStatus: 'TELEPORTING' })).toThrow(
      AppError,
    );
  });

  it('rejects a missing availability value', () => {
    expect(() => parseUpdateAvailabilityInput({})).toThrow(AppError);
  });

  it.each([
    ['verificationStatus', { verificationStatus: 'VERIFIED' }],
    ['licenceNumber', { licenceNumber: 'DL-999' }],
    ['userId', { userId: 'attacker-supplied' }],
    ['id', { id: 'attacker-supplied' }],
  ])('rejects a client-supplied %s field', (_label, injected) => {
    expect(() =>
      parseUpdateAvailabilityInput({ availabilityStatus: 'AVAILABLE', ...injected }),
    ).toThrow(AppError);
  });
});
