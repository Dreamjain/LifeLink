import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.util.js';

describe('password.util', () => {
  it('produces a hash that is not the plaintext password', async () => {
    const password = 'a-very-strong-passphrase';
    const hash = await hashPassword(password);

    expect(hash).not.toBe(password);
  });

  it('produces a bcrypt-formatted hash', async () => {
    const hash = await hashPassword('a-very-strong-passphrase');

    expect(hash).toMatch(/^\$2[aby]\$\d{2}\$/);
  });

  it('verifies the correct password successfully', async () => {
    const password = 'a-very-strong-passphrase';
    const hash = await hashPassword(password);

    await expect(verifyPassword(password, hash)).resolves.toBe(true);
  });

  it('fails verification for an incorrect password', async () => {
    const hash = await hashPassword('a-very-strong-passphrase');

    await expect(verifyPassword('a-completely-different-passphrase', hash)).resolves.toBe(false);
  });
});
