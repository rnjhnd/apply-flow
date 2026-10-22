export type DatabaseTargetName = 'development' | 'test';
export type DatabaseEnvironment = Record<string, string | undefined>;

const targets = {
  development: { variable: 'DATABASE_URL', port: '15432', database: 'applyflow_dev', username: 'applyflow_dev' },
  test: { variable: 'TEST_DATABASE_URL', port: '5433', database: 'applyflow_test', username: 'applyflow_test' }
} as const;

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseConfigurationError';
  }
}

export type LocalDatabaseTarget = {
  name: DatabaseTargetName;
  connectionString: string;
  host: string;
  port: string;
  database: string;
  username: string;
};

export function readDatabaseTarget(name: DatabaseTargetName, env: DatabaseEnvironment): LocalDatabaseTarget {
  if (env.NODE_ENV !== undefined && env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new DatabaseConfigurationError('Local database tooling is restricted to development/test environments.');
  }
  if (name === 'development' && env.NODE_ENV === 'test') {
    throw new DatabaseConfigurationError('Test processes cannot target the development database.');
  }
  const expected = targets[name];
  const raw = env[expected.variable];
  if (!raw) throw new DatabaseConfigurationError(`${expected.variable} is required; no fallback connection is permitted.`);

  try {
    const url = new URL(raw);
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const database = decodeURIComponent(url.pathname.slice(1));
    if (raw.trim() !== raw || !['postgresql:', 'postgres:'].includes(url.protocol)
      || !['127.0.0.1', 'localhost'].includes(url.hostname)
      || url.port !== expected.port || database !== expected.database || username !== expected.username
      || !password || password.startsWith('replace_with_') || url.hash) {
      throw new Error('Unexpected target');
    }
    // Prevent connection-string query parameters from overriding the checked identity.
    const parameters = [...url.searchParams.entries()];
    if (parameters.length > 1 || parameters.some(([key, value]) => key !== 'schema' || value !== 'public')) {
      throw new Error('Unexpected connection options');
    }
    return { name, connectionString: raw, host: url.hostname, port: url.port, database, username };
  } catch {
    throw new DatabaseConfigurationError(
      `${expected.variable} must explicitly target localhost or 127.0.0.1:${expected.port}/${expected.database} as ${expected.username}, with a non-placeholder password and only the optional schema=public parameter.`
    );
  }
}

export function requireTestDatabaseTarget(env: DatabaseEnvironment): LocalDatabaseTarget {
  if (env.NODE_ENV !== 'test') {
    throw new DatabaseConfigurationError('Test-data writes require NODE_ENV=test.');
  }
  return readDatabaseTarget('test', env);
}

export function assertDatabaseIdentity(
  target: LocalDatabaseTarget,
  identity: { database: string; username: string } | undefined
): void {
  if (identity?.database !== target.database || identity.username !== target.username) {
    throw new DatabaseConfigurationError('Connected database/user does not match the approved local target.');
  }
}

export function readComposePasswords(env: DatabaseEnvironment) {
  if (env.NODE_ENV !== undefined && env.NODE_ENV !== 'development' && env.NODE_ENV !== 'test') {
    throw new DatabaseConfigurationError('Compose tooling is restricted to development/test environments.');
  }
  const dev = env.POSTGRES_DEV_PASSWORD;
  const test = env.POSTGRES_TEST_PASSWORD;
  if (!dev || !test || dev.length < 16 || test.length < 16
    || dev.startsWith('replace_with_') || test.startsWith('replace_with_') || dev === test) {
    throw new DatabaseConfigurationError('Compose requires distinct, non-placeholder development/test passwords of at least 16 characters.');
  }
  for (const name of ['development', 'test'] as const) {
    const target = readDatabaseTarget(name, { ...env, NODE_ENV: 'development' });
    const expected = name === 'development' ? dev : test;
    if (decodeURIComponent(new URL(target.connectionString).password) !== expected) {
      throw new DatabaseConfigurationError('Compose credentials and database URLs do not match.');
    }
  }
  return { dev, test };
}
