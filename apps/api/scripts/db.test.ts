import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Fs from 'node:fs/promises';
import { migrationChain, sqlDigest, wrapApplicationDiff } from './migration-policy.js';

const ports = vi.hoisted(() => ({ spawn: vi.fn(), load: vi.fn(), connect: vi.fn(),
  read: vi.fn(), list: vi.fn(), mkdir: vi.fn(), write: vi.fn(), exists: vi.fn(), approve: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync: ports.spawn }));
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof Fs>(),
  readFile: ports.read, readdir: ports.list, mkdir: ports.mkdir, writeFile: ports.write }));
vi.mock('node:fs', async (original) => ({ ...await original<typeof import('node:fs')>(), existsSync: ports.exists }));
vi.mock('../src/config/load-env.js', () => ({ loadLocalEnvironment: ports.load, localEnvPath: 'never-loaded.env' }));
vi.mock('../src/db/client.js', () => ({ openLocalDatabase: ports.connect }));
// Keep pending-state rejection as an explicit historical fixture. The true branch
// uses the real source-approved manifest; all execution I/O is still mocked.
vi.mock('./migration-policy.js', async (original) => {
  const actual = await original<typeof import('./migration-policy.js')>();
  const pending = actual.migrationChain.map((entry) => entry.name === '0002_job_applications'
    ? { ...entry, approval: 'REVIEW_PENDING' as const } : entry);
  return { ...actual,
    assertDeploymentApproval: (args: string[]) => actual.assertDeploymentApproval(args, ports.approve() ? actual.migrationChain : pending),
    validateMigrationHistory: (rows: unknown, options: { allowInitialPrefix?: boolean } = {}) =>
      actual.validateMigrationHistory(rows, { ...options, chain: ports.approve() ? actual.migrationChain : pending })
  };
});

const actualFs = await vi.importActual<typeof Fs>('node:fs/promises');
const { main } = await import('./db.js');
const candidateUrl = new URL('../prisma/migrations/0002_job_applications/migration.sql', import.meta.url);

