import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { applicationSchema, applicationStatusSchema, listApplicationHistoryResponseSchema, listApplicationsResponseSchema,
  type Application, type ApplicationStatus, type ListApplicationsQuery, type UpdateApplicationRequest } from '@applyflow/contracts';
import { createApp } from '../src/app.js';
import { parseEnv } from '../src/config/env.js';
import { parseAuthConfig } from '../src/config/auth.js';
import { assertDatabaseIdentity, requireTestDatabaseTarget } from '../src/config/database.js';
import { loadLocalEnvironment } from '../src/config/load-env.js';
import { openLocalDatabase } from '../src/db/client.js';
import type { Prisma } from '../src/generated/prisma/client.ts';
import { createApplicationService, type ApplicationDatabase, type ApplicationTransaction } from '../src/modules/applications/service.js';
import { ApplicationHttpError } from '../src/modules/applications/http-error.js';
import { createSessionService } from '../src/modules/auth/sessions.js';
import { generateToken, hashSessionToken } from '../src/modules/auth/tokens.js';
import { AUTH_LIMITS } from '../src/modules/auth/admission.js';
import { decodeApplicationCursor, encodeApplicationCursor } from '../src/modules/applications/pagination.js';
import { assertApprovedChain, validateMigrationHistory, validateMigrationTables, verifyMigrationFiles,
  type MigrationHistoryRow } from '../scripts/migration-policy.js';

