import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import type { Pool, PoolClient, PoolConfig, ClientConfig } from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../../apps/api/src/generated/prisma/client.ts';
import { runFixtureInspection, type FixtureInspectionRuntime } from './fixture-preflight.js';
import { fixtureBackendSql, installedFixtureDriver, type FixtureDriver } from './fixture-database.js';
import { preflightControlSql, type ReadOnlyDependencies } from './read-only-database.js';
import { readOnlyCatalogSql } from './catalog.js';
import { requireLivePhase } from './execution.js';
import { env, sql, inspection, deferred } from './b1-fakes.js';

function fakeSocket() {
  return Object.assign(new EventEmitter(), { remoteAddress: '127.0.0.1', remotePort: 5433, destroyed: false, closed: false,
    destroy(this: EventEmitter & { destroyed: boolean; closed: boolean }) {
      if (!this.destroyed) { this.destroyed = true; this.closed = true; this.emit('close', false); } return this;
    } });
}
function fixture() {
  const signals = new EventEmitter(); const b2Socket = fakeSocket(); const socket = fakeSocket();
  const checked = inspection(); const schema = checked.schema as typeof import('./schema.js').expectedSchema;
  const identity = { database: 'applyflow_test', username: 'applyflow_test', sessionUser: 'applyflow_test', pid: 123 };
  const settings = { ...identity, version: '170009', readOnly: 'on', defaultReadOnly: 'on', isolation: 'repeatable read',
    statementTimeout: '5s', lockTimeout: '2s', idleTimeout: '10s', searchPath: 'pg_catalog,public' };
  const rows = new Map<string, unknown[]>([
    [fixtureBackendSql, [identity]], [preflightControlSql.settings, [settings]], [preflightControlSql.quiet, [{ others: 0 }]],
    [readOnlyCatalogSql.identity.text, [{ database: 'applyflow_test', username: 'applyflow_test' }]],
    [readOnlyCatalogSql.relations.text, ['Session', 'User', '_prisma_migrations'].map((name) => ({ name, kind: 'r', persistence: 'p' }))],
    [readOnlyCatalogSql.history.text, checked.history as unknown[]],
    [readOnlyCatalogSql.tables.text, schema.tables.map((name) => ({ name }))],
    [readOnlyCatalogSql.columns.text, schema.columns], [readOnlyCatalogSql.indexes.text, schema.indexes],
    [readOnlyCatalogSql.constraints.text, schema.constraints.map((value) => ({ value }))],
    [readOnlyCatalogSql.triggers.text, []], [readOnlyCatalogSql.rowSecurity.text, []]
  ]);
  const wire = vi.fn(async (text: string) => ({ command: text === 'ROLLBACK' ? 'ROLLBACK' : 'SELECT', rows: rows.get(text) ?? [] }));
  // B2 settings are strict; the fixture backend PID is a different fixed query.
  const b2Query = vi.fn(async (text: string) => {
    const { pid: _pid, ...b2Settings } = settings; void _pid;
    return { command: text === 'ROLLBACK' ? 'ROLLBACK' : text === preflightControlSql.begin ? 'BEGIN' : 'SELECT',
      rows: text === preflightControlSql.settings ? [b2Settings] : rows.get(text) ?? [] };
  });
  const b2Client = Object.assign(new EventEmitter(), { connection: { stream: b2Socket as unknown },
    connect: vi.fn(async () => undefined), query: b2Query,
    end: vi.fn(async () => { b2Socket.destroy(); b2Client.emit('end'); }) });
  let b2Config!: ClientConfig; let config!: PoolConfig;
  const b2: ReadOnlyDependencies = { socket: vi.fn(() => b2Socket as unknown as Socket), client: vi.fn((value) => {
    b2Config = value; return b2Client;
  }) };
  const physical = Object.assign(new EventEmitter(), { processID: 123, connection: { stream: socket as unknown }, query: wire });
  const pool = Object.assign(new EventEmitter(), { end: vi.fn(async () => { socket.destroy(); physical.emit('end'); }) });
  const tx = { $executeRaw: vi.fn(async (query: Prisma.Sql) => { await physical.query(query.text); return 0; }),
    $queryRaw: vi.fn(async (query: Prisma.Sql) => (await physical.query(query.text)).rows) } as unknown as Prisma.TransactionClient;
  const prisma = { $connect: vi.fn(async () => { config.stream!(); await config.onConnect!(physical as unknown as PoolClient); }),
    $disconnect: vi.fn(async () => undefined),
    $transaction: vi.fn(async <T>(work: (value: Prisma.TransactionClient) => Promise<T>) => {
      await physical.query('BEGIN');
      try { const value = await work(tx); await physical.query('COMMIT'); return value; }
      catch (error) { await physical.query('ROLLBACK'); throw error; }
    }) };
  const driver: FixtureDriver = { socket: vi.fn(() => socket as unknown as Socket), pool: vi.fn((value) => {
    config = value; return pool as unknown as Pool;
  }), prisma: vi.fn(() => prisma as unknown as ReturnType<FixtureDriver['prisma']>) };
  const runtime: FixtureInspectionRuntime = { environment: { ...env }, args: [], platform: 'win32', signals,
    readMigration: vi.fn(() => sql), readOnly: vi.fn(async () => b2), prisma: vi.fn(async () => driver), output: vi.fn() };
  return { runtime, signals, rows, settings, identity, b2, b2Client, b2Socket, b2Query, socket, wire, physical, pool,
    prisma, driver, tx, config: () => config, b2Config: () => b2Config, run: () => runFixtureInspection(runtime) };
}
function expectRemoved(signals: EventEmitter) {
  for (const name of ['SIGINT', 'SIGTERM', 'SIGBREAK']) expect(signals.listenerCount(name)).toBe(0);
}
function outputCode(f: ReturnType<typeof fixture>, code: string) {
  expect(f.runtime.output).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(`^APPLYFLOW_FIXTURE_INSPECTION ${code}:`));
}
function atReceiptBoundary(f: ReturnType<typeof fixture>, action: () => void) {
  const end = f.pool.end.getMockImplementation()!;
  f.pool.end.mockImplementation(async () => {
    await end();
    function later(remaining: number) {
      queueMicrotask(() => { if (remaining) later(remaining - 1); else action(); });
    }
    later(6);
  });
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('C1B private sequential inspection command, injected ports only', () => {
  it('rejects the audited nextTick error-before-close ordering at the CLI, ten times', async () => {
    const results: number[] = []; const orderings: string[][] = [];
    for (let repetition = 0; repetition < 10; repetition++) {
      const f = fixture(); const delivered = deferred(); const events: string[] = [];
      f.pool.end.mockImplementation(async () => {
        f.socket.destroyed = true; f.socket.closed = true;
        process.nextTick(() => {
          events.push('owned-error'); f.socket.emit('error', new Error('private-queued-error'));
          events.push('owned-close'); f.socket.emit('close', true); f.physical.emit('end'); delivered.resolve();
        });
      });
      vi.mocked(f.runtime.output).mockImplementation((message) => { events.push(message.includes(' PASSED:') ? 'PASSED' : 'FAILED'); });
      results.push(await f.run()); await delivered.promise; orderings.push(events);
    }
    expect(results).toEqual(Array<number>(10).fill(1));
    expect(orderings).toEqual(Array.from({ length: 10 }, () => ['owned-error', 'owned-close', 'FAILED']));
  });
  it('reports PASSED only after a queued orderly close following fulfilled pool end', async () => {
    const f = fixture(); const events: string[] = [];
    f.pool.end.mockImplementation(async () => {
      f.socket.destroyed = true; f.socket.closed = true; events.push('pool-end');
      process.nextTick(() => { events.push('owned-close'); f.socket.emit('close', false); f.physical.emit('end'); });
    });
    vi.mocked(f.runtime.output).mockImplementation((message) => { events.push(message.includes(' PASSED:') ? 'PASSED' : 'FAILED'); });
    expect(await f.run()).toBe(0); outputCode(f, 'PASSED');
    expect(events).toEqual(['pool-end', 'owned-close', 'PASSED']); expectRemoved(f.signals);
  });
  it.each(['SIGINT', 'SIGTERM', 'SIGBREAK'] as const)('keeps shutdown owned while awaiting observed close after %s', async (signal) => {
    const f = fixture(); const ended = deferred();
    f.pool.end.mockImplementation(async () => { f.socket.destroyed = true; f.socket.closed = true; ended.resolve(); });
    const running = f.run(); await ended.promise; await Promise.resolve();
    expect(f.runtime.output).not.toHaveBeenCalled();
    expect(f.pool.listenerCount('error')).toBe(2); expect(f.socket.listenerCount('error')).toBe(2);
    f.signals.emit(signal); f.signals.emit(signal); expect(f.runtime.output).not.toHaveBeenCalled();
    f.socket.emit('close', false); f.physical.emit('end');
    expect(await running).toBe(signal === 'SIGTERM' ? 143 : 130); outputCode(f, 'INTERRUPTED');
    expect(f.pool.end).toHaveBeenCalledOnce(); expect(f.wire.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    expectRemoved(f.signals);
  });
  it.each([false, true])('fails missing close at the shutdown deadline, including throwing destruction: %s', async (throwing) => {
    vi.useFakeTimers(); const f = fixture(); const ended = deferred();
    f.pool.end.mockImplementation(async () => { f.socket.destroyed = true; f.socket.closed = true; ended.resolve(); });
    const destroy = vi.spyOn(f.socket, 'destroy');
    if (throwing) destroy.mockImplementation(() => { throw new Error('private-destruction-sentinel'); });
    const running = f.run(); await ended.promise; await vi.advanceTimersByTimeAsync(1999);
    expect(f.runtime.output).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1);
    expect(await running).toBe(1); outputCode(f, 'PRISMA_FAILED'); expect(destroy).toHaveBeenCalledOnce();
    // Late close, errors and repeated abort cannot revive the rejected command.
    f.socket.emit('close', false); f.socket.emit('error', new Error('private-late-sentinel'));
    f.signals.emit('SIGINT'); await vi.advanceTimersByTimeAsync(0);
    outputCode(f, 'PRISMA_FAILED'); expect(destroy).toHaveBeenCalledOnce(); expect(f.pool.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(f.runtime.output).mock.calls)).not.toContain('sentinel'); expectRemoved(f.signals);
  });
  it.each(['error', 'duplicate', 'had-error'] as const)('never grants CLI success for abnormal close evidence: %s', async (kind) => {
    const f = fixture();
    f.pool.end.mockImplementation(async () => {
      f.socket.destroyed = true; f.socket.closed = true;
      if (kind === 'error') for (let index = 0; index < 2; index++) f.socket.emit('error', new Error('private-error-sentinel'));
      f.socket.emit('close', kind === 'had-error');
      if (kind === 'duplicate') f.socket.emit('close', false);
      f.physical.emit('end');
    });
    expect(await f.run()).toBe(1); outputCode(f, 'PRISMA_FAILED');
    expect(f.pool.end).toHaveBeenCalledOnce(); expect(JSON.stringify(vi.mocked(f.runtime.output).mock.calls)).not.toContain('sentinel');
  });
  it.each(['before', 'after'] as const)('fails safely when close listener registration throws %s attachment', async (when) => {
    vi.useFakeTimers(); const f = fixture(); const on = f.socket.on.bind(f.socket);
    vi.spyOn(f.socket, 'on').mockImplementation((event, handler) => {
      if (event === 'close' && when === 'before') throw new Error('private-registration-sentinel');
      const result = on(event, handler);
      if (event === 'close') throw new Error('private-registration-sentinel');
      return result;
    });
    const running = f.run(); await vi.advanceTimersByTimeAsync(2000);
    expect(await running).toBe(1); outputCode(f, 'PRISMA_FAILED'); expect(f.pool.end).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(f.runtime.output).mock.calls)).not.toContain('sentinel'); expectRemoved(f.signals);
  });
  it.each(['pool', 'socket'] as const)('rejects the audited late %s error after receipt creation, ten times', async (resource) => {
    const results: number[] = []; const freeze = vi.spyOn(Object, 'freeze');
    for (let repetition = 0; repetition < 10; repetition++) {
      freeze.mockClear();
      const f = fixture(); const events: string[] = []; let receiptsAtError = 0;
      // Exact audit ordering: six nested microtasks after successful end().
      // The wrapper has made its receipt, but the CLI has not yet reported.
      atReceiptBoundary(f, () => {
        receiptsAtError = freeze.mock.calls.filter(([value]) => value !== null && typeof value === 'object'
          && Object.keys(value).length === 3 && Reflect.get(value, 'outcome') === 'passed'
          && Reflect.get(value, 'readOnly') === true && Reflect.get(value, 'closed') === true).length;
        events.push('owned-error'); f[resource].emit('error', new Error('private-audit-sentinel'));
      });
      vi.mocked(f.runtime.output).mockImplementation((message) => { events.push(message.includes(' PASSED:') ? 'PASSED' : 'FAILED'); });
      results.push(await f.run());
      // Observe both the B2 and Prisma frozen receipts before injecting error.
      // The earlier wrapper check is therefore insufficient by construction.
      expect(receiptsAtError).toBe(2);
      expect(events).toEqual(['owned-error', 'FAILED']); outputCode(f, 'PRISMA_FAILED'); expectRemoved(f.signals);
      expect(f.prisma.$transaction).toHaveBeenCalledOnce(); expect(f.pool.end).toHaveBeenCalledOnce();
    }
    expect(results).toEqual(Array<number>(10).fill(1));
  });
  it('latches multiple late pool/socket errors without disclosing sensitive exceptions', async () => {
    const f = fixture(); const secret = new Error(`${env.TEST_DATABASE_URL} password=private-password SQL-result private-token`);
    secret.stack = 'private-stack-sentinel';
    atReceiptBoundary(f, () => {
      for (let index = 0; index < 3; index++) { f.pool.emit('error', secret); f.socket.emit('error', secret); }
    });
    expect(await f.run()).toBe(1); outputCode(f, 'PRISMA_FAILED');
    const output = JSON.stringify(vi.mocked(f.runtime.output).mock.calls);
    for (const forbidden of [env.TEST_DATABASE_URL, 'offline-only', 'private-password', 'SQL-result', 'private-token', 'private-stack-sentinel']) {
      expect(output).not.toContain(forbidden);
    }
    expect(f.prisma.$transaction).toHaveBeenCalledOnce(); expect(f.pool.end).toHaveBeenCalledOnce();
  });
  it.each(['SIGINT', 'SIGTERM', 'SIGBREAK'] as const)('rejects cancellation at the receipt/reporting boundary: %s', async (signal) => {
    const f = fixture(); atReceiptBoundary(f, () => { f.signals.emit(signal); f.signals.emit(signal); });
    expect(await f.run()).toBe(signal === 'SIGTERM' ? 143 : 130); outputCode(f, 'INTERRUPTED'); expectRemoved(f.signals);
    expect(f.pool.end).toHaveBeenCalledOnce(); expect(() => f.config().stream!()).toThrow();
  });
  it.each(['rollback', 'closure'] as const)('retains error observation while %s is unsettled and rejects late success', async (stage) => {
    const f = fixture(); const entered = deferred(); const held = deferred();
    if (stage === 'rollback') {
      const query = f.wire.getMockImplementation()!;
      f.wire.mockImplementation(async (text) => { if (text === 'ROLLBACK') { entered.resolve(); await held.promise; } return query(text); });
    } else {
      const end = f.pool.end.getMockImplementation()!;
      f.pool.end.mockImplementation(async () => { entered.resolve(); await held.promise; await end(); });
    }
    const running = f.run(); await entered.promise;
    expect(f.pool.listenerCount('error')).toBe(2); expect(f.socket.listenerCount('error')).toBe(2);
    f.pool.emit('error', new Error('private-closure-sentinel')); f.socket.emit('error', new Error('private-socket-sentinel'));
    expect(f.runtime.output).not.toHaveBeenCalled(); expect(f.signals.listenerCount('SIGINT')).toBe(1);
    held.resolve(); expect(await running).toBe(1); outputCode(f, 'PRISMA_FAILED');
    expect(f.wire.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    expect(f.wire.mock.calls.some(([text]) => text === 'COMMIT')).toBe(false);
    expect(f.pool.end).toHaveBeenCalledOnce(); expectRemoved(f.signals);
    // No successful receipt reached the CLI: retain sanitized error sinks.
    expect(f.pool.listenerCount('error')).toBe(2); expect(f.socket.listenerCount('error')).toBe(2);
    f.pool.emit('error', new Error('late-after-failure')); f.socket.emit('error', new Error('late-after-failure'));
    await Promise.resolve(); expect(f.runtime.output).toHaveBeenCalledOnce();
  });
  it('retains its own observers through adapter disposal and removes them only after confirmed shutdown', async () => {
    const f = fixture(); const events: string[] = [];
    const poolOff = vi.spyOn(f.pool, 'off'); const socketOff = vi.spyOn(f.socket, 'off');
    f.prisma.$disconnect.mockImplementation(async () => {
      events.push('prisma-disconnect'); expect(f.pool.listenerCount('error')).toBe(2); expect(f.socket.listenerCount('error')).toBe(2);
      expect(poolOff).not.toHaveBeenCalled(); expect(socketOff).not.toHaveBeenCalled();
    });
    const end = f.pool.end.getMockImplementation()!;
    f.pool.end.mockImplementation(async () => {
      expect(f.pool.listenerCount('error')).toBe(2); expect(f.socket.listenerCount('error')).toBe(2);
      await end(); events.push('pool-and-socket-closed');
    });
    vi.mocked(f.runtime.output).mockImplementation(() => {
      events.push('report'); expect(f.socket.closed).toBe(true);
      expect(poolOff).toHaveBeenCalledOnce(); expect(socketOff).toHaveBeenCalledOnce();
      // Existing connector sinks remain; only the CLI's additional observers go.
      expect(f.pool.listenerCount('error')).toBe(1); expect(f.socket.listenerCount('error')).toBe(1); expectRemoved(f.signals);
    });
    expect(await f.run()).toBe(0); outputCode(f, 'PASSED');
    expect(events).toEqual(['prisma-disconnect', 'pool-and-socket-closed', 'report']);
  });
  it.each(['pool', 'socket'] as const)('rechecks shared failure after %s observer removal', async (resource) => {
    const f = fixture(); const emitter: EventEmitter = f[resource]; const remove = emitter.off.bind(emitter);
    vi.spyOn(emitter, 'off').mockImplementation((event, handler) => {
      const result = remove(event, handler);
      // Our observer is gone. The retained connector review callback must still
      // invalidate CLI success before the finite synchronous completion boundary.
      f[resource].emit('error', new Error('private-teardown-sentinel')); return result;
    });
    expect(await f.run()).toBe(1); outputCode(f, 'PRISMA_FAILED'); expectRemoved(f.signals);
    expect(f.pool.end).toHaveBeenCalledOnce(); expect(() => f.config().stream!()).toThrow();
  });
  it.each(['pool', 'socket'] as const)('sanitizes %s observer-removal failure instead of reporting PASSED', async (resource) => {
    const f = fixture(); vi.spyOn(f[resource], 'off').mockImplementation(() => { throw new Error('private-removal-sentinel'); });
    expect(await f.run()).toBe(1); outputCode(f, 'PRISMA_FAILED'); expectRemoved(f.signals);
    expect(JSON.stringify(vi.mocked(f.runtime.output).mock.calls)).not.toContain('sentinel');
    expect(f.socket.closed).toBe(true); expect(f.pool.end).toHaveBeenCalledOnce();
  });
  it('keeps interruption handling installed through owned-observer teardown', async () => {
    const f = fixture(); const remove = f.pool.off.bind(f.pool);
    vi.spyOn(f.pool, 'off').mockImplementation((event, handler) => {
      const result = remove(event, handler);
      expect(f.signals.listenerCount('SIGINT')).toBe(1); f.signals.emit('SIGINT'); f.signals.emit('SIGINT'); return result;
    });
    expect(await f.run()).toBe(130); outputCode(f, 'INTERRUPTED'); expectRemoved(f.signals);
    expect(f.socket.closed).toBe(true); expect(f.pool.end).toHaveBeenCalledOnce();
  });
  it.each(['pool', 'socket'] as const)('retains ownership when %s observer registration partially fails', async (resource) => {
    const f = fixture(); const register = f[resource].on.bind(f[resource]);
    vi.spyOn(f[resource], 'on').mockImplementation((event, handler) => {
      register(event, handler); throw new Error('private-registration-sentinel');
    });
    expect(await f.run()).toBe(1); outputCode(f, 'PRISMA_FAILED'); expectRemoved(f.signals);
    expect(f.pool.end).toHaveBeenCalledOnce(); expect(f[resource].listenerCount('error')).toBeGreaterThan(0);
    expect(JSON.stringify(vi.mocked(f.runtime.output).mock.calls)).not.toContain('sentinel');
  });
  it('finishes owned observer teardown before reporting failure from the reporter itself', async () => {
    const f = fixture();
    vi.mocked(f.runtime.output).mockImplementation(() => {
      expect(f.socket.closed).toBe(true); expect(f.pool.end).toHaveBeenCalledOnce();
      expect(f.pool.listenerCount('error')).toBe(1); expect(f.socket.listenerCount('error')).toBe(1); expectRemoved(f.signals);
      throw new Error('private-reporter-sentinel');
    });
    expect(await f.run()).toBe(1); expect(f.runtime.output).toHaveBeenCalledOnce();
  });
  it('finishes B2 rollback/closure before constructing exactly one Prisma inspection, then revokes authority', async () => {
    const f = fixture();
    vi.mocked(f.runtime.prisma).mockImplementation(async () => {
      expect(f.b2Client.end).toHaveBeenCalledOnce(); expect(f.b2Socket.closed).toBe(true);
      expect(f.b2Query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1); return f.driver;
    });
    expect(await f.run()).toBe(0); outputCode(f, 'PASSED');
    expect(f.driver.pool).toHaveBeenCalledOnce(); expect(f.driver.socket).toHaveBeenCalledOnce();
    expect(f.prisma.$transaction).toHaveBeenCalledOnce();
    expect(f.wire.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    expect(f.pool.end).toHaveBeenCalledOnce(); expect(f.prisma.$disconnect).toHaveBeenCalledOnce();
    expect(f.socket.closed).toBe(true); expectRemoved(f.signals);
    expect(() => f.config().stream!()).toThrow();
    await expect(f.config().onConnect!(f.physical as unknown as PoolClient)).rejects.toThrow();
    expect(f.driver.socket).toHaveBeenCalledOnce();
    expect(f.config()).toMatchObject({ options: '-c default_transaction_read_only=on -c search_path=pg_catalog,public',
      idleTimeoutMillis: 0, max: 1, ssl: false, pipeline: false, application_name: 'applyflow-prisma-inspection' });
    expect(f.b2Config()).toMatchObject({ options: expect.stringContaining('default_transaction_read_only=on') });
    const allowed = new Set(['BEGIN', 'ROLLBACK', 'SET TRANSACTION READ ONLY', fixtureBackendSql,
      ...Object.values(preflightControlSql), ...Object.values(readOnlyCatalogSql).map((query) => query.text)]);
    expect([...f.wire.mock.calls, ...f.b2Query.mock.calls].every(([text]) => allowed.has(text))).toBe(true);
  });
  it.each([{ NODE_ENV: undefined }, { NODE_ENV: 'production' }, { TEST_DATABASE_URL: undefined },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('5433', '15432') },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('127.0.0.1', 'localhost') },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('/applyflow_test', '/applyflow_dev') },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('applyflow_test:', 'other:') },
    { TEST_DATABASE_URL: `${env.TEST_DATABASE_URL}?options=x` }, { DATABASE_URL: env.TEST_DATABASE_URL },
    { PGHOST: 'other' }, { PGOPTIONS: 'x' }, { NODE_OPTIONS: '--inspect' }, { NODE_PATH: 'x' },
    { DEBUG: '*' }, { NODE_DEBUG: 'net' }, { RUST_LOG: 'debug' }, { RUST_BACKTRACE: '1' }, { PRISMA_QUERY_LOG: 'on' }])(
    'rejects unsafe shell configuration before dependency construction (%#)', async (change) => {
      const f = fixture(); f.runtime.environment = { ...env, ...change };
      expect(await f.run()).toBe(1); outputCode(f, 'ADMISSION');
      expect(f.runtime.readOnly).not.toHaveBeenCalled(); expect(f.runtime.prisma).not.toHaveBeenCalled();
      expect(f.driver.pool).not.toHaveBeenCalled(); expect(f.b2.client).not.toHaveBeenCalled(); expectRemoved(f.signals);
    }
  );
  it.each(['--approve', '--sql=DELETE', '--base-url=http://other', 'fixture-cycle', '--mode=inspect-only'])(
    'rejects argument %s without activation', async (argument) => {
      const f = fixture(); f.runtime.args = [argument]; expect(await f.run()).toBe(1); outputCode(f, 'ARGUMENTS');
      expect(f.runtime.readMigration).not.toHaveBeenCalled(); expect(f.runtime.readOnly).not.toHaveBeenCalled();
    }
  );
  it('checks migration bytes before loading either dependency', async () => {
    const f = fixture(); vi.mocked(f.runtime.readMigration).mockReturnValue(Buffer.from('wrong'));
    expect(await f.run()).toBe(1); outputCode(f, 'MIGRATION'); expect(f.runtime.readOnly).not.toHaveBeenCalled();
  });
  it.each(['rollback', 'close', 'peer', 'interrupt'] as const)('never issues Prisma authority after B2 %s failure', async (kind) => {
    const f = fixture();
    if (kind === 'rollback') {
      const original = f.b2Query.getMockImplementation()!;
      f.b2Query.mockImplementation(async (text) => text === 'ROLLBACK' ? { rows: [], command: 'UNKNOWN' } : original(text));
    }
    if (kind === 'close') f.b2Client.end.mockRejectedValue(new Error('databaseUrl-sensitive-sentinel'));
    if (kind === 'peer') f.b2Socket.remotePort = 15432;
    if (kind === 'interrupt') f.b2Client.connect.mockImplementation(async () => { f.signals.emit('SIGINT'); });
    expect(await f.run()).toBe(kind === 'interrupt' ? 130 : 1);
    outputCode(f, kind === 'interrupt' ? 'INTERRUPTED' : 'B2_FAILED');
    expect(f.runtime.prisma).not.toHaveBeenCalled(); expectRemoved(f.signals);
  });
  it.each(['url', 'override', 'diagnostic'])('rechecks the invoking environment after B2: %s', async (kind) => {
    const f = fixture(); const end = f.b2Client.end.getMockImplementation()!;
    f.b2Client.end.mockImplementation(async () => {
      await end();
      if (kind === 'url') f.runtime.environment.TEST_DATABASE_URL = env.TEST_DATABASE_URL.replace('5433', '15432');
      if (kind === 'override') f.runtime.environment.PGHOST = 'other';
      if (kind === 'diagnostic') f.runtime.environment.DEBUG = '*';
    });
    expect(await f.run()).toBe(1); expect(f.runtime.prisma).not.toHaveBeenCalled();
  });
  it('rechecks admission after Prisma dependency loading before pool construction', async () => {
    const f = fixture();
    vi.mocked(f.runtime.prisma).mockImplementation(async () => { f.runtime.environment.PGPORT = '15432'; return f.driver; });
    expect(await f.run()).toBe(1); expect(f.driver.pool).not.toHaveBeenCalled(); expect(f.driver.socket).not.toHaveBeenCalled();
  });
  it('retains ownership for shutdown if interruption races pool construction', async () => {
    const f = fixture(); const make = vi.mocked(f.driver.pool).getMockImplementation()!;
    vi.mocked(f.driver.pool).mockImplementation((config) => { const pool = make(config); f.signals.emit('SIGINT'); return pool; });
    expect(await f.run()).toBe(130); outputCode(f, 'INTERRUPTED');
    expect(f.pool.end).toHaveBeenCalledOnce(); expect(f.driver.prisma).not.toHaveBeenCalled();
    expect(() => f.config().stream!()).toThrow(); expect(f.driver.socket).not.toHaveBeenCalled();
  });
  it.each(['schema', 'history'])('independently validates Prisma %s after successful B2 closure', async (kind) => {
    const f = fixture();
    vi.mocked(f.runtime.prisma).mockImplementation(async () => {
      f.rows.set(kind === 'schema' ? readOnlyCatalogSql.triggers.text : readOnlyCatalogSql.history.text, kind === 'schema' ? [{ value: 'unexpected' }] : []);
      return f.driver;
    });
    expect(await f.run()).toBe(1); outputCode(f, 'PRISMA_FAILED'); expect(f.pool.end).toHaveBeenCalledOnce();
  });
  it.each(['socket', 'stream', 'pid', 'database', 'receiver', 'client', 'reconnect', 'readOnly', 'defaultReadOnly', 'isolation', 'rollback', 'close']) (
    'rejects Prisma physical/read-only/shutdown discrepancy: %s', async (kind) => {
      const f = fixture(); const connect = f.prisma.$connect.getMockImplementation()!;
      f.prisma.$connect.mockImplementation(async () => {
        if (kind === 'socket') f.socket.remoteAddress = '127.0.0.2';
        if (kind === 'stream') f.physical.connection.stream = {};
        if (kind === 'pid') f.identity.pid++;
        if (kind === 'database') f.identity.database = 'applyflow_dev';
        await connect();
        if (kind === 'receiver') Reflect.apply(f.physical.query, {}, ['SELECT 1']);
        if (kind === 'client') await f.config().onConnect!(Object.assign(new EventEmitter(), {
          processID: 123, connection: f.physical.connection, query: f.wire
        }) as unknown as PoolClient);
        if (kind === 'reconnect') f.config().stream!();
        if (kind === 'readOnly') f.settings.readOnly = 'off';
        if (kind === 'defaultReadOnly') f.settings.defaultReadOnly = 'off';
        if (kind === 'isolation') f.settings.isolation = 'read committed';
      });
      if (kind === 'rollback') {
        const normal = f.wire.getMockImplementation()!;
        f.wire.mockImplementation(async (text) => text === 'ROLLBACK' ? { command: 'UNKNOWN', rows: [] } : normal(text));
      }
      if (kind === 'close') f.pool.end.mockRejectedValue(new Error('private-driver-sentinel'));
      expect(await f.run()).toBe(1); outputCode(f, 'PRISMA_FAILED');
      expect(f.driver.socket).toHaveBeenCalledOnce(); expect(f.pool.end).toHaveBeenCalledOnce(); expectRemoved(f.signals);
    }
  );
  it.each(['SIGINT', 'SIGTERM', 'SIGBREAK'] as const)('awaits active Prisma rollback/closure on repeated %s', async (signal) => {
    const f = fixture(); const entered = deferred(); const held = deferred<Awaited<ReturnType<typeof f.wire>>>();
    const normal = f.wire.getMockImplementation()!;
    f.wire.mockImplementation((text) => { if (text === preflightControlSql.quiet) { entered.resolve(); return held.promise; } return normal(text); });
    const running = f.run(); await entered.promise;
    f.signals.emit(signal); f.signals.emit(signal); expect(f.runtime.output).not.toHaveBeenCalled();
    held.resolve({ command: 'SELECT', rows: [{ others: 0 }] });
    expect(await running).toBe(signal === 'SIGTERM' ? 143 : 130); outputCode(f, 'INTERRUPTED');
    expect(f.wire.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    expect(f.pool.end).toHaveBeenCalledOnce(); expectRemoved(f.signals); expect(() => f.config().stream!()).toThrow();
  });
  it.each(['b2-close', 'prisma-close', 'prisma-rollback'])('never reports success on interruption during %s', async (stage) => {
    const f = fixture();
    if (stage === 'b2-close') {
      const end = f.b2Client.end.getMockImplementation()!;
      f.b2Client.end.mockImplementation(async () => { f.signals.emit('SIGINT'); await end(); });
    } else if (stage === 'prisma-close') {
      f.prisma.$disconnect.mockImplementation(async () => { f.signals.emit('SIGINT'); });
    } else {
      const normal = f.wire.getMockImplementation()!;
      f.wire.mockImplementation(async (text) => { if (text === 'ROLLBACK') f.signals.emit('SIGINT'); return normal(text); });
    }
    expect(await f.run()).toBe(130); outputCode(f, 'INTERRUPTED'); expectRemoved(f.signals);
  });
  it('keeps command ownership until interrupted Prisma shutdown actually settles', async () => {
    const f = fixture(); const entered = deferred(); const held = deferred(); const end = f.pool.end.getMockImplementation()!;
    f.pool.end.mockImplementation(async () => { entered.resolve(); await held.promise; await end(); });
    const running = f.run(); await entered.promise; f.signals.emit('SIGTERM');
    expect(f.runtime.output).not.toHaveBeenCalled(); expect(f.signals.listenerCount('SIGTERM')).toBe(1);
    expect(() => f.config().stream!()).toThrow(); held.resolve();
    expect(await running).toBe(143); outputCode(f, 'INTERRUPTED'); expectRemoved(f.signals);
  });
  it.each(['readOnly', 'prisma'] as const)('cancels %s loading without allocating resources after late success', async (kind) => {
    const f = fixture(); const entered = deferred(); const held = deferred<never>();
    vi.mocked(f.runtime[kind]).mockImplementation(async () => { entered.resolve(); return held.promise; });
    const running = f.run(); await entered.promise; f.signals.emit('SIGBREAK');
    expect(await running).toBe(130); expectRemoved(f.signals);
    held.resolve((kind === 'readOnly' ? f.b2 : f.driver) as never);
    await Promise.resolve(); expect(f.driver.pool).not.toHaveBeenCalled();
    expect(f.b2.client).toHaveBeenCalledTimes(kind === 'readOnly' ? 0 : 1);
    if (kind === 'prisma') expect(f.b2Client.end).toHaveBeenCalledOnce();
  });
  it.each(['connection', 'inspection', 'rollback'])('awaits B2 shutdown after interruption during %s', async (stage) => {
    const f = fixture(); const entered = deferred(); const held = deferred();
    if (stage === 'connection') f.b2Client.connect.mockImplementation(async () => { entered.resolve(); await held.promise; });
    else {
      const normal = f.b2Query.getMockImplementation()!;
      f.b2Query.mockImplementation(async (text) => {
        if (text === (stage === 'rollback' ? 'ROLLBACK' : preflightControlSql.quiet)) { entered.resolve(); await held.promise; }
        return normal(text);
      });
    }
    const endEntered = deferred(); const endHeld = deferred(); const end = f.b2Client.end.getMockImplementation()!;
    f.b2Client.end.mockImplementation(async () => { endEntered.resolve(); await endHeld.promise; await end(); });
    const running = f.run(); await entered.promise; f.signals.emit('SIGINT'); held.resolve();
    await endEntered.promise; expect(f.runtime.output).not.toHaveBeenCalled(); endHeld.resolve();
    expect(await running).toBe(130); expect(f.runtime.prisma).not.toHaveBeenCalled(); expectRemoved(f.signals);
    expect(f.b2Query.mock.calls.filter(([text]) => text === 'ROLLBACK').length).toBeLessThanOrEqual(1);
  });
  it.each(['readOnly', 'prisma'] as const)('bounds %s constructor loading, rejects late completion without allocating', async (kind) => {
    vi.useFakeTimers(); const f = fixture(); const entered = deferred(); const held = deferred<never>();
    vi.mocked(f.runtime[kind]).mockImplementation(async () => { entered.resolve(); return held.promise; });
    const running = f.run(); await entered.promise; await vi.advanceTimersByTimeAsync(5000);
    expect(await running).toBe(1); outputCode(f, 'TIMEOUT'); expectRemoved(f.signals);
    held.reject(new Error('late-sensitive-sentinel')); await vi.advanceTimersByTimeAsync(0);
    expect(f.driver.pool).not.toHaveBeenCalled();
  });
  it.each(['connect', 'operation', 'shutdown'])('settles %s deadline with throwing destruction and rejects late success', async (stage) => {
    vi.useFakeTimers(); const f = fixture(); const entered = deferred(); const held = deferred();
    const destroy = vi.spyOn(f.socket, 'destroy').mockImplementation(() => { throw new Error('password-private-sentinel'); });
    f.pool.end.mockImplementation(async () => { if (stage === 'shutdown') { entered.resolve(); await held.promise; } });
    if (stage === 'connect') {
      const connect = f.prisma.$connect.getMockImplementation()!;
      f.prisma.$connect.mockImplementation(async () => { await connect(); entered.resolve(); await held.promise; });
    }
    if (stage === 'operation') {
      const normal = f.wire.getMockImplementation()!;
      f.wire.mockImplementation(async (text) => { if (text === preflightControlSql.quiet) { entered.resolve(); await held.promise; } return normal(text); });
    }
    const running = f.run(); await entered.promise;
    // Failed connect/operation still owns the same additional bounded shutdown.
    await vi.advanceTimersByTimeAsync(stage === 'connect' ? 7000 : stage === 'operation' ? 62000 : 2000);
    expect(await running).toBe(1); outputCode(f, 'PRISMA_FAILED'); expect(destroy).toHaveBeenCalledOnce();
    held.resolve(); await vi.advanceTimersByTimeAsync(0);
    expect(f.runtime.output).toHaveBeenCalledOnce(); expect(destroy).toHaveBeenCalledOnce(); expectRemoved(f.signals);
  });
  it('revokes retained constructor callbacks on failure and gives a fresh invocation an independent budget', async () => {
    const f = fixture(); const other = fixture();
    expect(await f.run()).toBe(0); expect(await other.run()).toBe(0);
    expect(() => f.config().stream!()).toThrow(); expect(() => other.config().stream!()).toThrow();
    expect(f.driver.socket).toHaveBeenCalledOnce(); expect(other.driver.socket).toHaveBeenCalledOnce();
  });
  it('exports no authority, installed constructor defaults, or live driver and rejects forged mode authority', async () => {
    const module = await import('./fixture-preflight.js');
    expect(Object.keys(module)).toEqual(['runFixtureInspection']);
    for (const mode of ['inspect-only', 'fixture-cycle', {}, undefined]) {
      await expect(Reflect.apply(installedFixtureDriver, undefined, [mode, { approved: true }])).rejects.toThrow('disabled');
    }
    for (const phase of ['fixtures', 'smoke', 'full'] as const) expect(() => requireLivePhase(phase)).toThrow('disabled');
  });
  it('does not accept a forged runtime/authority as an installed composition', async () => {
    const output = vi.fn();
    expect(await Reflect.apply(runFixtureInspection, undefined, [{ authority: Object.freeze({}), mode: 'fixture-cycle', output }])).toBe(1);
    expect(output).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('ARGUMENTS:'));
  });
  it('fails closed on partially successful signal registration and removes its listener', async () => {
    const f = fixture(); const on = f.signals.on.bind(f.signals);
    vi.spyOn(f.signals, 'on').mockImplementation((event, listener) => { on(event, listener); throw new Error('private-signal-sentinel'); });
    expect(await f.run()).toBe(1); outputCode(f, 'UNEXPECTED'); expectRemoved(f.signals);
    expect(f.runtime.readOnly).not.toHaveBeenCalled();
  });
  it('removes all normal-platform handlers without registering Windows-only SIGBREAK', async () => {
    const f = fixture(); f.runtime.platform = 'linux'; const on = vi.spyOn(f.signals, 'on');
    expect(await f.run()).toBe(0); expect(on.mock.calls.map(([event]) => event)).toEqual(['SIGINT', 'SIGTERM']); expectRemoved(f.signals);
  });
  it('sanitizes constructor exceptions, signal removal failures and reporter failure', async () => {
    const f = fixture(); vi.mocked(f.runtime.prisma).mockRejectedValue(new Error(`private-token-sentinel ${env.TEST_DATABASE_URL}`));
    expect(await f.run()).toBe(1); outputCode(f, 'PRISMA_FAILED');
    expect(JSON.stringify(vi.mocked(f.runtime.output).mock.calls)).not.toContain('sentinel');
    const other = fixture(); vi.spyOn(other.signals, 'off').mockImplementation(() => { throw new Error('private-sentinel'); });
    expect(await other.run()).toBe(1); outputCode(other, 'UNEXPECTED');
    const reporter = fixture(); vi.mocked(reporter.runtime.output).mockImplementation(() => { throw new Error('private-sentinel'); });
    expect(await reporter.run()).toBe(1);
  });
  it('uses only native import.meta.main and initializes failure status in the direct entry block (evaluated with safe ports)', async () => {
    const source = readFileSync(new URL('./fixture-preflight.ts', import.meta.url), 'utf8');
    const entry = source.slice(source.indexOf('if (import.meta.main === true)'))
      .replace('import.meta.main', 'nativeMain').replaceAll('import(', 'load(').replaceAll('import.meta.url', 'moduleUrl');
    const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<void>;
    const evaluate = new AsyncFunction('nativeMain', 'process', 'runFixtureInspection', 'readFileSync', 'writeSync', 'load', 'moduleUrl', 'line', entry);
    const fakeProcess = { exitCode: undefined as number | undefined, env: {}, argv: ['node', 'spoofed'], platform: 'win32' };
    const run = vi.fn(async () => { expect(fakeProcess.exitCode).toBe(1); return 0; }); const forbidden = vi.fn(() => { throw new Error(); });
    await evaluate(false, fakeProcess, run, forbidden, forbidden, forbidden, import.meta.url, forbidden);
    expect(run).not.toHaveBeenCalled(); expect(fakeProcess.exitCode).toBeUndefined();
    await evaluate(true, fakeProcess, run, forbidden, forbidden, forbidden, import.meta.url, forbidden);
    expect(run).toHaveBeenCalledOnce(); expect(fakeProcess.exitCode).toBe(0); expect(forbidden).not.toHaveBeenCalled();
    // The actual entry composition, evaluated under fakes, rejects arguments
    // before its installed constructor loaders. This is not a live CLI launch.
    fakeProcess.argv = ['node', 'spoofed', '--approve']; const write = vi.fn();
    await evaluate(true, fakeProcess, runFixtureInspection, forbidden, write, forbidden, import.meta.url, (code: string) => code);
    expect(fakeProcess.exitCode).toBe(1); expect(write).toHaveBeenCalledExactlyOnceWith(1, expect.stringContaining('ARGUMENTS:'));
    expect(forbidden).not.toHaveBeenCalled();
    const broken = vi.fn(async () => { throw new Error('private-entry-sentinel'); }); write.mockClear();
    await evaluate(true, fakeProcess, broken, forbidden, write, forbidden, import.meta.url, (code: string) => code);
    expect(fakeProcess.exitCode).toBe(1); expect(write).toHaveBeenCalledExactlyOnceWith(2, 'UNEXPECTED\n');
  });
});
