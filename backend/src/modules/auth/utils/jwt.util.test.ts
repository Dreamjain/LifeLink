import { randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { UserRole } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { env } from '../../../config/env.js';
import { signAccessToken, verifyAccessToken } from './jwt.util.js';

const userId = randomUUID();

describe('jwt.util', () => {
  it('signs and verifies a valid token', () => {
    const token = signAccessToken({ userId, role: UserRole.PATIENT });

    const claims = verifyAccessToken(token);

    expect(claims.sub).toBe(userId);
    expect(claims.role).toBe(UserRole.PATIENT);
  });

  it('includes all required claims', () => {
    const token = signAccessToken({ userId, role: UserRole.PATIENT });
    const claims = verifyAccessToken(token);

    expect(claims).toEqual(
      expect.objectContaining({
        sub: expect.any(String),
        role: expect.any(String),
        jti: expect.any(String),
        iss: expect.any(String),
        aud: expect.any(String),
        iat: expect.any(Number),
        exp: expect.any(Number),
      }),
    );
  });

  it('sets the configured issuer', () => {
    const token = signAccessToken({ userId, role: UserRole.PATIENT });
    const claims = verifyAccessToken(token);

    expect(claims.iss).toBe(env.JWT_ISSUER);
  });

  it('sets the configured audience', () => {
    const token = signAccessToken({ userId, role: UserRole.PATIENT });
    const claims = verifyAccessToken(token);

    expect(claims.aud).toBe(env.JWT_AUDIENCE);
  });

  it('expires approximately per the configured JWT_EXPIRES_IN (15m)', () => {
    const token = signAccessToken({ userId, role: UserRole.PATIENT });
    const claims = verifyAccessToken(token);

    const lifetimeSeconds = claims.exp - claims.iat;

    expect(lifetimeSeconds).toBeGreaterThanOrEqual(895);
    expect(lifetimeSeconds).toBeLessThanOrEqual(905);
  });

  it('preserves a supplied jti', () => {
    const jti = randomUUID();
    const token = signAccessToken({ userId, role: UserRole.PATIENT, jti });

    const claims = verifyAccessToken(token);

    expect(claims.jti).toBe(jti);
  });

  it('generates a valid, unique jti when none is supplied', () => {
    const tokenA = signAccessToken({ userId, role: UserRole.PATIENT });
    const tokenB = signAccessToken({ userId, role: UserRole.PATIENT });

    const claimsA = verifyAccessToken(tokenA);
    const claimsB = verifyAccessToken(tokenB);

    expect(claimsA.jti).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(claimsA.jti).not.toBe(claimsB.jti);
  });

  it('rejects a tampered token', () => {
    const token = signAccessToken({ userId, role: UserRole.PATIENT });
    const segments = token.split('.');
    const tamperedPayload = Buffer.from(segments[1] ?? '', 'base64url')
      .toString('utf8')
      .replace('PATIENT', 'ADMIN');
    segments[1] = Buffer.from(tamperedPayload, 'utf8').toString('base64url');
    const tampered = segments.join('.');

    expect(() => verifyAccessToken(tampered)).toThrow(jwt.JsonWebTokenError);
  });

  it('rejects a token signed with an invalid signature', () => {
    const foreignToken = jwt.sign(
      { role: UserRole.PATIENT },
      'a-completely-different-secret-key-value',
      {
        algorithm: 'HS256',
        subject: userId,
        issuer: env.JWT_ISSUER,
        audience: env.JWT_AUDIENCE,
        jwtid: randomUUID(),
        expiresIn: '15m',
      },
    );

    expect(() => verifyAccessToken(foreignToken)).toThrow(jwt.JsonWebTokenError);
  });

  it('rejects an expired token', () => {
    const expiredToken = jwt.sign({ role: UserRole.PATIENT }, env.JWT_SECRET, {
      algorithm: 'HS256',
      subject: userId,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      jwtid: randomUUID(),
      expiresIn: '-1s',
    });

    expect(() => verifyAccessToken(expiredToken)).toThrow(jwt.TokenExpiredError);
  });

  it('rejects a token signed with an algorithm other than HS256', () => {
    const wrongAlgorithmToken = jwt.sign({ role: UserRole.PATIENT }, env.JWT_SECRET, {
      algorithm: 'HS512',
      subject: userId,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      jwtid: randomUUID(),
      expiresIn: '15m',
    });

    expect(() => verifyAccessToken(wrongAlgorithmToken)).toThrow(jwt.JsonWebTokenError);
  });
});