// No live defaults or top-level connection. Only the separately selected serial
// integration runner can invoke beforeAll and admit the exact test target.
const path = '/api/applications';
const marker = `search-filter-${randomUUID()}-`;
const clock = new Date('2026-10-22T12:00:00.000Z');
let time = clock;
let connection: Awaited<ReturnType<typeof openLocalDatabase>> | undefined;
let stopped = false;
let executionAdmitted = false;
const users = new Set<string>();
const sessions = new Map<string, { userId: string | null; tokenHash: string }>();
const applications = new Map<string, string>();
const events = new Map<string, { applicationId: string; applicationVersion: number; fromStatus: ApplicationStatus; toStatus: ApplicationStatus }>();
const unexpected = { users: new Set<string>(), sessions: new Set<string>(), applications: new Set<string>(), history: new Set<string>() };
const pids = new Set<number>();
let migrationFingerprint: string | undefined, schemaFingerprint: string | undefined;
type Tx = Prisma.TransactionClient;
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function client() {
  const target = requireTestDatabaseTarget(process.env);
  if (target.host !== '127.0.0.1' || target.port !== '5433' || target.database !== 'applyflow_test'
    || target.username !== 'applyflow_test' || !connection) throw new Error('Exact test connection is not admitted.');
  if (connection.target.connectionString !== target.connectionString) throw new Error('Test target changed.');
  return connection.client;
}
function reportResiduals() {
  // UUIDs only. Never serialize Session objects, proof headers, errors or URLs.
  console.error('Recorded/possible residual search/filter fixture IDs; no broader cleanup authorized:', {
    users: [...users], sessions: [...sessions.keys()], applications: [...applications.keys()], history: [...events.keys()],
    unexpected: Object.fromEntries(Object.entries(unexpected).map(([key, ids]) => [key, [...ids]]))
  });
}
async function identity(database: Pick<Tx, '$queryRaw'>, isolation = 'read committed') {
  const rows = await database.$queryRaw<Array<{ database: string; username: string; sessionUser: string;
    version: string; port: number; address: string | null; isolation: string; pid: number }>>`
    SELECT current_database()::text AS database, current_user::text AS username, session_user::text AS "sessionUser",
      current_setting('server_version_num') AS version, inet_server_port() AS port, inet_server_addr()::text AS address,
      current_setting('transaction_isolation') AS isolation, pg_backend_pid() AS pid
  `;
  const row = rows[0];
  assertDatabaseIdentity(requireTestDatabaseTarget(process.env), row);
  if (rows.length !== 1 || row?.sessionUser !== 'applyflow_test' || !/^17\d{4}$/.test(row.version)
    || row.port !== 5432 || !row.address || row.isolation !== isolation) throw new Error('Unexpected connected test identity/settings.');
  pids.add(row.pid);
}
async function historyAdmission(database: Pick<Tx, '$queryRaw'>) {
  const rows = await database.$queryRaw<MigrationHistoryRow[]>`
    SELECT migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count, logs
    FROM public._prisma_migrations
  `;
  validateMigrationHistory(rows);
  const fingerprint = digest(rows.sort((a, b) => a.migration_name.localeCompare(b.migration_name)));
  if (migrationFingerprint && fingerprint !== migrationFingerprint) throw new Error('Migration metadata changed.');
  migrationFingerprint = fingerprint;
}
async function inventory(database: Tx | ReturnType<typeof client>) {
  const liveUsers = await database.user.findMany({ select: { id: true, email: true } });
  const liveSessions = await database.session.findMany({ select: { id: true, userId: true, tokenHash: true } });
  const liveApps = await database.jobApplication.findMany({ select: { id: true, userId: true, company: true } });
  const liveEvents = await database.applicationStatusHistory.findMany({ select: {
    id: true, applicationId: true, applicationVersion: true, fromStatus: true, toStatus: true
  } });
  for (const row of liveUsers) if (!users.has(row.id) || row.email !== `${marker}${row.id}@example.invalid`) unexpected.users.add(row.id);
  for (const row of liveSessions) {
    const expected = sessions.get(row.id);
    if (!expected || expected.userId !== row.userId || expected.tokenHash !== row.tokenHash
      || (row.userId !== null && !users.has(row.userId))) unexpected.sessions.add(row.id);
  }
  for (const row of liveApps) if (applications.get(row.id) !== row.userId || !users.has(row.userId)
    || !row.company.startsWith(marker)) unexpected.applications.add(row.id);
  for (const row of liveEvents) {
    const expected = events.get(row.id);
    if (!expected || !applications.has(row.applicationId) || expected.applicationId !== row.applicationId
      || expected.applicationVersion !== row.applicationVersion || expected.fromStatus !== row.fromStatus
      || expected.toStatus !== row.toStatus) unexpected.history.add(row.id);
  }
  if (Object.values(unexpected).some(ids => ids.size)) throw new Error('Unrelated or unproven records found; writes stopped.');
}
async function admit(database: Tx | ReturnType<typeof client>) {
  if (stopped) throw new Error('Suite writes have stopped.');
  try {
    client(); assertApprovedChain(); await identity(database); await historyAdmission(database);
    await schemaAdmission(database); await inventory(database); await clientsAdmission(database);
  } catch {
    stopped = true;
    throw new Error('Test identity, migration or fixture ownership admission failed. No further writes authorized.');
  }
}
async function schemaAdmission(database: Pick<Tx, '$queryRaw'>) {
  const tables = await database.$queryRaw<Array<{ name: string }>>`SELECT tablename::text AS name FROM pg_tables WHERE schemaname='public'`;
  validateMigrationTables(tables.map(row => row.name), 4);
  const columns = await database.$queryRaw<Array<{ table: string; name: string; type: string; required: boolean; default: string | null }>>`
    SELECT c.relname::text AS "table", a.attname::text AS name, format_type(a.atttypid,a.atttypmod) AS type,
      a.attnotnull AS required, pg_get_expr(d.adbin,d.adrelid) AS "default"
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
    WHERE n.nspname='public' AND c.relkind='r' AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum
  `;
  const expected = {
    User: [['id','uuid',true,null],['email','character varying(254)',true,null],['passwordHash','text',true,null],['createdAt','timestamp(3) with time zone',true,'CURRENT_TIMESTAMP'],['updatedAt','timestamp(3) with time zone',true,null]],
    Session: [['id','uuid',true,null],['tokenHash','character(64)',true,null],['csrfToken','character(64)',true,null],['userId','uuid',false,null],['createdAt','timestamp(3) with time zone',true,'CURRENT_TIMESTAMP'],['lastSeenAt','timestamp(3) with time zone',true,'CURRENT_TIMESTAMP'],['expiresAt','timestamp(3) with time zone',true,null]],
    JobApplication: [['id','uuid',true,null],['userId','uuid',true,null],['company','character varying(160)',true,null],['jobTitle','character varying(200)',true,null],['status','"ApplicationStatus"',true,"'SAVED'::\"ApplicationStatus\""],['applicationDate','date',false,null],['location','character varying(200)',false,null],['jobUrl','character varying(2048)',false,null],['notes','text',false,null],['createdAt','timestamp(3) with time zone',true,'CURRENT_TIMESTAMP'],['updatedAt','timestamp(3) with time zone',true,null],['version','integer',true,'1'],['archivedAt','timestamp(3) with time zone',false,null]],
    ApplicationStatusHistory: [['id','uuid',true,null],['applicationId','uuid',true,null],['fromStatus','"ApplicationStatus"',true,null],['toStatus','"ApplicationStatus"',true,null],['applicationVersion','integer',true,null],['changedAt','timestamp(3) with time zone',true,'CURRENT_TIMESTAMP']],
    _prisma_migrations: [['id','character varying(36)',true,null],['checksum','character varying(64)',true,null],['finished_at','timestamp with time zone',false,null],['migration_name','character varying(255)',true,null],['logs','text',false,null],['rolled_back_at','timestamp with time zone',false,null],['started_at','timestamp with time zone',true,'now()'],['applied_steps_count','integer',true,'0']]
  };
  for (const [table, fields] of Object.entries(expected)) {
    if (JSON.stringify(columns.filter(row => row.table === table).map(row => [row.name,row.type,row.required,row.default])) !== JSON.stringify(fields)) throw new Error('Unexpected catalog columns.');
  }
  const constraints = await database.$queryRaw<Array<{ name: string; valid: boolean; definition: string }>>`
    SELECT c.conname::text AS name,c.convalidated AS valid,pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
  `;
  const expectedConstraints = {
    User_pkey: 'PRIMARY KEY (id)', Session_pkey: 'PRIMARY KEY (id)', _prisma_migrations_pkey: 'PRIMARY KEY (id)',
    Session_userId_fkey: 'FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE CASCADE',
    JobApplication_pkey: 'PRIMARY KEY (id)', JobApplication_userId_fkey: 'FOREIGN KEY ("userId") REFERENCES "User"(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    JobApplication_applicationDate_required_check: `CHECK (((status = 'SAVED'::"ApplicationStatus") OR ("applicationDate" IS NOT NULL)))`,
    JobApplication_version_positive_check: 'CHECK ((version > 0))', ApplicationStatusHistory_pkey: 'PRIMARY KEY (id)',
    ApplicationStatusHistory_applicationId_fkey: 'FOREIGN KEY ("applicationId") REFERENCES "JobApplication"(id) ON UPDATE CASCADE ON DELETE RESTRICT',
    ApplicationStatusHistory_status_changed_check: 'CHECK (("fromStatus" <> "toStatus"))', ApplicationStatusHistory_version_check: 'CHECK (("applicationVersion" >= 2))'
  };
  if (constraints.length !== Object.keys(expectedConstraints).length || constraints.some(row => !row.valid
    || expectedConstraints[row.name as keyof typeof expectedConstraints] !== row.definition)) throw new Error('Unexpected catalog constraints.');
  const indexes = await database.$queryRaw<Array<{ name: string; valid: boolean; ready: boolean; definition: string }>>`
    SELECT i.relname::text AS name,x.indisvalid AS valid,x.indisready AS ready,pg_get_indexdef(i.oid) AS definition
    FROM pg_index x JOIN pg_class t ON t.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace WHERE n.nspname='public'
  `;
  const expectedIndexes = {
    User_pkey: 'CREATE UNIQUE INDEX "User_pkey" ON public."User" USING btree (id)',
    User_email_key: 'CREATE UNIQUE INDEX "User_email_key" ON public."User" USING btree (email)',
    Session_pkey: 'CREATE UNIQUE INDEX "Session_pkey" ON public."Session" USING btree (id)',
    Session_tokenHash_key: 'CREATE UNIQUE INDEX "Session_tokenHash_key" ON public."Session" USING btree ("tokenHash")',
    Session_userId_idx: 'CREATE INDEX "Session_userId_idx" ON public."Session" USING btree ("userId")',
    Session_expiresAt_idx: 'CREATE INDEX "Session_expiresAt_idx" ON public."Session" USING btree ("expiresAt")',
    _prisma_migrations_pkey: 'CREATE UNIQUE INDEX _prisma_migrations_pkey ON public._prisma_migrations USING btree (id)',
    JobApplication_pkey: 'CREATE UNIQUE INDEX "JobApplication_pkey" ON public."JobApplication" USING btree (id)',
    JobApplication_userId_createdAt_id_idx: 'CREATE INDEX "JobApplication_userId_createdAt_id_idx" ON public."JobApplication" USING btree ("userId", "createdAt" DESC, id DESC)',
    ApplicationStatusHistory_pkey: 'CREATE UNIQUE INDEX "ApplicationStatusHistory_pkey" ON public."ApplicationStatusHistory" USING btree (id)',
    ApplicationStatusHistory_applicationId_applicationVersion_key: 'CREATE UNIQUE INDEX "ApplicationStatusHistory_applicationId_applicationVersion_key" ON public."ApplicationStatusHistory" USING btree ("applicationId", "applicationVersion")'
  };
  if (indexes.length !== Object.keys(expectedIndexes).length || indexes.some(row => !row.valid || !row.ready
    || expectedIndexes[row.name as keyof typeof expectedIndexes] !== row.definition)) throw new Error('Unexpected catalog indexes.');
  const enums = await database.$queryRaw<Array<{ type: string; label: string }>>`
    SELECT t.typname::text AS type,e.enumlabel::text AS label FROM pg_enum e JOIN pg_type t ON t.oid=e.enumtypid
    JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' ORDER BY e.enumsortorder
  `;
  if (JSON.stringify(enums) !== JSON.stringify(['SAVED','APPLIED','ASSESSMENT','INTERVIEW','OFFER','REJECTED','WITHDRAWN'].map(label => ({ type: 'ApplicationStatus', label })))) throw new Error('Unexpected status enum.');
  const extra = await database.$queryRaw<Array<{ name: string }>>`
    SELECT nspname::text AS name FROM pg_namespace WHERE nspname NOT IN ('public','pg_catalog','information_schema') AND nspname NOT LIKE 'pg_toast%' AND nspname NOT LIKE 'pg_temp_%'
    UNION ALL SELECT p.proname::text FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
    UNION ALL SELECT t.tgname::text FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal
    UNION ALL SELECT c.relname::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND (c.relkind NOT IN ('r','i') OR c.relrowsecurity OR c.relforcerowsecurity)
    UNION ALL SELECT t.typname::text FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public'
      AND t.typname NOT IN ('User','_User','Session','_Session','JobApplication','_JobApplication',
        'ApplicationStatusHistory','_ApplicationStatusHistory','ApplicationStatus','_ApplicationStatus','_prisma_migrations','__prisma_migrations')
  `;
  if (extra.length) throw new Error('Unexpected inspected schema objects.');
  const fingerprint = digest({ tables: tables.map(row => row.name).sort(), columns,
    constraints: constraints.sort((a,b) => a.name.localeCompare(b.name)),
    indexes: indexes.sort((a,b) => a.name.localeCompare(b.name)), enums });
  if (schemaFingerprint && fingerprint !== schemaFingerprint) throw new Error('Catalog fingerprint changed.');
  schemaFingerprint = fingerprint;
}

