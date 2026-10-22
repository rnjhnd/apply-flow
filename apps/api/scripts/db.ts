import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  DatabaseConfigurationError, readComposePasswords, readDatabaseTarget, requireTestDatabaseTarget,
  type DatabaseTargetName
} from '../src/config/database.js';
import { loadLocalEnvironment, localEnvPath } from '../src/config/load-env.js';

const apiRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = resolve(apiRoot, '../..');
const migrationsRoot = join(apiRoot, 'prisma/migrations');
const initialDirectory = join(migrationsRoot, '0001_init_auth');
const sqlPath = join(initialDirectory, 'migration.sql');
const require = createRequire(import.meta.url);

function safeOutput(value: string): string {
  let result = value.replace(/postgres(?:ql)?:\/\/[^\s'"<>]+/gi, '[redacted database URL]');
  for (const key of ['POSTGRES_DEV_PASSWORD', 'POSTGRES_TEST_PASSWORD']) {
    const secret = process.env[key];
    if (secret) result = result.split(secret).join('[redacted]');
  }
  return result;
}

function childEnvironment(target?: DatabaseTargetName): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  // Do not let inherited libpq settings change the target/schema selected by our URL.
  for (const key of Object.keys(environment)) if (key.toUpperCase().startsWith('PG')) delete environment[key];
  delete environment.PRISMA_MIGRATION_TARGET;
  environment.XDG_CACHE_HOME = join(repositoryRoot, '.cache');
  environment.PRISMA_HIDE_UPDATE_MESSAGE = '1';
  if (target) {
    environment.PRISMA_MIGRATION_TARGET = target;
    environment.NODE_ENV = target === 'test' ? 'test' : 'development';
  }
  return environment;
}

function run(executable: string, args: string[], target?: DatabaseTargetName): void {
  const result = spawnSync(executable, args, {
    cwd: apiRoot,
    env: childEnvironment(target),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 180_000,
    windowsHide: true
  });
  if (result.stdout) process.stdout.write(safeOutput(result.stdout));
  if (result.stderr) process.stderr.write(safeOutput(result.stderr));
  if (result.error || result.status !== 0) {
    throw new DatabaseConfigurationError('Command failed; no reset, retry against another database, or automatic recovery was attempted.');
  }
}

function prisma(args: string[], target?: DatabaseTargetName): void {
  run(process.execPath, [require.resolve('prisma/build/index.js'), ...args, '--config', join(apiRoot, 'prisma.config.ts')], target);
}

function compose(args: string[]): void {
  readComposePasswords(process.env);
  if (!existsSync(localEnvPath)) throw new DatabaseConfigurationError('Initialize apps/api/.env before using Compose.');
  run('docker', ['compose', '--env-file', localEnvPath, '--file', join(repositoryRoot, 'compose.yaml'), ...args]);
}

async function initializeEnvironment(): Promise<void> {
  if (existsSync(localEnvPath)) throw new DatabaseConfigurationError('apps/api/.env already exists; it was not modified.');
  for (const key of ['DATABASE_URL', 'TEST_DATABASE_URL', 'POSTGRES_DEV_PASSWORD', 'POSTGRES_TEST_PASSWORD']) {
    if (process.env[key] !== undefined) {
      throw new DatabaseConfigurationError('Database variables are already inherited; configure them deliberately instead of generating conflicting credentials.');
    }
  }
  const devPassword = randomBytes(32).toString('hex');
  const testPassword = randomBytes(32).toString('hex');
  const text = [
    '# Local-only generated credentials. Never commit this file.',
    'NODE_ENV=development', 'HOST=127.0.0.1', 'PORT=3000', 'APP_TIMEZONE=Asia/Manila',
    `POSTGRES_DEV_PASSWORD=${devPassword}`, `POSTGRES_TEST_PASSWORD=${testPassword}`,
    `DATABASE_URL=postgresql://applyflow_dev:${devPassword}@127.0.0.1:15432/applyflow_dev`,
    `TEST_DATABASE_URL=postgresql://applyflow_test:${testPassword}@127.0.0.1:5433/applyflow_test`, ''
  ].join('\n');
  await writeFile(localEnvPath, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  console.info('Created ignored apps/api/.env with independent random database passwords; values were not printed.');
}

async function verifyDatabase(target: DatabaseTargetName): Promise<void> {
  const { openLocalDatabase } = await import('../src/db/client.js');
  const { client, target: checked } = await openLocalDatabase(target, process.env);
  try {
    const tables = await client.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name
    `;
    console.info(JSON.stringify({ target, host: checked.host, port: checked.port, database: checked.database,
      username: checked.username, tables: tables.map((table) => table.table_name) }));
  } finally { await client.$disconnect(); }
}

async function createInitialMigration(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== '--name' || args[1] !== 'init_auth') {
    throw new DatabaseConfigurationError('This initial-only generator requires --name init_auth.');
  }
  const existing = await readdir(migrationsRoot);
  if (existing.some((entry) => entry !== 'migration_lock.toml')) {
    throw new DatabaseConfigurationError('A migration already exists; the initial-only generator will not overwrite or regenerate it.');
  }
  await mkdir(initialDirectory, { recursive: false });
  // No datasource selection, database connection, shadow database, or migration application.
  prisma(['migrate', 'diff', '--from-empty', '--to-schema', join(apiRoot, 'prisma/schema.prisma'), '--script', '--output', sqlPath]);
  if (!existsSync(sqlPath)) {
    throw new DatabaseConfigurationError('Prisma did not produce migration SQL; the empty directory was retained for inspection. No database changes were made.');
  }
  const sql = await readFile(sqlPath, 'utf8');
  if (!sql.trim()) throw new DatabaseConfigurationError('Prisma produced empty SQL; stop for inspection before any approval.');
  console.info(`Generated ${sqlPath}`);
  console.info(`SQL SHA-256: ${createHash('sha256').update(sql).digest('hex')}`);
  console.info('STOP: SQL approval is required before applying either database migration or running persistence integration tests.');
  console.info(sql);
}

async function applyApprovedMigration(target: DatabaseTargetName, args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== '--approved-sql-sha256' || !/^[a-f0-9]{64}$/.test(args[1] ?? '')) {
    throw new DatabaseConfigurationError('SQL approval is required: supply --approved-sql-sha256 only after explicit approval of the generated SQL.');
  }
  const names = await readdir(migrationsRoot);
  if (names.some((entry) => !['0001_init_auth', 'migration_lock.toml'].includes(entry))) {
    throw new DatabaseConfigurationError('Unexpected migrations found; this checkpoint only permits the reviewed initial migration.');
  }
  const sql = await readFile(sqlPath, 'utf8');
  if (createHash('sha256').update(sql).digest('hex') !== args[1]) {
    throw new DatabaseConfigurationError('SQL digest does not match the reviewed migration.');
  }
  if (target === 'test') requireTestDatabaseTarget({ ...process.env, NODE_ENV: 'test' });
  else readDatabaseTarget(target, process.env);
  const { openLocalDatabase } = await import('../src/db/client.js');
  const { client } = await openLocalDatabase(target, process.env);
  try {
    const tables = await client.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const hasHistory = tables.some((table) => table.table_name === '_prisma_migrations');
    if (hasHistory) {
      const history = await client.$queryRaw<Array<{ migration_name: string; checksum: string; finished_at: Date | null; rolled_back_at: Date | null }>>`
        SELECT migration_name, checksum, finished_at, rolled_back_at FROM public._prisma_migrations
      `;
      if (history.length > 1 || history.some((row) => row.migration_name !== '0001_init_auth'
        || row.checksum !== args[1] || !row.finished_at || row.rolled_back_at)) {
        throw new DatabaseConfigurationError('Conflicting or incomplete migration history found; stop for review.');
      }
      if (history.length === 1) {
        const expectedTables = ['_prisma_migrations', 'User', 'Session'];
        if (tables.length !== expectedTables.length || tables.some((table) => !expectedTables.includes(table.table_name))) {
          throw new DatabaseConfigurationError('Applied schema has unexpected tables; stop for review.');
        }
        console.info('The reviewed initial migration is already applied; no changes made.');
        return;
      }
    }
    if (tables.some((table) => table.table_name !== '_prisma_migrations')) {
      throw new DatabaseConfigurationError('Existing application tables found; stop for review rather than resetting or baselining.');
    }
  } finally { await client.$disconnect(); }
  prisma(['migrate', 'deploy'], target);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  // Offline builds may set NODE_ENV=production; they must never select a datasource.
  if (command === 'generate' || command === 'validate') {
    if (args.length) throw new DatabaseConfigurationError('Unexpected arguments.');
    prisma([command]);
    return;
  }
  if (process.env.NODE_ENV && !['development', 'test'].includes(process.env.NODE_ENV)) {
    throw new DatabaseConfigurationError('This checkpoint provides local database tooling only.');
  }
  if (command === 'env:init') {
    if (args.length) throw new DatabaseConfigurationError('Unexpected arguments.');
    await initializeEnvironment();
    return;
  }
  loadLocalEnvironment();
  if (process.env.NODE_ENV && !['development', 'test'].includes(process.env.NODE_ENV)) {
    throw new DatabaseConfigurationError('This checkpoint provides local database tooling only.');
  }
  if (command === 'migrate:create') return createInitialMigration(args);
  if (command === 'migrate:deploy') return applyApprovedMigration('development', args);
  if (command === 'migrate:test') return applyApprovedMigration('test', args);
  if (args.length) throw new DatabaseConfigurationError('Unexpected arguments.');
  switch (command) {
    case 'compose:validate': compose(['--profile', 'test', 'config', '--quiet']); break;
    case 'up': compose(['up', '--detach', '--wait', '--wait-timeout', '90', '--no-recreate', 'postgres-dev']); break;
    case 'test:up': compose(['--profile', 'test', 'up', '--detach', '--wait', '--wait-timeout', '90', '--no-recreate', 'postgres-test']); break;
    case 'stop': compose(['--profile', 'test', 'stop', 'postgres-dev', 'postgres-test']); break;
    case 'verify': await verifyDatabase('development'); await verifyDatabase('test'); break;
    default: throw new DatabaseConfigurationError('Unknown database command.');
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof DatabaseConfigurationError ? error.message : 'Database tooling failed; no automatic reset or cleanup was attempted.');
  process.exitCode = 1;
});
