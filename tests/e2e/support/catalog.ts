import { Prisma } from '../../../apps/api/src/generated/prisma/client.ts';
import type { DatabaseInspection } from './guarded-database.js';
import { z } from 'zod';
import { validateHistory, validateSchema } from './schema.js';

const endpointSchema = z.object({ host: z.literal('127.0.0.1'), port: z.literal(5433) });
const identitySchema = z.strictObject({ database: z.string().min(1), username: z.string().min(1) });

// SQL definitions are inert. Only an explicitly injected transaction may run
// them. Endpoint metadata must come from the admitted connector, not the
// container's inet_server_port() (5432 differs from the host's approved 5433).
export const catalogSql = {
  identity: Prisma.sql`SELECT current_database()::text AS database, current_user::text AS username`,
  history: Prisma.sql`SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count, logs FROM public._prisma_migrations ORDER BY migration_name FOR SHARE`,
  tables: Prisma.sql`SELECT c.relname AS name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY c.relname`,
  columns: Prisma.sql`SELECT c.relname AS "table", a.attname AS name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS type, NOT a.attnotnull AS nullable, pg_catalog.pg_get_expr(d.adbin, d.adrelid) AS "default" FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid = a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE n.nspname = 'public' AND c.relname IN ('User', 'Session') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY c.relname, a.attnum`,
  indexes: Prisma.sql`SELECT i.relname AS name, ARRAY(SELECT a.attname::text FROM unnest(x.indkey) WITH ORDINALITY AS k(attnum, ordinal) LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum ORDER BY k.ordinal) AS "columns", x.indisunique AS "unique", x.indisvalid AS valid, pg_catalog.pg_get_expr(x.indpred, x.indrelid) AS predicate, pg_catalog.pg_get_expr(x.indexprs, x.indrelid) AS expressions, am.amname AS method FROM pg_catalog.pg_index x JOIN pg_catalog.pg_class t ON t.oid = x.indrelid JOIN pg_catalog.pg_namespace n ON n.oid = t.relnamespace JOIN pg_catalog.pg_class i ON i.oid = x.indexrelid JOIN pg_catalog.pg_am am ON am.oid = i.relam WHERE n.nspname = 'public' AND t.relname IN ('User', 'Session') ORDER BY i.relname`,
  constraints: Prisma.sql`SELECT con.conname || ':' || pg_catalog.pg_get_constraintdef(con.oid) AS value FROM pg_catalog.pg_constraint con JOIN pg_catalog.pg_class c ON c.oid = con.conrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN ('User', 'Session') ORDER BY con.conname`,
  triggers: Prisma.sql`SELECT c.relname || ':' || t.tgname AS value FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND NOT t.tgisinternal ORDER BY c.relname, t.tgname`,
  rowSecurity: Prisma.sql`SELECT c.relname AS value FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND (c.relrowsecurity OR c.relforcerowsecurity) ORDER BY c.relname`
};

export async function inspectCatalog(tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  endpoint: { host: string; port: number }): Promise<DatabaseInspection> {
  // Strip unrelated context fields; never allow expected/configured identity
  // to replace what the query returned. Actual peer binding remains a B2 task.
  const checkedEndpoint = endpointSchema.safeParse(endpoint);
  if (!checkedEndpoint.success) throw new Error('Unexpected connected endpoint metadata.');
  const peer = Object.freeze({ host: checkedEndpoint.data.host, port: checkedEndpoint.data.port });
  const identities = await tx.$queryRaw<Array<{ database: string; username: string }>>(catalogSql.identity);
  if (identities.length !== 1 || !identities[0]) throw new Error('Unexpected connected identity.');
  const checkedIdentity = identitySchema.safeParse(identities[0]);
  if (!checkedIdentity.success) throw new Error('Unexpected connected identity.');
  const identity = Object.freeze({ database: checkedIdentity.data.database, username: checkedIdentity.data.username,
    host: peer.host, port: peer.port });
  const history: unknown = await tx.$queryRaw(catalogSql.history);
  const tables = await tx.$queryRaw<Array<{ name: string }>>(catalogSql.tables);
  const columns: unknown = await tx.$queryRaw(catalogSql.columns);
  const indexes: unknown = await tx.$queryRaw(catalogSql.indexes);
  const constraints = await tx.$queryRaw<Array<{ value: string }>>(catalogSql.constraints);
  const triggers = await tx.$queryRaw<Array<{ value: string }>>(catalogSql.triggers);
  const rowSecurity = await tx.$queryRaw<Array<{ value: string }>>(catalogSql.rowSecurity);
  return { identity, history,
    schema: { tables: tables.map((row) => row.name), columns, indexes,
      constraints: constraints.map((row) => row.value), triggers: triggers.map((row) => row.value), rowSecurity: rowSecurity.map((row) => row.value) } };
}

// B2 has its own fixed query vocabulary. B1's locking history read stays intact.
export const readOnlyCatalogSql = Object.freeze({
  ...catalogSql,
  history: Prisma.sql`SELECT migration_name, checksum, finished_at, rolled_back_at, applied_steps_count, logs FROM public._prisma_migrations ORDER BY migration_name`,
  relations: Prisma.sql`SELECT c.relname AS name, c.relkind::text AS kind, c.relpersistence::text AS persistence FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname IN ('User', 'Session', '_prisma_migrations') ORDER BY c.relname`
});
export type ReadOnlyCatalogKey = keyof typeof readOnlyCatalogSql;

export async function inspectReadOnlyCatalog(read: (key: ReadOnlyCatalogKey) => Promise<unknown>,
  endpoint: { host: string; port: number }): Promise<DatabaseInspection> {
  const peer = endpointSchema.parse(endpoint);
  const identities = z.array(identitySchema).length(1).parse(await read('identity'));
  const identity = identities[0]!;
  const relations = z.array(z.strictObject({ name: z.string(), kind: z.literal('r'), persistence: z.literal('p') }))
    .length(3).parse(await read('relations'));
  if (JSON.stringify(relations.map((row) => row.name).sort()) !== JSON.stringify(['Session', 'User', '_prisma_migrations'])) {
    throw new Error('Unexpected relation metadata.');
  }
  // Check ordinary permanent relations before touching migration-table contents.
  const history = await read('history');
  validateHistory(history);
  const names = z.array(z.strictObject({ name: z.string() }));
  const values = z.array(z.strictObject({ value: z.string() }));
  const schema = {
    tables: names.parse(await read('tables')).map((row) => row.name),
    columns: await read('columns'), indexes: await read('indexes'),
    constraints: values.parse(await read('constraints')).map((row) => row.value),
    triggers: values.parse(await read('triggers')).map((row) => row.value),
    rowSecurity: values.parse(await read('rowSecurity')).map((row) => row.value)
  };
  validateSchema(schema);
  return { identity: Object.freeze({ database: identity.database, username: identity.username,
    host: peer.host, port: peer.port }), history, schema };
}