async function fixtureWrite<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  let entered = false, completed = false;
  let callbackFailed = false, callbackError: unknown;
  try {
    return await client().$transaction(async tx => {
      entered = true;
      try {
        await admit(tx);
        await tx.$executeRaw`SET LOCAL statement_timeout = '8s'`;
        await tx.$executeRaw`SET LOCAL lock_timeout = '6s'`;
        const result = await work(tx); await admit(tx); completed = true; return result;
      } catch (error) { callbackFailed = true; callbackError = error; throw error; }
    }, { timeout: 15000, maxWait: 3000, isolationLevel: 'ReadCommitted' });
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      && typeof error.code === 'string' && /^P\d{4}$/.test(error.code) ? error.code : undefined;
    const originalCode = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } } | null)
      ?.meta?.driverAdapterError?.cause?.originalCode;
    const sqlState = typeof originalCode === 'string' && ['23514','23503','23505'].includes(originalCode) ? originalCode : undefined;
    // A rejection after the callback returned may be an ambiguous commit. Do
    // not attempt cleanup or another write after that, or a connection failure.
    if (!entered || completed || !callbackFailed || error !== callbackError
      || (code && !sqlState && !['P2002', 'P2003'].includes(code))) stopped = true;
    if (error instanceof ApplicationHttpError) throw error;
    // Prisma errors can embed fixture arguments, including session secrets.
    // Preserve only allowlisted codes, never a message, cause or driver object.
    throw Object.assign(new Error('Guarded integration transaction failed; raw database details withheld.'),
      code ? { code } : {}, sqlState ? { sqlState } : {});
  }
}
async function user() {
  const id = randomUUID(); users.add(id);
  await fixtureWrite(async tx => {
    if (await tx.user.count({ where: { OR: [{ id }, { email: `${marker}${id}@example.invalid` }] } })) throw new Error('Fixture identity collision.');
    await tx.user.create({ data: { id, email: `${marker}${id}@example.invalid`, passwordHash: 'integration-fixture-only' } });
  });
  return id;
}
async function session(userId: string | null) {
  const id = randomUUID(); const tokens = [generateToken(), generateToken()];
  if (sessions.has(id) || (userId !== null && !users.has(userId))) throw new Error('Session fixture identity rejected.');
  sessions.set(id, { userId, tokenHash: hashSessionToken(tokens[0]!) });
  return fixtureWrite(async tx => {
    if (await tx.session.count({ where: { id } })) throw new Error('Session fixture collision.');
    // Assign a pre-recorded fixture UUID while retaining the existing session
    // service's token generation contract, hashing and expiry policies.
    const delegate = new Proxy(tx.session, { get(target, key) {
      if (key === 'create') return (args: Prisma.SessionCreateArgs) => target.create({ ...args, data: { ...args.data, id } });
      return Reflect.get(target, key);
    } });
    const service = createSessionService({ session: delegate, $queryRaw: tx.$queryRaw.bind(tx) }, { now: () => time, token: () => tokens.shift()! });
    return userId === null ? service.createAnonymous() : service.createAuthenticated(userId);
  });
}
type Proof = Awaited<ReturnType<typeof session>>;
function headers(proof: Proof) { return { Origin: 'http://127.0.0.1:5173', 'X-ApplyFlow-Request': '1',
  'X-CSRF-Token': proof.session.csrfToken, Cookie: `applyflow_session=${proof.token}` }; }
