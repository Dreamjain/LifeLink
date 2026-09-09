import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error.js';
import {
  parseAcceptAssignmentInput,
  parseAssignmentIdParam,
  parseCreateAssignmentInput,
  parseEmergencyIdParam,
  parseRejectAssignmentInput,
} from './assignment.schema.js';

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

describe('create assignment schema', () => {
  it('accepts an ambulance and driver target', () => {
    const ambulanceId = randomUUID();
    const driverId = randomUUID();

    expect(parseCreateAssignmentInput({ ambulanceId, driverId })).toEqual({
      ambulanceId,
      driverId,
    });
  });

  it('requires both targets', () => {
    expectValidationError(() => parseCreateAssignmentInput({ ambulanceId: randomUUID() }));
    expectValidationError(() => parseCreateAssignmentInput({ driverId: randomUUID() }));
  });

  it('rejects non-uuid targets', () => {
    expectValidationError(() =>
      parseCreateAssignmentInput({ ambulanceId: 'not-a-uuid', driverId: randomUUID() }),
    );
    expectValidationError(() =>
      parseCreateAssignmentInput({ ambulanceId: randomUUID(), driverId: 'not-a-uuid' }),
    );
  });

  it.each([
    'hospitalId',
    'createdByUserId',
    'status',
    'assignmentStatus',
    'emergencyStatus',
    'ambulanceStatus',
    'attemptNumber',
    'assignedAt',
    'respondedAt',
    'hospitalResponseId',
  ])('rejects the server-controlled field %s', (field) => {
    expectValidationError(() =>
      parseCreateAssignmentInput({
        ambulanceId: randomUUID(),
        driverId: randomUUID(),
        [field]: 'anything',
      }),
    );
  });
});

describe('accept assignment schema', () => {
  it('accepts an empty body', () => {
    expect(parseAcceptAssignmentInput({})).toEqual({});
  });

  it('rejects any client-supplied field', () => {
    expectValidationError(() => parseAcceptAssignmentInput({ status: 'ACCEPTED' }));
    expectValidationError(() => parseAcceptAssignmentInput({ driverId: randomUUID() }));
  });
});

describe('reject assignment schema', () => {
  it('accepts a meaningful rejection reason', () => {
    expect(parseRejectAssignmentInput({ rejectionReason: 'Vehicle fault' })).toEqual({
      rejectionReason: 'Vehicle fault',
    });
  });

  it('requires a rejection reason', () => {
    expectValidationError(() => parseRejectAssignmentInput({}));
  });

  it('rejects a blank rejection reason', () => {
    expectValidationError(() => parseRejectAssignmentInput({ rejectionReason: '   ' }));
  });

  it('rejects an over-long rejection reason', () => {
    expectValidationError(() => parseRejectAssignmentInput({ rejectionReason: 'x'.repeat(501) }));
  });

  it('rejects a client-supplied assignment status', () => {
    expectValidationError(() =>
      parseRejectAssignmentInput({ rejectionReason: 'Vehicle fault', status: 'REJECTED' }),
    );
  });
});

describe('id params', () => {
  it('validates assignment and emergency ids', () => {
    const assignmentId = randomUUID();
    const emergencyId = randomUUID();

    expect(parseAssignmentIdParam(assignmentId)).toBe(assignmentId);
    expect(parseEmergencyIdParam(emergencyId)).toBe(emergencyId);
    expectValidationError(() => parseAssignmentIdParam('not-a-uuid'));
    expectValidationError(() => parseEmergencyIdParam('not-a-uuid'));
    expectValidationError(() => parseAssignmentIdParam(undefined));
  });
});
