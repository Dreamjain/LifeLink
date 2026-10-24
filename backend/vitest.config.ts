import { defineConfig } from 'vitest/config';
import { validateTestDatabaseUrl } from './src/config/test-database-url.js';

// Vitest loads this configuration before test modules. Set the process-local database URL only
// after explicit validation, so dotenv in application code cannot fall back to backend/.env.
process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = validateTestDatabaseUrl(process.env.TEST_DATABASE_URL);
// Keep test imports independent of developer or production credentials. This fixed value exists
// only in the Vitest process; production environment validation remains unchanged.
process.env.JWT_SECRET = 'lifelink-vitest-only-jwt-secret-never-use-in-production';

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
