import { readFile } from 'node:fs/promises';
import type * as Fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertApprovedChain, assertDeploymentApproval, baselineChecksum, initialChecksum, historyChecksum, migrationChain,
  applicationBaselineChecksum, applicationChecksum, historyBaselineChecksum, lifecycleChecksum, lifecycleDiff,
  sqlDigest, statusHistoryDiff,
  validateMigrationDirectory, validateMigrationHistory, validateMigrationTables,
  verifyMigrationFiles, wrapApplicationDiff, wrapStatusHistoryDiff, wrapLifecycleDiff, type MigrationSpec } from './migration-policy.js';

const files = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof Fs>(), readFile: files.read, readdir: files.list }));
const actualFs = await vi.importActual<typeof Fs>('node:fs/promises');
beforeEach(() => {
  files.read.mockReset().mockImplementation(actualFs.readFile);
  files.list.mockReset().mockImplementation(actualFs.readdir);
});

describe('version/history schema foundation without a database', () => {
  const historySql = () => readFile(new URL('../prisma/migrations/0003_application_status_history/migration.sql', import.meta.url), 'utf8');
  it('recognizes source approval only with the exact fourth checksum and completed history', () => {
    expect(migrationChain.slice(0, 3).every(entry => entry.approval === 'APPROVED')).toBe(true);
    expect(() => assertApprovedChain()).not.toThrow();
    expect(() => assertDeploymentApproval(['--approved-sql-sha256', lifecycleChecksum])).not.toThrow();
    expect(validateMigrationHistory(rows())).toBe(4);
    expect(() => assertDeploymentApproval(['--approved-sql-sha256', historyChecksum], approved)).toThrow('exact fourth');
    expect(() => validateMigrationHistory(rows().slice(0, 3), { chain: approved })).toThrow('Missing or extra');
  });
  it('rejects substituted old and new pinned digests, even in an approved fixture', () => {
    for (const index of [0, 1, 2, 3]) {
      const changed = approved.map((entry, i) => i === index ? { ...entry, sha256: 'f'.repeat(64) } : entry);
      expect(() => assertApprovedChain(changed)).toThrow('Unexpected migration-chain');
    }
    expect(() => assertDeploymentApproval(['--approved-sql-sha256', applicationChecksum], approved)).toThrow('exact fourth');
  });
  it('pins the full pre-version schema and leaves authentication model definitions intact', async () => {
    const previous = await readFile(new URL('../prisma/baselines/0002_job_applications.prisma', import.meta.url), 'utf8');
    const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    expect(sqlDigest(previous)).toBe(applicationBaselineChecksum);
    for (const name of ['User', 'Session']) {
      const model = new RegExp(`model ${name} \\{[\\s\\S]*?\\n\\}`);
      expect(schema.replace(/\r\n/g, '\n').match(model)?.[0]).toBe(previous.match(model)?.[0]);
    }
    expect(schema).toMatch(/version\s+Int\s+@default\(1\)/);
    const history = schema.slice(schema.indexOf('model ApplicationStatusHistory'));
    expect(history).toMatch(/id\s+String\s+@id @default\(uuid\(\)\) @db.Uuid/);
    expect(history).toMatch(/applicationId\s+String\s+@db.Uuid/);
    expect(history).toMatch(/changedAt\s+DateTime\s+@default\(now\(\)\) @db.Timestamptz\(3\)/);
    expect(history).toContain('@@unique([applicationId, applicationVersion])');
    expect(history).toContain('onDelete: Restrict');
    expect(history).not.toMatch(/userId|actorId|metadata/);
  });
  it('matches the exact offline diff plus three CHECKs with no backfill/data statements', async () => {
    const sql = await historySql();
    const raw = sql.slice('BEGIN;\n\n'.length, sql.indexOf('\n\n-- Foundation constraints'));
    expect(wrapStatusHistoryDiff(raw)).toBe(sql);
    expect(sqlDigest(sql)).toBe(historyChecksum);
    expect(sql).toContain('"version" INTEGER NOT NULL DEFAULT 1');
    expect(sql).toContain('CHECK ("version" > 0)');
    expect(sql).toContain('CHECK ("fromStatus" <> "toStatus")');
    expect(sql).toContain('CHECK ("applicationVersion" >= 2)');
    expect(sql).toContain('ON DELETE RESTRICT ON UPDATE CASCADE');
    expect(sql).not.toMatch(/\b(?:INSERT|DELETE|TRUNCATE|DROP)\b(?! RESTRICT)/);
    expect(sql).not.toMatch(/\bUPDATE\b(?! CASCADE)/);
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.endsWith('COMMIT;\n')).toBe(true);
  });
  it.each([
    statusHistoryDiff + '\nUPDATE "JobApplication" SET version = 1;',
    statusHistoryDiff.replace('DEFAULT 1', 'DEFAULT 2'),
    statusHistoryDiff.replace('ON DELETE RESTRICT', 'ON DELETE CASCADE'),
    statusHistoryDiff.replace('CREATE UNIQUE INDEX', 'CREATE INDEX'),
    statusHistoryDiff.replace('"fromStatus" "ApplicationStatus" NOT NULL', '"fromStatus" TEXT'),
    statusHistoryDiff + '\nCREATE TABLE "Other" (id INT);',
    statusHistoryDiff + '\nINSERT INTO "ApplicationStatusHistory" DEFAULT VALUES;'
  ])('rejects unapproved diff operations or definitions %#', sql => {
    expect(() => wrapStatusHistoryDiff(sql)).toThrow('Unexpected history diff');
  });
  it('requires the exact third directory and table inventory without widening old prefixes', () => {
    const prefix = ['0001_init_auth', '0002_job_applications', 'migration_lock.toml'];
    expect(() => validateMigrationDirectory(prefix, 2)).not.toThrow();
    expect(() => validateMigrationDirectory([...prefix, '0003_application_status_history'], 3)).not.toThrow();
    expect(() => validateMigrationDirectory(prefix, 3)).toThrow();
    expect(() => validateMigrationDirectory([...prefix, '0003_application_status_history'], 2)).toThrow();
    const tables = ['User', 'Session', '_prisma_migrations', 'JobApplication', 'ApplicationStatusHistory'];
    expect(() => validateMigrationTables(tables, 3)).not.toThrow();
    expect(() => validateMigrationTables(tables, 2)).toThrow();
    expect(() => validateMigrationTables(tables.slice(0, 4), 3)).toThrow();
  });
  it.each(['baselines/0001_init_auth.prisma', 'baselines/0002_job_applications.prisma',
    'baselines/0003_application_status_history.prisma'])('refuses changed baseline bytes: %s', async suffix => {
    files.read.mockImplementation(async (path: Parameters<typeof actualFs.readFile>[0]) => {
      const bytes = await actualFs.readFile(path);
      return String(path).replace(/\\/g, '/').endsWith(suffix) ? Buffer.concat([bytes, Buffer.from('changed')]) : bytes;
    });
    await expect(verifyMigrationFiles()).rejects.toThrow(/baseline/);
  });
});

