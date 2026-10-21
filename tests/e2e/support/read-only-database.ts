import type { ClientConfig, QueryResult } from 'pg';
import type { Socket } from 'node:net';
import { z } from 'zod';
import type { DatabaseEnvironment } from '../../../apps/api/src/config/database.js';
import { admitEnvironment } from './environment.js';
import { approvedChecksum } from './database-preflight.js';
import { digest } from './schema.js';
import { inspectReadOnlyCatalog, readOnlyCatalogSql, type ReadOnlyCatalogKey } from './catalog.js';

export const preflightLimits = Object.freeze({ connect: 5000, statement: 5000, lock: 2000,
  idleTransaction: 10000, total: 20000, shutdown: 2000 });
export const preflightControlSql = Object.freeze({
  begin: 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
  rollback: 'ROLLBACK',
  settings: `SELECT current_database()::text AS database, current_user::text AS username,
    session_user::text AS "sessionUser", current_setting('server_version_num') AS version,
    current_setting('transaction_read_only') AS "readOnly",
    current_setting('default_transaction_read_only') AS "defaultReadOnly",
    current_setting('transaction_isolation') AS isolation,
    current_setting('statement_timeout') AS "statementTimeout",
    current_setting('lock_timeout') AS "lockTimeout",
    current_setting('idle_in_transaction_session_timeout') AS "idleTimeout",
    current_setting('search_path') AS "searchPath"`,
  quiet: `SELECT count(*)::int AS others FROM pg_catalog.pg_stat_activity
    WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend'`
});

export type PreflightFailureCode = 'ADMISSION' | 'CONNECT' | 'PEER' | 'SETTINGS' | 'QUIET'
  | 'CATALOG' | 'QUERY' | 'ROLLBACK' | 'CLOSE' | 'TIMEOUT' | 'INTERRUPTED' | 'CONNECTION';
const failureCodes = new Set<string>(['ADMISSION', 'CONNECT', 'PEER', 'SETTINGS', 'QUIET',
  'CATALOG', 'QUERY', 'ROLLBACK', 'CLOSE', 'TIMEOUT', 'INTERRUPTED', 'CONNECTION']);
export type PreflightFailureDetail = 'IDENTITY' | 'VERSION' | 'MIGRATION' | 'SCHEMA';
const failureDetails = new Set<string>(['IDENTITY', 'VERSION', 'MIGRATION', 'SCHEMA']);
export class ReadOnlyPreflightError extends Error {
  readonly code: PreflightFailureCode;
  readonly detail: PreflightFailureDetail | undefined;
  constructor(code: PreflightFailureCode, detail?: PreflightFailureDetail) {
    const safeCode = failureCodes.has(code) ? code : 'QUERY';
    super(`Read-only preflight failed: ${safeCode}.`);
    this.code = safeCode; this.name = 'ReadOnlyPreflightError';
    this.detail = detail && failureDetails.has(detail) ? detail : undefined;
  }
}

// Required injection: there is no default driver, pool, or implicit connection.
// Socket is the protocol stream, not a caller-reported host/port descriptor.
export type ReadOnlyClient = {
  readonly connection: { readonly stream: unknown };
  connect(): Promise<unknown>;
  query(text: string): Promise<Pick<QueryResult, 'rows' | 'command'>>;
  end(): Promise<void>;
  on(event: 'error' | 'end', listener: () => void): unknown;
  once(event: 'end', listener: () => void): unknown;
  off(event: 'error' | 'end', listener: () => void): unknown;
};
export type ReadOnlyDependencies = {
  socket(): Socket;
  client(config: ClientConfig): ReadOnlyClient;
};
const settingsSchema = z.array(z.strictObject({ database: z.literal('applyflow_test'), username: z.literal('applyflow_test'),
  sessionUser: z.literal('applyflow_test'), version: z.string().regex(/^17\d{4}$/), readOnly: z.literal('on'),
  defaultReadOnly: z.literal('on'), isolation: z.string(), statementTimeout: z.literal('5s'),
  lockTimeout: z.literal('2s'), idleTimeout: z.literal('10s'), searchPath: z.string().regex(/^pg_catalog, ?public$/) })).length(1);

// Capture fixed SQL text at module initialization. No caller SQL or SQL callback
// can reach the client. B1 query objects and its transaction wrapper are untouched.
const catalogText = Object.freeze(Object.fromEntries(Object.entries(readOnlyCatalogSql).map(([key, sql]) => [key, sql.text]))) as
  Readonly<Record<ReadOnlyCatalogKey, string>>;
export type ReadOnlyPreflightResult = Readonly<{ outcome: 'passed'; readOnly: true; closed: true }>;

