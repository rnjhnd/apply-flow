import { createHash } from 'node:crypto';
import { z } from 'zod';
import { approvedChecksum, approvedMigration } from './database-preflight.js';

const column = z.strictObject({ table: z.string(), name: z.string(), type: z.string(), nullable: z.boolean(), default: z.string().nullable() });
const index = z.strictObject({ name: z.string(), columns: z.array(z.string()), unique: z.boolean(), valid: z.literal(true),
  predicate: z.null(), expressions: z.null(), method: z.literal('btree') });
export const schemaSnapshot = z.strictObject({
  tables: z.array(z.string()), columns: z.array(column), indexes: z.array(index),
  constraints: z.array(z.string()), triggers: z.array(z.string()), rowSecurity: z.array(z.string())
});
export type SchemaSnapshot = z.infer<typeof schemaSnapshot>;
const c = (table: string, name: string, type: string, nullable = false, defaultValue: string | null = null) =>
  ({ table, name, type, nullable, default: defaultValue });
export const expectedSchema: SchemaSnapshot = {
  tables: ['Session', 'User', '_prisma_migrations'],
  columns: [c('User', 'id', 'uuid'), c('User', 'email', 'character varying(254)'), c('User', 'passwordHash', 'text'),
    c('User', 'createdAt', 'timestamp(3) with time zone', false, 'CURRENT_TIMESTAMP'),
    c('User', 'updatedAt', 'timestamp(3) with time zone'),
    c('Session', 'id', 'uuid'), c('Session', 'tokenHash', 'character(64)'), c('Session', 'csrfToken', 'character(64)'),
    c('Session', 'userId', 'uuid', true), c('Session', 'createdAt', 'timestamp(3) with time zone', false, 'CURRENT_TIMESTAMP'),
    c('Session', 'lastSeenAt', 'timestamp(3) with time zone', false, 'CURRENT_TIMESTAMP'),
    c('Session', 'expiresAt', 'timestamp(3) with time zone')],
  indexes: [
    { name: 'User_pkey', columns: ['id'], unique: true, valid: true },
    { name: 'User_email_key', columns: ['email'], unique: true, valid: true },
    { name: 'Session_pkey', columns: ['id'], unique: true, valid: true },
    { name: 'Session_tokenHash_key', columns: ['tokenHash'], unique: true, valid: true },
    { name: 'Session_userId_idx', columns: ['userId'], unique: false, valid: true },
    { name: 'Session_expiresAt_idx', columns: ['expiresAt'], unique: false, valid: true }]
    .map((item) => ({ ...item, valid: true as const, predicate: null, expressions: null, method: 'btree' as const })),
  constraints: ['User_pkey:PRIMARY KEY (id)', 'Session_pkey:PRIMARY KEY (id)',
    'Session_userId_fkey:FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE'],
  triggers: [], rowSecurity: []
};

export function digest(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
function canonicalSchema(input: unknown): string {
  const parsed = schemaSnapshot.safeParse(input);
  if (!parsed.success) throw new Error('Unexpected schema metadata.');
  // Sort catalog rows, preserving index-column order. Duplicate catalog entries
  // remain visible and cannot be hidden by converting arrays to sets.
  const sorted = Object.fromEntries(Object.entries(parsed.data).map(([key, rows]) =>
    [key, rows.map((row) => JSON.stringify(row)).sort()]));
  return JSON.stringify(sorted);
}
const pinnedSchema = canonicalSchema(expectedSchema);
export function validateSchema(input: unknown): void {
  if (canonicalSchema(input) !== pinnedSchema) throw new Error('Unexpected schema metadata.');
}
export const historyRow = z.strictObject({ migration_name: z.literal(approvedMigration), checksum: z.literal(approvedChecksum),
  finished_at: z.date(), rolled_back_at: z.null(), applied_steps_count: z.literal(1), logs: z.union([z.null(), z.literal('')]) });
export function validateHistory(input: unknown): void {
  if (!z.array(historyRow).length(1).safeParse(input).success) throw new Error('Unexpected migration history.');
}
