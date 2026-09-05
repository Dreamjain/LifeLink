import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error.js';
import {
  parseAmbulanceIdParam,
  parseAmbulanceStatusAction,
  parseBedIdParam,
  parseBedStatusAction,
  parseCreateAmbulanceInput,
  parseCreateBedInput,
  parseUpdateAmbulanceInput,
  parseUpdateBedInput,
} from './resource.schema.js';

const SERVER_CONTROLLED = [
  ['id', { id: randomUUID() }],
  ['hospitalId', { hospitalId: randomUUID() }],
  ['status', { status: 'OUT_OF_SERVICE' }],
  ['createdAt', { createdAt: '2020-01-01' }],
  ['updatedAt', { updatedAt: '2020-01-01' }],
] as const;

describe('bed schemas', () => {
  const valid = { bedCode: 'ICU-01', bedType: 'ICU' };

  it('accepts a valid bed', () => {
    expect(parseCreateBedInput(valid)).toEqual(valid);
  });

  it('accepts a bed without a bedType (schema default applies)', () => {
    expect(() => parseCreateBedInput({ bedCode: 'GEN-01' })).not.toThrow();
  });

  it('rejects a missing bedCode', () => {
    expect(() => parseCreateBedInput({ bedType: 'ICU' })).toThrow(AppError);
  });

  it('rejects a bedCode longer than the column allows', () => {
    expect(() => parseCreateBedInput({ bedCode: 'X'.repeat(51) })).toThrow(AppError);
  });

  it('rejects an invalid bedType', () => {
    expect(() => parseCreateBedInput({ bedCode: 'A-1', bedType: 'HAMMOCK' })).toThrow(AppError);
  });

  it.each(SERVER_CONTROLLED)('rejects a client-supplied %s on create', (_label, injected) => {
    expect(() => parseCreateBedInput({ ...valid, ...injected })).toThrow(AppError);
  });

  it.each(SERVER_CONTROLLED)('rejects a client-supplied %s on update', (_label, injected) => {
    expect(() => parseUpdateBedInput({ bedCode: 'A-2', ...injected })).toThrow(AppError);
  });

  it('accepts an empty update body', () => {
    expect(() => parseUpdateBedInput({})).not.toThrow();
  });

  it.each(['MARK_OUT_OF_SERVICE', 'RETURN_TO_SERVICE'])('accepts the %s action', (action) => {
    expect(parseBedStatusAction({ action })).toBe(action);
  });

  it('rejects a raw status assignment instead of an action', () => {
    expect(() => parseBedStatusAction({ status: 'RESERVED' })).toThrow(AppError);
  });

  it.each(['RESERVED', 'OCCUPIED', 'RETIRE', 'ANYTHING'])(
    'rejects the unsupported action %s',
    (action) => {
      expect(() => parseBedStatusAction({ action })).toThrow(AppError);
    },
  );

  it('validates the bed id param', () => {
    expect(() => parseBedIdParam(randomUUID())).not.toThrow();
    expect(() => parseBedIdParam('not-a-uuid')).toThrow(AppError);
  });
});

describe('ambulance schemas', () => {
  const valid = {
    vehicleNumber: 'KA-01-AB-1234',
    ambulanceType: 'ADVANCED_LIFE_SUPPORT',
    capabilities: ['VENTILATOR'],
  };

  it('accepts a valid ambulance', () => {
    expect(parseCreateAmbulanceInput(valid)).toEqual(valid);
  });

  it('accepts an ambulance with only a vehicle number', () => {
    expect(() => parseCreateAmbulanceInput({ vehicleNumber: 'KA-02-CD-5678' })).not.toThrow();
  });

  it('rejects a vehicleNumber longer than the column allows', () => {
    expect(() => parseCreateAmbulanceInput({ vehicleNumber: 'X'.repeat(31) })).toThrow(AppError);
  });

  it('rejects an invalid ambulanceType', () => {
    expect(() =>
      parseCreateAmbulanceInput({ vehicleNumber: 'KA-03', ambulanceType: 'HELICOPTER' }),
    ).toThrow(AppError);
  });

  it('rejects non-string capabilities', () => {
    expect(() => parseCreateAmbulanceInput({ vehicleNumber: 'KA-04', capabilities: [42] })).toThrow(
      AppError,
    );
  });

  it.each(SERVER_CONTROLLED)('rejects a client-supplied %s on create', (_label, injected) => {
    expect(() => parseCreateAmbulanceInput({ ...valid, ...injected })).toThrow(AppError);
  });

  it.each(SERVER_CONTROLLED)('rejects a client-supplied %s on update', (_label, injected) => {
    expect(() => parseUpdateAmbulanceInput({ vehicleNumber: 'KA-05', ...injected })).toThrow(
      AppError,
    );
  });

  it.each(['MARK_OUT_OF_SERVICE', 'RETURN_TO_SERVICE', 'RETIRE'])(
    'accepts the %s action',
    (action) => {
      expect(parseAmbulanceStatusAction({ action })).toBe(action);
    },
  );

  it.each(['OFFERED', 'ASSIGNED', 'EN_ROUTE'])('rejects the workflow-owned action %s', (action) => {
    expect(() => parseAmbulanceStatusAction({ action })).toThrow(AppError);
  });

  it('rejects a raw status assignment instead of an action', () => {
    expect(() => parseAmbulanceStatusAction({ status: 'EN_ROUTE' })).toThrow(AppError);
  });

  it('validates the ambulance id param', () => {
    expect(() => parseAmbulanceIdParam(randomUUID())).not.toThrow();
    expect(() => parseAmbulanceIdParam('nope')).toThrow(AppError);
  });
});
