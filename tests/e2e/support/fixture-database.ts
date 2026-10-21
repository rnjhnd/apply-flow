import type { Pool, PoolConfig, PoolClient } from 'pg';
import type { Socket } from 'node:net';
import { z } from 'zod';
import { Prisma, type PrismaClient } from '../../../apps/api/src/generated/prisma/client.ts';
import type { DatabaseEnvironment } from '../../../apps/api/src/config/database.js';
import { admitEnvironment } from './environment.js';
import { approvedChecksum } from './database-preflight.js';
import { digest } from './schema.js';
import { inspectCatalog, inspectReadOnlyCatalog, readOnlyCatalogSql } from './catalog.js';
import { assertInspection, createGuardedTransactions, transactionOptions } from './guarded-database.js';
import { preflightControlSql } from './read-only-database.js';
import { executeCleanup, prismaCleanupRepository } from './cleanup.js';
import { resolveIntentUsers, type CleanupPermit, type createFinalizer, type OwnedUser } from './finalization.js';
import { recordedUsers, runServiceFixture } from './fixture-services.js';
import type { createChildRecorder } from './child-protocol.js';
import type { OperationLedger } from './fixture-evidence.js';
import type { JournalIo } from './journal.js';
import type { Owner } from './ownership.js';

export type FixtureMode = 'inspect-only' | 'fixture-cycle';
export const fixtureBackendSql = 'SELECT current_database()::text AS database, current_user::text AS username, session_user::text AS "sessionUser", pg_backend_pid()::int AS pid';
const backendSchema = z.array(z.strictObject({ database: z.literal('applyflow_test'), username: z.literal('applyflow_test'),
  sessionUser: z.literal('applyflow_test'), pid: z.number().int().positive() })).length(1);
type PrivatePrisma = Pick<PrismaClient, '$connect' | '$disconnect' | '$transaction'>;
export type FixtureDriver = {
  socket(): Socket;
  pool(config: PoolConfig): Pool;
  prisma(pool: Pool, error: () => void): PrivatePrisma;
};

