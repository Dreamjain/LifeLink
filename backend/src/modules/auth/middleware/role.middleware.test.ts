import type { Request, Response } from 'express';
import { UserRole } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedPrincipal } from '../types/auth.types.js';
import { requireRole } from './role.middleware.js';

const buildReq = (user?: AuthenticatedPrincipal): Request => ({ user }) as unknown as Request;
const buildRes = (): Response => ({}) as Response;

describe('requireRole', () => {
  it('allows an authenticated user with a permitted role', () => {
    const next = vi.fn();
    const req = buildReq({ userId: 'user-1', role: UserRole.PATIENT, jti: 'jti-1' });

    requireRole(UserRole.PATIENT)(req, buildRes(), next);

    expect(next).toHaveBeenCalledWith();
  });

  it('allows a role matching any of several permitted roles', () => {
    const next = vi.fn();
    const req = buildReq({ userId: 'user-1', role: UserRole.HOSPITAL_STAFF, jti: 'jti-1' });

    requireRole(UserRole.HOSPITAL_STAFF, UserRole.ADMIN)(req, buildRes(), next);

    expect(next).toHaveBeenCalledWith();
  });

  it('rejects a role that is not permitted', () => {
    const next = vi.fn();
    const req = buildReq({ userId: 'user-1', role: UserRole.DRIVER, jti: 'jti-1' });

    requireRole(UserRole.PATIENT, UserRole.ADMIN)(req, buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'INSUFFICIENT_ROLE' }));
  });

  it('rejects an unauthenticated request', () => {
    const next = vi.fn();

    requireRole(UserRole.PATIENT)(buildReq(undefined), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });
});
