import { randomUUID } from 'node:crypto';
import { EmergencyType, Severity } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error.js';
import {
  MAX_CLIENT_IDEMPOTENCY_KEY_LENGTH,
  parseCancelEmergencyInput,
  parseCreateEmergencyInput,
  parseEmergencyIdParam,
  parseIdempotencyKey,
} from './emergency.schema.js';

const expectValidationError = (act: () => unknown): void => {
  try {
    act();
    expect.unreachable('expected a validation error');
  } catch (error) {
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).code).toBe('VALIDATION_ERROR');
    expect((error as AppError).statusCode).toBe(400);
  }
};

describe('create emergency schema', () => {
  it('accepts an empty body and leaves the defaults to the database', () => {
    expect(parseCreateEmergencyInput({})).toEqual({});
  });

  it('accepts every patient-supplied field', () => {
    const input = {
      requestType: EmergencyType.AMBULANCE_REQUEST,
      severity: Severity.HIGH,
      description: 'Chest pain',
      pickupAddress: '12 Elm Street',
      pickupLatitude: 26.6,
      pickupLongitude: 74.03,
    };

    expect(parseCreateEmergencyInput(input)).toEqual(input);
  });

  it.each([
    'id',
    'patientId',
    'currentStatus',
    'cancelledAt',
    'completedAt',
    'expiresAt',
    'createdAt',
    'updatedAt',
    'idempotencyKey',
    'hospitalResponses',
    'ambulanceAssignments',
    'bedReservations',
    'statusHistory',
    'notifications',
    'somethingUnknown',
  ])('rejects the server-controlled or unknown field %s', (field) => {
    expectValidationError(() => parseCreateEmergencyInput({ [field]: 'anything' }));
  });

  it('rejects an invalid enum value', () => {
    expectValidationError(() => parseCreateEmergencyInput({ requestType: 'NOT_A_TYPE' }));
    expectValidationError(() => parseCreateEmergencyInput({ severity: 'NOT_A_SEVERITY' }));
  });

  it('rejects a blank or over-long description and address', () => {
    expectValidationError(() => parseCreateEmergencyInput({ description: '   ' }));
    expectValidationError(() => parseCreateEmergencyInput({ description: 'x'.repeat(2001) }));
    expectValidationError(() => parseCreateEmergencyInput({ pickupAddress: '   ' }));
    expectValidationError(() => parseCreateEmergencyInput({ pickupAddress: 'x'.repeat(501) }));
  });
});

describe('coordinate validation', () => {
  it.each([-90, 0, 90])('accepts latitude %s', (pickupLatitude) => {
    expect(parseCreateEmergencyInput({ pickupLatitude })).toEqual({ pickupLatitude });
  });

  it.each([-180, 0, 180])('accepts longitude %s', (pickupLongitude) => {
    expect(parseCreateEmergencyInput({ pickupLongitude })).toEqual({ pickupLongitude });
  });

  it.each([-90.0001, 90.0001, 91, -91, 1000])('rejects latitude %s', (pickupLatitude) => {
    expectValidationError(() => parseCreateEmergencyInput({ pickupLatitude }));
  });

  it.each([-180.0001, 180.0001, 181, -181, 1000])('rejects longitude %s', (pickupLongitude) => {
    expectValidationError(() => parseCreateEmergencyInput({ pickupLongitude }));
  });

  it('rejects a non-numeric coordinate', () => {
    expectValidationError(() => parseCreateEmergencyInput({ pickupLatitude: '26.6' }));
    expectValidationError(() => parseCreateEmergencyInput({ pickupLongitude: null }));
  });
});

describe('idempotency key schema', () => {
  it('accepts a normal key', () => {
    expect(parseIdempotencyKey('sos-2026-09-10_01')).toBe('sos-2026-09-10_01');
  });

  it('accepts a key at the maximum length', () => {
    const key = 'k'.repeat(MAX_CLIENT_IDEMPOTENCY_KEY_LENGTH);
    expect(parseIdempotencyKey(key)).toBe(key);
  });

  it('rejects a key one character too long', () => {
    expectValidationError(() =>
      parseIdempotencyKey('k'.repeat(MAX_CLIENT_IDEMPOTENCY_KEY_LENGTH + 1)),
    );
  });

  it('rejects a missing, empty or blank key', () => {
    expectValidationError(() => parseIdempotencyKey(undefined));
    expectValidationError(() => parseIdempotencyKey(''));
    expectValidationError(() => parseIdempotencyKey('   '));
  });

  it.each(['has space', 'semi;colon', 'new\nline', 'slash/key', 'quote"key', 'emoji😀'])(
    'rejects the malformed key %j',
    (key) => {
      expectValidationError(() => parseIdempotencyKey(key));
    },
  );

  it('keeps the namespaced value within the column limit', () => {
    const namespaced = `${randomUUID()}:${'k'.repeat(MAX_CLIENT_IDEMPOTENCY_KEY_LENGTH)}`;
    expect(namespaced.length).toBeLessThanOrEqual(128);
  });
});

describe('cancel schema and id params', () => {
  it('accepts an empty cancel body', () => {
    expect(parseCancelEmergencyInput({})).toEqual({});
  });

  it('rejects any client-supplied cancel field', () => {
    expectValidationError(() => parseCancelEmergencyInput({ currentStatus: 'CANCELLED' }));
    expectValidationError(() => parseCancelEmergencyInput({ cancelledAt: new Date() }));
  });

  it('validates the emergency id param', () => {
    const emergencyId = randomUUID();
    expect(parseEmergencyIdParam(emergencyId)).toBe(emergencyId);
    expectValidationError(() => parseEmergencyIdParam('not-a-uuid'));
    expectValidationError(() => parseEmergencyIdParam(undefined));
  });
});