function guardedDatabase(): ApplicationDatabase {
  return { $transaction: work => fixtureWrite(async tx => {
    const guarded: ApplicationTransaction = {
      session: tx.session,
      // Forward actual Prisma SQL unchanged; this is admission, not a SQL mock.
      $queryRaw: (async (query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
        await admit(tx);
        const text = Array.isArray(query) ? query.join('?') : '';
        if (text.includes('UPDATE public."Session"') && ![...sessions.values()].some(s => s.tokenHash === values[1])) {
          throw new Error('Unowned session refresh rejected.');
        }
        return tx.$queryRaw(query, ...values);
      }) as ApplicationTransaction['$queryRaw'],
      jobApplication: new Proxy(tx.jobApplication, { get(target, key) {
        if (key === 'create') return async (args: Prisma.JobApplicationCreateArgs) => {
          await admit(tx);
          const owner = args.data.userId;
          if (!owner || !users.has(owner) || !args.data.company.startsWith(marker)) throw new Error('Unowned HTTP create rejected.');
          const id = randomUUID(); applications.set(id, owner);
          if (await target.count({ where: { id } })) throw new Error('Application fixture collision.');
          return target.create({ ...args, data: { ...args.data, id } });
        };
        if (key === 'update') return async (args: Prisma.JobApplicationUpdateArgs) => {
          await admit(tx);
          if (!args.where.id || applications.get(args.where.id) !== args.where.userId
            || (args.data.company !== undefined && (typeof args.data.company !== 'string' || !args.data.company.startsWith(marker)))) {
            throw new Error('Unowned HTTP update rejected.');
          }
          return target.update(args);
        };
        if (key === 'delete') return async (args: Prisma.JobApplicationDeleteArgs) => {
          await admit(tx);
          if (!args.where.id || applications.get(args.where.id) !== args.where.userId
            || typeof args.where.version !== 'number' || JSON.stringify(args.where.archivedAt) !== '{"not":null}') {
            throw new Error('Unowned or insufficiently scoped HTTP deletion rejected.');
          }
          return target.delete(args);
        };
        return Reflect.get(target, key);
      } }),
      applicationStatusHistory: new Proxy(tx.applicationStatusHistory, { get(target, key) {
        if (key === 'create') return async (args: Prisma.ApplicationStatusHistoryCreateArgs) => {
          await admit(tx);
          const data = args.data;
          if (!data.applicationId || !applications.has(data.applicationId)) throw new Error('Unowned history insert rejected.');
          const id = randomUUID();
          events.set(id, { applicationId: data.applicationId, applicationVersion: data.applicationVersion, fromStatus: data.fromStatus, toStatus: data.toStatus });
          if (await target.count({ where: { id } })) throw new Error('History fixture collision.');
          return target.create({ ...args, data: { ...data, id } });
        };
        if (key === 'deleteMany') return async (args: Prisma.ApplicationStatusHistoryDeleteManyArgs) => {
          await admit(tx);
          const id = args.where?.applicationId, relation = args.where?.application;
          const owner = typeof id === 'string' ? applications.get(id) : undefined;
          if (!owner || !relation || !('userId' in relation) || relation.userId !== owner
            || Object.keys(args.where ?? {}).sort().join(',') !== 'application,applicationId') {
            throw new Error('Unowned or insufficiently scoped history deletion rejected.');
          }
          const result = await target.deleteMany(args);
          return result;
        };
        return Reflect.get(target, key);
      } })
    };
    return work(guarded);
  }) };
}
function app() {
  return createApp(parseEnv({ NODE_ENV: 'test' }), { config: parseAuthConfig({ NODE_ENV: 'test' }),
    sessions: createSessionService(client(), { now: () => time }) }, {
    applications: createApplicationService(guardedDatabase(), { now: () => time, timeZone: 'America/Los_Angeles' })
  });
}
function edit(row: Application, changes: Partial<UpdateApplicationRequest> = {}): UpdateApplicationRequest {
  return { company: row.company, jobTitle: row.jobTitle, status: row.status, applicationDate: row.applicationDate,
    location: row.location, jobUrl: row.jobUrl, notes: row.notes, expectedVersion: row.version, ...changes };
}
async function create(proof: Proof, changes: Record<string, unknown> = {}) {
  const response = await request(app()).post(path).set(headers(proof)).send({ company: marker + 'company', jobTitle: 'Engineer', ...changes }).expect(201);
  const row = applicationSchema.parse(response.body.application);
  if (!applications.has(row.id)) throw new Error('HTTP create ownership was not recorded.');
  expect(response.headers['set-cookie'] === undefined).toBe(true);
  return row;
}
async function update(proof: Proof, row: Application, changes: Partial<UpdateApplicationRequest> = {}) {
  const response = await request(app()).put(`${path}/${row.id}`).set(headers(proof)).send(edit(row, changes)).expect(200);
  return applicationSchema.parse(response.body.application);
}
async function state(id: string) {
  if (!applications.has(id)) throw new Error('Unowned snapshot rejected.');
  return {
    application: await client().jobApplication.findUnique({ where: { id } }),
    history: await client().applicationStatusHistory.findMany({ where: { applicationId: id }, orderBy: { applicationVersion: 'desc' } }),
    activity: await client().session.findMany({ where: { id: { in: [...sessions.keys()] } },
      select: { id: true, userId: true, createdAt: true, lastSeenAt: true, expiresAt: true }, orderBy: { id: 'asc' } })
  };
}

