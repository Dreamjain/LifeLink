import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error.js';
import { parseLoginInput, parseRegisterInput } from './auth.schema.js';

const validRegisterPayload = {
  phone: '+15551234567',
  email: 'patient@example.com',
  password: 'a-very-strong-passphrase',
  displayName: 'Test Patient',
};

describe('auth.schema', () => {
  describe('parseRegisterInput', () => {
    it('accepts a valid registration payload', () => {
      const result = parseRegisterInput(validRegisterPayload);

      expect(result).toEqual(validRegisterPayload);
    });

    it('accepts a payload without an email', () => {
      const withoutEmail = {
        phone: validRegisterPayload.phone,
        password: validRegisterPayload.password,
        displayName: validRegisterPayload.displayName,
      };

      expect(() => parseRegisterInput(withoutEmail)).not.toThrow();
    });

    it('rejects a password shorter than 12 characters', () => {
      expect(() => parseRegisterInput({ ...validRegisterPayload, password: 'short' })).toThrow(
        AppError,
      );
    });

    it('rejects an invalid email', () => {
      expect(() => parseRegisterInput({ ...validRegisterPayload, email: 'not-an-email' })).toThrow(
        AppError,
      );
    });

    it('rejects an invalid phone number', () => {
      expect(() => parseRegisterInput({ ...validRegisterPayload, phone: 'not-a-phone' })).toThrow(
        AppError,
      );
    });

    it('rejects a missing displayName', () => {
      const withoutDisplayName = {
        phone: validRegisterPayload.phone,
        email: validRegisterPayload.email,
        password: validRegisterPayload.password,
      };

      expect(() => parseRegisterInput(withoutDisplayName)).toThrow(AppError);
    });

    it('rejects a client-supplied role field', () => {
      expect(() => parseRegisterInput({ ...validRegisterPayload, role: 'ADMIN' })).toThrow(
        AppError,
      );
    });

    it('rejects client-supplied server-controlled fields', () => {
      expect(() =>
        parseRegisterInput({
          ...validRegisterPayload,
          id: 'attacker-supplied-id',
          status: 'ACTIVE',
          passwordHash: 'attacker-supplied-hash',
        }),
      ).toThrow(AppError);
    });
  });

  describe('parseLoginInput', () => {
    it('accepts a valid login payload', () => {
      const result = parseLoginInput({
        phone: '+15551234567',
        password: 'whatever-the-user-typed',
      });

      expect(result).toEqual({ phone: '+15551234567', password: 'whatever-the-user-typed' });
    });

    it('rejects a missing password', () => {
      expect(() => parseLoginInput({ phone: '+15551234567' })).toThrow(AppError);
    });

    it('rejects a missing phone', () => {
      expect(() => parseLoginInput({ password: 'whatever-the-user-typed' })).toThrow(AppError);
    });
  });
});
