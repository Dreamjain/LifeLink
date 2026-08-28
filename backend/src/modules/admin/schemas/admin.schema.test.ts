import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error.js';
import {
  parseApprovePatientInput,
  parseRejectPatientInput,
  parseUserIdParam,
} from './admin.schema.js';

describe('admin.schema', () => {
  describe('parseUserIdParam', () => {
    it('accepts a valid uuid', () => {
      expect(() => parseUserIdParam(randomUUID())).not.toThrow();
    });

    it('rejects a non-uuid value', () => {
      expect(() => parseUserIdParam('pending')).toThrow(AppError);
    });
  });

  describe('parseApprovePatientInput', () => {
    it('accepts an empty body', () => {
      expect(() => parseApprovePatientInput({})).not.toThrow();
    });

    it('rejects an attempt to inject status/role via the body', () => {
      expect(() => parseApprovePatientInput({ status: 'ACTIVE', role: 'ADMIN' })).toThrow(AppError);
    });
  });

  describe('parseRejectPatientInput', () => {
    it('accepts an empty body', () => {
      expect(() => parseRejectPatientInput({})).not.toThrow();
    });

    it('accepts an optional reason', () => {
      const result = parseRejectPatientInput({ reason: 'Incomplete identity information.' });
      expect(result.reason).toBe('Incomplete identity information.');
    });

    it('rejects an attempt to inject status/role via the body', () => {
      expect(() => parseRejectPatientInput({ status: 'REJECTED', role: 'ADMIN' })).toThrow(
        AppError,
      );
    });
  });
});
