const LOCAL_TEST_DATABASE = 'lifelink_test';
const LOCAL_DATABASE_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Validate the explicit test target without ever including connection details in errors. */
export const validateTestDatabaseUrl = (rawUrl: string | undefined): string => {
  if (!rawUrl) {
    throw new Error(
      'Backend tests require TEST_DATABASE_URL. Refusing to fall back to DATABASE_URL from backend/.env.',
    );
  }

  let parsed: URL;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('TEST_DATABASE_URL must be a valid PostgreSQL connection URL.');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('TEST_DATABASE_URL must use the postgres: or postgresql: protocol.');
  }

  let databaseName: string;

  try {
    databaseName = decodeURIComponent(parsed.pathname).replace(/^\/+/, '');
  } catch {
    throw new Error('TEST_DATABASE_URL must target the local lifelink_test database.');
  }

  if (databaseName !== LOCAL_TEST_DATABASE) {
    throw new Error('TEST_DATABASE_URL must target the local lifelink_test database.');
  }

  if (!LOCAL_DATABASE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(
      'TEST_DATABASE_URL must use localhost or a loopback address. Remote test databases require a separately documented configuration.',
    );
  }

  return rawUrl;
};