export async function inspectReadOnlyDatabase(source: DatabaseEnvironment, migration: Uint8Array,
  dependencies: ReadOnlyDependencies, signal?: AbortSignal): Promise<ReadOnlyPreflightResult> {
  let target: ReturnType<typeof admitEnvironment>;
  try {
    target = admitEnvironment(source);
  } catch { throw new ReadOnlyPreflightError('ADMISSION'); }
  try { if (digest(migration) !== approvedChecksum) throw new Error(); }
  catch { throw new ReadOnlyPreflightError('ADMISSION', 'MIGRATION'); }
  if (signal?.aborted) throw new ReadOnlyPreflightError('INTERRUPTED');

  let socket: Socket | undefined; let client: ReadOnlyClient | undefined;
  let failure: PreflightFailureCode | undefined;
  let failureDetail: PreflightFailureDetail | undefined;
  let stageDetail: PreflightFailureDetail | undefined;
  let stage: PreflightFailureCode = 'CONNECT'; let closing = false; let ended = false;
  let beginDispatched = false; let finished = false; let closed = false;
  const rollback: { requested: boolean; dispatched: boolean; outcome: 'unconfirmed' | 'confirmed' | 'failed' } = {
    requested: false, dispatched: false, outcome: 'unconfirmed'
  };
  let rejectStopped!: (error: ReadOnlyPreflightError) => void;
  const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
  // Catch even if a synchronous constructor fails before the first await.
  void stopped.catch(() => undefined);
  function fail(code: PreflightFailureCode, detail?: PreflightFailureDetail) {
    if (!failure) { failure = code; failureDetail = detail; rejectStopped(new ReadOnlyPreflightError(code, detail)); }
  }
  function destroyOwned() { try { socket?.destroy(); } catch { fail('CLOSE'); } }
  // Latch cancellation immediately. Bounded cleanup may still send ROLLBACK on
  // the owned transport before end()/the shutdown deadline destroys it.
  function interrupt() { fail('INTERRUPTED'); }
  function connectionFailed() { fail('CONNECTION'); }
  function connectionEnded() { ended = true; if (!closing) fail('CONNECTION'); }
  function assertAdmission() {
    if (failure) throw new ReadOnlyPreflightError(failure, failureDetail);
    if (signal?.aborted) throw new ReadOnlyPreflightError('INTERRUPTED');
    try {
      const current = admitEnvironment(source);
      if (current.connectionString !== target.connectionString || digest(migration) !== approvedChecksum) throw new Error();
    } catch { throw new ReadOnlyPreflightError('ADMISSION'); }
  }
  function peer() {
    if (!socket || !client || ended || client.connection.stream !== socket || socket.destroyed || socket.closed
      || socket.remoteAddress !== '127.0.0.1' || socket.remotePort !== 5433) throw new ReadOnlyPreflightError('PEER');
    return Object.freeze({ host: socket.remoteAddress, port: socket.remotePort });
  }
  async function wait<T>(operation: () => Promise<T>): Promise<T> {
    assertAdmission();
    const value = await Promise.race([operation(), stopped]);
    assertAdmission();
    return value;
  }
  function dispatch(text: string): Promise<Pick<QueryResult, 'rows' | 'command'>> {
    const active = client!;
    const send = active.query;
    if (typeof send !== 'function') throw new ReadOnlyPreflightError('QUERY');
    if (text === preflightControlSql.rollback && rollback.dispatched) throw new ReadOnlyPreflightError('ROLLBACK');
    try {
      return send.call(active, text);
    } catch (error) {
      if (text === preflightControlSql.rollback) rollback.outcome = 'failed';
      throw error;
    } finally {
      // Invocation, including a synchronous throw, is the handoff boundary.
      // Admission/peer failures never enter this block and cannot set these flags.
      if (text === preflightControlSql.begin) beginDispatched = true;
      if (text === preflightControlSql.rollback) rollback.dispatched = true;
    }
  }
  async function query(text: string) {
    if (text === preflightControlSql.rollback) rollback.requested = true;
    assertAdmission(); peer();
    const result = await wait(() => dispatch(text));
    peer();
    return result;
  }
  async function settings(inTransaction: boolean) {
    stage = 'SETTINGS'; stageDetail = undefined;
    const rows = (await query(preflightControlSql.settings)).rows;
    if (!z.array(z.object({ database: z.literal('applyflow_test'), username: z.literal('applyflow_test'),
      sessionUser: z.literal('applyflow_test') })).length(1).safeParse(rows).success) {
      throw new ReadOnlyPreflightError('SETTINGS', 'IDENTITY');
    }
    if (!z.array(z.object({ version: z.string().regex(/^17\d{4}$/) })).length(1).safeParse(rows).success) {
      throw new ReadOnlyPreflightError('SETTINGS', 'VERSION');
    }
    const parsed = settingsSchema.parse(rows)[0]!;
    if (inTransaction && parsed.isolation !== 'repeatable read') throw new ReadOnlyPreflightError('SETTINGS');
  }
  async function quiet() {
    stage = 'QUIET'; stageDetail = undefined;
    z.array(z.strictObject({ others: z.literal(0) })).length(1).parse((await query(preflightControlSql.quiet)).rows);
  }

  const totalTimer = setTimeout(() => { fail('TIMEOUT'); destroyOwned(); }, preflightLimits.total);
  signal?.addEventListener('abort', interrupt, { once: true });
  let connectTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    assertAdmission();
    socket = dependencies.socket();
    socket.on('error', connectionFailed);
    const password = decodeURIComponent(new URL(target.connectionString).password);
    client = dependencies.client({ host: '127.0.0.1', port: 5433, database: 'applyflow_test', user: 'applyflow_test',
      password, ssl: false, pipeline: false, stream: () => socket!, application_name: 'applyflow-read-only-preflight',
      client_encoding: 'UTF8', connectionTimeoutMillis: preflightLimits.connect,
      statement_timeout: preflightLimits.statement, lock_timeout: preflightLimits.lock,
      idle_in_transaction_session_timeout: preflightLimits.idleTransaction,
      options: '-c default_transaction_read_only=on -c search_path=pg_catalog,public' });
    client.on('error', connectionFailed); client.on('end', connectionEnded);
    if (client.connection.stream !== socket) throw new ReadOnlyPreflightError('PEER');
    connectTimer = setTimeout(() => { fail('TIMEOUT'); destroyOwned(); }, preflightLimits.connect);
    await wait(() => client!.connect());
    clearTimeout(connectTimer);
    stage = 'PEER'; peer();
    stage = 'QUERY';
    if ((await query(preflightControlSql.begin)).command !== 'BEGIN') throw new ReadOnlyPreflightError('SETTINGS');
    await settings(true);
    await quiet();
    stage = 'CATALOG';
    const inspection = await inspectReadOnlyCatalog(async (key) => {
      if (!Object.hasOwn(catalogText, key)) throw new ReadOnlyPreflightError('QUERY');
      stageDetail = key === 'identity' ? 'IDENTITY' : key === 'history' ? 'MIGRATION' : 'SCHEMA';
      return (await query(catalogText[key])).rows;
    }, peer());
    if (inspection.identity.database !== target.database || inspection.identity.username !== target.username) {
      throw new ReadOnlyPreflightError('CATALOG', 'IDENTITY');
    }
    stage = 'ROLLBACK'; stageDetail = undefined;
    if ((await query(preflightControlSql.rollback)).command !== 'ROLLBACK') throw new ReadOnlyPreflightError('ROLLBACK');
    rollback.outcome = 'confirmed';
    // A new autocommit read sees fresh activity instead of the transaction's
    // cached pg_stat_activity snapshot. Startup READ ONLY still applies.
    await settings(false); await quiet();
    assertAdmission(); peer(); finished = true;
  } catch (error) {
    if (rollback.dispatched && rollback.outcome === 'unconfirmed' && !failure) rollback.outcome = 'failed';
    fail(error instanceof ReadOnlyPreflightError ? error.code : stage,
      error instanceof ReadOnlyPreflightError ? error.detail : stageDetail);
  }
  finally {
    clearTimeout(connectTimer);
    // One bounded shutdown budget. Only the fixed ROLLBACK may bypass failed
    // admission, and only on the same still-usable approved protocol transport.
    // A dispatched rollback is never retried; late replies cannot resume reads.
    let shutdownTimedOut = false;
    let rejectShutdown!: () => void;
    const shutdownExpired = new Promise<never>((_resolve, reject) => { rejectShutdown = () => reject(new ReadOnlyPreflightError('CLOSE')); });
    void shutdownExpired.catch(() => undefined);
    const shutdownTimer = setTimeout(() => { shutdownTimedOut = true; fail('CLOSE'); destroyOwned(); rejectShutdown(); }, preflightLimits.shutdown);
    if (client) {
      if (beginDispatched && !rollback.dispatched) {
        rollback.requested = true;
        try {
          peer();
          const result = await Promise.race([dispatch(preflightControlSql.rollback), shutdownExpired]);
          peer();
          if (result.command === 'ROLLBACK') rollback.outcome = 'confirmed';
          else { rollback.outcome = 'failed'; fail('ROLLBACK'); }
        } catch {
          if (rollback.dispatched && !shutdownTimedOut) rollback.outcome = 'failed';
          fail('ROLLBACK');
        }
      }
      closing = true;
      try {
        await Promise.race([client.end(), shutdownExpired]);
        closed = socket?.closed === true;
        if (!closed) fail('CLOSE');
      } catch { fail('CLOSE'); }
      // Keep the sanitized error sink on an unconfirmed driver until its end
      // event: a late driver rejection/error must not become an uncaught leak.
      const removeListeners = () => { client!.off('error', connectionFailed); client!.off('end', connectionEnded); socket?.off('error', connectionFailed); };
      if (closed) removeListeners(); else client.once('end', removeListeners);
    }
    if (!closed) destroyOwned();
    if (!client) socket?.off('error', connectionFailed);
    clearTimeout(shutdownTimer); clearTimeout(totalTimer);
    signal?.removeEventListener('abort', interrupt);
  }
  if (failure || !finished || !rollback.requested || !rollback.dispatched || rollback.outcome !== 'confirmed' || !closed) {
    throw new ReadOnlyPreflightError(failure ?? 'CLOSE', failureDetail);
  }
  return Object.freeze({ outcome: 'passed', readOnly: true, closed: true });
}