beforeEach(() => {
  vi.resetAllMocks();
  ports.spawn.mockReturnValue({ status: 0, stdout: '', stderr: '' });
  ports.approve.mockReturnValue(false);
  ports.connect.mockImplementation(() => { throw new Error('Database construction tripwire'); });
  ports.load.mockImplementation(() => { throw new Error('Environment loading tripwire'); });
  ports.read.mockImplementation((path: Parameters<typeof actualFs.readFile>[0], encoding?: 'utf8') =>
    encoding ? actualFs.readFile(path, encoding) : actualFs.readFile(path));
  ports.list.mockImplementation((path: Parameters<typeof actualFs.readdir>[0], options?: { withFileTypes: true }) =>
    options ? actualFs.readdir(path, options) : actualFs.readdir(path));
  ports.exists.mockReturnValue(true);
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

function futureApproval() {
  ports.approve.mockReturnValue(true);
  ports.load.mockImplementation(() => {});
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('TEST_DATABASE_URL', 'postgresql://applyflow_test:test-fixture-password@127.0.0.1:5433/applyflow_test');
}
function connection(count: 1 | 2) {
  const tables = ['User', 'Session', '_prisma_migrations', ...(count === 2 ? ['JobApplication'] : [])]
    .map((table_name) => ({ table_name }));
  const history = migrationChain.slice(0, count).map((entry, index) => ({
    migration_name: entry.name, checksum: entry.sha256, started_at: new Date(1000 + index * 2000),
    finished_at: new Date(2000 + index * 2000), rolled_back_at: null, applied_steps_count: 1, logs: null
  }));
  return { client: { $queryRaw: vi.fn().mockResolvedValueOnce(tables).mockResolvedValueOnce(history),
    $disconnect: vi.fn().mockResolvedValue(undefined) } };
}

// Native Windows process.env collapses case variants. A temporary plain record
// models collisions deterministically; restore the original reference even when
// the operation rejects. No real child is spawned with these environments.
async function withEnvironment<T>(environment: NodeJS.ProcessEnv, work: () => Promise<T>): Promise<T> {
  const original = process.env;
  process.env = environment;
  try { return await work(); }
  finally { process.env = original; }
}

function selectorKeys(environment: NodeJS.ProcessEnv): string[] {
  return Object.keys(environment).filter((key) => key.toUpperCase() === 'PRISMA_MIGRATION_TARGET');
}

async function assertOfflineChildConfiguration(environment: NodeJS.ProcessEnv): Promise<void> {
  // Exercise the unchanged real Prisma configuration with Windows-style lookup,
  // not just a case-sensitive fake's uppercase property. The local environment
  // loader and connection ports remain tripwires from this test module.
  const windowsLookup = new Proxy(environment, { get(target, property) {
    if (typeof property !== 'string') return Reflect.get(target, property);
    const key = Object.keys(target).sort().find((value) => value.toUpperCase() === property.toUpperCase());
    return key === undefined ? undefined : target[key];
  } });
  await withEnvironment(windowsLookup, async () => {
    vi.resetModules();
    const { default: configuration } = await import('../prisma.config.js');
    expect(configuration.datasource?.url).toBe('postgresql://offline:offline@127.0.0.1:1/offline');
  });
  expect(ports.load).not.toHaveBeenCalled();
  expect(ports.connect).not.toHaveBeenCalled();
}

const inheritedSelectors = [
  { name: 'uppercase', values: { PRISMA_MIGRATION_TARGET: 'development' } },
  { name: 'lowercase', values: { prisma_migration_target: 'test' } },
  { name: 'mixed-case', values: { PrIsMa_MiGrAtIoN_TaRgEt: 'development' } },
  { name: 'colliding case variants', values: {
    PRISMA_MIGRATION_TARGET: 'development', prisma_migration_target: 'test', PrIsMa_MiGrAtIoN_TaRgEt: 'invalid'
  } }
];

describe('future approved-chain deployment with injected database/process ports only', () => {
  const args = ['migrate:test', '--approved-sql-sha256', migrationChain[1]!.sha256!];
  it('is idempotent when the complete exact chain is present', async () => {
    futureApproval();
    const full = connection(2);
    ports.connect.mockResolvedValue(full);
    await main(args);
    expect(ports.connect).toHaveBeenCalledTimes(1);
    expect(full.client.$disconnect).toHaveBeenCalledTimes(1);
    expect(ports.spawn).not.toHaveBeenCalled();
  });
  it('closes preflight before deployment and verifies the full chain after a single deployment', async () => {
    futureApproval();
    const before = connection(1), after = connection(2);
    ports.connect.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    await main(args);
    expect(ports.connect).toHaveBeenCalledTimes(2);
    expect(ports.spawn).toHaveBeenCalledTimes(1);
    expect(ports.spawn.mock.calls[0]![1].slice(1, 3)).toEqual(['migrate', 'deploy']);
    expect(before.client.$disconnect.mock.invocationCallOrder[0]!).toBeLessThan(ports.spawn.mock.invocationCallOrder[0]!);
    expect(after.client.$disconnect).toHaveBeenCalledTimes(1);
  });
  it('requires explicit test mode instead of manufacturing NODE_ENV=test', async () => {
    futureApproval();
    vi.stubEnv('NODE_ENV', 'development');
    await expect(main(args)).rejects.toThrow('NODE_ENV=test');
    expect(ports.connect).not.toHaveBeenCalled();
    expect(ports.spawn).not.toHaveBeenCalled();
  });
  it('rejects the wrong test URL before connection', async () => {
    futureApproval();
    vi.stubEnv('TEST_DATABASE_URL', 'postgresql://applyflow_dev:fixture@127.0.0.1:15432/applyflow_dev');
    await expect(main(args)).rejects.toThrow('TEST_DATABASE_URL must explicitly target');
    expect(ports.connect).not.toHaveBeenCalled();
    expect(ports.spawn).not.toHaveBeenCalled();
  });
  it('disconnects and refuses missing history rather than baselining', async () => {
    futureApproval();
    const missing = connection(1);
    missing.client.$queryRaw.mockReset().mockResolvedValue([{ table_name: 'User' }]);
    ports.connect.mockResolvedValue(missing);
    await expect(main(args)).rejects.toThrow('Missing approved initial migration history');
    expect(missing.client.$disconnect).toHaveBeenCalledTimes(1);
    expect(ports.spawn).not.toHaveBeenCalled();
  });
  it('does not retry when post-deployment completion remains unverified', async () => {
    futureApproval();
    const before = connection(1), after = connection(1);
    ports.connect.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
    await expect(main(args)).rejects.toThrow('Migration completion was not verified');
    expect(ports.spawn).toHaveBeenCalledTimes(1);
    expect(after.client.$disconnect).toHaveBeenCalledTimes(1);
  });
  it.each(['development', 'test'] as const)('replaces every inherited variant with only the deliberately selected %s target', async (target) => {
    futureApproval();
    ports.connect.mockResolvedValueOnce(connection(1)).mockResolvedValueOnce(connection(2));
    const environment = { ...process.env, NODE_ENV: target === 'test' ? 'test' : 'development',
      DATABASE_URL: 'postgresql://applyflow_dev:dev-fixture-password@127.0.0.1:15432/applyflow_dev',
      PRISMA_MIGRATION_TARGET: 'invalid', prisma_migration_target: 'invalid', PrIsMa_MiGrAtIoN_TaRgEt: 'invalid'
    };
    await withEnvironment(environment, () => main([target === 'test' ? 'migrate:test' : 'migrate:deploy', ...args.slice(1)]));
    expect(ports.spawn).toHaveBeenCalledTimes(1);
    const child = ports.spawn.mock.calls[0]![2].env;
    expect(selectorKeys(child)).toEqual(['PRISMA_MIGRATION_TARGET']);
    expect(child.PRISMA_MIGRATION_TARGET).toBe(target);
    expect(child.NODE_ENV).toBe(environment.NODE_ENV);
    expect(selectorKeys(environment)).toHaveLength(3);
    expect(environment.PRISMA_MIGRATION_TARGET).toBe('invalid');
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('offline database command boundaries', () => {
  it('imports without invoking a CLI, environment loader, process or connection', async () => {
    vi.resetModules();
    await import('./db.js');
    for (const port of Object.values(ports)) expect(port).not.toHaveBeenCalled();
  });
  it.each(['validate', 'generate'])('runs %s with offline datasource selection even in production builds', async (command) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('PRISMA_MIGRATION_TARGET', 'development');
    vi.stubEnv('PGHOST', 'foreign.example');
    await main([command]);
    expect(ports.spawn).toHaveBeenCalledTimes(1);
    const [, args, options] = ports.spawn.mock.calls[0]!;
    expect(args.slice(1)).toEqual([command, '--config', expect.stringMatching(/prisma.config.ts$/)]);
    expect(options.env.PRISMA_MIGRATION_TARGET).toBeUndefined();
    expect(options.env.PGHOST).toBeUndefined();
    expect(options.env.NODE_ENV).toBe('production');
    expect(ports.load).not.toHaveBeenCalled();
    expect(ports.connect).not.toHaveBeenCalled();
  });
  it.each(inheritedSelectors.flatMap(({ name, values }) => ['validate', 'generate'].map((command) => ({ name, values, command }))))(
    'strips $name selectors for $command before evaluating the child configuration', async ({ values, command }) => {
      const environment: NodeJS.ProcessEnv = { ...process.env, ...values, NODE_ENV: 'production',
        DATABASE_URL: 'must-not-select-a-database', TEST_DATABASE_URL: 'must-not-select-a-database' };
      await withEnvironment(environment, () => main([command]));
      expect(ports.spawn).toHaveBeenCalledTimes(1);
      const child = ports.spawn.mock.calls[0]![2].env;
      expect(selectorKeys(child)).toEqual([]);
      expect(child.NODE_ENV).toBe('production');
      for (const [key, value] of Object.entries(values)) expect(environment[key]).toBe(value);
      await assertOfflineChildConfiguration(child);
    }
  );
  it.each([
    ['validate', '--url', 'postgresql://secret'], ['generate', '--schema', 'foreign.prisma'],
    ['migrate:create', '--name', 'init_auth'], ['migrate:create', '--name', 'job_applications', '--force'],
    ['migrate:create', '--name', '../../foreign'], ['migrate:create', '--from-config-datasource']
  ].map((args) => ({ args })))('rejects unsupported offline arguments before resources %#', async ({ args }) => {
    await expect(main(args)).rejects.toThrow();
    expect(ports.spawn).not.toHaveBeenCalled();
    expect(ports.load).not.toHaveBeenCalled();
    expect(ports.connect).not.toHaveBeenCalled();
    expect(ports.mkdir).not.toHaveBeenCalled();
  });
  it.each(['migrate:deploy', 'migrate:test'])('rejects %s before environment loading, driver import or subprocess creation', async (command) => {
    await expect(main([command, '--approved-sql-sha256', migrationChain[1]!.sha256!])).rejects.toThrow('REVIEW_PENDING');
    expect(ports.load).not.toHaveBeenCalled();
    expect(ports.connect).not.toHaveBeenCalled();
    expect(ports.spawn).not.toHaveBeenCalled();
  });
  it.each(['migrate:deploy', 'migrate:test'])('rejects a different SQL digest for %s before resources despite source approval', async (command) => {
    ports.approve.mockReturnValue(true);
    await expect(main([command, '--approved-sql-sha256', 'f'.repeat(64)])).rejects.toThrow('Explicit approval of the exact second migration SQL digest is required.');
    expect(ports.load).not.toHaveBeenCalled();
    expect(ports.connect).not.toHaveBeenCalled();
    expect(ports.spawn).not.toHaveBeenCalled();
  });
  it('refuses to overwrite existing application SQL', async () => {
    await expect(main(['migrate:create', '--name', 'job_applications'])).rejects.toThrow(/Missing or unexpected migration/);
    expect(ports.mkdir).not.toHaveBeenCalled();
    expect(ports.write).not.toHaveBeenCalled();
    expect(ports.spawn).not.toHaveBeenCalled();
  });
  it('generates only from the frozen schema and wraps the result, with no local environment or connection', async () => {
    const final = await actualFs.readFile(candidateUrl, 'utf8');
    let generated = final.slice('BEGIN;\n\n'.length, final.indexOf('\n\n-- Require a date')).concat('\n');
    const diff = generated;
    ports.list.mockResolvedValue(['0001_init_auth', 'migration_lock.toml']);
    ports.read.mockImplementation((path: Parameters<typeof actualFs.readFile>[0], encoding?: 'utf8') => {
      if (String(path).replace(/\\/g, '/').endsWith('0002_job_applications/migration.sql')) return Promise.resolve(encoding ? generated : Buffer.from(generated));
      return encoding ? actualFs.readFile(path, encoding) : actualFs.readFile(path);
    });
    ports.write.mockImplementation((_path: unknown, value: string) => { generated = value; return Promise.resolve(); });
    await withEnvironment({ ...process.env, PRISMA_MIGRATION_TARGET: 'development',
      prisma_migration_target: 'test', PrIsMa_MiGrAtIoN_TaRgEt: 'invalid' },
    () => main(['migrate:create', '--name', 'job_applications']));
    expect(generated).toBe(wrapApplicationDiff(diff));
    expect(sqlDigest(generated)).toBe(migrationChain[1]?.sha256);
    expect(ports.spawn).toHaveBeenCalledTimes(1);
    const [, args, options] = ports.spawn.mock.calls[0]!;
    expect(args).toEqual([expect.stringMatching(/prisma[/\\]build[/\\]index.js$/), 'migrate', 'diff',
      '--from-schema', expect.stringMatching(/baselines[/\\]0001_init_auth.prisma$/),
      '--to-schema', expect.stringMatching(/prisma[/\\]schema.prisma$/), '--script', '--output',
      expect.stringMatching(/0002_job_applications[/\\]migration.sql$/), '--config', expect.stringMatching(/prisma.config.ts$/)]);
    expect(options.env.PRISMA_MIGRATION_TARGET).toBeUndefined();
    expect(selectorKeys(options.env)).toEqual([]);
    expect(ports.load).not.toHaveBeenCalled();
    expect(ports.connect).not.toHaveBeenCalled();
    expect(ports.mkdir).toHaveBeenCalledWith(expect.stringMatching(/0002_job_applications$/), { recursive: false });
    await assertOfflineChildConfiguration(options.env);
  });
  it.each(['0001_init_auth/migration.sql', 'baselines/0001_init_auth.prisma'])('rejects changed protected bytes: %s', async (suffix) => {
    ports.list.mockResolvedValue(['0001_init_auth', 'migration_lock.toml']);
    ports.read.mockImplementation((path: Parameters<typeof actualFs.readFile>[0]) => {
      if (String(path).replace(/\\/g, '/').endsWith(suffix)) return Promise.resolve(Buffer.from('changed'));
      return actualFs.readFile(path);
    });
    await expect(main(['migrate:create', '--name', 'job_applications'])).rejects.toThrow(/bytes changed/);
    expect(ports.mkdir).not.toHaveBeenCalled();
    expect(ports.spawn).not.toHaveBeenCalled();
  });
  it('does not retry a failed engine process or leak its exception', async () => {
    ports.spawn.mockReturnValue({ status: 1, error: new Error('postgresql://private:secret@host/db') });
    await expect(main(['validate'])).rejects.toThrow('Command failed; no reset, retry against another database, or automatic recovery was attempted.');
    expect(ports.spawn).toHaveBeenCalledTimes(1);
    expect(ports.connect).not.toHaveBeenCalled();
  });
});