async function clientsAdmission(tx: Pick<Tx, '$queryRaw'>) {
  const peers = await tx.$queryRaw<Array<{ count: number }>>`
    SELECT count(*)::int AS count FROM pg_stat_activity
    WHERE datname=current_database() AND backend_type='client backend'
      AND pid<>pg_backend_pid() AND NOT (pid=ANY(${[...pids]}::int[]))
  `;
  const hazards = await tx.$queryRaw<Array<{ count: number }>>`
    SELECT (SELECT count(*) FROM pg_prepared_xacts WHERE database=current_database())::int
      + (SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid
        WHERE a.datname=current_database() AND NOT l.granted)::int
      + (SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND backend_type='client backend'
        AND pid<>pg_backend_pid() AND (xact_start IS NOT NULL OR state='active'))::int AS count
  `;
  if (peers[0]?.count !== 0 || hazards[0]?.count !== 0) throw new Error('Unexpected test client, prepared transaction or lock wait.');
}
async function readOnlyInspection() {
  const rollback = new Error('Intentional read-only inspection rollback.');
  let inspected = false;
  try {
    await client().$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
      await identity(tx, 'repeatable read');
      const settings = await tx.$queryRaw<Array<{ readOnly: string }>>`SELECT current_setting('transaction_read_only') AS "readOnly"`;
      if (settings[0]?.readOnly !== 'on') throw new Error('Inspection is not read-only.');
      await historyAdmission(tx); await schemaAdmission(tx); await clientsAdmission(tx);
      if (await tx.user.count() || await tx.session.count() || await tx.jobApplication.count()
        || await tx.applicationStatusHistory.count()) throw new Error('Test database is not empty.');
      await inventory(tx);
      await clientsAdmission(tx); inspected = true; throw rollback;
    }, { timeout: 10000, maxWait: 3000 });
  } catch (error) {
    if (error === rollback && inspected) return;
    stopped = true;
    // Raw driver causes may contain authentication material; never attach them.
    // eslint-disable-next-line preserve-caught-error
    throw new Error('Read-only test database inspection/rollback was not confirmed.');
  }
  stopped = true; throw new Error('Read-only inspection unexpectedly committed.');
}

beforeAll(async () => {
  try {
    loadLocalEnvironment();
    const target = requireTestDatabaseTarget(process.env);
    if (target.host !== '127.0.0.1' || target.port !== '5433' || target.database !== 'applyflow_test' || target.username !== 'applyflow_test') throw new Error('Unexpected target.');
    assertApprovedChain(); await verifyMigrationFiles();
    connection = await openLocalDatabase('test', process.env);
    await readOnlyInspection();
    await connection.client.$disconnect(); connection = undefined; pids.clear();
    console.info('Search/filter read-only preflight passed; admission connection closed.', {
      target: '127.0.0.1:5433/applyflow_test', role: 'applyflow_test', migrations: '0001-0004',
      schemaFingerprint, migrationFingerprint, counts: { users: 0, sessions: 0, applications: 0, history: 0 }
    });
    // Close the admission pool before constructing the separate execution pool.
    connection = await openLocalDatabase('test', process.env);
    await admit(client()); await clientsAdmission(client());
    executionAdmitted = true;
  } catch {
    stopped = true; throw new Error('Test preflight or admission connection closure failed; no test writes authorized.');
  }
});
beforeEach(async () => {
  if (stopped) throw new Error('Suite stopped; refusing further test writes.');
  time = clock;
  await verifyMigrationFiles();
  await admit(client());
  try { await clientsAdmission(client()); }
  catch { stopped = true; throw new Error('Competing client/lock admission failed; writes stopped.'); }
});

type SearchQuery = Partial<ListApplicationsQuery>;
type Seed = { company?: string; jobTitle?: string; status?: ApplicationStatus; archived?: boolean; createdAt?: Date };
async function seed(owner: string, specs: Seed[]) {
  if (!users.has(owner) || specs.length > 128) throw new Error('Unowned or oversized fixture batch rejected.');
  return fixtureWrite(async tx => {
    const data = specs.map(spec => {
      const id = randomUUID(); applications.set(id, owner);
      const status = spec.status ?? 'SAVED';
      return { id, userId: owner, company: marker + (spec.company ?? 'company'), jobTitle: spec.jobTitle ?? 'Engineer', status,
        applicationDate: status === 'SAVED' ? null : new Date('2024-02-29T00:00:00.000Z'),
        archivedAt: spec.archived ? clock : null, createdAt: spec.createdAt ?? clock, updatedAt: clock };
    });
    if (await tx.jobApplication.count({ where: { id: { in: data.map(row => row.id) } } })) throw new Error('Fixture ID collision.');
    await admit(tx);
    if (data.some(row => applications.get(row.id) !== row.userId || !row.company.startsWith(marker))) throw new Error('Batch ownership rejected.');
    await tx.jobApplication.createMany({ data });
    return data;
  });
}
async function page(proof: Proof, query: SearchQuery = {}) {
  const response = await request(app()).get(path).set(headers(proof)).query(query).expect(200);
  expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers['set-cookie']).toBeUndefined();
  return listApplicationsResponseSchema.parse(response.body);
}
function ordered(rows: Array<{ id: string; createdAt: Date }>) {
  return [...rows].sort((a,b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id === b.id ? 0 : -1)).map(row => row.id);
}
async function walk(proof: Proof, query: SearchQuery, expected: string[]) {
  const ids: string[] = [], cursors = new Set<string>();
  let cursor: string | undefined;
  for (let attempt = 0; attempt <= expected.length + 1; attempt++) {
    const result = await page(proof, { ...query, limit: 2, ...(cursor ? { cursor } : {}) });
    expect(result.items.map(row => row.id)).toEqual(expected.slice(ids.length, ids.length + 2));
    ids.push(...result.items.map(row => row.id));
    if (ids.length === expected.length) { expect(result.nextCursor).toBeNull(); break; }
    expect(result.nextCursor).not.toBeNull();
    const last = result.items.at(-1)!;
    expect(decodeApplicationCursor(result.nextCursor!)).toEqual({ id: last.id, createdAt: new Date(last.createdAt) });
    expect(cursors.has(result.nextCursor!)).toBe(false); cursors.add(result.nextCursor!);
    cursor = result.nextCursor!;
  }
  expect(ids).toEqual(expected); expect(new Set(ids).size).toBe(ids.length);
}
async function lifecycle(proof: Proof, row: Application, operation: 'archive' | 'restore') {
  const response = await request(app()).post(`${path}/${row.id}/${operation}`).set(headers(proof))
    .send({ expectedVersion: row.version }).expect(200);
  return applicationSchema.parse(response.body.application);
}

it('matches case-insensitive whole phrases in the middle of company OR title without searching other fields', async () => {
  const owner = await user(), proof = await session(owner);
  const rows = await seed(owner, [{ company: 'before Data Platform after', jobTitle: 'Other role' },
    { company: 'Other company', jobTitle: 'Senior DATA PLATFORM Engineer' },
    { company: 'Data something Platform', jobTitle: 'Unrelated' }]);
  await create(proof, { company: marker + 'notes-only', notes: 'Data Platform', location: 'Data Platform', jobUrl: 'https://example.invalid/DataPlatform' });
  await walk(proof, { q: 'dAtA pLaTfOrM' }, ordered(rows.slice(0, 2)));
  expect((await page(proof, { q: 'no-such-search-result' })).items).toEqual([]);
});

