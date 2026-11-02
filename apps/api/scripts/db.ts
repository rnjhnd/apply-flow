import { randomBytes } from 'node:crypto';
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
import { assertDeploymentApproval, applicationBaselineChecksum, applicationChecksum, baselineChecksum, initialChecksum, migrationChain,
  sqlDigest, validateMigrationDirectory, validateMigrationHistory, validateMigrationTables,
  verifyMigrationFiles, wrapApplicationDiff, wrapStatusHistoryDiff, wrapLifecycleDiff,
  type MigrationCount, type MigrationHistoryRow } from './migration-policy.js';

const apiRoot = fileURLToPath(new URL('../', import.meta.url));
const repositoryRoot = resolve(apiRoot, '../..');
const migrationsRoot = join(apiRoot, 'prisma/migrations');
const applicationDirectory = join(migrationsRoot, '0002_job_applications');
const sqlPath = join(applicationDirectory, 'migration.sql');
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
  // Copied records are case-sensitive even on Windows. Remove every inherited
  // selector before setting a deliberate target; offline children receive none.
  for (const key of Object.keys(environment)) {
    const normalized = key.toUpperCase();
    if (normalized.startsWith('PG') || normalized === 'PRISMA_MIGRATION_TARGET') delete environment[key];
  }
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

async function createApplicationMigration(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== '--name' || args[1] !== 'job_applications') {
    throw new DatabaseConfigurationError('This offline generator requires --name job_applications.');
  }
  const existing = await readdir(migrationsRoot);
  validateMigrationDirectory(existing, false);
  const initial = await readFile(join(migrationsRoot, '0001_init_auth/migration.sql'));
  const baselinePath = join(apiRoot, 'prisma/baselines/0001_init_auth.prisma');
  if (sqlDigest(initial) !== initialChecksum || sqlDigest(await readFile(baselinePath)) !== baselineChecksum) {
    throw new DatabaseConfigurationError('Initial migration or frozen schema bytes changed; generation refused.');
  }
  await mkdir(applicationDirectory, { recursive: false });
  // No datasource selection, database connection, shadow database, or migration application.
  prisma(['migrate', 'diff', '--from-schema', baselinePath, '--to-schema', join(apiRoot, 'prisma/schema.prisma'), '--script', '--output', sqlPath]);
  if (!existsSync(sqlPath)) {
    throw new DatabaseConfigurationError('Prisma did not produce migration SQL; the empty directory was retained for inspection. No database changes were made.');
  }
  const sql = wrapApplicationDiff(await readFile(sqlPath, 'utf8'));
  await writeFile(sqlPath, sql, { encoding: 'utf8', flag: 'w' });
  console.info(`Generated ${sqlPath}`);
  console.info(`SQL SHA-256: ${sqlDigest(await readFile(sqlPath))}`);
  console.info('REVIEW_PENDING: Pin this candidate digest, then STOP for separate SQL approval before deployment or integration tests.');
  console.info(sql);
}

async function createStatusHistoryMigration(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== '--name' || args[1] !== 'application_status_history') {
    throw new DatabaseConfigurationError('This offline generator requires --name application_status_history.');
  }
  validateMigrationDirectory(await readdir(migrationsRoot), 2);
  const baselinePath = join(apiRoot, 'prisma/baselines/0002_job_applications.prisma');
  if (sqlDigest(await readFile(join(migrationsRoot, '0001_init_auth/migration.sql'))) !== initialChecksum
    || sqlDigest(await readFile(join(migrationsRoot, '0002_job_applications/migration.sql'))) !== applicationChecksum
    || sqlDigest(await readFile(join(apiRoot, 'prisma/baselines/0001_init_auth.prisma'))) !== baselineChecksum
    || sqlDigest(await readFile(baselinePath)) !== applicationBaselineChecksum) {
    throw new DatabaseConfigurationError('Protected migration or baseline bytes changed; generation refused.');
  }
  const directory = join(migrationsRoot, '0003_application_status_history');
  const output = join(directory, 'migration.sql');
  await mkdir(directory, { recursive: false });
  prisma(['migrate', 'diff', '--from-schema', baselinePath, '--to-schema', join(apiRoot, 'prisma/schema.prisma'), '--script', '--output', output]);
  if (!existsSync(output)) throw new DatabaseConfigurationError('Offline history diff output missing; no retry or cleanup attempted.');
  const sql = wrapStatusHistoryDiff(await readFile(output, 'utf8'));
  await writeFile(output, sql, { encoding: 'utf8', flag: 'w' });
  console.info(`Generated ${output}`);
  console.info(`SQL SHA-256: ${sqlDigest(await readFile(output))}`);
  console.info('REVIEW_PENDING: Separate approval of the exact SQL is required before any deployment or integration run.');
  console.info(sql);
}

