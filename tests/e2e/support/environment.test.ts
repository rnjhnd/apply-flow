import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { admitEnvironment, childEnvironment } from './environment.js';
import { approvedChecksum, approvedMigration, verifyDatabase, type PreflightConnection } from './database-preflight.js';
import { requireLiveRuntime } from './fixtures.js';

const url = 'postgresql://applyflow_test:offline-fixture-only@127.0.0.1:5433/applyflow_test';
const env = { NODE_ENV: 'test', TEST_DATABASE_URL: url };
const sql = readFileSync(new URL('../../../apps/api/prisma/migrations/0001_init_auth/migration.sql', import.meta.url));

function connection() {
  return { identity: vi.fn<PreflightConnection['identity']>().mockResolvedValue({ database: 'applyflow_test',
    username: 'applyflow_test', host: '127.0.0.1', port: 5433 }),
  history: vi.fn<PreflightConnection['history']>().mockResolvedValue([{ migration_name: approvedMigration,
    checksum: approvedChecksum, finished_at: new Date('2026-10-20T00:00:00Z'), rolled_back_at: null }]),
  close: vi.fn<PreflightConnection['close']>().mockResolvedValue(undefined) };
}

describe('offline browser-test environment admission', () => {
  it.each([undefined, '', 'development', 'production'])('rejects NODE_ENV=%s before connection', async (NODE_ENV) => {
    const connect = vi.fn();
    await expect(verifyDatabase({ ...env, NODE_ENV }, sql, connect)).rejects.toThrow('NODE_ENV=test');
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([
    url.replace('127.0.0.1', 'localhost'), url.replace('127.0.0.1', '192.0.2.1'),
    url.replace('5433', '15432'), url.replace('/applyflow_test', '/applyflow_dev'),
    url.replace('applyflow_test:', 'applyflow_dev:'), `${url}?host=evil.invalid`, `${url}?schema=private`
  ])('rejects a changed target without including it in errors (%#)', (TEST_DATABASE_URL) => {
    expect(() => admitEnvironment({ ...env, TEST_DATABASE_URL })).toThrow(/target|TEST_DATABASE_URL/);
    try { admitEnvironment({ ...env, TEST_DATABASE_URL }); }
    catch (error) { expect(String(error)).not.toContain('offline-fixture-only'); }
  });
  it('requires the dedicated URL and refuses development fallback', () => {
    expect(() => admitEnvironment({ NODE_ENV: 'test' })).toThrow('no fallback');
    expect(() => admitEnvironment({ NODE_ENV: 'test', DATABASE_URL: url })).toThrow('no fallback');
  });
  it.each(['PGHOST', 'PGPORT', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGSERVICE', 'PGOPTIONS',
    'NODE_OPTIONS', 'NODE_PATH', 'DATABASE_URL', 'DIRECT_URL', 'SHADOW_DATABASE_URL', 'APP_ORIGIN', 'HOST', 'PORT'])(
    'rejects inherited %s', (key) => { expect(() => childEnvironment({ ...env, [key]: 'unsafe' })).toThrow('overrides'); }
  );
  it('forwards only OS allowlisted values and explicitly selected test policy', () => {
    const child = childEnvironment({ ...env, PATH: 'fixture-path', POSTGRES_DEV_PASSWORD: 'private',
      PRODUCTION_DATABASE_URL: 'private', APP_SECRET: 'private', ALLOW_LOCAL_REGISTRATION: 'false' });
    expect(child).toEqual({ ...env, PATH: 'fixture-path', ALLOW_LOCAL_REGISTRATION: 'true', APP_TIMEZONE: 'Asia/Manila' });
    expect(JSON.stringify(child)).not.toContain('private');
  });
  it('makes live execution unavailable without connecting or starting anything', () => {
    expect(() => requireLiveRuntime()).toThrow('Stage 2C.3B');
  });
});

describe('database preflight using only injected mock responses', () => {
  it('checks the actual approved SQL bytes, endpoint, identity, and one completed migration', async () => {
    const mock = connection(); const connect = vi.fn().mockResolvedValue(mock);
    await verifyDatabase(env, sql, connect);
    expect(connect).toHaveBeenCalledOnce(); expect(mock.identity).toHaveBeenCalledOnce();
    expect(mock.history).toHaveBeenCalledOnce(); expect(mock.close).toHaveBeenCalledOnce();
  });
  it('rejects altered SQL before requesting a connection', async () => {
    const connect = vi.fn();
    await expect(verifyDatabase(env, Buffer.from('changed'), connect)).rejects.toThrow('migration contents');
    expect(connect).not.toHaveBeenCalled();
  });
  it.each([
    { database: 'applyflow_dev' }, { username: 'applyflow_dev' }, { host: 'localhost' }, { port: 15432 }
  ])('rejects connected identity mismatch %j and closes', async (change) => {
    const mock = connection(); mock.identity.mockResolvedValue({ ...await mock.identity(), ...change });
    await expect(verifyDatabase(env, sql, async () => mock)).rejects.toThrow(/match/);
    expect(mock.history).not.toHaveBeenCalled(); expect(mock.close).toHaveBeenCalledOnce();
  });
  it.each(['missing', 'extra', 'checksum', 'name', 'unfinished', 'rollback', 'invalid-date'])(
    'rejects %s migration history', async (change) => {
      const mock = connection(); const rows = await mock.history(); const row = rows[0]!;
      if (change === 'missing') rows.pop();
      if (change === 'extra') rows.push({ ...row });
      if (change === 'checksum') row.checksum = '0'.repeat(64);
      if (change === 'name') row.migration_name = 'unexpected';
      if (change === 'unfinished') row.finished_at = null;
      if (change === 'rollback') row.rolled_back_at = new Date();
      if (change === 'invalid-date') row.finished_at = new Date(NaN);
      mock.history.mockResolvedValue(rows);
      await expect(verifyDatabase(env, sql, async () => mock)).rejects.toThrow('migration history');
      expect(mock.close).toHaveBeenCalledOnce();
    }
  );
  it('closes after a failed identity query without permitting a history check', async () => {
    const mock = connection(); mock.identity.mockRejectedValue(new Error('mock query failure'));
    await expect(verifyDatabase(env, sql, async () => mock)).rejects.toThrow('mock query failure');
    expect(mock.close).toHaveBeenCalledOnce(); expect(mock.history).not.toHaveBeenCalled();
  });
});
