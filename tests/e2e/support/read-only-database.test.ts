import { EventEmitter } from 'node:events';
import type { Socket } from 'node:net';
import type { ClientConfig } from 'pg';
import type { DatabaseEnvironment } from '../../../apps/api/src/config/database.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { inspectReadOnlyDatabase, preflightControlSql, preflightLimits, ReadOnlyPreflightError,
  type ReadOnlyClient, type ReadOnlyDependencies } from './read-only-database.js';
import { catalogSql, inspectReadOnlyCatalog, readOnlyCatalogSql } from './catalog.js';
import { env, sql, inspection, deferred } from './b1-fakes.js';

function fixture() {
  const emitter = new EventEmitter();
  const socketEvents = new EventEmitter();
  const socket = Object.assign(socketEvents, { remoteAddress: '127.0.0.1', remotePort: 5433,
    destroyed: false, closed: false, destroy: vi.fn(() => {
      Object.assign(socket, { destroyed: true, closed: true }); socket.emit('close'); return socket;
    }) });
  const expected = inspection();
  const schema = expected.schema as typeof import('./schema.js').expectedSchema;
  const settings = { database: 'applyflow_test', username: 'applyflow_test', sessionUser: 'applyflow_test',
    version: '170009', readOnly: 'on', defaultReadOnly: 'on', isolation: 'repeatable read',
    statementTimeout: '5s', lockTimeout: '2s', idleTimeout: '10s', searchPath: 'pg_catalog, public' };
  const rows = new Map<string, unknown[]>([
    [preflightControlSql.settings, [settings]], [preflightControlSql.quiet, [{ others: 0 }]],
    [readOnlyCatalogSql.identity.text, [{ database: 'applyflow_test', username: 'applyflow_test' }]],
    [readOnlyCatalogSql.relations.text, ['Session', 'User', '_prisma_migrations'].map((name) => ({ name, kind: 'r', persistence: 'p' }))],
    [readOnlyCatalogSql.history.text, expected.history as unknown[]],
    [readOnlyCatalogSql.tables.text, schema.tables.map((name) => ({ name }))],
    [readOnlyCatalogSql.columns.text, schema.columns], [readOnlyCatalogSql.indexes.text, schema.indexes],
    [readOnlyCatalogSql.constraints.text, schema.constraints.map((value) => ({ value }))],
    [readOnlyCatalogSql.triggers.text, []], [readOnlyCatalogSql.rowSecurity.text, []]
  ]);
  const query = vi.fn(async (text: string) => {
    if (text === preflightControlSql.begin) return { command: 'BEGIN', rows: [] };
    if (text === preflightControlSql.rollback) return { command: 'ROLLBACK', rows: [] };
    if (!rows.has(text)) throw new Error('Unexpected query');
    return { command: 'SELECT', rows: rows.get(text)! };
  });
  const client = Object.assign(emitter, { connection: { stream: socket as unknown },
    connect: vi.fn(async (): Promise<void> => undefined), query,
    end: vi.fn(async () => { socket.destroy(); emitter.emit('end'); }) });
  const makeClient = vi.fn((config: ClientConfig): ReadOnlyClient => {
    client.connection.stream = config.stream!(); return client;
  });
  const makeSocket = vi.fn(() => socket as unknown as Socket);
  const dependencies: ReadOnlyDependencies = { socket: makeSocket, client: makeClient };
  return { socket, client, query, rows, settings, dependencies, makeClient, makeSocket,
    run: (source: DatabaseEnvironment = { ...env }, migration: Uint8Array = sql, signal?: AbortSignal) =>
      inspectReadOnlyDatabase(source, migration, dependencies, signal) };
}

