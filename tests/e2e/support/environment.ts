import { DatabaseConfigurationError, requireTestDatabaseTarget,
  type DatabaseEnvironment } from '../../../apps/api/src/config/database.js';

// Never load .env here: discovery/import must be inert, and development credentials
// must not enter a future test-server child. The caller supplies TEST_DATABASE_URL.
export function admitEnvironment(source: DatabaseEnvironment) {
  const target = requireTestDatabaseTarget(source);
  if (target.host !== '127.0.0.1') {
    throw new DatabaseConfigurationError('Browser tests require the canonical loopback test target.');
  }
  if (Object.keys(source).some((key) => source[key] !== undefined
    && (/^PG/i.test(key) || /^(NODE_OPTIONS|NODE_PATH|APP_ORIGIN|PORT|HOST|DATABASE_URL|DIRECT_URL|SHADOW_DATABASE_URL)$/i.test(key)))) {
    throw new DatabaseConfigurationError('Remove inherited connection/runtime overrides before browser-test admission.');
  }
  return target;
}

export function childEnvironment(source: DatabaseEnvironment): Record<string, string> {
  const target = admitEnvironment(source);
  const clean: Record<string, string> = { NODE_ENV: 'test', TEST_DATABASE_URL: target.connectionString,
    ALLOW_LOCAL_REGISTRATION: 'true', APP_TIMEZONE: 'Asia/Manila' };
  // Small OS-only allowlist; do not spread process.env or forward application secrets.
  for (const key of ['SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'PATH', 'Path']) {
    if (source[key] !== undefined) clean[key] = source[key];
  }
  return clean;
}
