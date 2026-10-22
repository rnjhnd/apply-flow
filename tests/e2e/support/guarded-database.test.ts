import { describe, expect, it, vi } from 'vitest';
import { AmbiguousCommitError, assertInspection, authenticationDatabase, connectGuarded, createGuardedTransactions, transactionOptions, transactionSetup } from './guarded-database.js';
import type { PrismaClient } from '../../../apps/api/src/generated/prisma/client.ts';
import { admitEnvironment } from './environment.js';
import { validateHistory, validateSchema, expectedSchema } from './schema.js';
import { inspectCatalog, catalogSql } from './catalog.js';
import { env, sql, inspection, fakeDatabase, deferred } from './b1-fakes.js';

describe('B1 injected database admission and Prisma transaction composition', () => {
  it.each([
    {}, { NODE_ENV: 'production' }, { NODE_ENV: 'test', DATABASE_URL: env.TEST_DATABASE_URL },
    { ...env, NODE_ENV: 'development' }, { ...env, TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('5433', '15432') },
    { ...env, TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('127.0.0.1', 'localhost') },
    { ...env, TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('/applyflow_test', '/applyflow_dev') },
    { ...env, TEST_DATABASE_URL: env.TEST_DATABASE_URL.replace('applyflow_test:', 'applyflow_dev:') },
    { ...env, PGHOST: '127.0.0.1' }, { ...env, NODE_OPTIONS: '--inspect' }
  ])('rejects unsafe environment before the injected connector (%#)', async (source) => {
    const connect = vi.fn();
    await expect(connectGuarded(source, sql, connect)).rejects.toThrow();
    expect(connect).not.toHaveBeenCalled();
  });
  it('rejects changed migration bytes before connection', async () => {
    const connect = vi.fn();
    await expect(connectGuarded(env, Buffer.from('changed'), connect)).rejects.toThrow('Unapproved');
    expect(connect).not.toHaveBeenCalled();
  });
  it.each(['database', 'username', 'host', 'port'] as const)('closes a connection with unexpected %s', async (key) => {
    const value = inspection(); Object.assign(value.identity, { [key]: key === 'port' ? 15432 : 'unexpected' });
    const close = vi.fn();
    await expect(connectGuarded(env, sql, async () => ({ close, inspect: async () => value }))).rejects.toThrow();
    expect(close).toHaveBeenCalledOnce();
  });
  it('returns only an admitted connection and keeps it open for its owner', async () => {
    const connection = { close: vi.fn(), inspect: async () => inspection() };
    expect(await connectGuarded(env, sql, async () => connection)).toBe(connection);
    expect(connection.close).not.toHaveBeenCalled();
  });
  it.each([
    [], [{ checksum: 'wrong' }],
    [{ migration_name: 'other' }], [{ finished_at: null }]
  ].map((history) => ({ history })))('rejects incomplete history (%#)', ({ history }) => { expect(() => validateHistory(history)).toThrow(); });
  it('rejects checksum, step, rollback, log, and date mismatches independently', () => {
    const good = (inspection().history as Array<Record<string, unknown>>)[0];
    for (const patch of [{ checksum: 'wrong' }, { applied_steps_count: 0 }, { rolled_back_at: new Date() }, { logs: 'failure' }, { finished_at: new Date(NaN) }]) {
      expect(() => validateHistory([{ ...good, ...patch }])).toThrow();
    }
    validateHistory(inspection().history);
  });
  it.each(['tables', 'columns', 'indexes', 'constraints', 'triggers', 'rowSecurity'] as const)('rejects changed schema %s', (key) => {
    const changed = structuredClone(expectedSchema);
    (changed[key] as unknown[]).push('unexpected');
    expect(() => validateSchema(changed)).toThrow();
  });
  it('rejects duplicate catalog rows, altered defaults, and partial indexes', () => {
    const altered = structuredClone(expectedSchema); altered.tables.push('User');
    expect(() => validateSchema(altered)).toThrow();
    expect(() => validateSchema({ ...expectedSchema, columns: expectedSchema.columns.map((row) => ({ ...row, default: 'changed' })) })).toThrow();
    expect(() => validateSchema({ ...expectedSchema, indexes: expectedSchema.indexes.map((row) => ({ ...row, predicate: 'true' })) })).toThrow();
    validateSchema({ ...expectedSchema, tables: [...expectedSchema.tables].reverse() });
  });
  it('preserves the real callback transaction, return identity, and bounded options', async () => {
    const fake = fakeDatabase(); const value = { accepted: true };
    const host = vi.spyOn(fake.host, '$transaction');
    const work = vi.fn(async (tx) => { expect(tx).toBe(fake.tx); return value; });
    expect(await fake.database.$transaction(work)).toBe(value);
    expect(work).toHaveBeenCalledOnce(); expect(host.mock.calls[0]?.[1]).toEqual(transactionOptions);
    expect(fake.query).toHaveBeenCalledWith(transactionSetup[0]); expect(fake.execute).toHaveBeenCalledWith(transactionSetup[1]);
    expect(fake.inspect).toHaveBeenCalledTimes(3); expect(fake.stats).toEqual({ commits: 1, rollbacks: 0 });
  });
  it('preserves callback rejection without retry and rolls back the fake host', async () => {
    const fake = fakeDatabase(); const error = new Error('callback failure'); const work = vi.fn(async () => { throw error; });
    await expect(fake.database.$transaction(work)).rejects.toBe(error);
    expect(work).toHaveBeenCalledOnce(); expect(fake.stats).toEqual({ commits: 0, rollbacks: 1 });
  });
  it('does not deliver callback results until the injected host confirms commit', async () => {
    const fake = fakeDatabase(); const commit = deferred(); const result = { response: 'safe' };
    const host = { async $transaction<T>(work: Parameters<typeof fake.host.$transaction<T>>[0]) {
      const value = await work(fake.tx); await commit.promise; return value;
    } };
    const guarded = createGuardedTransactions(env, sql, host, fake.inspect); const delivered = vi.fn();
    const operation = guarded.$transaction(async () => result).then(delivered);
    for (let turn = 0; turn < 12; turn++) await Promise.resolve();
    expect(fake.inspect).toHaveBeenCalledTimes(3); expect(delivered).not.toHaveBeenCalled();
    commit.resolve(); await operation; expect(delivered).toHaveBeenCalledWith(result);
  });
  it('preserves a host commit error without returning a success result or retrying', async () => {
    const fake = fakeDatabase(); const error = new Error('commit uncertain'); const callback = vi.fn(async () => 'result');
    const host = { async $transaction<T>(work: Parameters<typeof fake.host.$transaction<T>>[0]): Promise<T> {
      await work(fake.tx); throw error;
    } };
    await expect(createGuardedTransactions(env, sql, host, fake.inspect).$transaction(callback)).rejects.toBe(error);
    expect(callback).toHaveBeenCalledOnce();
  });
  it.each([1, 2, 3])('rolls back when inspection %i fails', async (failureAt) => {
    const fake = fakeDatabase(); let count = 0;
    fake.inspect.mockImplementation(async () => { const data = inspection(); if (++count === failureAt) data.identity.database = 'wrong'; return data; });
    const work = vi.fn(async () => 'ok');
    await expect(fake.database.$transaction(work)).rejects.toThrow();
    expect(work).toHaveBeenCalledTimes(failureAt === 3 ? 1 : 0);
    expect(fake.stats.rollbacks).toBe(1);
  });
  it('closes queued admission before any transaction and detects changed environment', async () => {
    const fake = fakeDatabase(); const host = vi.spyOn(fake.host, '$transaction');
    const guarded = createGuardedTransactions(env, sql, fake.host, fake.inspect, () => false);
    await expect(guarded.$transaction(async () => undefined)).rejects.toThrow('closed'); expect(host).not.toHaveBeenCalled();
    const source = { ...env }; const changing = createGuardedTransactions(source, sql, fake.host, fake.inspect);
    source.NODE_ENV = 'production';
    expect(() => changing.$transaction(async () => undefined)).toThrow(); expect(host).not.toHaveBeenCalled();
  });
  it('propagates setup failure before the product callback', async () => {
    const fake = fakeDatabase(); fake.query.mockRejectedValue(new Error('timeout'));
    const callback = vi.fn(); await expect(fake.database.$transaction(callback)).rejects.toThrow('timeout');
    expect(callback).not.toHaveBeenCalled(); expect(fake.stats.rollbacks).toBe(1);
  });
  it('runs only the supplied catalog reader and assembles strict metadata', async () => {
    const fake = fakeDatabase(); const data = inspection();
    fake.query.mockReset().mockResolvedValueOnce([{ database: 'applyflow_test', username: 'applyflow_test' }])
      .mockResolvedValueOnce(data.history).mockResolvedValueOnce(expectedSchema.tables.map((name) => ({ name })))
      .mockResolvedValueOnce(expectedSchema.columns).mockResolvedValueOnce(expectedSchema.indexes)
      .mockResolvedValueOnce(expectedSchema.constraints.map((value) => ({ value }))).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(await inspectCatalog(fake.tx, { host: '127.0.0.1', port: 5433 })).toEqual(data);
    expect(fake.query.mock.calls.map(([statement]) => statement)).toEqual(Object.values(catalogSql));
    expect(fake.execute).not.toHaveBeenCalled();
  });
});

