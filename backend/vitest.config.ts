import { defineConfig } from 'vitest/config';

// bcrypt hashing is intentionally slow (BCRYPT_ROUNDS=12) and the suite is DB-backed, so
// under parallel workers some tests need more than Vitest's 5s default. Assertions are
// unchanged; this only grants a realistic time budget.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Every DB-backed test file shares one database, and dispatch selects the oldest eligible
    // driver from the global pool, so files must not run concurrently or one file's fixture
    // drivers can be dispatched by another file. Tests inside a file were already sequential.
    fileParallelism: false,
  },
});
