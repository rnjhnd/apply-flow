import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DatabaseConfigurationError } from '../src/config/database.js';

export type MigrationSpec = Readonly<{
  name: string; sha256: string | null; approval: 'APPROVED' | 'REVIEW_PENDING';
}>;
export const initialChecksum = '98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840';
export const baselineChecksum = '043b3e43163c7aa05f09be3d3a3dabd5e9698418bca265c40bad9fe022dd1129';
export const migrationChain: readonly MigrationSpec[] = Object.freeze([
  Object.freeze({ name: '0001_init_auth', sha256: initialChecksum, approval: 'APPROVED' as const }),
  // A digest is integrity evidence, not permission. This remains pending until a
  // separately approved follow-up changes this explicit approval state.
  Object.freeze({ name: '0002_job_applications', sha256: '74e056f699c2781c01f12d3195ed119074d5b0d4d04fef979c185e17d775a333', approval: 'REVIEW_PENDING' as const })
]);
export const prismaRoot = fileURLToPath(new URL('../prisma/', import.meta.url));
export const migrationsRoot = fileURLToPath(new URL('../prisma/migrations/', import.meta.url));
export function sqlDigest(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }
function fail(message: string): never { throw new DatabaseConfigurationError(message); }

export function assertApprovedChain(chain: readonly MigrationSpec[] = migrationChain): void {
  if (chain.length !== 2 || chain[0]?.name !== '0001_init_auth' || chain[0].sha256 !== initialChecksum
    || chain[1]?.name !== '0002_job_applications') fail('Unexpected migration-chain definition.');
  if (chain.some((entry) => entry.approval !== 'APPROVED')) fail('Migration approval is REVIEW_PENDING; no database connection or deployment is permitted.');
  if (chain.some((entry) => !entry.sha256 || !/^[a-f0-9]{64}$/.test(entry.sha256) || entry.sha256.length !== 64)) fail('Missing or malformed approved migration digest.');
}

export function assertDeploymentApproval(args: readonly string[], chain: readonly MigrationSpec[] = migrationChain): void {
  assertApprovedChain(chain);
  if (args.length !== 2 || args[0] !== '--approved-sql-sha256' || args[1] !== chain[1]?.sha256) {
    fail('Explicit approval of the exact second migration SQL digest is required.');
  }
}

export function validateMigrationDirectory(names: readonly string[], generated: boolean): void {
  const expected = ['0001_init_auth', 'migration_lock.toml', ...(generated ? ['0002_job_applications'] : [])];
  if (names.length !== expected.length || new Set(names).size !== names.length
    || names.some((name) => !expected.includes(name))) fail('Missing or unexpected migration files; no overwrite or recovery was attempted.');
}

export async function verifyMigrationFiles(): Promise<void> {
  const entries = await readdir(migrationsRoot, { withFileTypes: true });
  validateMigrationDirectory(entries.map((entry) => entry.name), true);
  for (const entry of entries) {
    if (entry.isSymbolicLink() || (entry.name === 'migration_lock.toml' ? !entry.isFile() : !entry.isDirectory())) {
      fail('Unexpected migration file type.');
    }
  }
  for (const entry of migrationChain) {
    const bytes = await readFile(new URL(`../prisma/migrations/${entry.name}/migration.sql`, import.meta.url));
    if (!entry.sha256 || sqlDigest(bytes) !== entry.sha256) fail('Local migration bytes do not match the pinned digest.');
  }
  const baseline = await readFile(new URL('../prisma/baselines/0001_init_auth.prisma', import.meta.url));
  if (sqlDigest(baseline) !== baselineChecksum) fail('Frozen authentication schema does not match the reviewed baseline.');
}

const historyRow = z.strictObject({
  migration_name: z.string(), checksum: z.string(), started_at: z.date(), finished_at: z.date(),
  rolled_back_at: z.null(), applied_steps_count: z.literal(1), logs: z.union([z.null(), z.literal('')])
});
export type MigrationHistoryRow = z.infer<typeof historyRow>;

// Database rows have no physical order. Validate exact membership and causal
// execution order; a shuffled SELECT result must not conceal reordered execution.
export function validateMigrationHistory(input: unknown, options: {
  allowInitialPrefix?: boolean; chain?: readonly MigrationSpec[];
} = {}): 1 | 2 {
  const chain = options.chain ?? migrationChain;
  assertApprovedChain(chain);
  const parsed = z.array(historyRow).safeParse(input);
  if (!parsed.success) fail('Malformed or incomplete migration history.');
  const rows = parsed.data;
  if (rows.length !== 2 && !(options.allowInitialPrefix && rows.length === 1)) fail('Missing or extra migration history.');
  if (new Set(rows.map((row) => row.migration_name)).size !== rows.length) fail('Duplicate migration history.');
  let previousFinished: number | undefined;
  for (const expected of chain.slice(0, rows.length)) {
    const row = rows.find((value) => value.migration_name === expected.name);
    if (!row || row.checksum !== expected.sha256 || row.finished_at.getTime() < row.started_at.getTime()
      || (previousFinished !== undefined && row.started_at.getTime() < previousFinished)) fail('Conflicting or reordered migration history.');
    previousFinished = row.finished_at.getTime();
  }
  return rows.length as 1 | 2;
}

export function validateMigrationTables(tables: readonly string[], count: 1 | 2): void {
  const expected = ['User', 'Session', '_prisma_migrations', ...(count === 2 ? ['JobApplication'] : [])];
  if (tables.length !== expected.length || new Set(tables).size !== tables.length
    || tables.some((table) => !expected.includes(table))) fail('Applied schema has missing or unexpected tables; stop for review.');
}

// A deliberately fixed vocabulary for the installed engine's schema-to-schema
// diff. This is a generation guard, not a general SQL parser or live drift proof.
export function wrapApplicationDiff(sql: string): string {
  const clean = sql.replace(/--[^\r\n]*/g, '').trim();
  const statements = clean.split(';').map((value) => value.trim()).filter(Boolean);
  const starts = [
    /^CREATE TYPE "ApplicationStatus" AS ENUM /,
    /^CREATE TABLE "JobApplication" \(/,
    /^CREATE INDEX "JobApplication_userId_createdAt_id_idx" ON "JobApplication"\(/,
    /^ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_userId_fkey" FOREIGN KEY /
  ];
  if (statements.length !== starts.length || statements.some((value, index) => !starts[index]?.test(value))
    || /\b(DROP|TRUNCATE|DELETE|INSERT|UPDATE|GRANT|REVOKE)\b/.test(clean.replace(/ON UPDATE CASCADE|ON DELETE RESTRICT/g, ''))
    || !clean.includes('ON DELETE RESTRICT ON UPDATE CASCADE')) fail('Unexpected schema diff; only the reviewed additive application operations are allowed.');
  return `BEGIN;\n\n${sql.trim().replace(/\r\n/g, '\n')}\n\n-- Require a date after leaving SAVED.\n`
    + 'ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_applicationDate_required_check"\n'
    + 'CHECK ("status" = \'SAVED\' OR "applicationDate" IS NOT NULL);\n\nCOMMIT;\n';
}