// No installed factory or activation authority is issued in B3B. These distinct
// hard-closed modes require separately reviewed C1/C2 code changes, not flags or
// caller-supplied tokens. Injected test ports below remain usable with fakes.
export async function installedFixtureDriver(mode: FixtureMode): Promise<FixtureDriver> {
  if (mode === 'inspect-only') throw new Error('B3C1 installed inspection driver is disabled.');
  if (mode === 'fixture-cycle') throw new Error('B3C2 installed fixture driver is disabled.');
  throw new Error('Installed fixture driver is disabled.');
}
export async function openFixtureDatabase(source: DatabaseEnvironment, migration: Uint8Array, mode: FixtureMode,
  driver: FixtureDriver, review: () => void, signal?: AbortSignal) {
  const target = admitEnvironment(source);
  if (digest(migration) !== approvedChecksum || !['inspect-only', 'fixture-cycle'].includes(mode)
    || Object.keys(source).some((key) => source[key] !== undefined && /^(DEBUG|NODE_DEBUG|RUST_LOG|RUST_BACKTRACE|PRISMA_.*LOG.*)$/i.test(key))) {
    throw new Error('Fixture database admission rejected.');
  }
  let failed = false; let closing = false; let closed = false; let busy = false;
  let socket: Socket | undefined; let bound: PoolClient | undefined; let pool: Pool | undefined; let client: PrivatePrisma | undefined;
  let pid: number | undefined; let physicalAllocations = 0; let closePromise: Promise<void> | undefined;
  let rollbackConfirmations = 0;
  let destructionRequested = false;
  const fail = () => { if (!failed) { failed = true; try { review(); } catch { /* Never expose reporter/storage failures. */ } } };
  const abort = () => fail();
  function destroyOwned() {
    if (!socket || destructionRequested) return;
    destructionRequested = true;
    try { socket.destroy(); } catch { /* Destruction is best effort, never settlement evidence. */ }
  }
  function assert() {
    if (failed || closing || signal?.aborted || admitEnvironment(source).connectionString !== target.connectionString
      || digest(migration) !== approvedChecksum) throw new Error('Fixture database authority unavailable.');
  }
  function peer(clientValue = bound) {
    if (!socket || !clientValue || clientValue !== bound || clientValue.connection.stream !== socket
      || socket.destroyed || socket.closed || socket.remoteAddress !== '127.0.0.1' || socket.remotePort !== 5433) {
      fail(); throw new Error('Fixture protocol binding rejected.');
    }
    return Object.freeze({ host: '127.0.0.1', port: 5433 });
  }
  async function backend(tx: Prisma.TransactionClient) {
    assert(); peer();
    const row = backendSchema.parse(await tx.$queryRaw(Prisma.sql([fixtureBackendSql])))[0]!;
    assert(); peer();
    if (row.pid !== pid || row.pid !== z.number().int().positive().parse(Reflect.get(bound!, 'processID'))) { fail(); throw new Error('Fixture backend binding rejected.'); }
  }
  async function quiet(tx: Prisma.TransactionClient) {
    z.array(z.strictObject({ others: z.literal(0) })).length(1).parse(await tx.$queryRaw(Prisma.sql([preflightControlSql.quiet])));
  }
  async function inspect(tx: Prisma.TransactionClient) {
    await backend(tx); await quiet(tx);
    z.array(z.object({ version: z.string().regex(/^17\d{4}$/), readOnly: z.literal('off'), defaultReadOnly: z.literal('off'),
      isolation: z.literal('read committed'), statementTimeout: z.literal('5s'), lockTimeout: z.literal('2s'), idleTimeout: z.literal('10s'),
      searchPath: z.literal('public') })).length(1).parse(await tx.$queryRaw(Prisma.sql([preflightControlSql.settings])));
    const result = await inspectCatalog(tx, peer());
    assertInspection(target, result); await backend(tx); return result;
  }
  async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        fail();
        // Settle regardless of transport destruction; never expose its exception.
        reject(new Error('Fixture database deadline exceeded.')); destroyOwned();
      }, ms);
    })]); } finally { clearTimeout(timer); }
  }
  async function close() {
    closing = true;
    closePromise ??= (async () => {
      try {
        if (busy) throw new Error();
        await bounded((async () => { await client?.$disconnect(); await pool?.end(); })(), 2000);
        if (socket && socket.closed !== true) throw new Error();
        closed = true;
      } catch { fail(); destroyOwned(); throw new Error('Fixture database closure requires review.'); }
      finally { signal?.removeEventListener('abort', abort); }
    })();
    return closePromise;
  }
  async function readOnly<T>(read?: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T | undefined> {
    assert();
    const rollback = new Error('Owned read-only rollback'); let value: T | undefined; let inspected = false;
    let rollbackObserved = false;
    const before = rollbackConfirmations;
    try {
      await client!.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`SET TRANSACTION READ ONLY`);
        await backend(tx);
        const settings = z.array(z.object({ version: z.string().regex(/^17\d{4}$/), readOnly: z.literal('on'),
          defaultReadOnly: z.literal(mode === 'inspect-only' ? 'on' : 'off'), isolation: z.literal('repeatable read'),
          statementTimeout: z.literal('5s'), lockTimeout: z.literal('2s'), idleTimeout: z.literal('10s'),
          searchPath: z.string().regex(/^pg_catalog, ?public$/) })).length(1)
          .parse(await tx.$queryRaw(Prisma.sql([preflightControlSql.settings])));
        void settings;
        await quiet(tx);
        const result = await inspectReadOnlyCatalog(async (key) => tx.$queryRaw(Prisma.sql([readOnlyCatalogSql[key].text])), peer());
        assertInspection(target, result);
        if (read) value = await read(tx);
        await backend(tx); assert(); inspected = true; throw rollback;
      }, { ...transactionOptions, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    } catch (error) {
      rollbackObserved = error === rollback && inspected && rollbackConfirmations === before + 1;
    }
    if (!rollbackObserved) { fail(); throw new Error('Fixture read-only rollback requires review.'); }
    assert(); peer(); return value;
  }
  async function exclusive<T>(work: () => Promise<T>): Promise<T> {
    assert(); if (busy) throw new Error('Fixture operation already pending.'); busy = true;
    try { const value = await bounded(work(), 60_000); assert(); return value; }
    catch { fail(); throw new Error('Fixture database operation requires review.'); }
    finally { busy = false; }
  }
  if (signal?.aborted) throw new Error('Fixture database admission rejected.');
  signal?.addEventListener('abort', abort, { once: true });
  try {
    pool = driver.pool({ host: '127.0.0.1', port: 5433, database: 'applyflow_test', user: 'applyflow_test',
      password: decodeURIComponent(new URL(target.connectionString).password), ssl: false, max: 1,
      connectionTimeoutMillis: 5000, statement_timeout: 5000, lock_timeout: 2000, idle_in_transaction_session_timeout: 10_000,
      options: `-c default_transaction_read_only=${mode === 'inspect-only' ? 'on' : 'off'} -c search_path=pg_catalog,public`,
      stream: () => {
        assert(); if (physicalAllocations++ !== 0) { fail(); throw new Error('Fixture reconnect rejected.'); }
        socket = driver.socket(); socket.on('error', fail); return socket;
      },
      onConnect: async (incoming) => {
        assert(); if (bound) { fail(); throw new Error('Fixture client replacement rejected.'); }
        bound = incoming as PoolClient; peer(bound);
        bound.on('error', fail); bound.on('end', () => { if (!closing) fail(); });
        const send = bound.query;
        bound.query = function (this: PoolClient, ...args: unknown[]) {
          // The pg adapter routes BEGIN, callback queries, COMMIT and ROLLBACK
          // through this exact client.query. Preserve every overload/receiver.
          const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string } | undefined)?.text;
          if (this !== bound || (failed && text !== 'ROLLBACK')) throw new Error('Fixture driver admission rejected.');
          peer(this); const result = Reflect.apply(send, this, args);
          if (text === 'ROLLBACK' && result && typeof result.then === 'function') {
            return result.then((value: { command?: string }) => { if (value.command === 'ROLLBACK') rollbackConfirmations++; return value; });
          }
          return result;
        } as PoolClient['query'];
        const identity = backendSchema.parse((await bound.query(fixtureBackendSql)).rows)[0]!;
        if (identity.pid !== z.number().int().positive().parse(Reflect.get(bound, 'processID'))) { fail(); throw new Error('Fixture backend binding rejected.'); }
        pid = identity.pid;
      }
    });
    pool.on('error', fail);
    client = driver.prisma(pool, fail);
    await bounded(client.$connect(), 5000);
    await exclusive(() => readOnly());
  } catch { fail(); try { await close(); } catch { /* Fixed failure; preserve evidence. */ } throw new Error('Fixture database initialization requires review.'); }
  const guarded = createGuardedTransactions(source, migration, client, inspect, () => !failed && !closing && !signal?.aborted);
  function writable() { assert(); if (mode !== 'fixture-cycle') throw new Error('Fixture writes disabled in inspect-only mode.'); }
  return Object.freeze({
    inspect: () => exclusive(() => readOnly()),
    cycle(email: string, recorder: ReturnType<typeof createChildRecorder>, ledger: OperationLedger) {
      writable(); return exclusive(() => runServiceFixture(email, guarded, recorder, ledger));
    },
    finalize(finalizer: ReturnType<typeof createFinalizer>, owner: Owner, journal: JournalIo) {
      writable(); return exclusive(() => finalizer.finalize(guarded, async (tx, emails) =>
        recordedUsers(owner, journal, emails, await resolveIntentUsers(tx, emails))));
    },
    cleanup(permit: CleanupPermit) {
      writable(); return exclusive(() => executeCleanup(permit, guarded, { ...prismaCleanupRepository(guarded),
        async verifyAbsent(targets: { users: readonly OwnedUser[]; hashes: readonly string[] }) {
          return await readOnly(async (tx) => {
            const ids = targets.users.map((user) => user.id);
            const users = ids.length ? await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT id FROM public."User" WHERE id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})`) : [];
            const hashes = targets.hashes.length ? Prisma.sql`"tokenHash" IN (${Prisma.join(targets.hashes)})` : Prisma.sql`FALSE`;
            const related = ids.length ? Prisma.sql`"userId" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})` : Prisma.sql`FALSE`;
            const sessions = await tx.$queryRaw<unknown[]>(Prisma.sql`SELECT id FROM public."Session" WHERE (${hashes}) OR (${related})`);
            return users.length === 0 && sessions.length === 0;
          }) === true;
        } }));
    },
    close,
    isClosed: () => closed
  });
}