async function createLifecycleMigration(args: string[]): Promise<void> {
  if (args.length !== 2 || args[0] !== '--name' || args[1] !== 'application_lifecycle') {
    throw new DatabaseConfigurationError('This offline generator requires --name application_lifecycle.');
  }
  // File verification deliberately permits REVIEW_PENDING; execution approval
  // is a separate guard. The exact three-migration prefix forbids overwrites.
  await verifyMigrationFiles(3);
  const baselinePath = join(apiRoot, 'prisma/baselines/0003_application_status_history.prisma');
  const directory = join(migrationsRoot, '0004_application_lifecycle');
  const output = join(directory, 'migration.sql');
  await mkdir(directory, { recursive: false });
  prisma(['migrate', 'diff', '--from-schema', baselinePath, '--to-schema', join(apiRoot, 'prisma/schema.prisma'), '--script', '--output', output]);
  if (!existsSync(output)) throw new DatabaseConfigurationError('Offline lifecycle diff output missing; no retry or cleanup attempted.');
  const sql = wrapLifecycleDiff(await readFile(output, 'utf8'));
  await writeFile(output, sql, { encoding: 'utf8', flag: 'w' });
  console.info(`Generated ${output}`);
  console.info(`SQL SHA-256: ${sqlDigest(await readFile(output))}`);
  console.info('REVIEW_PENDING: Separate approval of the exact SQL is required before any deployment or integration run.');
  console.info(sql);
}

async function inspectMigrationState(target: DatabaseTargetName): Promise<MigrationCount> {
  const { openLocalDatabase } = await import('../src/db/client.js');
  const { client } = await openLocalDatabase(target, process.env);
  try {
    const tables = await client.$queryRaw<Array<{ table_name: string }>>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    `;
    const hasHistory = tables.some((table) => table.table_name === '_prisma_migrations');
    if (!hasHistory) throw new DatabaseConfigurationError('Missing approved initial migration history; no reset or baseline adoption is permitted.');
    const history = await client.$queryRaw<MigrationHistoryRow[]>`
      SELECT migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count, logs
      FROM public._prisma_migrations
    `;
    const count = validateMigrationHistory(history, { allowInitialPrefix: true });
    validateMigrationTables(tables.map((table) => table.table_name), count);
    return count;
  } finally { await client.$disconnect(); }
}

async function applyApprovedMigration(target: DatabaseTargetName, args: string[]): Promise<void> {
  assertDeploymentApproval(args);
  await verifyMigrationFiles();
  if (target === 'test') requireTestDatabaseTarget(process.env);
  else readDatabaseTarget(target, process.env);
  const before = await inspectMigrationState(target);
  if (before === migrationChain.length) {
    console.info('The exact reviewed migration chain is already applied; no changes made.');
    return;
  }
  if (before !== 3) {
    throw new DatabaseConfigurationError('Fourth migration deployment requires exactly the completed 0001 + 0002 + 0003 prefix; no earlier migration is authorized by this checksum.');
  }
  await verifyMigrationFiles();
  prisma(['migrate', 'deploy'], target);
  if (await inspectMigrationState(target) !== migrationChain.length) {
    throw new DatabaseConfigurationError('Migration completion was not verified; stop for review without retry.');
  }
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  // Offline builds may set NODE_ENV=production; they must never select a datasource.
  if (command === 'generate' || command === 'validate') {
    if (args.length) throw new DatabaseConfigurationError('Unexpected arguments.');
    prisma([command]);
    return;
  }
  if (command === 'migrate:create') {
    if (args[1] === 'application_lifecycle') return createLifecycleMigration(args);
    return args[1] === 'application_status_history' ? createStatusHistoryMigration(args) : createApplicationMigration(args);
  }
  // Approval denial must precede environment loading and all live construction.
  if (command === 'migrate:deploy' || command === 'migrate:test') assertDeploymentApproval(args);
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

if (import.meta.main) void main().catch((error: unknown) => {
  console.error(error instanceof DatabaseConfigurationError ? error.message : 'Database tooling failed; no automatic reset or cleanup was attempted.');
  process.exitCode = 1;
});
