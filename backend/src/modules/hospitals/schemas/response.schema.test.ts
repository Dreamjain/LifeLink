import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { AppError } from '../../../common/errors/app-error.js';
import {
  parseAcceptResponseInput,
  parseCreateReservationInput,
  parseRejectResponseInput,
  parseReleaseReservationInput,
  parseReservationIdParam,
  parseResponseIdParam,
} from './response.schema.js';

const SERVER_CONTROLLED = [
  ['id', { id: randomUUID() }],
  ['hospitalId', { hospitalId: randomUUID() }],
  ['emergencyId', { emergencyId: randomUUID() }],
  ['status', { status: 'ACCEPTED' }],
  ['responseByUserId', { responseByUserId: randomUUID() }],
  ['reservedByUserId', { reservedByUserId: randomUUID() }],
  ['respondedAt', { respondedAt: '2020-01-01' }],
  ['reservedAt', { reservedAt: '2020-01-01' }],
  ['releasedAt', { releasedAt: '2020-01-01' }],
  ['createdAt', { createdAt: '2020-01-01' }],
  ['updatedAt', { updatedAt: '2020-01-01' }],
  ['currentStatus', { currentStatus: 'BED_RESERVED' }],
] as const;

describe('accept schema', () => {
  it('accepts an empty body', () => {
    expect(() => parseAcceptResponseInput({})).not.toThrow();
  });

  it.each(SERVER_CONTROLLED)('rejects a client-supplied %s', (_label, injected) => {
    expect(() => parseAcceptResponseInput({ ...injected })).toThrow(AppError);
  });
});

describe('reject schema', () => {
  it('accepts a meaningful rejection reason', () => {
    expect(parseRejectResponseInput({ rejectionReason: 'No ICU capacity.' }).rejectionReason).toBe(
      'No ICU capacity.',
    );
  });

  it('requires a rejection reason', () => {
    expect(() => parseRejectResponseInput({})).toThrow(AppError);
  });

  it('rejects a blank rejection reason', () => {
    expect(() => parseRejectResponseInput({ rejectionReason: '   ' })).toThrow(AppError);
  });

  it('rejects an over-long rejection reason', () => {
    expect(() => parseRejectResponseInput({ rejectionReason: 'x'.repeat(501) })).toThrow(AppError);
  });

  it.each(SERVER_CONTROLLED)('rejects a client-supplied %s', (_label, injected) => {
    expect(() =>
      parseRejectResponseInput({ rejectionReason: 'No capacity.', ...injected }),
    ).toThrow(AppError);
  });
});

describe('create reservation schema', () => {
  it('accepts a bedId', () => {
    const bedId = randomUUID();
    expect(parseCreateReservationInput({ bedId }).bedId).toBe(bedId);
  });

  it('requires a bedId', () => {
    expect(() => parseCreateReservationInput({})).toThrow(AppError);
  });

  it('rejects a non-uuid bedId', () => {
    expect(() => parseCreateReservationInput({ bedId: 'bed-1' })).toThrow(AppError);
  });

  it.each(SERVER_CONTROLLED)('rejects a client-supplied %s', (_label, injected) => {
    expect(() => parseCreateReservationInput({ bedId: randomUUID(), ...injected })).toThrow(
      AppError,
    );
  });

  it('rejects a client-supplied bed status', () => {
    expect(() =>
      parseCreateReservationInput({ bedId: randomUUID(), bedStatus: 'RESERVED' }),
    ).toThrow(AppError);
  });
});

describe('release reservation schema', () => {
  it('accepts an empty body', () => {
    expect(() => parseReleaseReservationInput({})).not.toThrow();
  });

  it('accepts an optional release reason', () => {
    expect(parseReleaseReservationInput({ releaseReason: 'Bed damaged.' }).releaseReason).toBe(
      'Bed damaged.',
    );
  });

  it.each(SERVER_CONTROLLED)('rejects a client-supplied %s', (_label, injected) => {
    expect(() => parseReleaseReservationInput({ ...injected })).toThrow(AppError);
  });
});

describe('id params', () => {
  it('validates response and reservation ids', () => {
    expect(() => parseResponseIdParam(randomUUID())).not.toThrow();
    expect(() => parseResponseIdParam('nope')).toThrow(AppError);
    expect(() => parseReservationIdParam(randomUUID())).not.toThrow();
    expect(() => parseReservationIdParam('nope')).toThrow(AppError);
  });
});
