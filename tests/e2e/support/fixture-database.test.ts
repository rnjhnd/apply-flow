import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { Pool, PoolClient, PoolConfig } from 'pg';
import type { Socket } from 'node:net';
import pg from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import type { DatabaseEnvironment } from '../../../apps/api/src/config/database.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../../apps/api/src/generated/prisma/client.ts';
import { openFixtureDatabase, inspectFixtureDatabase, fixtureBackendSql, type FixtureDriver, type FixtureMode } from './fixture-database.js';
import { catalogSql, readOnlyCatalogSql } from './catalog.js';
import { cleanupSql } from './cleanup.js';
import { preflightControlSql } from './read-only-database.js';
import { env, sql, inspection, deferred, finalizationFixture, owner, userId, email, hash } from './b1-fakes.js';

function fixture(mode: FixtureMode = 'inspect-only') {
  const socket = Object.assign(new EventEmitter(), { remoteAddress: '127.0.0.1', remotePort: 5433, destroyed: false, closed: false,
    destroy(this: EventEmitter & { destroyed: boolean; closed: boolean }) {
      if (!this.destroyed) { this.destroyed = true; this.closed = true; this.emit('close', false); } return this;
    } });
  const identity = { database: 'applyflow_test', username: 'applyflow_test', sessionUser: 'applyflow_test', pid: 123 };
  const checked = inspection(); const schema = checked.schema as typeof import('./schema.js').expectedSchema;
  let inReadOnly = true;
  const settings = { version: '170009', readOnly: 'on', defaultReadOnly: mode === 'inspect-only' ? 'on' : 'off',
    isolation: 'repeatable read', statementTimeout: '5s', lockTimeout: '2s', idleTimeout: '10s', searchPath: 'pg_catalog,public' };
  const rows = new Map<string, unknown[]>([
    [fixtureBackendSql, [identity]], [preflightControlSql.settings, [settings]], [preflightControlSql.quiet, [{ others: 0 }]],
    [readOnlyCatalogSql.identity.text, [{ database: 'applyflow_test', username: 'applyflow_test' }]],
    [readOnlyCatalogSql.relations.text, ['Session', 'User', '_prisma_migrations'].map((name) => ({ name, kind: 'r', persistence: 'p' }))],
    [readOnlyCatalogSql.history.text, checked.history as unknown[]], [readOnlyCatalogSql.tables.text, schema.tables.map((name) => ({ name }))],
    [catalogSql.history.text, checked.history as unknown[]],
    [readOnlyCatalogSql.columns.text, schema.columns], [readOnlyCatalogSql.indexes.text, schema.indexes],
    [readOnlyCatalogSql.constraints.text, schema.constraints.map((value) => ({ value }))],
    [readOnlyCatalogSql.triggers.text, []], [readOnlyCatalogSql.rowSecurity.text, []]
  ]);
  const wire = vi.fn(async (text: string) => ({ command: text === 'ROLLBACK' ? 'ROLLBACK' : text === 'BEGIN' ? 'BEGIN' : 'SELECT', rows: rows.get(text) ?? [] }));
  const physical = Object.assign(new EventEmitter(), { processID: 123, connection: { stream: socket }, query: wire });
  let config!: PoolConfig;
  const pool = Object.assign(new EventEmitter(), { end: vi.fn(async () => { socket.destroy(); physical.emit('end'); }) });
  const tx = { $executeRaw: vi.fn(async (query: Prisma.Sql) => {
    if (query.text === 'SET TRANSACTION READ ONLY') inReadOnly = true;
    await physical.query(query.text); return 0;
  }), $queryRaw: vi.fn(async (query: Prisma.Sql) => {
    if (query.text === preflightControlSql.settings) Object.assign(settings,
      { readOnly: inReadOnly ? 'on' : 'off', isolation: inReadOnly ? 'repeatable read' : 'read committed', searchPath: inReadOnly ? 'pg_catalog,public' : 'public' });
    return (await physical.query(query.text)).rows;
  }) } as unknown as Prisma.TransactionClient;
  const prisma = { $connect: vi.fn(async () => {
    config.stream!(); await config.onConnect!(physical as unknown as PoolClient);
  }), $disconnect: vi.fn(async () => undefined),
  $transaction: vi.fn(async <T>(work: (value: Prisma.TransactionClient) => Promise<T>) => {
    inReadOnly = mode === 'inspect-only'; await physical.query('BEGIN');
    try { const value = await work(tx); await physical.query('COMMIT'); return value; }
    catch (error) { await physical.query('ROLLBACK'); throw error; }
  }) };
  const driver: FixtureDriver = { socket: vi.fn(() => socket as unknown as Socket), pool: vi.fn((value) => {
    config = value; return pool as unknown as Pool;
  }), prisma: vi.fn(() => prisma as unknown as ReturnType<FixtureDriver['prisma']>) };
  const review = vi.fn(); const controller = new AbortController();
  return { socket, identity, settings, rows, wire, physical, tx, prisma, pool, driver, review, controller,
    config: () => config, open: (environment: DatabaseEnvironment = env, migration = sql) => openFixtureDatabase(environment, migration, mode, driver, review, controller.signal) };
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('B3 private physical Prisma binding (injected, no pg/socket construction)', () => {
  it('rejects the audited queued error-before-close ordering before issuing a receipt, ten times', async () => {
    const results: string[] = [];
    for (let repetition = 0; repetition < 10; repetition++) {
      const f = fixture(); const delivered = deferred();
      f.pool.end.mockImplementation(async () => {
        f.socket.destroyed = true; f.socket.closed = true;
        process.nextTick(() => {
          f.socket.emit('error', new Error('private-queued-error'));
          f.socket.emit('close', true); f.physical.emit('end'); delivered.resolve();
        });
      });
      results.push(await inspectFixtureDatabase(env, sql, f.driver, f.controller.signal).then(() => 'receipt', () => 'failed'));
      await delivered.promise;
    }
    expect(results).toEqual(Array<string>(10).fill('failed'));
  });
  it('withholds the receipt after pool end and a true closed flag until close is observed', async () => {
    const f = fixture(); const ended = deferred(); let completed = false;
    f.pool.end.mockImplementation(async () => { f.socket.destroyed = true; f.socket.closed = true; ended.resolve(); });
    const inspecting = inspectFixtureDatabase(env, sql, f.driver, f.controller.signal).then((receipt) => { completed = true; return receipt; });
    await ended.promise; await Promise.resolve(); await Promise.resolve();
    expect(completed).toBe(false); expect(f.socket.listenerCount('close')).toBe(1);
    f.socket.emit('close', false);
    expect(await inspecting).toEqual({ outcome: 'passed', readOnly: true, closed: true });
    expect(f.prisma.$disconnect).toHaveBeenCalledOnce(); expect(f.pool.end).toHaveBeenCalledOnce();
  });
  it('still requires pool end fulfillment when close has already been observed', async () => {
    const f = fixture(); const closed = deferred(); const end = deferred(); let completed = false;
    f.pool.end.mockImplementation(async () => { f.socket.destroy(); f.physical.emit('end'); closed.resolve(); await end.promise; });
    const inspecting = inspectFixtureDatabase(env, sql, f.driver, f.controller.signal).then((receipt) => { completed = true; return receipt; });
    await closed.promise; await Promise.resolve(); expect(completed).toBe(false);
    end.resolve(); expect((await inspecting).closed).toBe(true);
  });
  it('bounds missing close evidence within the original shared shutdown deadline', async () => {
    vi.useFakeTimers(); const f = fixture(); const ended = deferred(); let completed = false;
    const destroy = vi.spyOn(f.socket, 'destroy');
    f.pool.end.mockImplementation(async () => { f.socket.destroyed = true; f.socket.closed = true; ended.resolve(); });
    const inspecting = inspectFixtureDatabase(env, sql, f.driver, f.controller.signal, f.review);
    const rejected = expect(inspecting.finally(() => { completed = true; })).rejects.toThrow('closure requires review');
    await ended.promise; await vi.advanceTimersByTimeAsync(1999); expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1); await rejected;
    expect(destroy).toHaveBeenCalledOnce(); expect(f.pool.end).toHaveBeenCalledOnce();
    f.socket.emit('close', false); await vi.advanceTimersByTimeAsync(0);
    expect(f.review).toHaveBeenCalledOnce();
  });
  it.each(['had-error', 'duplicate', 'flag-missing', 'premature'] as const)('rejects abnormal observed closure: %s', async (kind) => {
    const f = fixture();
    if (kind === 'premature') {
      const connect = f.prisma.$connect.getMockImplementation()!;
      f.prisma.$connect.mockImplementation(async () => { await connect(); f.socket.destroy(); });
    } else {
      f.pool.end.mockImplementation(async () => {
        if (kind !== 'flag-missing') { f.socket.destroyed = true; f.socket.closed = true; }
        f.socket.emit('close', kind === 'had-error');
        if (kind === 'duplicate') f.socket.emit('close', false);
        f.physical.emit('end');
      });
    }
    await expect(inspectFixtureDatabase(env, sql, f.driver, f.controller.signal)).rejects.toThrow('review');
    expect(f.pool.end).toHaveBeenCalledOnce();
  });
  it('registers the close observer before connect work and rejects partial registration failure', async () => {
    const f = fixture(); const on = f.socket.on.bind(f.socket);
    vi.spyOn(f.socket, 'on').mockImplementation((event, handler) => {
      const result = on(event, handler);
      if (event === 'close') throw new Error('private-close-registration');
      return result;
    });
    await expect(inspectFixtureDatabase(env, sql, f.driver, f.controller.signal)).rejects.toThrow('review');
    expect(f.wire).not.toHaveBeenCalled(); expect(f.pool.end).toHaveBeenCalledOnce();
  });
  it('returns only a frozen closed receipt after exactly one initial inspection', async () => {
    const f = fixture();
    const receipt = await inspectFixtureDatabase(env, sql, f.driver, f.controller.signal);
    expect(receipt).toEqual({ outcome: 'passed', readOnly: true, closed: true });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(f.prisma.$transaction).toHaveBeenCalledOnce();
    expect(f.wire.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    expect(f.prisma.$disconnect).toHaveBeenCalledOnce(); expect(f.pool.end).toHaveBeenCalledOnce();
  });
  it('does not certify inspection when cancellation arrives during owned closure', async () => {
    const f = fixture();
    f.prisma.$disconnect.mockImplementation(async () => { f.controller.abort(); });
    await expect(inspectFixtureDatabase(env, sql, f.driver, f.controller.signal)).rejects.toThrow('review');
    expect(f.pool.end).toHaveBeenCalledOnce();
  });
  it('does not certify inspection when the owned driver emits an error during closure', async () => {
    const f = fixture();
    f.prisma.$disconnect.mockImplementation(async () => { f.pool.emit('error', new Error('private-sentinel')); });
    await expect(inspectFixtureDatabase(env, sql, f.driver, f.controller.signal)).rejects.toThrow('review');
  });
  it.each(['pool', 'socket'] as const)('notifies the shared latch on %s failure after the frozen receipt exists', async (resource) => {
    const f = fixture(); const failure = vi.fn();
    const receipt = await inspectFixtureDatabase(env, sql, f.driver, f.controller.signal, failure);
    expect(receipt).toEqual({ outcome: 'passed', readOnly: true, closed: true }); expect(failure).not.toHaveBeenCalled();
    f[resource].emit('error', new Error('private-sentinel')); f[resource].emit('error', new Error('another-private-sentinel'));
    expect(failure).toHaveBeenCalledOnce(); expect(Object.isFrozen(receipt)).toBe(true);
    // This receipt proves inspection/closure only, not later command success.
    expect(Object.keys(receipt).sort()).toEqual(['closed', 'outcome', 'readOnly']);
  });
  it('sanitizes a throwing shared failure callback and still refuses completion', async () => {
    const f = fixture();
    f.prisma.$disconnect.mockImplementation(async () => { f.pool.emit('error', new Error('private-driver-sentinel')); });
    await expect(inspectFixtureDatabase(env, sql, f.driver, f.controller.signal, () => { throw new Error('private-observer-sentinel'); }))
      .rejects.toThrow('Fixture inspection requires review.');
    expect(f.pool.end).toHaveBeenCalledOnce();
  });
  it.each(['inspect-only', 'fixture-cycle'] as const)('requires actual backend/socket and confirmed read-only rollback in %s mode', async (mode) => {
    const f = fixture(mode); const db = await f.open(); await db.inspect();
    expect(f.wire.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(2);
    expect(f.config()).toMatchObject({ host: '127.0.0.1', port: 5433, database: 'applyflow_test', user: 'applyflow_test', max: 1, ssl: false });
    expect(Object.keys(db).sort()).toEqual(['cleanup', 'close', 'cycle', 'finalize', 'inspect', 'isClosed']);
    await db.close(); expect(db.isClosed()).toBe(true); expect(f.pool.end).toHaveBeenCalledOnce(); expect(f.review).not.toHaveBeenCalled();
  });
  it.each([{ NODE_ENV: undefined }, { NODE_ENV: 'production' }, { TEST_DATABASE_URL: undefined },
    { DATABASE_URL: env.TEST_DATABASE_URL }, { PGOPTIONS: 'x' }, { DEBUG: '*' },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('5433', '15432') },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('127.0.0.1', 'localhost') },
    { TEST_DATABASE_URL: `${env.TEST_DATABASE_URL}?options=x` }])('rejects admission before factories (%#)', async (change) => {
    const f = fixture(); await expect(f.open({ ...env, ...change })).rejects.toThrow();
    expect(f.driver.pool).not.toHaveBeenCalled(); expect(f.driver.socket).not.toHaveBeenCalled();
  });
  it('rejects changed migration bytes before construction', async () => {
    const f = fixture(); await expect(f.open(env, Buffer.from('changed'))).rejects.toThrow(); expect(f.driver.pool).not.toHaveBeenCalled();
  });
  it.each(['address', 'port', 'stream', 'pid', 'database', 'sessionUser'])('fails closed for bad physical evidence: %s', async (kind) => {
    const f = fixture();
    if (kind === 'address') f.socket.remoteAddress = '127.0.0.2';
    if (kind === 'port') f.socket.remotePort = 15432;
    if (kind === 'stream') f.physical.connection.stream = {} as typeof f.socket;
    if (kind === 'pid') f.identity.pid++;
    if (kind === 'database') f.identity.database = 'applyflow_dev';
    if (kind === 'sessionUser') f.identity.sessionUser = 'other';
    await expect(f.open()).rejects.toThrow('review'); expect(f.review).toHaveBeenCalled();
  });
  it.each(['schema', 'migration', 'version', 'quiet', 'rollback', 'read-only', 'isolation'])('rejects inspection discrepancy %s', async (kind) => {
    const f = fixture();
    if (kind === 'schema') f.rows.set(readOnlyCatalogSql.triggers.text, [{ value: 'unexpected' }]);
    if (kind === 'migration') f.rows.set(readOnlyCatalogSql.history.text, []);
    if (kind === 'version') f.settings.version = '180000';
    if (kind === 'quiet') f.rows.set(preflightControlSql.quiet, [{ others: 1 }]);
    if (kind === 'rollback') f.wire.mockImplementation(async (text) => ({ command: text === 'ROLLBACK' ? 'UNKNOWN' : 'SELECT', rows: f.rows.get(text) ?? [] }));
    if (kind === 'read-only' || kind === 'isolation') {
      const normal = f.wire.getMockImplementation()!;
      f.wire.mockImplementation(async (text) => text === preflightControlSql.settings
        ? { command: 'SELECT', rows: [{ ...f.settings, ...(kind === 'read-only' ? { readOnly: 'off' } : { isolation: 'read committed' }) }] }
        : normal(text));
    }
    await expect(f.open()).rejects.toThrow('review'); expect(f.pool.end).toHaveBeenCalledOnce();
  });
  it('rejects transaction backend substitution even on the same admitted endpoint', async () => {
    const f = fixture(); const db = await f.open(); f.identity.pid = 456;
    await expect(db.inspect()).rejects.toThrow('review'); await db.close();
  });
  it('guards every query receiver and stream, not just max:1 or the initial settings query', async () => {
    const f = fixture(); const db = await f.open();
    expect(() => Reflect.apply(f.physical.query, { connection: f.physical.connection }, ['SELECT 1'])).toThrow();
    f.physical.connection.stream = {} as typeof f.socket;
    expect(() => f.physical.query('COMMIT')).toThrow('binding'); await db.close();
  });
  it('refuses a second physical socket/client and never retries', async () => {
    const f = fixture(); const db = await f.open();
    expect(() => f.config().stream!()).toThrow('reconnect'); expect(f.driver.socket).toHaveBeenCalledOnce(); await db.close();
  });
  it('blocks writes from inspect-only facade before any operation is dispatched', async () => {
    const f = fixture(); const db = await f.open(); const before = f.wire.mock.calls.length;
    expect(() => db.cleanup({ ownership: 'parent-finalized' })).toThrow('disabled');
    expect(f.wire.mock.calls).toHaveLength(before); await db.close();
  });
  it('keeps interruption failed after a late read settles, permitting only rollback', async () => {
    const f = fixture(); const db = await f.open(); const held = deferred<Awaited<ReturnType<typeof f.wire>>>();
    const normal = f.wire.getMockImplementation()!; let entered!: () => void; const at = new Promise<void>((resolve) => { entered = resolve; });
    f.wire.mockImplementation((text) => { if (text === preflightControlSql.quiet) { entered(); return held.promise; } return normal(text); });
    const reading = db.inspect(); const failure = expect(reading).rejects.toThrow('review'); await at; f.controller.abort();
    held.resolve({ command: 'SELECT', rows: [{ others: 0 }] }); await failure;
    expect(f.wire.mock.calls.at(-1)).toEqual(['ROLLBACK']); await db.close();
  });
  it('bounds unconfirmed closure and never reports it closed', async () => {
    vi.useFakeTimers(); const f = fixture(); const db = await f.open(); f.pool.end.mockReturnValue(new Promise<never>(() => undefined));
    const closing = db.close(); const rejected = expect(closing).rejects.toThrow('review');
    await vi.advanceTimersByTimeAsync(2000); await rejected; expect(db.isClosed()).toBe(false); expect(f.socket.destroyed).toBe(true);
  });
  it('settles a connection deadline even when owned destruction throws, rejecting late connection success', async () => {
    vi.useFakeTimers(); const f = fixture(); const entered = deferred(); const held = deferred();
    const connect = f.prisma.$connect.getMockImplementation()!;
    f.prisma.$connect.mockImplementation(async () => { await connect(); entered.resolve(); await held.promise; });
    const destroy = vi.spyOn(f.socket, 'destroy').mockImplementation(() => { throw new Error('private-destruction-sentinel'); });
    f.pool.end.mockImplementation(async () => { f.physical.emit('end'); });
    const opening = f.open(); const rejected = expect(opening).rejects.toThrow('Fixture database initialization requires review.');
    await entered.promise; await vi.advanceTimersByTimeAsync(7000); await rejected;
    expect(destroy).toHaveBeenCalledOnce(); expect(f.review).toHaveBeenCalledOnce();
    f.controller.abort(); f.controller.abort(); held.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(f.prisma.$connect).toHaveBeenCalledOnce(); expect(f.pool.end).toHaveBeenCalledOnce(); expect(destroy).toHaveBeenCalledOnce();
    expect(f.wire.mock.calls.some(([text]) => text === 'BEGIN')).toBe(false);
  });
  it('settles an operation deadline despite throwing destruction and does not accept a late query', async () => {
    vi.useFakeTimers(); const f = fixture(); const db = await f.open();
    const entered = deferred(); const held = deferred<Awaited<ReturnType<typeof f.wire>>>(); const query = f.wire.getMockImplementation()!;
    f.wire.mockImplementation((text) => {
      if (text === preflightControlSql.quiet) { entered.resolve(); return held.promise; }
      return query(text);
    });
    const destroy = vi.spyOn(f.socket, 'destroy').mockImplementation(() => { throw new Error('private-destruction-sentinel'); });
    f.pool.end.mockImplementation(async () => { f.physical.emit('end'); });
    const reading = db.inspect(); const rejected = expect(reading).rejects.toThrow('Fixture database operation requires review.');
    await entered.promise; await vi.advanceTimersByTimeAsync(60_000); await rejected;
    f.controller.abort(); f.controller.abort(); held.resolve({ command: 'SELECT', rows: [{ others: 0 }] });
    await vi.advanceTimersByTimeAsync(0);
    await expect(db.inspect()).rejects.toThrow('authority');
    const closing = expect(db.close()).rejects.toThrow('Fixture database closure requires review.');
    await vi.advanceTimersByTimeAsync(2000); await closing;
    expect(db.isClosed()).toBe(false); expect(destroy).toHaveBeenCalledOnce(); expect(f.review).toHaveBeenCalledOnce();
    expect(f.wire.mock.calls.some(([text]) => text === 'COMMIT')).toBe(false);
  });
  it('settles a shutdown deadline with throwing destruction and cannot be revived by late closure', async () => {
    vi.useFakeTimers(); const f = fixture(); const db = await f.open(); const held = deferred();
    f.pool.end.mockReturnValue(held.promise);
    const destroy = vi.spyOn(f.socket, 'destroy').mockImplementation(() => { throw new Error('private-destruction-sentinel'); });
    const closing = db.close(); const rejected = expect(closing).rejects.toThrow('Fixture database closure requires review.');
    await vi.advanceTimersByTimeAsync(2000); await rejected;
    f.controller.abort(); f.controller.abort(); f.socket.closed = true; held.resolve(); await vi.advanceTimersByTimeAsync(0);
    await expect(db.close()).rejects.toThrow('Fixture database closure requires review.');
    expect(db.isClosed()).toBe(false); expect(destroy).toHaveBeenCalledOnce(); expect(f.pool.end).toHaveBeenCalledOnce();
    expect(f.review).toHaveBeenCalledOnce(); await expect(db.inspect()).rejects.toThrow('authority');
  });
  it.each(['disconnect', 'pool-end'])('sanitizes throwing destruction after %s closure failure', async (stage) => {
    const f = fixture(); const db = await f.open();
    const destroy = vi.spyOn(f.socket, 'destroy').mockImplementation(() => { throw new Error('private-destruction-sentinel'); });
    if (stage === 'disconnect') f.prisma.$disconnect.mockRejectedValueOnce(new Error('private-driver-sentinel'));
    else f.pool.end.mockRejectedValueOnce(new Error('private-driver-sentinel'));
    await expect(db.close()).rejects.toThrow('Fixture database closure requires review.');
    await expect(db.close()).rejects.toThrow('Fixture database closure requires review.');
    expect(destroy).toHaveBeenCalledOnce(); expect(db.isClosed()).toBe(false);
  });
  it('pins the installed adapter/pool routing and backend-key capture used by this binding', () => {
    const adapter = readFileSync(new URL('../../../node_modules/@prisma/adapter-pg/dist/index.mjs', import.meta.url), 'utf8');
    const pool = readFileSync(new URL('../../../node_modules/pg-pool/index.js', import.meta.url), 'utf8');
    const client = readFileSync(new URL('../../../node_modules/pg/lib/client.js', import.meta.url), 'utf8');
    expect(adapter).toContain('this.externalPool = poolOrConfig');
    expect(adapter).toContain('const conn = await this.client.connect()');
    expect(adapter).toContain('new PgTransaction(conn, options');
    expect(adapter).toContain('await this.client.query({');
    expect(pool).toContain('this.options.onConnect(client)');
    expect(client).toContain('this.processID = msg.processID');
    expect(Prisma.TransactionIsolationLevel.RepeatableRead).toBe('RepeatableRead');
  });
  it('executes the installed PrismaPg transaction adapter over the exact guarded fake PoolClient', async () => {
    const f = fixture('fixture-cycle'); const db = await f.open();
    // Prototype identity only: no real Pool constructor/connect/socket is used.
    Object.setPrototypeOf(f.pool, pg.Pool.prototype);
    const release = vi.fn(); Object.assign(f.physical, { release });
    const connect = vi.fn(async () => f.physical); Object.assign(f.pool, { connect });
    const normal = f.wire.getMockImplementation()!;
    f.wire.mockImplementation(async (input) => {
      const text = typeof input === 'string' ? input : (input as { text: string }).text;
      return { ...await normal(text), fields: [], rowCount: 1 };
    });
    const adapter = await new PrismaPg(f.pool as unknown as Pool).connect();
    const tx = await adapter.startTransaction('READ COMMITTED');
    expect(await tx.queryRaw({ sql: 'SELECT 1', args: [], argTypes: [] })).toMatchObject({ rows: [], columnNames: [] });
    await tx.executeRaw({ sql: 'ROLLBACK', args: [], argTypes: [] }); await tx.rollback();
    expect(connect).toHaveBeenCalledOnce(); expect(release).toHaveBeenCalledOnce();
    f.physical.connection.stream = {} as typeof f.socket;
    await expect(tx.queryRaw({ sql: 'SELECT 1', args: [], argTypes: [] })).rejects.toBeDefined();
    await adapter.dispose(); await db.close();
  });
  it.each(['success', 'unrecorded-session', 'wrong-return', 'absence-failed', 'commit-invalidated', 'permit-revoked'] as const)(
    'composes bound guarded finalization/cleanup and enforced read-only verification: %s', async (kind) => {
      const f = fixture('fixture-cycle'); const db = await f.open();
      const evidence = finalizationFixture([{ kind: 'email', value: email }, { kind: 'user', value: userId, email }, { kind: 'tokenHash', value: hash }]);
      evidence.exit();
      // Exercise the private facade's strict resolver as well as its connection/tx guards.
      const users = [{ id: userId, email }]; const sessions = [{ tokenHash: hash, userId }];
      const resolverText = 'SELECT id, email FROM public."User" WHERE email IN ($1) ORDER BY id FOR KEY SHARE';
      f.rows.set(resolverText, users);
      const permit = await db.finalize(evidence.finalizer, owner, evidence.journal);
      f.rows.set(cleanupSql.lockUsers(users)!.text, users);
      f.rows.set(cleanupSql.lockSessions({ users, hashes: [hash] })!.text,
        kind === 'unrecorded-session' ? [{ tokenHash: 'b'.repeat(64), userId }] : sessions);
      f.rows.set(cleanupSql.deleteSessions(sessions)!.text, kind === 'wrong-return' ? [] : sessions);
      f.rows.set(cleanupSql.deleteUsers(users)!.text, users);
      if (kind === 'absence-failed') f.rows.set('SELECT id FROM public."User" WHERE id IN ($1::uuid)', [{ id: userId }]);
      if (kind === 'commit-invalidated') {
        const normal = f.wire.getMockImplementation()!;
        f.wire.mockImplementation(async (text) => { const value = await normal(text); if (text === 'COMMIT') f.controller.abort(); return value; });
      }
      if (kind === 'permit-revoked') {
        const normal = f.wire.getMockImplementation()!;
        f.wire.mockImplementation(async (text) => {
          const value = await normal(text);
          if (text === cleanupSql.lockSessions({ users, hashes: [hash] })!.text) evidence.finalizer.review();
          return value;
        });
      }
      if (kind === 'success') {
        await db.cleanup(permit); expect(evidence.finalizer.phase()).toBe('cleaned');
        expect(f.wire.mock.calls.filter(([text]) => text === 'SET TRANSACTION READ ONLY')).toHaveLength(2);
        const deletions = f.wire.mock.calls.filter(([text]) => text.startsWith('DELETE')).length;
        await db.cleanup(permit); expect(f.wire.mock.calls.filter(([text]) => text.startsWith('DELETE'))).toHaveLength(deletions);
      } else {
        await expect(db.cleanup(permit)).rejects.toThrow('review'); expect(evidence.finalizer.phase()).toBe('review-required');
        if (kind === 'permit-revoked') expect(f.wire.mock.calls.some(([text]) => text.startsWith('DELETE'))).toBe(false);
        await expect(db.inspect()).rejects.toThrow();
      }
      await db.close();
    }
  );
});
