import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error.js';
import {
  parseContactIdParam,
  parseCreateContactInput,
  parseUpdateContactInput,
  parseUpdateProfileInput,
} from './patient.schema.js';

describe('patient.schema', () => {
  describe('parseUpdateProfileInput', () => {
    it('accepts an empty object (all fields optional)', () => {
      expect(() => parseUpdateProfileInput({})).not.toThrow();
    });

    it('accepts a full valid payload', () => {
      const result = parseUpdateProfileInput({
        dateOfBirth: '1990-01-01',
        gender: 'female',
        bloodGroup: 'O_POSITIVE',
        allergies: 'peanuts',
        medicalSummary: 'none',
        addressLine: '123 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
      });

      expect(result.gender).toBe('female');
      expect(result.bloodGroup).toBe('O_POSITIVE');
    });

    it('rejects an invalid bloodGroup', () => {
      expect(() => parseUpdateProfileInput({ bloodGroup: 'NOT_A_BLOOD_GROUP' })).toThrow(AppError);
    });

    it('rejects server-controlled fields', () => {
      expect(() =>
        parseUpdateProfileInput({
          id: 'x',
          userId: 'x',
          status: 'ACTIVE',
          role: 'ADMIN',
          createdAt: 'x',
        }),
      ).toThrow(AppError);
    });
  });

  describe('parseCreateContactInput', () => {
    const valid = { name: 'Jane', relationship: 'Sister', phone: '+15551234567' };

    it('accepts a valid payload', () => {
      expect(() => parseCreateContactInput(valid)).not.toThrow();
    });

    it('rejects a missing name', () => {
      expect(() =>
        parseCreateContactInput({ relationship: 'Sister', phone: '+15551234567' }),
      ).toThrow(AppError);
    });

    it('rejects an invalid phone', () => {
      expect(() => parseCreateContactInput({ ...valid, phone: 'not-a-phone' })).toThrow(AppError);
    });

    it('rejects a client-supplied patientId', () => {
      expect(() => parseCreateContactInput({ ...valid, patientId: 'attacker-supplied' })).toThrow(
        AppError,
      );
    });
  });

  describe('parseUpdateContactInput', () => {
    it('accepts a partial payload', () => {
      expect(() => parseUpdateContactInput({ isPrimary: true })).not.toThrow();
    });

    it('rejects server-controlled fields', () => {
      expect(() => parseUpdateContactInput({ id: 'x', patientId: 'x' })).toThrow(AppError);
    });
  });

  describe('parseContactIdParam', () => {
    it('accepts a valid uuid', () => {
      expect(() => parseContactIdParam('550e8400-e29b-41d4-a716-446655440000')).not.toThrow();
    });

    it('rejects a non-uuid value', () => {
      expect(() => parseContactIdParam('not-a-uuid')).toThrow(AppError);
    });
  });
});
