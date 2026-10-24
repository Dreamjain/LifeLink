import { describe, expect, it } from 'vitest';
import { validateTestDatabaseUrl } from './test-database-url.js';

describe('validateTestDatabaseUrl', () => {
  it('accepts the dedicated local lifelink_test database', () => {
    const url = 'postgresql://localhost:5432/lifelink_test?schema=public';

    expect(() => validateTestDatabaseUrl(url)).not.toThrow();
  });

  it('rejects missing configuration without falling back to DATABASE_URL', () => {
    expect(() => validateTestDatabaseUrl(undefined)).toThrow(
      'Refusing to fall back to DATABASE_URL',
    );
  });

  it('rejects a different database name', () => {
    expect(() => validateTestDatabaseUrl('postgresql://localhost:5432/lifelink_dev')).toThrow(
      'must target the local lifelink_test database',
    );
  });

  it('rejects remote database hosts', () => {
    expect(() => validateTestDatabaseUrl('postgresql://db.example.com:5432/lifelink_test')).toThrow(
      'must use localhost or a loopback address',
    );
  });

  it('accepts an IPv4 loopback host', () => {
    const url = 'postgresql://127.0.0.1:5432/lifelink_test';

    expect(() => validateTestDatabaseUrl(url)).not.toThrow();
  });

  it('accepts the IPv6 loopback host', () => {
    const url = 'postgresql://[::1]:5432/lifelink_test';

    expect(() => validateTestDatabaseUrl(url)).not.toThrow();
  });
});
