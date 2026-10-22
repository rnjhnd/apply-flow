import { readFile } from 'node:fs/promises';
import type * as Fs from 'node:fs/promises';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { assertApprovedChain, assertDeploymentApproval, baselineChecksum, initialChecksum, migrationChain,
  sqlDigest, validateMigrationDirectory, validateMigrationHistory, validateMigrationTables,
  verifyMigrationFiles, wrapApplicationDiff, type MigrationSpec } from './migration-policy.js';

const files = vi.hoisted(() => ({ read: vi.fn(), list: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({ ...await original<typeof Fs>(), readFile: files.read, readdir: files.list }));
const actualFs = await vi.importActual<typeof Fs>('node:fs/promises');
beforeEach(() => {
  files.read.mockReset().mockImplementation(actualFs.readFile);
  files.list.mockReset().mockImplementation(actualFs.readdir);
});

const approved: readonly MigrationSpec[] = migrationChain;
const pending: readonly MigrationSpec[] = migrationChain.map((entry) => entry.name === '0002_job_applications'
  ? { ...entry, approval: 'REVIEW_PENDING' } : entry);
const rows = () => approved.map((entry, index) => ({ migration_name: entry.name, checksum: entry.sha256,
  started_at: new Date(1000 + index * 2000), finished_at: new Date(2000 + index * 2000),
  rolled_back_at: null, applied_steps_count: 1, logs: null }));
const readSql = () => readFile(new URL('../prisma/migrations/0002_job_applications/migration.sql', import.meta.url), 'utf8');
function unwrap(sql: string) { return sql.slice('BEGIN;\n\n'.length, sql.indexOf('\n\n-- Require a date')).concat('\n'); }

describe('exact source-approved migration chain', () => {
  it('pins only the reviewed names and bytes in the immutable source manifest', async () => {
    await verifyMigrationFiles();
    expect(sqlDigest(await readFile(new URL('../prisma/migrations/0001_init_auth/migration.sql', import.meta.url)))).toBe(initialChecksum);
    expect(sqlDigest(await readFile(new URL('../prisma/baselines/0001_init_auth.prisma', import.meta.url)))).toBe(baselineChecksum);
    expect(migrationChain).toEqual([
      { name: '0001_init_auth', sha256: '98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840', approval: 'APPROVED' },
      { name: '0002_job_applications', sha256: '74e056f699c2781c01f12d3195ed119074d5b0d4d04fef979c185e17d775a333', approval: 'APPROVED' }
    ]);
    expect(Object.isFrozen(migrationChain)).toBe(true);
    expect(migrationChain.every(Object.isFrozen)).toBe(true);
  });
  it('preserves pending-state rejection using an explicit pending fixture', () => {
    expect(() => assertApprovedChain(pending)).toThrow('REVIEW_PENDING');
    expect(() => assertDeploymentApproval(['--approved-sql-sha256', migrationChain[1]!.sha256!], pending)).toThrow('REVIEW_PENDING');
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
  it('requires the exact digest of the separately approved second migration', () => {
    expect(() => assertDeploymentApproval(['--approved-sql-sha256', approved[1]!.sha256!])).not.toThrow();
  });
  it.each(['0001_init_auth', '0002_job_applications'])('rejects altered %s bytes without writing files', async (name) => {
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
    [approved[0]!, { ...approved[1]!, sha256: null }], [approved[0]!, { ...approved[1]!, sha256: 'x' }],
    [{ ...approved[0]!, sha256: 'a'.repeat(64) }, approved[1]!]]
    .map((chain) => ({ chain })))('rejects invalid chain definition %#', ({ chain }) => {
    expect(() => assertApprovedChain(chain)).toThrow();
  });
  it('accepts only the exact current prefix for future transition, and the full chain for integration', () => {
    expect(validateMigrationHistory(rows().slice(0, 1), { chain: approved, allowInitialPrefix: true })).toBe(1);
    expect(() => validateMigrationHistory(rows().slice(0, 1), { chain: approved })).toThrow();
    expect(validateMigrationHistory(rows(), { chain: approved })).toBe(2);
    expect(validateMigrationHistory(rows().reverse(), { chain: approved })).toBe(2);
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
    expect(() => validateMigrationHistory([history[0], { ...history[1], ...change }], { chain: approved })).toThrow();
  });
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
