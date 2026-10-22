import { createHash } from 'node:crypto';
import { assertDatabaseIdentity, type DatabaseEnvironment, type LocalDatabaseTarget }
  from '../../../apps/api/src/config/database.js';
import { admitEnvironment } from './environment.js';

export const approvedMigration = '0001_init_auth';
export const approvedChecksum = '98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840';
export type MigrationRow = { migration_name: string; checksum: string;
  finished_at: Date | null; rolled_back_at: Date | null };
export type ConnectedIdentity = { database: string; username: string; host: string; port: number };
export type PreflightConnection = {
  identity(): Promise<ConnectedIdentity>;
  history(): Promise<MigrationRow[]>;
  close(): Promise<void>;
};

// Deliberately no database implementation in 2C.3A. All I/O is injected. Future
// callers must repeat this admission before each fixture/cleanup transaction.
export async function verifyDatabase(source: DatabaseEnvironment, sql: Uint8Array,
  connect: (target: LocalDatabaseTarget) => Promise<PreflightConnection>): Promise<void> {
  const target = admitEnvironment(source);
  if (createHash('sha256').update(sql).digest('hex') !== approvedChecksum) {
    throw new Error('Unapproved migration contents.');
  }
  const connection = await connect(target);
  try {
    const identity = await connection.identity();
    assertDatabaseIdentity(target, identity);
    // Adapter must report the client connection endpoint, not inet_server_port()
    // (PostgreSQL's internal container port differs from the approved host port).
    if (identity.host !== target.host || identity.port !== Number(target.port)) {
      throw new Error('Connected endpoint does not match the approved test target.');
    }
    const history = await connection.history();
    const row = history[0];
    if (history.length !== 1 || !row || row.migration_name !== approvedMigration
      || row.checksum !== approvedChecksum || !(row.finished_at instanceof Date)
      || !Number.isFinite(row.finished_at.getTime()) || row.rolled_back_at !== null) {
      throw new Error('Unexpected or incomplete migration history.');
    }
  } finally { await connection.close(); }
}
