import { X509Certificate } from 'node:crypto';
import { DatabaseConfigurationError, type DatabaseEnvironment } from './database.js';

// Runtime configuration only. Local/test/migration tooling never uses this path.
export function readProductionDatabaseTarget(environment: DatabaseEnvironment) {
  try {
    if (environment.NODE_ENV !== 'production') throw new Error();
    const raw = environment.DATABASE_URL;
    if (!raw || raw.trim() !== raw) throw new Error();
    const url = new URL(raw);
    const database = decodeURIComponent(url.pathname.slice(1));
    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    const options = [...url.searchParams.entries()];
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.port
      || !Number.isInteger(Number(url.port)) || Number(url.port) < 1 || Number(url.port) > 65535
      || !username || !password || password.startsWith('replace_with_') || !database || database.includes('/') || url.hash
      || options.length > 1 || options.some(([key, value]) => key !== 'schema' || value !== 'public')) throw new Error();
    const ca = environment.DATABASE_SSL_CA;
    if (ca !== undefined) new X509Certificate(ca);
    return { name: 'production' as const, connectionString: raw, host: url.hostname,
      port: url.port, database, username, ssl: { rejectUnauthorized: true as const, ...(ca === undefined ? {} : { ca }) } };
  } catch {
    throw new DatabaseConfigurationError('Invalid production database configuration; require explicit PostgreSQL identity/port, no connection overrides, and a valid optional CA certificate.');
  }
}
