import net from 'node:net';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireLivePhase } from './execution.js';
import { inspectReadOnlyDatabase } from './read-only-database.js';

// Gate A intentionally has no approval environment flag or CLI bypass. Even
// direct invocation stops before reading credentials, constructing a socket,
// reading migration bytes, or instantiating the driver. Gate B needs review.
export async function runPreflightCommand(): Promise<number> {
  try {
    requireLivePhase('preflight');
    // Prepared composition, unreachable until a separately reviewed Gate B
    // change. No B1 write host, product startup, .env loader or pool is used.
    const migration = readFileSync(new URL('../../../apps/api/prisma/migrations/0001_init_auth/migration.sql', import.meta.url));
    await inspectReadOnlyDatabase(process.env, migration, {
      socket: () => new net.Socket(), client: (config) => new pg.Client(config)
    });
    console.info('Read-only preflight passed.');
    return 0;
  } catch {
    console.error('Read-only preflight disabled: Gate B approval and review are required.');
    return 1;
  }
}

// Imports and discovery are inert, including outside NODE_ENV=test.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runPreflightCommand();
}
