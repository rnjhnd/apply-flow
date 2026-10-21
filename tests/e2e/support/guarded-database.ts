import { Prisma, type PrismaClient } from '../../../apps/api/src/generated/prisma/client.ts';
import { assertDatabaseIdentity, type DatabaseEnvironment, type LocalDatabaseTarget } from '../../../apps/api/src/config/database.js';
import { admitEnvironment } from './environment.js';
import { approvedChecksum, type ConnectedIdentity } from './database-preflight.js';
import { digest, validateHistory, validateSchema } from './schema.js';
import type { AuthenticationDatabase } from '../../../apps/api/src/modules/auth/authentication.js';

export const transactionOptions = Object.freeze({ maxWait: 3000, timeout: 10_000, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
export const transactionSetup = [
  Prisma.sql`SELECT set_config('lock_timeout', '2000ms', true), set_config('statement_timeout', '5000ms', true), set_config('idle_in_transaction_session_timeout', '10000ms', true), set_config('search_path', 'public', true)`,
  Prisma.sql`LOCK TABLE public."User", public."Session" IN ROW SHARE MODE`,
  Prisma.sql`LOCK TABLE public._prisma_migrations IN SHARE MODE`
] as const;
export type TransactionHost = {
  $transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, options?: typeof transactionOptions): Promise<T>;
};
export type DatabaseInspection = { identity: ConnectedIdentity; history: unknown; schema: unknown };
export type InspectTransaction = (tx: Prisma.TransactionClient) => Promise<DatabaseInspection>;
export class AmbiguousCommitError extends Error {
  constructor() { super('Transaction commit outcome requires review.'); this.name = 'AmbiguousCommitError'; }
}

function admit(source: DatabaseEnvironment, sql: Uint8Array): LocalDatabaseTarget {
  const target = admitEnvironment(source);
  if (digest(sql) !== approvedChecksum) throw new Error('Unapproved migration contents.');
  return target;
}
export function assertInspection(target: LocalDatabaseTarget, value: DatabaseInspection) {
  assertDatabaseIdentity(target, value.identity);
  if (value.identity.host !== target.host || value.identity.port !== Number(target.port)) throw new Error('Unexpected connected endpoint.');
  validateHistory(value.history); validateSchema(value.schema);
}

// No default connector: B1 cannot instantiate a driver, connect, or fall back.
export async function connectGuarded<T extends { close(): Promise<void>; inspect(): Promise<DatabaseInspection> }>(
  source: DatabaseEnvironment, sql: Uint8Array, connect: (target: LocalDatabaseTarget) => Promise<T>
): Promise<T> {
  const target = admit(source, sql);
  const connection = await connect(target);
  try { assertInspection(target, await connection.inspect()); return connection; }
  catch (error) { await connection.close(); throw error; }
}

// Product callbacks receive the actual transaction object. No query rewriting,
// result substitution, retry, nested transaction, or cookie handling is added.
export function createGuardedTransactions(source: DatabaseEnvironment, sql: Uint8Array,
  database: TransactionHost, inspect: InspectTransaction, allowed: () => boolean = () => true) {
  admit(source, sql);
  return {
    $transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>, assertAuthority: () => void = () => undefined): Promise<T> {
      const target = admit(source, sql);
      function checkAdmission() {
        const current = admit(source, sql);
        if (JSON.stringify(current) !== JSON.stringify(target) || !allowed()) throw new Error('Database admission changed.');
        assertAuthority();
      }
      if (!allowed()) return Promise.reject(new Error('Fixture writing is closed.'));
      assertAuthority();
      return database.$transaction(async (tx) => {
        checkAdmission();
        await tx.$queryRaw(transactionSetup[0]);
        checkAdmission();
        assertInspection(target, await inspect(tx));
        checkAdmission();
        await tx.$executeRaw(transactionSetup[1]);
        checkAdmission();
        await tx.$executeRaw(transactionSetup[2]);
        checkAdmission();
        assertInspection(target, await inspect(tx));
        checkAdmission();
        const result = await work(tx);
        checkAdmission();
        assertInspection(target, await inspect(tx));
        checkAdmission();
        return result;
      }, transactionOptions).then((result) => {
        // The host may already have dispatched COMMIT. Do not pretend a later
        // authority check can cancel it, roll it back, or authorize a retry.
        try { checkAdmission(); } catch { throw new AmbiguousCommitError(); }
        return result;
      });
    }
  };
}

// Compile-time compatibility with the installed Prisma 7.10.1 overloads.
export function authenticationDatabase(client: PrismaClient, guarded: ReturnType<typeof createGuardedTransactions>) {
  const user = Object.freeze({ findUnique: client.user.findUnique.bind(client.user) });
  const result: AuthenticationDatabase = { user, $transaction: guarded.$transaction };
  return result;
}