// Reproduce the audit's promise-reaction window after the last catalog result,
// before the adapter can hand normal ROLLBACK to the driver. No real I/O occurs.
function afterFinalCatalog(fake: ReturnType<typeof fixture>, effect: () => void, depth = 3) {
  const normal = fake.query.getMockImplementation()!;
  const evidence = { completed: false, rollbackCallsAtFault: -1 };
  fake.query.mockImplementation(async (text) => {
    const result = await normal(text);
    if (text === readOnlyCatalogSql.rowSecurity.text) {
      evidence.completed = true;
      const schedule = (remaining: number) => queueMicrotask(() => {
        if (remaining) schedule(remaining - 1);
        else {
          evidence.rollbackCallsAtFault = fake.query.mock.calls.filter(([query]) => query === 'ROLLBACK').length;
          effect();
        }
      });
      schedule(depth);
    }
    return result;
  });
  return evidence;
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('B2 private read-only database adapter (injected protocol/socket only)', () => {
  it('uses one owned protocol stream, fixed settings, read-only BEGIN, fresh final checks and one ROLLBACK', async () => {
    const fake = fixture();
    const result = await fake.run();
    expect(result).toEqual({ outcome: 'passed', readOnly: true, closed: true }); expect(Object.isFrozen(result)).toBe(true);
    expect(fake.makeSocket).toHaveBeenCalledOnce(); expect(fake.makeClient).toHaveBeenCalledOnce();
    const config = fake.makeClient.mock.calls[0]![0];
    expect(config).toMatchObject({ host: '127.0.0.1', port: 5433, database: 'applyflow_test', user: 'applyflow_test',
      ssl: false, pipeline: false, connectionTimeoutMillis: 5000, statement_timeout: 5000,
      lock_timeout: 2000, idle_in_transaction_session_timeout: 10000,
      options: '-c default_transaction_read_only=on -c search_path=pg_catalog,public' });
    expect(config).not.toHaveProperty('connectionString'); expect(config.stream!()).toBe(fake.socket);
    expect(fake.client.connection.stream).toBe(fake.socket);
    const calls = fake.query.mock.calls.map(([text]) => text);
    expect(calls.slice(0, 3)).toEqual([preflightControlSql.begin, preflightControlSql.settings, preflightControlSql.quiet]);
    expect(calls.slice(-3)).toEqual([preflightControlSql.rollback, preflightControlSql.settings, preflightControlSql.quiet]);
    expect(calls.filter((text) => text === 'ROLLBACK')).toHaveLength(1);
    expect(calls).not.toContain(catalogSql.history.text);
    const allowed = new Set([...Object.values(preflightControlSql), ...Object.values(readOnlyCatalogSql).map((item) => item.text)]);
    expect(calls.every((text) => allowed.has(text))).toBe(true);
    expect(fake.client.end).toHaveBeenCalledOnce();
    expect(fake.client.listenerCount('error')).toBe(0); expect(fake.client.listenerCount('end')).toBe(0);
    expect(fake.socket.listenerCount('error')).toBe(0);
    expect(Object.keys(result).sort()).toEqual(['closed', 'outcome', 'readOnly']);
  });
  it('accepts only the optional schema=public URL parameter without forwarding it', async () => {
    const fake = fixture(); await fake.run({ ...env, TEST_DATABASE_URL: `${env.TEST_DATABASE_URL}?schema=public` });
    expect(fake.makeClient.mock.calls[0]![0]).not.toHaveProperty('connectionString');
  });
  it('accepts the fixed startup search path with PostgreSQL preserving comma spacing', async () => {
    const fake = fixture(); fake.settings.searchPath = 'pg_catalog,public'; await expect(fake.run()).resolves.toHaveProperty('outcome', 'passed');
  });
  it.each([
    { NODE_ENV: undefined }, { NODE_ENV: 'development' }, { NODE_ENV: 'production' }, { TEST_DATABASE_URL: undefined },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('127.0.0.1', 'localhost') },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('127.0.0.1', '192.0.2.1') },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('5433', '15432') },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('/applyflow_test', '/applyflow_dev') },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('applyflow_test:', 'applyflow_dev:') },
    { TEST_DATABASE_URL: `${env.TEST_DATABASE_URL}?options=-c%20default_transaction_read_only=off` },
    { TEST_DATABASE_URL: `${env.TEST_DATABASE_URL}?host=127.0.0.1` },
    { TEST_DATABASE_URL: `${env.TEST_DATABASE_URL}?schema=other` },
    { TEST_DATABASE_URL: `${env.TEST_DATABASE_URL}?schema=public&schema=public` },
    { DATABASE_URL: env.TEST_DATABASE_URL }, { DIRECT_URL: env.TEST_DATABASE_URL }, { SHADOW_DATABASE_URL: env.TEST_DATABASE_URL },
    { PGHOST: '127.0.0.1' }, { PGPORT: '5433' }, { PGOPTIONS: '-c default_transaction_read_only=off' },
    { pgpassword: 'sentinel' }, { NODE_OPTIONS: '--inspect' }, { NODE_PATH: 'sentinel' }, { APP_ORIGIN: 'sentinel' },
    { HOST: '127.0.0.1' }, { PORT: '3000' }
  ])('rejects unsafe environment before resource construction (%j)', async (override) => {
    const fake = fixture();
    await expect(fake.run({ ...env, ...override })).rejects.toThrow('ADMISSION');
    expect(fake.makeSocket).not.toHaveBeenCalled(); expect(fake.makeClient).not.toHaveBeenCalled();
  });
  it('rejects changed migration bytes before constructing resources', async () => {
    const fake = fixture(); await expect(fake.run(env, Buffer.from('different migration'))).rejects.toThrow('ADMISSION');
    expect(fake.makeClient).not.toHaveBeenCalled(); expect(fake.makeSocket).not.toHaveBeenCalled();
  });
  it('rejects already cancelled requests before constructing resources', async () => {
    const fake = fixture(); const cancel = new AbortController(); cancel.abort();
    await expect(fake.run(env, sql, cancel.signal)).rejects.toThrow('INTERRUPTED'); expect(fake.makeSocket).not.toHaveBeenCalled();
  });
  it.each([{ remoteAddress: '::1' }, { remoteAddress: undefined }, { remotePort: 5432 }, { remotePort: undefined },
    { destroyed: true }, { closed: true }])('rejects unavailable/wrong actual socket evidence (%j)', async (change) => {
    const fake = fixture(); Object.assign(fake.socket, change);
    await expect(fake.run()).rejects.toThrow('PEER'); expect(fake.query).not.toHaveBeenCalled(); expect(fake.client.end).toHaveBeenCalledOnce();
  });
  it('rejects a different protocol stream even with correct caller metadata', async () => {
    const fake = fixture(); fake.makeClient.mockImplementationOnce(() => {
      fake.client.connection.stream = { remoteAddress: '127.0.0.1', remotePort: 5433 }; return fake.client;
    });
    await expect(fake.run()).rejects.toThrow('PEER'); expect(fake.client.connect).not.toHaveBeenCalled();
  });
  it('rechecks the protocol stream after connection and before every query', async () => {
    const fake = fixture(); fake.client.connect.mockImplementationOnce(async () => { fake.client.connection.stream = {}; });
    await expect(fake.run()).rejects.toThrow('PEER'); expect(fake.query).not.toHaveBeenCalled();
  });
  it('does not use extended socket metadata to replace actual connected identity', async () => {
    const fake = fixture(); Object.assign(fake.socket, { database: 'applyflow_test', username: 'applyflow_test' });
    fake.settings.database = 'applyflow_dev'; await expect(fake.run()).rejects.toThrow('SETTINGS');
    expect(fake.query.mock.calls.some(([text]) => text === readOnlyCatalogSql.history.text)).toBe(false);
  });
  it.each([
    { readOnly: 'off' }, { defaultReadOnly: 'off' }, { isolation: 'read committed' },
    { database: 'applyflow_dev' }, { username: 'applyflow_dev' }, { sessionUser: 'another_user' },
    { version: '180000' }, { version: 'garbage' }, { statementTimeout: '0' }, { lockTimeout: '0' },
    { idleTimeout: '0' }, { searchPath: 'public' }
  ])('rejects unsafe effective settings before catalog inspection (%j)', async (change) => {
    const fake = fixture(); Object.assign(fake.settings, change);
    await expect(fake.run()).rejects.toThrow('SETTINGS');
    expect(fake.query.mock.calls.map(([text]) => text)).toEqual([preflightControlSql.begin, preflightControlSql.settings, 'ROLLBACK']);
    expect(fake.client.end).toHaveBeenCalledOnce();
  });
  it.each([{ rows: [] }, { rows: [{ ...fixture().settings }, { ...fixture().settings }] }])('rejects missing/duplicate settings rows', async ({ rows }) => {
    const fake = fixture(); fake.rows.set(preflightControlSql.settings, rows); await expect(fake.run()).rejects.toThrow('SETTINGS');
  });
  it.each(['v', 'f', 'p', 'm'])('rejects relation kind %s before reading migration contents', async (kind) => {
    const fake = fixture(); fake.rows.set(readOnlyCatalogSql.relations.text, [
      { name: 'User', kind: 'r', persistence: 'p' }, { name: 'Session', kind: 'r', persistence: 'p' },
      { name: '_prisma_migrations', kind, persistence: 'p' }
    ]);
    await expect(fake.run()).rejects.toThrow('CATALOG');
    expect(fake.query.mock.calls.map(([text]) => text)).not.toContain(readOnlyCatalogSql.history.text);
  });
  it.each([
    { relations: [{ name: 'User', kind: 'r', persistence: 'p' }] },
    { relations: ['User', 'User', '_prisma_migrations'].map((name) => ({ name, kind: 'r', persistence: 'p' })) },
    { relations: ['User', 'Session', '_prisma_migrations'].map((name) => ({ name, kind: 'r', persistence: 'u' })) }
  ])('rejects missing, duplicate or nonpermanent relation metadata', async ({ relations }) => {
    const fake = fixture(); fake.rows.set(readOnlyCatalogSql.relations.text, relations);
    await expect(fake.run()).rejects.toThrow('CATALOG');
    expect(fake.query.mock.calls.map(([text]) => text)).not.toContain(readOnlyCatalogSql.history.text);
  });
  it.each([
    ['migration_name', 'other'], ['checksum', 'a'.repeat(64)], ['finished_at', null],
    ['rolled_back_at', new Date()], ['applied_steps_count', 0], ['logs', 'sensitive failure text']
  ])('rejects migration-history mismatch in %s', async (key, value) => {
    const fake = fixture(); Object.assign(fake.rows.get(readOnlyCatalogSql.history.text)![0]!, { [key as string]: value });
    await expect(fake.run()).rejects.toThrow('CATALOG'); expect(fake.client.end).toHaveBeenCalledOnce();
  });
  it.each([{ rows: [] }, { rows: [...inspection().history as unknown[], ...inspection().history as unknown[]] }])('rejects missing or additional migration rows', async ({ rows }) => {
    const fake = fixture(); fake.rows.set(readOnlyCatalogSql.history.text, rows); await expect(fake.run()).rejects.toThrow('CATALOG');
  });
  it.each(['tables', 'columns', 'indexes', 'constraints', 'triggers', 'rowSecurity'] as const)(
    'rejects a catalog discrepancy in %s', async (key) => {
      const fake = fixture();
      const rows = fake.rows.get(readOnlyCatalogSql[key].text)!;
      fake.rows.set(readOnlyCatalogSql[key].text, key === 'triggers' || key === 'rowSecurity' ? [{ value: 'unexpected' }] : [...rows, ...rows]);
      await expect(fake.run()).rejects.toThrow('CATALOG');
      expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    }
  );
  it.each(['identity', 'relations', 'history', 'tables', 'columns', 'indexes', 'constraints', 'triggers', 'rowSecurity'] as const)(
    'sanitizes query failure at %s and requests rollback and close', async (key) => {
      const fake = fixture(); const normal = fake.query.getMockImplementation()!;
      fake.query.mockImplementation(async (text) => {
        if (text === readOnlyCatalogSql[key].text) throw new Error('postgresql://user:password@host/db raw-cookie csrf-proof');
        return normal(text);
      });
      await expect(fake.run()).rejects.toThrow(/^Read-only preflight failed: CATALOG\.$/);
      expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1); expect(fake.client.end).toHaveBeenCalledOnce();
    }
  );
  it.each([1, 2])('fails closed for other clients on quiet check %i', async (at) => {
    const fake = fixture(); const normal = fake.query.getMockImplementation()!; let checks = 0;
    fake.query.mockImplementation(async (text) => {
      if (text === preflightControlSql.quiet && ++checks === at) return { command: 'SELECT', rows: [{ others: 1 }] };
      return normal(text);
    });
    await expect(fake.run()).rejects.toThrow('QUIET'); expect(fake.client.end).toHaveBeenCalledOnce();
  });
  it('checks identity again after rollback, without assuming the previous read proves it', async () => {
    const fake = fixture(); const normal = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (text) => {
      if (text === 'ROLLBACK') fake.settings.username = 'other'; return normal(text);
    });
    await expect(fake.run()).rejects.toThrow('SETTINGS');
  });
  it('fails if the socket changes during inspection', async () => {
    const fake = fixture(); const normal = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (text) => {
      if (text === readOnlyCatalogSql.columns.text) fake.socket.remotePort = 15432; return normal(text);
    });
    await expect(fake.run()).rejects.toThrow('PEER');
  });
  it('rejects a wrong independent catalog identity despite valid settings', async () => {
    const fake = fixture(); fake.rows.set(readOnlyCatalogSql.identity.text, [{ database: 'applyflow_dev', username: 'applyflow_test' }]);
    await expect(fake.run()).rejects.toThrow('CATALOG');
  });
  it('cannot recover authorization when the environment changes mid-read', async () => {
    const fake = fixture(); const source = { ...env }; const normal = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (text) => {
      if (text === readOnlyCatalogSql.columns.text) source.NODE_ENV = 'production'; return normal(text);
    });
    await expect(fake.run(source)).rejects.toThrow('ADMISSION');
    expect(fake.query.mock.calls.map(([text]) => text)).not.toContain(readOnlyCatalogSql.indexes.text);
  });
  it('sanitizes synchronous socket and driver constructor exceptions', async () => {
    for (const constructor of ['socket', 'client'] as const) {
      const fake = fixture(); fake.dependencies[constructor] = () => { throw new Error('password connection-string sentinel'); };
      await expect(fake.run()).rejects.toThrow(/^Read-only preflight failed: CONNECT\.$/);
      if (constructor === 'client') expect(fake.socket.destroy).toHaveBeenCalled();
    }
  });
  it('sanitizes connection rejection without retry or fallback', async () => {
    const fake = fixture(); fake.client.connect.mockRejectedValueOnce(new Error('sensitive url'));
    await expect(fake.run()).rejects.toThrow(/^Read-only preflight failed: CONNECT\.$/);
    expect(fake.client.connect).toHaveBeenCalledOnce(); expect(fake.query).not.toHaveBeenCalled(); expect(fake.client.end).toHaveBeenCalledOnce();
  });
  it.each(['reject', 'wrong-command'] as const)('never succeeds or retries after rollback %s', async (mode) => {
    const fake = fixture(); const normal = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (text) => {
      if (text === 'ROLLBACK') { if (mode === 'reject') throw new Error('secret'); return { command: 'COMMIT', rows: [] }; }
      return normal(text);
    });
    await expect(fake.run()).rejects.toThrow('ROLLBACK');
    expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1); expect(fake.client.end).toHaveBeenCalledOnce();
  });
  it.each(['reject', 'no-close'] as const)('never succeeds after driver shutdown %s', async (mode) => {
    const fake = fixture(); fake.client.end.mockImplementationOnce(async () => { if (mode === 'reject') throw new Error('raw secret'); });
    await expect(fake.run()).rejects.toThrow('CLOSE'); expect(fake.socket.destroy).toHaveBeenCalled();
  });
  it('sanitizes failures while destroying the owned socket', async () => {
    const fake = fixture(); fake.client.end.mockRejectedValueOnce(new Error('sensitive driver failure'));
    fake.socket.destroy.mockImplementation(() => { throw new Error('raw password sentinel'); });
    await expect(fake.run()).rejects.toThrow(/^Read-only preflight failed: CLOSE\.$/);
  });
  it('rejects unexpected BEGIN confirmation and requests rollback', async () => {
    const fake = fixture(); fake.query.mockResolvedValueOnce({ command: 'SELECT', rows: [] });
    await expect(fake.run()).rejects.toThrow('SETTINGS'); expect(fake.query.mock.calls.map(([text]) => text)).toEqual([preflightControlSql.begin, 'ROLLBACK']);
  });
  it('bounds stalled connection establishment and ignores late connect completion', async () => {
    vi.useFakeTimers(); const fake = fixture(); const connect = deferred(); fake.client.connect.mockReturnValueOnce(connect.promise);
    const pending = fake.run(); const failure = expect(pending).rejects.toThrow('TIMEOUT');
    await vi.advanceTimersByTimeAsync(preflightLimits.connect); await failure;
    connect.resolve(); await Promise.resolve(); expect(fake.query).not.toHaveBeenCalled(); expect(fake.client.end).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a stalled query and cannot dispatch later catalog reads after late completion', async () => {
    vi.useFakeTimers(); const fake = fixture(); const read = deferred<Awaited<ReturnType<typeof fake.query>>>();
    const normal = fake.query.getMockImplementation()!; fake.query.mockImplementation(async (text) =>
      text === readOnlyCatalogSql.history.text ? read.promise : normal(text));
    const pending = fake.run(); const failure = expect(pending).rejects.toThrow('TIMEOUT');
    await vi.advanceTimersByTimeAsync(preflightLimits.total); await failure;
    const count = fake.query.mock.calls.length; read.resolve({ command: 'SELECT', rows: inspection().history as unknown[] });
    await Promise.resolve(); await Promise.resolve(); expect(fake.query).toHaveBeenCalledTimes(count);
    expect(fake.query.mock.calls.map(([text]) => text)).not.toContain(readOnlyCatalogSql.tables.text); expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds stalled rollback and shutdown within one shutdown budget', async () => {
    vi.useFakeTimers(); const fake = fixture(); const never = new Promise<never>(() => undefined);
    fake.query.mockRejectedValueOnce(new Error('begin failed'));
    const normal = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (text) => text === 'ROLLBACK' ? never : normal(text));
    fake.client.end.mockReturnValueOnce(never);
    const pending = fake.run(); const failure = expect(pending).rejects.toThrow('QUERY');
    await vi.advanceTimersByTimeAsync(preflightLimits.shutdown); await failure;
    expect(fake.client.end).toHaveBeenCalledOnce(); expect(fake.socket.destroy).toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0);
  });
  it('cannot succeed when rollback remains unconfirmed', async () => {
    vi.useFakeTimers(); const fake = fixture(); const normal = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (text) => text === 'ROLLBACK' ? new Promise<never>(() => undefined) : normal(text));
    const pending = fake.run(); const failure = expect(pending).rejects.toThrow('TIMEOUT');
    await vi.advanceTimersByTimeAsync(preflightLimits.total); await failure; expect(fake.client.end).toHaveBeenCalledOnce();
  });
  it('bounds a stalled close, and late closure cannot establish success', async () => {
    vi.useFakeTimers(); const fake = fixture(); const ending = deferred(); fake.client.end.mockReturnValueOnce(ending.promise);
    const pending = fake.run(); const failure = expect(pending).rejects.toThrow('CLOSE');
    await vi.advanceTimersByTimeAsync(preflightLimits.shutdown); await failure;
    ending.resolve(); await Promise.resolve(); expect(fake.client.end).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
    fake.client.emit('error'); // Sanitized sink remains until confirmed end.
    fake.client.emit('end');
    expect(fake.client.listenerCount('error')).toBe(0); expect(fake.client.listenerCount('end')).toBe(0);
  });
  it('cancellation stops read continuation, attempts rollback, and never retries', async () => {
    const fake = fixture(); const controller = new AbortController(); const entered = deferred(); const read = deferred<Awaited<ReturnType<typeof fake.query>>>();
    const normal = fake.query.getMockImplementation()!; fake.query.mockImplementation(async (text) => {
      if (text === readOnlyCatalogSql.history.text) { entered.resolve(); return read.promise; } return normal(text);
    });
    const pending = fake.run(env, sql, controller.signal); const failure = expect(pending).rejects.toThrow('INTERRUPTED');
    await entered.promise; controller.abort(); await failure; const count = fake.query.mock.calls.length;
    read.resolve({ command: 'SELECT', rows: inspection().history as unknown[] }); await Promise.resolve();
    expect(fake.query).toHaveBeenCalledTimes(count); expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
  });
  it.each(['error', 'end'] as const)('rejects unexpected driver %s events before success', async (event) => {
    const fake = fixture(); const normal = fake.query.getMockImplementation()!;
    fake.query.mockImplementation(async (text) => {
      if (text === readOnlyCatalogSql.history.text) fake.client.emit(event); return normal(text);
    });
    await expect(fake.run()).rejects.toThrow('CONNECTION');
  });
  it('rejects cancellation during shutdown rather than publishing a completed inspection', async () => {
    const fake = fixture(); const controller = new AbortController();
    fake.client.end.mockImplementationOnce(async () => { controller.abort(); fake.socket.destroy(); fake.client.emit('end'); });
    await expect(fake.run(env, sql, controller.signal)).rejects.toThrow('INTERRUPTED');
  });
  it('does not expose forged diagnostic codes from an injected dependency', () => {
    const error = new ReadOnlyPreflightError('postgresql://user:secret@host/db' as 'QUERY');
    expect(error.code).toBe('QUERY'); expect(error.message).toBe('Read-only preflight failed: QUERY.');
  });
  it.each([2, 3, 4, 5])('dispatches cleanup rollback after the audit connection-error ordering %i', async (depth) => {
    const fake = fixture();
    const evidence = afterFinalCatalog(fake, () => fake.client.emit('error'), depth);
    await expect(fake.run()).rejects.toThrow(/^Read-only preflight failed: CONNECTION\.$/);
    expect(evidence).toEqual({ completed: true, rollbackCallsAtFault: 0 });
    expect(fake.query.mock.calls.filter(([text]) => text === preflightControlSql.begin)).toHaveLength(1);
    expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    expect(fake.client.end).toHaveBeenCalledOnce(); expect(fake.socket.closed).toBe(true);
    expect(fake.query.mock.calls.at(-1)).toEqual(['ROLLBACK']);
  });
  it('attempts cleanup rollback on usable owned transport after cancellation immediately before handoff', async () => {
    const fake = fixture(); const controller = new AbortController();
    const evidence = afterFinalCatalog(fake, () => controller.abort());
    await expect(fake.run(env, sql, controller.signal)).rejects.toThrow('INTERRUPTED');
    expect(evidence).toEqual({ completed: true, rollbackCallsAtFault: 0 });
    expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    expect(fake.client.end).toHaveBeenCalledOnce(); expect(fake.socket.closed).toBe(true);
  });
  it('uses only fixed cleanup rollback after admission is lost before normal handoff', async () => {
    const fake = fixture(); const source = { ...env };
    const evidence = afterFinalCatalog(fake, () => { source.NODE_ENV = 'production'; });
    await expect(fake.run(source)).rejects.toThrow('ADMISSION');
    expect(evidence).toEqual({ completed: true, rollbackCallsAtFault: 0 });
    expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    expect(fake.query.mock.calls.at(-1)).toEqual(['ROLLBACK']); expect(fake.client.end).toHaveBeenCalledOnce();
  });
  it('rechecks temporary peer-evidence failure before fixed cleanup handoff', async () => {
    const fake = fixture();
    const evidence = afterFinalCatalog(fake, () => {
      let reads = 0;
      Object.defineProperty(fake.socket, 'remotePort', { get: () => ++reads === 1 ? undefined : 5433 });
    });
    await expect(fake.run()).rejects.toThrow('PEER');
    expect(evidence).toEqual({ completed: true, rollbackCallsAtFault: 0 });
    expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    expect(fake.client.end).toHaveBeenCalledOnce();
  });
  it.each(['destroyed', 'swapped', 'wrong-peer', 'ended'] as const)(
    'never dispatches cleanup SQL on an unusable %s connection before rollback', async (condition) => {
      const fake = fixture();
      const evidence = afterFinalCatalog(fake, () => {
        if (condition === 'destroyed') fake.socket.destroy();
        if (condition === 'swapped') fake.client.connection.stream = {};
        if (condition === 'wrong-peer') fake.socket.remotePort = 15432;
        if (condition === 'ended') fake.client.emit('end');
      });
      await expect(fake.run()).rejects.toThrow(condition === 'ended' ? 'CONNECTION' : 'PEER');
      expect(evidence).toEqual({ completed: true, rollbackCallsAtFault: 0 });
      expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(0);
      expect(fake.client.end).toHaveBeenCalledOnce(); expect(fake.socket.closed).toBe(true);
    }
  );
  it('never repeats rollback handed to the driver before a connection error, even after late confirmation', async () => {
    const fake = fixture(); const confirmation = deferred<Awaited<ReturnType<typeof fake.query>>>();
    const normal = fake.query.getMockImplementation()!;
    fake.query.mockImplementation((text) => {
      if (text === 'ROLLBACK') { queueMicrotask(() => fake.client.emit('error')); return confirmation.promise; }
      return normal(text);
    });
    await expect(fake.run()).rejects.toThrow('CONNECTION');
    const count = fake.query.mock.calls.length;
    confirmation.resolve({ command: 'ROLLBACK', rows: [] }); await Promise.resolve(); await Promise.resolve();
    expect(fake.query).toHaveBeenCalledTimes(count);
    expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    expect(fake.query.mock.calls.at(-1)).toEqual(['ROLLBACK']); expect(fake.client.end).toHaveBeenCalledOnce();
  });
  it('treats synchronous rollback invocation failure as a driver handoff and never retries it', async () => {
    const fake = fixture(); const normal = fake.query.getMockImplementation()!;
    fake.query.mockImplementation((text) => {
      if (text === 'ROLLBACK') throw new Error('sensitive synchronous driver failure');
      return normal(text);
    });
    await expect(fake.run()).rejects.toThrow(/^Read-only preflight failed: ROLLBACK\.$/);
    expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    expect(fake.client.end).toHaveBeenCalledOnce();
  });
  it('does not retry a synchronous cleanup rollback invocation failure after the audit ordering', async () => {
    const fake = fixture(); const normal = fake.query.getMockImplementation()!;
    fake.query.mockImplementation((text) => {
      if (text === 'ROLLBACK') throw new Error('sensitive cleanup failure');
      return normal(text);
    });
    const evidence = afterFinalCatalog(fake, () => fake.client.emit('error'));
    await expect(fake.run()).rejects.toThrow('CONNECTION');
    expect(evidence).toEqual({ completed: true, rollbackCallsAtFault: 0 });
    expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    expect(fake.client.end).toHaveBeenCalledOnce();
  });
  it('retains an unconfirmed dispatched rollback after the overall timeout and late response', async () => {
    vi.useFakeTimers(); const fake = fixture(); const confirmation = deferred<Awaited<ReturnType<typeof fake.query>>>();
    const normal = fake.query.getMockImplementation()!;
    fake.query.mockImplementation((text) => text === 'ROLLBACK' ? confirmation.promise : normal(text));
    const pending = fake.run(); const failure = expect(pending).rejects.toThrow('TIMEOUT');
    await vi.advanceTimersByTimeAsync(preflightLimits.total); await failure;
    const count = fake.query.mock.calls.length;
    confirmation.resolve({ command: 'ROLLBACK', rows: [] }); await Promise.resolve(); await Promise.resolve();
    expect(fake.query).toHaveBeenCalledTimes(count);
    expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    expect(fake.client.end).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  });
});

describe('B2 read-only catalog preserves B1 and projects endpoint identity', () => {
  it('retains B1 row locking while the read-only history variant has no locking clause', () => {
    expect(catalogSql.history.text).toContain('FOR SHARE'); expect(readOnlyCatalogSql.history.text).not.toMatch(/FOR\s+(SHARE|UPDATE|KEY)/i);
  });
  it('strips extended endpoint metadata and returns only queried database/user identity', async () => {
    const fake = fixture(); const endpoint = { host: '127.0.0.1', port: 5433, database: 'wrong', username: 'wrong', databaseUrl: 'never-persist' };
    const result = await inspectReadOnlyCatalog(async (key) => fake.rows.get(readOnlyCatalogSql[key].text), endpoint);
    expect(result.identity).toEqual({ host: '127.0.0.1', port: 5433, database: 'applyflow_test', username: 'applyflow_test' });
    expect(JSON.stringify(result)).not.toContain('never-persist');
  });
});
