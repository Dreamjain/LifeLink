import { defineConfig } from 'vitest/config';

// bcrypt hashing is intentionally slow (BCRYPT_ROUNDS=12) and the suite is DB-backed, so
// under parallel workers some tests need more than Vitest's 5s default. Assertions are
// unchanged; this only grants a realistic time budget.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