it.each(['%', '_', '\\', "'", '"', 'C++ / R&D?!'])('matches literal punctuation %j without wildcard expansion', async literal => {
  const owner = await user(), proof = await session(owner);
  const rows = await seed(owner, [{ company: `before ${literal} after`, jobTitle: 'Other' },
    { company: 'Other', jobTitle: `before ${literal} after` }, { company: 'before any after', jobTitle: 'before X after' }]);
  await walk(proof, { q: literal }, ordered(rows.slice(0, 2)));
});

it('normalizes outer/blank whitespace while preserving internal whitespace', async () => {
  const owner = await user(), proof = await session(owner);
  const rows = await seed(owner, [{ jobTitle: 'Senior Data  Engineer' }, { jobTitle: 'Senior Data Engineer' }, { archived: true }]);
  await walk(proof, { q: ' \tData  Engineer\n ' }, [rows[0]!.id]);
  const defaults = await page(proof);
  expect(defaults.items.map(row => row.id)).toEqual(ordered(rows.slice(0, 2)));
  for (const q of ['', ' \t\n ', '\u2003\u00a0']) expect(await page(proof, { q })).toEqual(defaults);
});

it('accepts 200 Unicode code points after trimming and rejects malformed service input before session activity', async () => {
  const owner = await user(), proof = await session(owner), q = '\ud83d\ude00'.repeat(200);
  const rows = await seed(owner, [{ jobTitle: q }]);
  await walk(proof, { q: ` ${q} ` }, [rows[0]!.id]);
  const old = await state(rows[0]!.id); time = new Date(clock.getTime() + 1000);
  for (const q of ['\ud800', '\udc00', '\u0000', '\ud83d\ude00'.repeat(201)]) {
    await expect(createApplicationService(guardedDatabase(), { now: () => time, timeZone: 'UTC' }).list({ q }, { token: proof.token }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
  }
  expect(await state(rows[0]!.id)).toEqual(old);
});

it('filters all seven statuses independently in Active and Archived, with omission including every status', async () => {
  const owner = await user(), proof = await session(owner);
  const active = await seed(owner, applicationStatusSchema.options.map(status => ({ status, jobTitle: 'common phrase' })));
  const archived = await seed(owner, applicationStatusSchema.options.map(status => ({ status, jobTitle: 'common phrase', archived: true })));
  await walk(proof, {}, ordered(active)); await walk(proof, { view: 'archived' }, ordered(archived));
  for (const status of applicationStatusSchema.options) {
    await walk(proof, { status }, [active.find(row => row.status === status)!.id]);
    await walk(proof, { status, view: 'archived', q: 'COMMON PHRASE' }, [archived.find(row => row.status === status)!.id]);
  }
}, 30000);

it('applies combined search/status/view/owner predicates on every page and never returns foreign matches', async () => {
  const owner = await user(), foreignOwner = await user(), proof = await session(owner), foreign = await session(foreignOwner);
  const specs: Seed[] = Array.from({ length: 18 }, (_, index) => ({
    company: index % 2 ? 'irrelevant' : 'common phrase', status: index % 3 ? 'APPLIED' : 'INTERVIEW', archived: index % 4 === 0,
    createdAt: new Date(clock.getTime() - Math.floor(index / 3) * 1000)
  }));
  const owned = await seed(owner, specs), others = await seed(foreignOwner, specs);
  for (const view of ['active', 'archived'] as const) for (const status of ['APPLIED', 'INTERVIEW'] as const) {
    const indexes = specs.flatMap((spec, index) => spec.company === 'common phrase' && spec.status === status && !!spec.archived === (view === 'archived') ? [index] : []);
    await walk(proof, { q: 'COMMON PHRASE', status, view }, ordered(indexes.map(index => owned[index]!)));
    await walk(foreign, { q: 'COMMON PHRASE', status, view }, ordered(indexes.map(index => others[index]!)));
  }
}, 30000);

it('filters before limit+1 with sparse matches, tied timestamps and strict last-matching-row cursors', async () => {
  const owner = await user(), proof = await session(owner);
  const specs: Seed[] = Array.from({ length: 24 }, (_, index) => ({
    jobTitle: index % 5 === 0 ? 'prefix rare phrase suffix' : 'noise',
    createdAt: new Date(clock.getTime() - Math.floor(index / 6) * 1000)
  }));
  const rows = await seed(owner, specs), matches = rows.filter((_, index) => index % 5 === 0);
  await walk(proof, { q: 'RARE PHRASE' }, ordered(matches));
  const defaults = await page(proof);
  expect(defaults.items.map(row => row.id)).toEqual(ordered(rows).slice(0, 20));
  expect(decodeApplicationCursor(defaults.nextCursor!)).toEqual({ id: defaults.items.at(-1)!.id, createdAt: new Date(defaults.items.at(-1)!.createdAt) });
});

it('treats cursors from different search/status/view/owners as boundaries, not filter membership or authorization', async () => {
  const owner = await user(), otherOwner = await user(), proof = await session(owner), other = await session(otherOwner);
  const specs: Seed[] = Array.from({ length: 12 }, (_, index) => ({ jobTitle: index % 2 ? 'Beta' : 'Alpha',
    status: index % 3 ? 'APPLIED' : 'SAVED', archived: index % 4 < 2, createdAt: new Date(clock.getTime() - index * 1000) }));
  const rows = await seed(owner, specs); await seed(otherOwner, specs);
  const origin = await page(other, { q: 'Alpha', status: 'APPLIED', view: 'active', limit: 1 });
  expect(origin.nextCursor).not.toBeNull();
  const anchor = decodeApplicationCursor(origin.nextCursor!);
  for (const view of ['active', 'archived'] as const) for (const status of ['APPLIED', 'SAVED'] as const) {
    const expected = rows.filter((row, index) => specs[index]!.jobTitle === 'Beta' && row.status === status
      && (row.archivedAt !== null) === (view === 'archived') && (row.createdAt < anchor.createdAt
        || (row.createdAt.getTime() === anchor.createdAt.getTime() && row.id < anchor.id)));
    const result = await page(proof, { q: 'Beta', status, view, cursor: origin.nextCursor!, limit: 2 });
    expect(result.items.map(row => row.id)).toEqual(ordered(expected).slice(0, 2));
  }
  const missingAnchor = encodeApplicationCursor({ id: randomUUID(), createdAt: new Date(clock.getTime() + 1000) });
  expect((await page(proof, { q: 'Alpha', cursor: missingAnchor })).items.map(row => row.id))
    .toEqual(ordered(rows.filter((row, index) => specs[index]!.jobTitle === 'Alpha' && row.archivedAt === null)));
});

it('retains create/edit/archive/restore/history behavior and reflects changed filter membership on later reads', async () => {
  const proof = await session(await user());
  let row = await create(proof, { company: marker + 'old membership', jobTitle: 'First title' });
  expect(row.version).toBe(1); await walk(proof, { q: 'old membership', status: 'SAVED' }, [row.id]);
  row = await update(proof, row, { company: marker + 'new membership', jobTitle: 'Second title', status: 'APPLIED', applicationDate: '2024-02-29' });
  expect(row.version).toBe(2);
  await walk(proof, { q: 'old membership' }, []); await walk(proof, { q: 'new membership', status: 'APPLIED' }, [row.id]);
  const eventsBefore = listApplicationHistoryResponseSchema.parse((await request(app()).get(`${path}/${row.id}/history`).set(headers(proof)).expect(200)).body);
  expect(eventsBefore.items).toHaveLength(1); expect(eventsBefore.items[0]).toMatchObject({ fromStatus: 'SAVED', toStatus: 'APPLIED', applicationVersion: 2 });
  row = await lifecycle(proof, row, 'archive'); expect(row.version).toBe(3);
  await walk(proof, { q: 'new membership' }, []); await walk(proof, { q: 'new membership', view: 'archived', status: 'APPLIED' }, [row.id]);
  const detail = applicationSchema.parse((await request(app()).get(`${path}/${row.id}`).set(headers(proof)).expect(200)).body.application);
  expect(detail).toEqual(row);
  row = await lifecycle(proof, row, 'restore'); expect(row.version).toBe(4);
  await walk(proof, { q: 'Second title', status: 'APPLIED' }, [row.id]); await walk(proof, { view: 'archived' }, []);
  expect(listApplicationHistoryResponseSchema.parse((await request(app()).get(`${path}/${row.id}/history`).set(headers(proof)).expect(200)).body)).toEqual(eventsBefore);
  expect(row.applicationDate).toBe('2024-02-29');
});

it('rejects malformed HTTP queries before committing session activity or changing fixtures', async () => {
  const proof = await session(await user()), row = await create(proof), old = await state(row.id);
  time = new Date(clock.getTime() + 1000);
  for (const query of ['q=A&q=B', 'q=A&q=A', 'q%5B%5D=A', 'q%5Bcontains%5D=A', 'q=%00',
    'q=' + 'x'.repeat(201), 'status=SAVED&status=APPLIED', 'status=SAVED&status=SAVED', 'status=ALL', 'status=saved',
    'status%5B%5D=SAVED', 'view=all', 'limit=51', 'cursor=invalid', 'ownerId=other', 'unknown=value']) {
    const response = await request(app()).get(path + '?' + query).set(headers(proof)).expect(400);
    expect(response.body).toEqual({ code: 'INVALID_REQUEST', message: query === 'cursor=invalid' ? 'Invalid application cursor.' : 'Invalid application list query.' });
  }
  expect(await state(row.id)).toEqual(old);
});

it('enforces sessions, Origin, request admission and mutation CSRF without changing rejected session activity', async () => {
  const owner = await user(), proof = await session(owner), anonymous = await session(null), expired = await session(owner), revoked = await session(owner);
  const row = await create(proof);
  await fixtureWrite(async tx => {
    await tx.session.update({ where: { id: expired.session.id, userId: owner, tokenHash: sessions.get(expired.session.id)!.tokenHash }, data: { expiresAt: clock } });
    await admit(tx);
    await tx.session.delete({ where: { id: revoked.session.id, userId: owner, tokenHash: sessions.get(revoked.session.id)!.tokenHash } });
  });
  const old = await state(row.id); time = new Date(clock.getTime() + 1000);
  for (const invalid of [anonymous, expired, revoked, { ...proof, token: generateToken() }]) {
    await request(app()).get(path).query({ q: 'company', status: 'SAVED', view: 'archived' }).set(headers(invalid)).expect(401);
  }
  await request(app()).get(path + '?q=company').set(headers(proof)).unset('Cookie').expect(401);
  await request(app()).get(path + '?q=company').set(headers(proof)).set('Origin', 'https://evil.invalid').expect(403);
  await request(app()).get(path + '?q=company').set(headers(proof)).unset('X-ApplyFlow-Request').expect(403);
  await request(app()).get(path + '?q=company').set(headers(proof)).set('Sec-Fetch-Site', 'cross-site').expect(403);
  await request(app()).put(`${path}/${row.id}`).set(headers(proof)).unset('X-CSRF-Token').send(edit(row, { notes: 'rejected' })).expect(403);
  const limited = app();
  for (let index = 0; index < AUTH_LIMITS.requests; index++) await request(limited).get(path + '?status=invalid').set(headers(proof)).expect(400);
  await request(limited).get(path + '?q=company').set(headers(proof)).expect(429).expect(response => { expect(response.headers['retry-after']).toBeDefined(); });
  expect(await state(row.id)).toEqual(old);
  // GET does not acquire a new CSRF requirement; a valid owner still reads normally.
  expect((await request(app()).get(path + '?q=company').set(headers(proof)).unset('X-CSRF-Token').expect(200)).body.items.map((item: Application) => item.id)).toEqual([row.id]);
}, 30000);

type PlanNode = { 'Node Type': string; 'Actual Rows': number; 'Actual Loops': number;
  'Index Name'?: string; 'Rows Removed by Filter'?: number; 'Shared Hit Blocks'?: number; 'Shared Read Blocks'?: number; Plans?: PlanNode[] };
it.each(['selective', 'no-match'] as const)('observes a bounded read-only %s EXPLAIN on controlled fixtures without asserting a planner choice', async kind => {
  const owner = await user(), foreign = await user();
  await seed(owner, Array.from({ length: 96 }, (_, index) => ({ status: 'APPLIED', archived: index % 6 === 0,
    jobTitle: index === 47 ? 'prefix selective-search suffix' : 'Engineer' })));
  await seed(foreign, [{ jobTitle: 'selective-search', status: 'APPLIED' }]);
  const q = kind === 'selective' ? 'selective-search' : 'never-present-search', rollback = new Error('Plan inspection rollback');
  let inspected = false;
  try {
    await client().$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
      await identity(tx, 'repeatable read'); await historyAdmission(tx); await schemaAdmission(tx); await inventory(tx); await clientsAdmission(tx);
      const setting = await tx.$queryRaw<Array<{ readOnly: string }>>`SELECT current_setting('transaction_read_only') AS "readOnly"`;
      expect(setting[0]?.readOnly).toBe('on');
      // Parameterized representative SQL with the same list projection, predicates,
      // ordering and limit. This is not a capture of the exact ORM-issued statement.
      const rows = await tx.$queryRaw<Array<{ 'QUERY PLAN': Array<{ Plan: PlanNode; 'Planning Time': number; 'Execution Time': number }> }>>`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
        SELECT id, company, "jobTitle", status::text, "applicationDate", location, "jobUrl", notes,
          "createdAt", "updatedAt", version, "archivedAt" FROM public."JobApplication"
        WHERE "userId"=${owner}::uuid AND "archivedAt" IS NULL AND status='APPLIED'::"ApplicationStatus"
          AND (company ILIKE ('%' || ${q} || '%') OR "jobTitle" ILIKE ('%' || ${q} || '%'))
        ORDER BY "createdAt" DESC, id DESC LIMIT 21
      `;
      const plan = rows[0]?.['QUERY PLAN'][0];
      expect(plan).toBeDefined(); expect(plan!.Plan['Actual Rows']).toBe(kind === 'selective' ? 1 : 0);
      expect(Number.isFinite(plan!['Planning Time'])).toBe(true); expect(Number.isFinite(plan!['Execution Time'])).toBe(true);
      const nodes: Array<Record<string, string | number>> = [];
      function visit(node: PlanNode) {
        if (nodes.length >= 50) throw new Error('Unexpected plan size');
        nodes.push({ type: node['Node Type'], rows: node['Actual Rows'], loops: node['Actual Loops'],
          removedByFilter: node['Rows Removed by Filter'] ?? 0, sharedHits: node['Shared Hit Blocks'] ?? 0,
          sharedReads: node['Shared Read Blocks'] ?? 0, ...(node['Index Name'] ? { index: node['Index Name'] } : {}) });
        node.Plans?.forEach(visit);
      }
      visit(plan!.Plan);
      console.info('Controlled search/filter planner observation; small fixtures, no scale claim.', {
        kind, fixtures: { owner: 96, foreign: 1 }, planningMs: plan!['Planning Time'], executionMs: plan!['Execution Time'], nodes
      });
      await clientsAdmission(tx); inspected = true; throw rollback;
    }, { timeout: 10000, maxWait: 3000 });
  } catch (error) {
    if (error === rollback && inspected) return;
    stopped = true;
    // eslint-disable-next-line preserve-caught-error
    throw new Error('Read-only EXPLAIN/rollback not confirmed; no retry or cleanup writes.');
  }
  stopped = true; throw new Error('EXPLAIN inspection unexpectedly committed.');
}, 30000);
afterEach(async context => {
  if (stopped) { reportResiduals(); return; }
  try {
    await clientsAdmission(client());
    await fixtureWrite(async tx => {
      // Inventory must prove every linked ID before any delete, including rows
      // created inside rolled-back probes. Missing recorded IDs are harmless.
      await admit(tx);
      const ownedHistory = [...events].flatMap(([id, value]) => {
        const owner = applications.get(value.applicationId);
        // The missing-parent FK probe must roll back. Inventory rejects it if
        // it ever exists; never weaken an ownership predicate to undefined.
        return owner ? [{ id, ...value, application: { userId: owner, company: { startsWith: marker } } }] : [];
      });
      if (ownedHistory.length) await tx.applicationStatusHistory.deleteMany({ where: { OR: ownedHistory } });
      await admit(tx);
      if (applications.size) await tx.jobApplication.deleteMany({ where: { OR: [...applications].map(([id, userId]) => ({ id, userId, company: { startsWith: marker } })) } });
      await admit(tx);
      if (sessions.size) await tx.session.deleteMany({ where: { OR: [...sessions].map(([id, expected]) => ({ id, ...expected })) } });
      await admit(tx);
      if (users.size) await tx.user.deleteMany({ where: { OR: [...users].map(id => ({ id, email: `${marker}${id}@example.invalid` })) } });
      expect(await tx.applicationStatusHistory.count()).toBe(0); expect(await tx.jobApplication.count()).toBe(0);
      expect(await tx.session.count()).toBe(0); expect(await tx.user.count()).toBe(0);
    });
    // Verify committed cleanup visibility before discarding the recorded IDs.
    await admit(client());
    expect(await client().applicationStatusHistory.count()).toBe(0); expect(await client().jobApplication.count()).toBe(0);
    expect(await client().session.count()).toBe(0); expect(await client().user.count()).toBe(0);
    await readOnlyInspection();
    users.clear(); sessions.clear(); applications.clear(); events.clear();
  } catch {
    stopped = true; reportResiduals(); throw new Error('Owned fixture cleanup not proven complete; no retry or wider deletion attempted.');
  }
  if (context.task.result?.state === 'fail') stopped = true;
});
afterAll(async () => {
  if (stopped && (users.size || sessions.size || applications.size || events.size
    || Object.values(unexpected).some(ids => ids.size))) reportResiduals();
  try { await connection?.client.$disconnect(); connection = undefined; pids.clear(); }
  catch { throw new Error('Execution connection closure could not be confirmed.'); }
  if (!executionAdmitted) return; // Failed preflight never grants a new connection or writes.
  let verificationFailed = false;
  try {
    await verifyMigrationFiles();
    connection = await openLocalDatabase('test', process.env);
    await readOnlyInspection();
  } catch {
    verificationFailed = true; reportResiduals();
  }
  try { await connection?.client.$disconnect(); connection = undefined; pids.clear(); }
  catch { throw new Error('Independent inspection connection closure could not be confirmed.'); }
  if (verificationFailed) throw new Error('Independent final read-only verification failed; connection closed; no repair or cleanup retry.');
  console.info('Independent search/filter post-verification passed; all pools closed.', {
    counts: { users: 0, sessions: 0, applications: 0, history: 0 }, schemaFingerprint, migrationFingerprint
  });
});
