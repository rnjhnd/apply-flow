import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isPreflightEntrypoint, runPreflightCommand, type PreflightRuntime } from './read-only-preflight.js';
import { requireLivePhase } from './execution.js';
import { requireLiveRuntime } from './fixtures.js';
import { preflightControlSql, preflightLimits, ReadOnlyPreflightError, type ReadOnlyClient } from './read-only-database.js';
import { readOnlyCatalogSql } from './catalog.js';
import { env, sql, inspection, deferred } from './b1-fakes.js';

function fixture() {
  const signals = new EventEmitter(); const emitter = new EventEmitter();
  const socket = Object.assign(new EventEmitter(), { remoteAddress: '127.0.0.1', remotePort: 5433,
    destroyed: false, closed: false, destroy() { this.destroyed = true; this.closed = true; return this; } });
  const checked = inspection();
  const schema = checked.schema as typeof import('./schema.js').expectedSchema;
  const settings = { database: 'applyflow_test', username: 'applyflow_test', sessionUser: 'applyflow_test',
    version: '170009', readOnly: 'on', defaultReadOnly: 'on', isolation: 'repeatable read',
    statementTimeout: '5s', lockTimeout: '2s', idleTimeout: '10s', searchPath: 'pg_catalog,public' };
  const rows = new Map<string, unknown[]>([
    [preflightControlSql.settings, [settings]], [preflightControlSql.quiet, [{ others: 0 }]],
    [readOnlyCatalogSql.identity.text, [{ database: 'applyflow_test', username: 'applyflow_test' }]],
    [readOnlyCatalogSql.relations.text, ['Session', 'User', '_prisma_migrations'].map((name) => ({ name, kind: 'r', persistence: 'p' }))],
    [readOnlyCatalogSql.history.text, checked.history as unknown[]],
    [readOnlyCatalogSql.tables.text, schema.tables.map((name) => ({ name }))],
    [readOnlyCatalogSql.columns.text, schema.columns], [readOnlyCatalogSql.indexes.text, schema.indexes],
    [readOnlyCatalogSql.constraints.text, schema.constraints.map((value) => ({ value }))],
    [readOnlyCatalogSql.triggers.text, []], [readOnlyCatalogSql.rowSecurity.text, []]
  ]);
  const query = vi.fn(async (text: string) => {
    if (text === preflightControlSql.begin) return { command: 'BEGIN', rows: [] };
    if (text === 'ROLLBACK') return { command: 'ROLLBACK', rows: [] };
    if (!rows.has(text)) throw new Error('Unexpected fixed query');
    return { command: 'SELECT', rows: rows.get(text)! };
  });
  const client = Object.assign(emitter, { connection: { stream: socket as unknown }, query,
    connect: vi.fn(async (): Promise<unknown> => undefined),
    end: vi.fn(async () => { socket.destroy(); emitter.emit('end'); }) });
  const makeSocket = vi.fn(() => socket as unknown as Socket);
  const makeClient = vi.fn((): ReadOnlyClient => client);
  const runtime: PreflightRuntime = { environment: { ...env }, args: [], platform: 'win32', signals,
    readMigration: vi.fn(() => sql), driver: vi.fn(async () => ({ socket: makeSocket, client: makeClient })), output: vi.fn() };
  return { runtime, signals, client, socket, query, settings, rows, makeSocket, makeClient,
    run: () => runPreflightCommand(runtime) };
}
function expectRemoved(signals: EventEmitter) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) expect(signals.listenerCount(signal)).toBe(0);
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('B2 Gate B1 explicit read-only command (injected runtime only)', () => {
  it('runs only the read-only adapter and reports success after confirmed rollback and closure', async () => {
    const fake = fixture();
    expect(await fake.run()).toBe(0);
    expect(fake.runtime.output).toHaveBeenCalledExactlyOnceWith('APPLYFLOW_PREFLIGHT PASSED: Read-only inspection, rollback and connection closure completed.');
    expect(fake.makeSocket).toHaveBeenCalledOnce(); expect(fake.makeClient).toHaveBeenCalledOnce();
    expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    expect(fake.client.end).toHaveBeenCalledOnce(); expect(fake.socket.closed).toBe(true); expectRemoved(fake.signals);
    const allowed = new Set([...Object.values(preflightControlSql), ...Object.values(readOnlyCatalogSql).map((value) => value.text)]);
    expect(fake.query.mock.calls.every(([text]) => allowed.has(text))).toBe(true);
  });
  it('selects only the exact entry file; ordinary imports, runners and lookalike paths are inert', () => {
    expect(isPreflightEntrypoint(fileURLToPath(new URL('./read-only-preflight.ts', import.meta.url)))).toBe(true);
    expect(isPreflightEntrypoint(process.argv[1])).toBe(false);
    expect(isPreflightEntrypoint(undefined)).toBe(false);
    expect(isPreflightEntrypoint(fileURLToPath(new URL('./run.ts', import.meta.url)))).toBe(false);
    expect(isPreflightEntrypoint(fileURLToPath(new URL('./read-only-preflight.test.ts', import.meta.url)))).toBe(false);
  });
  it.each([
    { NODE_ENV: undefined }, { NODE_ENV: 'production' }, { NODE_ENV: 'development' }, { TEST_DATABASE_URL: undefined },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('5433', '15432') },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('/applyflow_test', '/applyflow_dev') },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('applyflow_test:', 'other:') },
    { TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('127.0.0.1', 'localhost') },
    { TEST_DATABASE_URL: `${env.TEST_DATABASE_URL}?options=unsafe` },
    { DATABASE_URL: env.TEST_DATABASE_URL }, { PGOPTIONS: 'unsafe' }, { NODE_OPTIONS: '--inspect' }
  ])('rejects invalid admission before driver loading or construction (%#)', async (override) => {
    const fake = fixture(); fake.runtime.environment = { ...env, ...override };
    expect(await fake.run()).toBe(1); expect(fake.runtime.output).toHaveBeenCalledWith(expect.stringContaining('PREFLIGHT ADMISSION:'));
    expect(fake.runtime.driver).not.toHaveBeenCalled(); expect(fake.runtime.readMigration).not.toHaveBeenCalled();
    expect(fake.makeSocket).not.toHaveBeenCalled(); expect(fake.makeClient).not.toHaveBeenCalled(); expectRemoved(fake.signals);
  });
  it.each(['--base-url=http://127.0.0.1:3000', '--sql=SELECT', '--database=other', '--approve', 'fixtures'])(
    'rejects command argument %s before admission or loading', async (argument) => {
      const fake = fixture(); fake.runtime.args = [argument];
      expect(await fake.run()).toBe(1); expect(fake.runtime.driver).not.toHaveBeenCalled();
      expect(fake.runtime.output).toHaveBeenCalledExactlyOnceWith('APPLYFLOW_PREFLIGHT ARGUMENTS: This command accepts no arguments.');
    }
  );
  it.each(['SIGINT', 'SIGTERM', 'SIGBREAK'] as const)('coordinates %s during every adapter phase without abandoning shutdown', async (signal) => {
    for (const phase of ['connect', 'inspection', 'rollback', 'close']) {
      const fake = fixture(); const entered = deferred(); const closeEntered = deferred(); const closeReady = deferred();
      const heldConnection = deferred(); const heldQuery = deferred<Awaited<ReturnType<typeof fake.query>>>();
      const normal = fake.query.getMockImplementation()!;
      const abort = vi.spyOn(AbortController.prototype, 'abort');
      fake.client.end.mockImplementationOnce(async () => {
        if (phase === 'close') entered.resolve();
        closeEntered.resolve(); await closeReady.promise; fake.socket.destroy(); fake.client.emit('end');
      });
      if (phase === 'connect') fake.client.connect.mockImplementationOnce(async () => { entered.resolve(); return heldConnection.promise; });
      fake.query.mockImplementation((text) => {
        if ((phase === 'inspection' && text === readOnlyCatalogSql.history.text) || (phase === 'rollback' && text === 'ROLLBACK')) {
          entered.resolve(); return heldQuery.promise;
        }
        return normal(text);
      });
      const pending = fake.run(); await entered.promise;
      fake.signals.emit(signal); fake.signals.emit(signal);
      await closeEntered.promise;
      fake.signals.emit(signal === 'SIGTERM' ? 'SIGINT' : 'SIGTERM');
      expect(fake.runtime.output).not.toHaveBeenCalled(); expect(abort).toHaveBeenCalledOnce();
      closeReady.resolve(); expect(await pending).toBe(signal === 'SIGTERM' ? 143 : 130);
      expect(fake.runtime.output).toHaveBeenCalledExactlyOnceWith('APPLYFLOW_PREFLIGHT INTERRUPTED: Preflight was interrupted; success is not established.');
      expect(fake.client.end).toHaveBeenCalledOnce();
      expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(phase === 'connect' ? 0 : 1);
      const calls = fake.query.mock.calls.length;
      heldConnection.resolve(); heldQuery.resolve({ command: phase === 'rollback' ? 'ROLLBACK' : 'SELECT', rows: [] });
      await Promise.resolve(); await Promise.resolve(); expect(fake.query).toHaveBeenCalledTimes(calls);
      expectRemoved(fake.signals); abort.mockRestore();
    }
  });
  it('does not register Windows-only SIGBREAK on other platforms and preserves unrelated listeners', async () => {
    const fake = fixture(); fake.runtime.platform = 'linux'; const existing = vi.fn(); fake.signals.on('SIGINT', existing);
    const on = vi.spyOn(fake.signals, 'on');
    expect(await fake.run()).toBe(0); expect(on.mock.calls.map(([signal]) => signal)).toEqual(['SIGINT', 'SIGTERM']);
    expect(fake.signals.listeners('SIGINT')).toEqual([existing]); fake.signals.off('SIGINT', existing); expectRemoved(fake.signals);
  });
  it('cancels driver loading before socket construction, handling late loader rejection', async () => {
    const fake = fixture(); const loading = deferred<Awaited<ReturnType<PreflightRuntime['driver']>>>(); const entered = deferred();
    fake.runtime.driver = vi.fn(() => { entered.resolve(); return loading.promise; });
    const pending = fake.run(); await entered.promise; fake.signals.emit('SIGINT');
    expect(await pending).toBe(130); expect(fake.makeSocket).not.toHaveBeenCalled(); expectRemoved(fake.signals);
    loading.reject(new Error('sensitive late loader failure')); await Promise.resolve(); await Promise.resolve();
    expect(fake.runtime.output).toHaveBeenCalledOnce();
  });
  it('does not load a driver after interruption during migration-file reading', async () => {
    const fake = fixture(); fake.runtime.readMigration = () => { fake.signals.emit('SIGTERM'); return sql; };
    expect(await fake.run()).toBe(143); expect(fake.runtime.driver).not.toHaveBeenCalled(); expectRemoved(fake.signals);
  });
  it('does not report interrupted, unconfirmed shutdown as success or retry rollback', async () => {
    vi.useFakeTimers(); const fake = fixture(); const entered = deferred(); const ending = deferred();
    fake.client.end.mockImplementationOnce(async () => { entered.resolve(); return ending.promise; });
    const pending = fake.run(); await entered.promise; fake.signals.emit('SIGINT');
    await vi.advanceTimersByTimeAsync(preflightLimits.shutdown);
    expect(await pending).toBe(130); expect(fake.socket.destroyed).toBe(true); expect(fake.client.end).toHaveBeenCalledOnce();
    expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    expectRemoved(fake.signals); ending.resolve(); await Promise.resolve(); expect(fake.runtime.output).toHaveBeenCalledOnce();
  });
  it('keeps interrupted rollback bounded when closure also stalls', async () => {
    vi.useFakeTimers(); const fake = fixture(); const entered = deferred(); const rollback = deferred<Awaited<ReturnType<typeof fake.query>>>();
    const normal = fake.query.getMockImplementation()!;
    fake.query.mockImplementation((text) => { if (text === 'ROLLBACK') { entered.resolve(); return rollback.promise; } return normal(text); });
    fake.client.end.mockReturnValueOnce(new Promise<never>(() => undefined));
    const pending = fake.run(); await entered.promise; fake.signals.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(preflightLimits.shutdown);
    expect(await pending).toBe(143); expect(fake.client.end).toHaveBeenCalledOnce();
    expect(fake.query.mock.calls.filter(([text]) => text === 'ROLLBACK')).toHaveLength(1);
    expectRemoved(fake.signals); rollback.resolve({ command: 'ROLLBACK', rows: [] }); await Promise.resolve();
    expect(fake.runtime.output).toHaveBeenCalledOnce();
  });
  it.each(['CONNECT', 'PEER', 'IDENTITY', 'VERSION', 'SETTINGS', 'MIGRATION', 'SCHEMA', 'QUIET', 'ROLLBACK', 'CLOSE'] as const)(
    'emits fixed %s diagnostics without sensitive values', async (code) => {
      const fake = fixture(); const normal = fake.query.getMockImplementation()!;
      const secret = 'postgresql://user:secret@host/db raw-cookie raw-password csrf-proof';
      if (code === 'CONNECT') fake.client.connect.mockRejectedValueOnce(new Error(secret));
      if (code === 'PEER') fake.socket.remotePort = 15432;
      if (code === 'IDENTITY') fake.settings.sessionUser = secret;
      if (code === 'VERSION') fake.settings.version = '180000';
      if (code === 'SETTINGS') fake.settings.readOnly = 'off';
      if (code === 'MIGRATION') Object.assign(fake.rows.get(readOnlyCatalogSql.history.text)![0]!, { checksum: secret });
      if (code === 'SCHEMA') fake.rows.set(readOnlyCatalogSql.triggers.text, [{ value: secret }]);
      if (code === 'QUIET') fake.rows.set(preflightControlSql.quiet, [{ others: 1 }]);
      if (code === 'ROLLBACK') fake.query.mockImplementation((text) => text === 'ROLLBACK' ? Promise.reject(new Error(secret)) : normal(text));
      if (code === 'CLOSE') fake.client.end.mockRejectedValueOnce(new Error(secret));
      expect(await fake.run()).toBe(1);
      expect(fake.runtime.output).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(new RegExp(`^APPLYFLOW_PREFLIGHT ${code}: [^.]+\\.$`)));
      expect(JSON.stringify(vi.mocked(fake.runtime.output).mock.calls)).not.toContain(secret);
      expect(fake.makeClient.mock.calls.length).toBeLessThanOrEqual(1); expectRemoved(fake.signals);
    }
  );
  it('reports local migration mismatch before constructing network resources', async () => {
    const fake = fixture(); fake.runtime.readMigration = () => Buffer.from('changed SQL');
    expect(await fake.run()).toBe(1); expect(fake.makeSocket).not.toHaveBeenCalled();
    expect(fake.runtime.output).toHaveBeenCalledWith(expect.stringContaining('PREFLIGHT MIGRATION:')); expectRemoved(fake.signals);
  });
  it('rechecks admission after asynchronous driver loading before any socket construction', async () => {
    const fake = fixture(); const normal = fake.runtime.driver;
    fake.runtime.driver = async () => {
      const dependencies = await normal(); fake.runtime.environment.PGOPTIONS = 'unsafe'; return dependencies;
    };
    expect(await fake.run()).toBe(1); expect(fake.makeSocket).not.toHaveBeenCalled(); expectRemoved(fake.signals);
    expect(fake.runtime.output).toHaveBeenCalledWith(expect.stringContaining('PREFLIGHT ADMISSION:'));
  });
  it('reports a bounded connection timeout once without reconnecting', async () => {
    vi.useFakeTimers(); const fake = fixture(); const entered = deferred();
    fake.client.connect.mockImplementationOnce(() => { entered.resolve(); return new Promise<never>(() => undefined); });
    const pending = fake.run(); await entered.promise;
    await vi.advanceTimersByTimeAsync(preflightLimits.connect);
    expect(await pending).toBe(1); expect(fake.client.connect).toHaveBeenCalledOnce();
    expect(fake.runtime.output).toHaveBeenCalledExactlyOnceWith('APPLYFLOW_PREFLIGHT TIMEOUT: The bounded preflight deadline expired.');
    expectRemoved(fake.signals); expect(vi.getTimerCount()).toBe(0);
  });
  it('sanitizes migration read and unexpected loader failures', async () => {
    for (const stage of ['read', 'load']) {
      const fake = fixture();
      if (stage === 'read') fake.runtime.readMigration = () => { throw new Error('private-file-url password'); };
      else fake.runtime.driver = async () => { throw new Error('private-driver-url password'); };
      expect(await fake.run()).toBe(1);
      expect(fake.runtime.output).toHaveBeenCalledWith(expect.stringContaining(stage === 'read' ? 'PREFLIGHT MIGRATION:' : 'PREFLIGHT UNEXPECTED:'));
      expectRemoved(fake.signals);
    }
  });
  it('cannot turn an injected exception into a successful result by forging its code/detail', async () => {
    for (const field of ['code', 'detail']) {
      const fake = fixture(); const error = new ReadOnlyPreflightError('QUERY');
      Object.defineProperty(error, field, { value: 'PASSED' }); fake.runtime.driver = async () => { throw error; };
      expect(await fake.run()).toBe(1); expect(fake.runtime.output).toHaveBeenCalledWith(expect.stringContaining('PREFLIGHT UNEXPECTED:'));
    }
  });
  it('retains primary adapter error codes while rejecting non-allowlisted reporting details', async () => {
    const fake = fixture(); const error = new ReadOnlyPreflightError('QUERY', 'password cookie csrf private-url' as 'SCHEMA');
    expect(error.detail).toBeUndefined(); expect(error.message).toBe('Read-only preflight failed: QUERY.');
    fake.runtime.driver = async () => { throw error; };
    expect(await fake.run()).toBe(1);
    expect(fake.runtime.output).toHaveBeenCalledExactlyOnceWith('APPLYFLOW_PREFLIGHT QUERY: A fixed inspection operation failed.');
  });
  it('catches throwing diagnostic getters without exposing the thrown value', async () => {
    const fake = fixture(); const error = new ReadOnlyPreflightError('QUERY');
    Object.defineProperty(error, 'detail', { get() { throw new Error('sensitive getter failure'); } });
    fake.runtime.driver = async () => { throw error; };
    expect(await fake.run()).toBe(1); expect(fake.runtime.output).toHaveBeenCalledWith(expect.stringContaining('PREFLIGHT UNEXPECTED:'));
  });
  it('sanitizes signal registration/removal failures and attempts all listener removals', async () => {
    for (const method of ['on', 'off'] as const) {
      const fake = fixture(); const original = fake.signals[method].bind(fake.signals);
      vi.spyOn(fake.signals, method).mockImplementation((event, handler) => {
        const value = original(event, handler); if (event === 'SIGTERM') throw new Error('sensitive signal adapter'); return value;
      });
      expect(await fake.run()).toBe(1); expectRemoved(fake.signals);
      expect(fake.runtime.output).toHaveBeenCalledWith(expect.stringContaining('PREFLIGHT UNEXPECTED:'));
    }
  });
  it('returns failure if output throws and never leaks its raw exception', async () => {
    const fake = fixture(); fake.runtime.output = vi.fn(() => { throw new Error('sensitive reporter error'); });
    expect(await fake.run()).toBe(1); expectRemoved(fake.signals);
    expect(fake.runtime.output).toHaveBeenLastCalledWith('APPLYFLOW_PREFLIGHT UNEXPECTED: Preflight failed unexpectedly; no sensitive diagnostics were emitted.');
  });
  it.each(['preflight', 'fixtures', 'smoke', 'full'] as const)('retains disabled %s execution regardless of environment flags', (phase) => {
    vi.stubEnv('APPLYFLOW_E2E_APPROVED', 'true'); vi.stubEnv('APPLYFLOW_PREFLIGHT_APPROVED', 'true');
    try {
      expect(() => requireLivePhase(phase)).toThrow('disabled');
      expect(requireLiveRuntime).toThrow('not implemented or enabled');
    } finally { vi.unstubAllEnvs(); }
  });
  it('uses the approved single installed driver version and stream factory contract', () => {
    // Static inspection only: no actual pg client/socket is constructed here.
    const metadata = JSON.parse(readFileSync(new URL('../../../node_modules/pg/package.json', import.meta.url), 'utf8')) as { version: string };
    expect(metadata.version).toBe('8.23.1');
    const connection = readFileSync(new URL('../../../node_modules/pg/lib/connection.js', import.meta.url), 'utf8');
    const client = readFileSync(new URL('../../../node_modules/pg/lib/client.js', import.meta.url), 'utf8');
    expect(client).toContain('stream: c.stream');
    expect(connection).toContain('this.stream = config.stream || getStream(config.ssl)');
    expect(connection).toContain('this.stream = this.stream(config)');
    expect(connection).toContain('this.stream.connect(port, host)');
    expect(connection).toContain('this.attachListeners(this.stream)');
  });
  it('retains the dedicated preflight script separately from the disabled full runner', () => {
    const manifest = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as { scripts: Record<string, string> };
    expect(manifest.scripts['test:e2e:preflight']).toBe('node --import tsx tests/e2e/support/read-only-preflight.ts');
    expect(manifest.scripts['test:e2e']).toBe('node --import tsx tests/e2e/support/run.ts');
  });
});
