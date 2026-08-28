import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole, UserStatus } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../database/prisma.js';
import { env } from '../../../config/env.js';
import { hashPassword } from '../utils/password.util.js';
import { signAccessToken } from '../utils/jwt.util.js';
import { requireAuth } from './auth.middleware.js';

const TEST_PHONE_PREFIX = '+1556';

const randomTestPhone = (): string =>
  `${TEST_PHONE_PREFIX}${Date.now().toString().slice(-6)}${Math.floor(Math.random() * 10_000)
    .toString()
    .padStart(4, '0')}`;

const createActiveUser = async () => {
  const user = await prisma.user.create({
    data: {
      phone: randomTestPhone(),
      email: `test.${randomUUID()}@example.com`,
      passwordHash: await hashPassword('a-very-strong-passphrase'),
      role: UserRole.PATIENT,
      status: UserStatus.ACTIVE,
      displayName: 'Middleware Test User',
    },
  });

  return user;
};

const buildReq = (authorization?: string): Request =>
  ({
    header: (name: string) => (name.toLowerCase() === 'authorization' ? authorization : undefined),
  }) as unknown as Request;

const buildRes = (): Response => ({}) as Response;

afterAll(async () => {
  await prisma.user.deleteMany({ where: { phone: { startsWith: TEST_PHONE_PREFIX } } });
});

describe('requireAuth', () => {
  it('rejects a missing Authorization header', async () => {
    const next = vi.fn();
    await requireAuth(buildReq(undefined), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MISSING_TOKEN' }));
  });

  it('rejects a malformed Authorization header (no Bearer scheme)', async () => {
    const next = vi.fn();
    await requireAuth(buildReq('Token abc.def.ghi'), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MALFORMED_TOKEN' }));
  });

  it('rejects a Bearer header with no token', async () => {
    const next = vi.fn();
    await requireAuth(buildReq('Bearer '), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'MALFORMED_TOKEN' }));
  });

  it('rejects an invalid/tampered token', async () => {
    const next = vi.fn();
    await requireAuth(buildReq('Bearer not-a-real-jwt'), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });

  it('rejects an expired token', async () => {
    const expired = jwt.sign({ role: UserRole.PATIENT }, env.JWT_SECRET, {
      algorithm: 'HS256',
      subject: randomUUID(),
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      jwtid: randomUUID(),
      expiresIn: '-1s',
    });

    const next = vi.fn();
    await requireAuth(buildReq(`Bearer ${expired}`), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'TOKEN_EXPIRED' }));
  });

  it('rejects a token with the wrong issuer', async () => {
    const wrongIssuer = jwt.sign({ role: UserRole.PATIENT }, env.JWT_SECRET, {
      algorithm: 'HS256',
      subject: randomUUID(),
      issuer: 'someone-else',
      audience: env.JWT_AUDIENCE,
      jwtid: randomUUID(),
      expiresIn: '15m',
    });

    const next = vi.fn();
    await requireAuth(buildReq(`Bearer ${wrongIssuer}`), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });

  it('rejects a token signed with a different algorithm', async () => {
    const wrongAlgorithm = jwt.sign({ role: UserRole.PATIENT }, env.JWT_SECRET, {
      algorithm: 'HS512',
      subject: randomUUID(),
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      jwtid: randomUUID(),
      expiresIn: '15m',
    });

    const next = vi.fn();
    await requireAuth(buildReq(`Bearer ${wrongAlgorithm}`), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });

  it('populates req.user for a valid token belonging to an active user', async () => {
    const user = await createActiveUser();
    const token = signAccessToken({ userId: user.id, role: user.role });

    const req = buildReq(`Bearer ${token}`);
    const next = vi.fn();
    await requireAuth(req, buildRes(), next);

    expect(next).toHaveBeenCalledWith();
    expect(req.user).toEqual({ userId: user.id, role: user.role, jti: expect.any(String) });

    await prisma.user.delete({ where: { id: user.id } });
  });

  it('rejects a valid token whose account is no longer active', async () => {
    const user = await createActiveUser();
    await prisma.user.update({ where: { id: user.id }, data: { status: UserStatus.SUSPENDED } });
    const token = signAccessToken({ userId: user.id, role: user.role });

    const next = vi.fn();
    await requireAuth(buildReq(`Bearer ${token}`), buildRes(), next);

    expect(next).toHaveBeenCalledWith(expect.objectContaining({ code: 'INACTIVE_ACCOUNT' }));

    await prisma.user.delete({ where: { id: user.id } });
  });
});