// Retain pending-state coverage after source approval using an explicit fixture.
const approved: readonly MigrationSpec[] = migrationChain;
const pending: readonly MigrationSpec[] = migrationChain.map(entry => entry.name === '0004_application_lifecycle'
  ? { ...entry, approval: 'REVIEW_PENDING' as const } : entry);
const rows = () => approved.map((entry, index) => ({ migration_name: entry.name, checksum: entry.sha256,
  started_at: new Date(1000 + index * 2000), finished_at: new Date(2000 + index * 2000),
  rolled_back_at: null, applied_steps_count: 1, logs: null }));
const readSql = () => readFile(new URL('../prisma/migrations/0002_job_applications/migration.sql', import.meta.url), 'utf8');
function unwrap(sql: string) { return sql.slice('BEGIN;\n\n'.length, sql.indexOf('\n\n-- Require a date')).concat('\n'); }

describe('nullable archive foundation without a database', () => {
  it('freezes the full pre-archive schema and adds only the nullable timestamp', async () => {
    const previous = await readFile(new URL('../prisma/baselines/0003_application_status_history.prisma', import.meta.url), 'utf8');
    const schema = (await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
    expect(sqlDigest(previous)).toBe(historyBaselineChecksum);
    const archiveField = '  archivedAt      DateTime?         @db.Timestamptz(3)\n';
    expect(schema.split(archiveField)).toHaveLength(2);
    expect(schema.replace(archiveField, '')).toBe(previous);
    expect(schema.slice(schema.indexOf('model JobApplication'), schema.indexOf('model ApplicationStatusHistory'))).toContain(archiveField);
  });
  it('pins exactly the one-column transactional migration with no data backfill', async () => {
    const sql = await readFile(new URL('../prisma/migrations/0004_application_lifecycle/migration.sql', import.meta.url), 'utf8');
    const raw = sql.slice('BEGIN;\n\n'.length, -'\n\nCOMMIT;\n'.length);
    expect(wrapLifecycleDiff(raw)).toBe(sql);
    expect(sqlDigest(sql)).toBe(lifecycleChecksum);
    expect(sql).toBe('BEGIN;\n\n-- AlterTable\nALTER TABLE "JobApplication" ADD COLUMN     "archivedAt" TIMESTAMPTZ(3);\n\nCOMMIT;\n');
    expect(sql).not.toMatch(/\b(?:DEFAULT|NOT NULL|INSERT|UPDATE|DELETE|DROP|TRUNCATE|INDEX|REFERENCES)\b/);
  });
  it.each([
    lifecycleDiff.replace('TIMESTAMPTZ(3)', 'TIMESTAMP(3)'),
    lifecycleDiff.replace('TIMESTAMPTZ(3)', 'TIMESTAMPTZ(6)'),
    lifecycleDiff.replace('TIMESTAMPTZ(3)', 'TIMESTAMPTZ(3) NOT NULL'),
    lifecycleDiff.replace('TIMESTAMPTZ(3)', 'TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP'),
    lifecycleDiff.replace('archivedAt', 'deletedAt'),
    lifecycleDiff.replace('JobApplication', 'User'),
    lifecycleDiff + '\nUPDATE "JobApplication" SET "archivedAt" = now();',
    lifecycleDiff + '\nDELETE FROM "ApplicationStatusHistory";',
    lifecycleDiff + '\nDROP TABLE "Session";',
    lifecycleDiff + '\nCREATE INDEX "other" ON "JobApplication" ("archivedAt");',
    lifecycleDiff + '\n' + lifecycleDiff,
    ''
  ])('rejects any broader or changed archive diff %#', sql => {
    expect(() => wrapLifecycleDiff(sql)).toThrow('Unexpected lifecycle diff');
  });
  it('requires the exact fourth directory while retaining the three-migration schema inventory', () => {
    const prefix = ['migration_lock.toml', ...migrationChain.slice(0, 3).map(entry => entry.name)];
    expect(() => validateMigrationDirectory(prefix, 3)).not.toThrow();
    expect(() => validateMigrationDirectory(prefix, 4)).toThrow();
    expect(() => validateMigrationDirectory([...prefix, '0004_application_lifecycle'], 4)).not.toThrow();
    expect(() => validateMigrationDirectory([...prefix, '0004_application_lifecycle'], 3)).toThrow();
    const tables = ['User', 'Session', '_prisma_migrations', 'JobApplication', 'ApplicationStatusHistory'];
    expect(() => validateMigrationTables(tables, 4)).not.toThrow();
    expect(() => validateMigrationTables([...tables, 'Other'], 4)).toThrow();
    expect(() => validateMigrationTables(tables.slice(0, -1), 4)).toThrow();
  });
  it.each([{ finished_at: null }, { checksum: 'f'.repeat(64) }, { rolled_back_at: new Date() },
    { started_at: new Date(1), finished_at: new Date(2) }, { applied_steps_count: 0 }, { logs: 'failed' }])(
    'rejects invalid fourth metadata after the completed three-migration prefix %#', change => {
      const history = rows().map((row, index) => index === 3 ? { ...row, ...change } : row);
      expect(() => validateMigrationHistory(history, { chain: approved, allowInitialPrefix: true })).toThrow();
    });
});

describe('exact source-approved migration chain', () => {
  it('pins only the reviewed names and bytes in the immutable source manifest', async () => {
    await verifyMigrationFiles();
    expect(sqlDigest(await readFile(new URL('../prisma/migrations/0001_init_auth/migration.sql', import.meta.url)))).toBe(initialChecksum);
    expect(sqlDigest(await readFile(new URL('../prisma/baselines/0001_init_auth.prisma', import.meta.url)))).toBe(baselineChecksum);
    expect(migrationChain).toEqual([
      { name: '0001_init_auth', sha256: '98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840', approval: 'APPROVED' },
      { name: '0002_job_applications', sha256: '74e056f699c2781c01f12d3195ed119074d5b0d4d04fef979c185e17d775a333', approval: 'APPROVED' },
      { name: '0003_application_status_history', sha256: historyChecksum, approval: 'APPROVED' },
      { name: '0004_application_lifecycle', sha256: lifecycleChecksum, approval: 'APPROVED' }
    ]);
    expect(Object.isFrozen(migrationChain)).toBe(true);
    expect(migrationChain.every(Object.isFrozen)).toBe(true);
  });
  it('preserves pending-state rejection using an explicit pending fixture', () => {
    expect(() => assertApprovedChain(pending)).toThrow('REVIEW_PENDING');
    expect(() => assertDeploymentApproval(['--approved-sql-sha256', migrationChain[2]!.sha256!], pending)).toThrow('REVIEW_PENDING');
    expect(() => validateMigrationHistory(rows(), { chain: pending })).toThrow('REVIEW_PENDING');
  });
  it('does not normalize SQL bytes before hashing', async () => {
    const sql = await readSql();
    expect(sqlDigest(sql.replace(/\n/g, '\r\n'))).not.toBe(migrationChain[1]?.sha256);
    expect(sqlDigest(sql + '\n')).not.toBe(migrationChain[1]?.sha256);
  });
  it.each([[], ['--approved-sql-sha256'], ['--approved-sql-sha256', initialChecksum],
    ['--approved-sql-sha256', 'f'.repeat(64)], ['--approved-sql-sha256', migrationChain[1]!.sha256!, '--force']]
    .map((args) => ({ args })))('rejects wrong approval arguments %#', ({ args }) => {
    expect(() => assertDeploymentApproval(args, approved)).toThrow();
  });
  it('requires the exact fourth digest after separate source approval', () => {
    expect(() => assertDeploymentApproval(['--approved-sql-sha256', approved[3]!.sha256!], approved)).not.toThrow();
    for (const entry of approved.slice(0, 3)) {
      expect(() => assertDeploymentApproval(['--approved-sql-sha256', entry.sha256!], approved)).toThrow('exact fourth');
    }
  });
  it.each(['0001_init_auth', '0002_job_applications', '0003_application_status_history',
    '0004_application_lifecycle'])('rejects altered %s bytes without writing files', async (name) => {
    files.read.mockImplementation(async (path: Parameters<typeof actualFs.readFile>[0]) => {
      const bytes = await actualFs.readFile(path);
      return String(path).replace(/\\/g, '/').endsWith(`${name}/migration.sql`)
        ? Buffer.concat([bytes, Buffer.from('\n-- Unreviewed bytes\n')]) : bytes;
    });
    await expect(verifyMigrationFiles()).rejects.toThrow('Local migration bytes do not match the pinned digest.');
  });
  it('rejects an unrecognized local migration even after exact source approval', async () => {
    const entries = await actualFs.readdir(new URL('../prisma/migrations/', import.meta.url), { withFileTypes: true });
    files.list.mockResolvedValue([...entries, { name: '0003_unapproved' }]);
    await expect(verifyMigrationFiles()).rejects.toThrow('Missing or unexpected migration files');
  });
  it.each([[], [...approved].reverse(), [...approved, approved[1]!],
    approved.map((entry, index) => index === 1 ? { ...entry, sha256: null } : entry),
    approved.map((entry, index) => index === 1 ? { ...entry, sha256: 'x' } : entry),
    approved.map((entry, index) => index === 0 ? { ...entry, sha256: 'a'.repeat(64) } : entry)]
    .map((chain) => ({ chain })))('rejects invalid chain definition %#', ({ chain }) => {
    expect(() => assertApprovedChain(chain)).toThrow();
  });
  it('accepts only the exact current prefix for future transition, and the full chain for integration', () => {
    expect(validateMigrationHistory(rows().slice(0, 1), { chain: approved, allowInitialPrefix: true })).toBe(1);
    expect(() => validateMigrationHistory(rows().slice(0, 1), { chain: approved })).toThrow();
    expect(validateMigrationHistory(rows().slice(0, 2), { chain: approved, allowInitialPrefix: true })).toBe(2);
    expect(() => validateMigrationHistory(rows().slice(0, 2), { chain: approved })).toThrow();
    expect(validateMigrationHistory(rows().slice(0, 3), { chain: approved, allowInitialPrefix: true })).toBe(3);
    expect(() => validateMigrationHistory(rows().slice(0, 3), { chain: approved })).toThrow();
    expect(validateMigrationHistory(rows(), { chain: approved })).toBe(4);
    expect(validateMigrationHistory(rows().reverse(), { chain: approved })).toBe(4);
  });
  it.each([
    [], rows().slice(1), [rows()[0], rows()[0]], [...rows(), rows()[1]],
    rows().map((row, index) => index === 1 ? { ...row, migration_name: '0003_unknown' } : row),
    rows().map((row, index) => index === 1 ? { ...row, checksum: 'f'.repeat(64) } : row),
    rows().map((row, index) => index === 0 ? { ...row, checksum: 'f'.repeat(64) } : row),
    rows().map((row, index) => index === 1 ? { ...row, started_at: new Date(1), finished_at: new Date(2) } : row)
  ].map((history) => ({ history })))('rejects missing, duplicate, extra, conflicting or reordered history %#', ({ history }) => {
    expect(() => validateMigrationHistory(history, { chain: approved, allowInitialPrefix: true })).toThrow();
  });
  it.each([{ finished_at: null }, { rolled_back_at: new Date() }, { started_at: new Date(NaN) },
    { finished_at: new Date(0) }, { applied_steps_count: 0 }, { logs: 'failed SQL' }, { unexpected: 'secret' }])('rejects malformed/incomplete history %#', (change) => {
    const history = rows();
    expect(() => validateMigrationHistory(history.map((row, index) => index === 1 ? { ...row, ...change } : row), { chain: approved })).toThrow();
  });
  it.each([{ finished_at: null }, { checksum: 'f'.repeat(64) }, { rolled_back_at: new Date() },
    { started_at: new Date(1), finished_at: new Date(2) }, { applied_steps_count: 0 }, { logs: 'failed' }])(
    'rejects invalid third-migration metadata even after a valid prefix %#', change => {
      const history = rows().map((row, index) => index === 2 ? { ...row, ...change } : row);
      expect(() => validateMigrationHistory(history, { chain: approved, allowInitialPrefix: true })).toThrow();
    }
  );
  it('requires exact directory contents for generation and verification', () => {
    expect(() => validateMigrationDirectory(['0001_init_auth', 'migration_lock.toml'], false)).not.toThrow();
    expect(() => validateMigrationDirectory(['0002_job_applications', '0001_init_auth', 'migration_lock.toml'], true)).not.toThrow();
    for (const names of [[], ['migration_lock.toml'], ['0001_init_auth', 'migration_lock.toml', 'unknown'],
      ['0001_init_auth', '0001_init_auth', 'migration_lock.toml']]) expect(() => validateMigrationDirectory(names, true)).toThrow();
    expect(() => validateMigrationDirectory(['0001_init_auth', '0002_job_applications', 'migration_lock.toml'], false)).toThrow();
  });
  it('checks prefix and full-chain table inventories without tolerating extras', () => {
    const initial = ['User', 'Session', '_prisma_migrations'];
    expect(() => validateMigrationTables(initial, 1)).not.toThrow();
    expect(() => validateMigrationTables([...initial, 'JobApplication'], 2)).not.toThrow();
    expect(() => validateMigrationTables(initial, 2)).toThrow();
    expect(() => validateMigrationTables([...initial, 'JobApplication'], 1)).toThrow();
    expect(() => validateMigrationTables([...initial, 'JobApplication', 'foreign_table'], 2)).toThrow();
    expect(() => validateMigrationTables([...initial, 'User'], 2)).toThrow();
  });
});

describe('additive application migration expectations', () => {
  it('is exactly the offline diff plus transaction boundaries and the named CHECK', async () => {
    const sql = await readSql();
    expect(wrapApplicationDiff(unwrap(sql))).toBe(sql);
    expect(sql.startsWith('BEGIN;\n')).toBe(true);
    expect(sql.endsWith('COMMIT;\n')).toBe(true);
    expect(sql).toContain('"JobApplication_applicationDate_required_check"\nCHECK ("status" = \'SAVED\' OR "applicationDate" IS NOT NULL)');
    expect(sql).toContain('ON DELETE RESTRICT ON UPDATE CASCADE');
    expect(sql).toContain('("userId", "createdAt" DESC, "id" DESC)');
    expect(sql).toContain("('SAVED', 'APPLIED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN')");
    for (const column of ['"id" UUID NOT NULL', '"userId" UUID NOT NULL', '"company" VARCHAR(160) NOT NULL',
      '"jobTitle" VARCHAR(200) NOT NULL', '"applicationDate" DATE', '"location" VARCHAR(200)',
      '"jobUrl" VARCHAR(2048)', '"notes" TEXT', '"createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP',
      '"updatedAt" TIMESTAMPTZ(3) NOT NULL']) expect(sql).toContain(column);
    expect(sql).not.toContain('UNIQUE');
    expect(sql).not.toMatch(/(?:ALTER|DROP) TABLE "(?:User|Session)"/);
  });
  it('preserves the frozen auth models and generates UUIDs/timestamps through Prisma', async () => {
    const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
    const baseline = await readFile(new URL('../prisma/baselines/0001_init_auth.prisma', import.meta.url), 'utf8');
    const normalized = schema.replace(/\r\n/g, '\n').replace(/^[ \t]*applications JobApplication\[\]\n/m, '');
    expect(normalized.startsWith(baseline)).toBe(true);
    const application = schema.slice(schema.indexOf('model JobApplication'));
    expect(application).toMatch(/id\s+String\s+@id @default\(uuid\(\)\) @db.Uuid/);
    expect(application).toMatch(/updatedAt\s+DateTime\s+@updatedAt @db.Timestamptz\(3\)/);
    expect(application).toContain('onDelete: Restrict');
    expect(application).toContain('@@index([userId, createdAt(sort: Desc), id(sort: Desc)])');
  });
  it.each(['DROP TABLE "User";', 'TRUNCATE "Session";', 'DELETE FROM "User";', 'INSERT INTO "User" VALUES (1);',
    'ALTER TABLE "User" ADD COLUMN "x" TEXT;', 'UPDATE "Session" SET "userId" = NULL;', 'CREATE TABLE "Other" (id INT);'])('rejects forbidden extra operation %s', async (operation) => {
    const raw = unwrap(await readSql());
    expect(() => wrapApplicationDiff(raw + operation)).toThrow();
  });
});