describe('B1 audit corrections: identity projection, live admission, and read-only facade', () => {
  function reader(identity: unknown) {
    const fake = fakeDatabase(); const data = inspection();
    fake.query.mockReset().mockResolvedValueOnce([identity]).mockResolvedValueOnce(data.history)
      .mockResolvedValueOnce(expectedSchema.tables.map((name) => ({ name })))
      .mockResolvedValueOnce(expectedSchema.columns).mockResolvedValueOnce(expectedSchema.indexes)
      .mockResolvedValueOnce(expectedSchema.constraints.map((value) => ({ value }))).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    return fake;
  }
  it('cannot overwrite unexpected queried identity through an extended endpoint context', async () => {
    const fake = reader({ database: 'unexpected_database', username: 'unexpected_user' });
    const endpoint = { host: '127.0.0.1', port: 5433, database: 'applyflow_test', username: 'applyflow_test', databaseUrl: 'private-sentinel' };
    const result = await inspectCatalog(fake.tx, endpoint);
    expect(result.identity).toEqual({ database: 'unexpected_database', username: 'unexpected_user', host: '127.0.0.1', port: 5433 });
    expect(() => assertInspection(admitEnvironment(env), result)).toThrow('database/user');
    expect(JSON.stringify(result)).not.toContain('private-sentinel'); expect(Object.isFrozen(result.identity)).toBe(true);
  });
  it.each([{ host: 'localhost', port: 5433 }, { host: '127.0.0.1', port: 15432 }, { host: '127.0.0.1', port: '5433' }, {}])(
    'rejects malformed endpoint metadata before queries (%#)', async (endpoint) => {
      const fake = fakeDatabase();
      await expect(inspectCatalog(fake.tx, endpoint as { host: string; port: number })).rejects.toThrow('endpoint metadata');
      expect(fake.query).not.toHaveBeenCalled();
    }
  );
  it('rejects unexpected queried identity fields without forwarding their values', async () => {
    const fake = reader({ database: 'applyflow_test', username: 'applyflow_test', password: 'private-sentinel' });
    await expect(inspectCatalog(fake.tx, { host: '127.0.0.1', port: 5433 })).rejects.toThrow(/^Unexpected connected identity\.$/);
    expect(fake.query).toHaveBeenCalledOnce();
  });
  it('captures endpoint fields before awaiting the query, ignoring later caller mutations', async () => {
    const fake = reader({ database: 'applyflow_test', username: 'applyflow_test' }); const gate = deferred<unknown[]>();
    fake.query.mockReset().mockReturnValueOnce(gate.promise).mockResolvedValueOnce(inspection().history)
      .mockResolvedValueOnce(expectedSchema.tables.map((name) => ({ name }))).mockResolvedValueOnce(expectedSchema.columns)
      .mockResolvedValueOnce(expectedSchema.indexes).mockResolvedValueOnce(expectedSchema.constraints.map((value) => ({ value })))
      .mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const endpoint = { host: '127.0.0.1', port: 5433 }; const pending = inspectCatalog(fake.tx, endpoint);
    endpoint.port = 15432; gate.resolve([{ database: 'applyflow_test', username: 'applyflow_test' }]);
    expect((await pending).identity.port).toBe(5433);
  });
  it.each([1, 2, 3])('rolls back admission loss during inspection %i', async (at) => {
    const fake = fakeDatabase(); let admitted = true; let count = 0;
    fake.inspect.mockImplementation(async () => { if (++count === at) admitted = false; return inspection(); });
    const work = vi.fn(async () => 'safe');
    await expect(createGuardedTransactions(env, sql, fake.host, fake.inspect, () => admitted).$transaction(work)).rejects.toThrow('admission changed');
    expect(fake.stats).toEqual({ commits: 0, rollbacks: 1 }); expect(work).toHaveBeenCalledTimes(at === 3 ? 1 : 0);
  });
  it('rolls back admission loss immediately after the callback returns', async () => {
    const fake = fakeDatabase(); let admitted = true;
    const database = createGuardedTransactions(env, sql, fake.host, fake.inspect, () => admitted);
    await expect(database.$transaction(async () => { admitted = false; return 'uncommitted'; })).rejects.toThrow('admission changed');
    expect(fake.stats).toEqual({ commits: 0, rollbacks: 1 });
  });
  it('reports post-callback commit-window invalidation as ambiguous without replay', async () => {
    const fake = fakeDatabase(); const commitStarted = deferred(); const confirmation = deferred(); let admitted = true; let commits = 0;
    const host = { async $transaction<T>(work: Parameters<typeof fake.host.$transaction<T>>[0]) {
      const value = await work(fake.tx); commitStarted.resolve(); await confirmation.promise; commits++; return value;
    } };
    const work = vi.fn(async () => 'value'); const guarded = createGuardedTransactions(env, sql, host, fake.inspect, () => admitted);
    const pending = guarded.$transaction(work); const failure = expect(pending).rejects.toBeInstanceOf(AmbiguousCommitError);
    await commitStarted.promise; admitted = false; confirmation.resolve(); await failure;
    expect(commits).toBe(1); expect(work).toHaveBeenCalledOnce();
  });
  it('exposes only a bound findUnique method and forwards arguments, receiver, promise and rejection', async () => {
    const fake = fakeDatabase(); const result = { id: 'safe-id', email: 'safe@example.invalid' }; const promise = Promise.resolve(result);
    const model = { marker: 'model', findUnique: vi.fn(function (this: { marker: string }, args: unknown) {
      expect(this.marker).toBe('model'); expect(args).toEqual({ where: { email: result.email } }); return promise;
    }), create: vi.fn(), update: vi.fn(), delete: vi.fn(), upsert: vi.fn() };
    const database = authenticationDatabase({ user: model } as unknown as PrismaClient, fake.database);
    expect(Object.keys(database.user)).toEqual(['findUnique']); expect(Object.isFrozen(database.user)).toBe(true);
    for (const method of ['create', 'update', 'delete', 'upsert', 'deleteMany']) expect(method in database.user).toBe(false);
    const operation = database.user.findUnique({ where: { email: result.email } }); expect(operation).toBe(promise); expect(await operation).toBe(result);
    const error = new Error('lookup failure'); model.findUnique.mockImplementationOnce(() => Promise.reject(error));
    await expect(database.user.findUnique({ where: { email: result.email } })).rejects.toBe(error);
    expect(model.create).not.toHaveBeenCalled(); expect(fake.stats).toEqual({ commits: 0, rollbacks: 0 });
  });
});
