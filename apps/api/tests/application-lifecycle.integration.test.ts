import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { applicationSchema, listApplicationHistoryResponseSchema, listApplicationsResponseSchema, type Application, type ApplicationStatus,
  type UpdateApplicationRequest } from '@applyflow/contracts';
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
import { assertApprovedChain, validateMigrationHistory, validateMigrationTables, verifyMigrationFiles,
  type MigrationHistoryRow } from '../scripts/migration-policy.js';

// No live defaults or top-level connection. Only the separately selected serial
// integration runner can invoke beforeAll and admit the exact test target.
const path = '/api/applications';
const marker = `lifecycle-${randomUUID()}-`;
const clock = new Date('2026-10-22T12:00:00.000Z');
let time = clock;
let connection: Awaited<ReturnType<typeof openLocalDatabase>> | undefined;
let stopped = false;
const users = new Set<string>();
const sessions = new Map<string, { userId: string | null; tokenHash: string }>();
const applications = new Map<string, string>();
const events = new Map<string, { applicationId: string; applicationVersion: number; fromStatus: ApplicationStatus; toStatus: ApplicationStatus }>();
const unexpected = { users: new Set<string>(), sessions: new Set<string>(), applications: new Set<string>(), history: new Set<string>() };
const pids = new Set<number>();
type Tx = Prisma.TransactionClient;

function client() {
  const target = requireTestDatabaseTarget(process.env);
  if (target.host !== '127.0.0.1' || target.port !== '5433' || target.database !== 'applyflow_test'
    || target.username !== 'applyflow_test' || !connection) throw new Error('Exact test connection is not admitted.');
  if (connection.target.connectionString !== target.connectionString) throw new Error('Test target changed.');
  return connection.client;
}
function reportResiduals() {
  // UUIDs only. Never serialize Session objects, proof headers, errors or URLs.
  console.error('Recorded/possible residual lifecycle fixture IDs; no broader cleanup authorized:', {
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
    await schemaAdmission(database); await inventory(database);
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
type Fault = { kind: 'afterChildren' | 'invalidDeleteResponse' | 'invalidArchiveResponse' | 'updateFailure';
  childrenDeleted: number; parentDeleted: boolean; updates: number };
function guardedDatabase(fault?: Fault): ApplicationDatabase {
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
          if (!args.where.id || applications.get(args.where.id) !== args.where.userId) throw new Error('Unowned HTTP update rejected.');
          if (fault) fault.updates++;
          if (fault?.kind === 'updateFailure') throw new Error('Owned update failure probe.');
          const result = await target.update(args);
          return fault?.kind === 'invalidArchiveResponse' ? { ...result, archivedAt: null } : result;
        };
        if (key === 'delete') return async (args: Prisma.JobApplicationDeleteArgs) => {
          await admit(tx);
          if (!args.where.id || applications.get(args.where.id) !== args.where.userId
            || typeof args.where.version !== 'number' || JSON.stringify(args.where.archivedAt) !== '{"not":null}') {
            throw new Error('Unowned or insufficiently scoped HTTP deletion rejected.');
          }
          if (fault?.kind === 'afterChildren') throw new Error('Failure after real child deletion.');
          const result = await target.delete(args);
          if (fault) fault.parentDeleted = true;
          return fault?.kind === 'invalidDeleteResponse' ? { ...result, id: 'invalid' } : result;
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
          if (fault) fault.childrenDeleted = result.count;
          return result;
        };
        return Reflect.get(target, key);
      } })
    };
    return work(guarded);
  }) };
}
function app(fault?: Fault) {
  return createApp(parseEnv({ NODE_ENV: 'test' }), { config: parseAuthConfig({ NODE_ENV: 'test' }),
    sessions: createSessionService(client(), { now: () => time }) }, {
    applications: createApplicationService(guardedDatabase(fault), { now: () => time, timeZone: 'America/Los_Angeles' })
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
        WHERE a.datname=current_database() AND NOT l.granted)::int AS count
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
      await historyAdmission(tx); await schemaAdmission(tx); await inventory(tx); await clientsAdmission(tx);
      if (await tx.user.count() || await tx.session.count() || await tx.jobApplication.count()
        || await tx.applicationStatusHistory.count()) throw new Error('Test database is not empty.');
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
    // Close the admission pool before constructing the separate execution pool.
    connection = await openLocalDatabase('test', process.env);
    await admit(client()); await clientsAdmission(client());
  } catch {
    stopped = true; throw new Error('Test preflight or admission connection closure failed; no test writes authorized.');
  }
});
beforeEach(async () => {
  if (stopped) throw new Error('Suite stopped; refusing further test writes.');
  time = clock;
  await admit(client());
  try { await clientsAdmission(client()); }
  catch { stopped = true; throw new Error('Competing client/lock admission failed; writes stopped.'); }
});
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
  let failed = false;
  try { if (connection && !stopped) await readOnlyInspection(); }
  catch { failed = true; }
  try { await connection?.client.$disconnect(); }
  catch { throw new Error('Test database connection closure could not be confirmed.'); }
  if (failed) throw new Error('Final read-only verification did not complete; connection closed.');
});

type Operation = 'archive' | 'restore' | 'delete' | 'edit';
function operation(proof: Proof, row: Application, kind: Operation, fault?: Fault) {
  const http = request(app(fault)), url = `${path}/${row.id}`;
  if (kind === 'edit') return http.put(url).set(headers(proof)).send(edit(row, { status: 'INTERVIEW', applicationDate: '2024-02-29' }));
  if (kind === 'delete') return http.delete(url).set(headers(proof)).send({ expectedVersion: row.version, confirmPermanentDeletion: true });
  return http.post(`${url}/${kind}`).set(headers(proof)).send({ expectedVersion: row.version });
}
async function lifecycle(proof: Proof, row: Application, kind: 'archive' | 'restore') {
  return applicationSchema.parse((await operation(proof, row, kind).expect(200)).body.application);
}
function preserved(row: Application) {
  return { id: row.id, company: row.company, jobTitle: row.jobTitle, status: row.status,
    applicationDate: row.applicationDate, location: row.location, jobUrl: row.jobUrl, notes: row.notes, createdAt: row.createdAt };
}
function fault(kind: Fault['kind']): Fault { return { kind, childrenDeleted: 0, parentDeleted: false, updates: 0 }; }
async function history(proof: Proof, row: Application) {
  return listApplicationHistoryResponseSchema.parse((await request(app()).get(`${path}/${row.id}/history`).set(headers(proof)).expect(200)).body);
}

// A holder plus TWO real service transactions, each with its own authenticated
// Session lock. Observe PostgreSQL lock waits before releasing the owned row.
// Start the second only after the first is waiting: both winner orders are
// exercised by the table below, without replacing SQL or serializing HTTP calls.
async function contend(row: Application, proofs: [Proof, Proof], kinds: [Operation, Operation]) {
  const owner = applications.get(row.id);
  if (!owner || proofs.some(proof => proof.session.userId !== owner) || proofs[0].session.id === proofs[1].session.id) {
    throw new Error('Race fixture ownership/session separation rejected.');
  }
  let release!: () => void, ready!: (pid: number) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve; timer = setTimeout(() => reject(new Error('Owned row gate timed out.')), 7000);
  });
  void gate.catch(() => undefined);
  const locked = new Promise<number>(resolve => { ready = resolve; });
  const holder = client().$transaction(async tx => {
    await admit(tx);
    await tx.$executeRaw`SET LOCAL statement_timeout = '8s'`;
    await tx.$queryRaw`SELECT id FROM public."JobApplication" WHERE id=${row.id}::uuid AND "userId"=${owner}::uuid FOR UPDATE`;
    const pid = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    ready(pid[0]!.pid); await gate;
  }, { timeout: 10000, maxWait: 3000, isolationLevel: 'ReadCommitted' });
  void holder.catch(() => undefined);
  const pending: Array<Promise<PromiseSettledResult<request.Response>>> = [];
  let failed = false;
  async function waitFor(blocker: number, count: number) {
    for (let attempt = 0; attempt < 80; attempt++) {
      await identity(client());
      const rows = await client().$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname=current_database() AND pid<>${blocker} AND pid=ANY(${[...pids]}::int[])
          AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0
          AND query LIKE '%public."JobApplication"%' AND query LIKE '%FOR UPDATE%'
      `;
      if (rows[0]?.waiting === count) return;
      await delay(25);
    }
    throw new Error('Expected real overlapping application lock waits were not observed.');
  }
  try {
    const blocker = await Promise.race([locked, holder.then(() => { throw new Error('Holder ended before contention.'); })]);
    for (const index of [0, 1] as const) {
      pending.push(operation(proofs[index], row, kinds[index]).then(
        value => ({ status: 'fulfilled' as const, value }), () => ({ status: 'rejected' as const, reason: undefined })));
      await waitFor(blocker, index + 1);
    }
  } catch { failed = true; }
  finally {
    clearTimeout(timer); release();
    try { await holder; } catch { failed = true; }
  }
  const settled = await Promise.all(pending);
  if (settled.some(result => result.status === 'rejected')) {
    stopped = true; throw new Error('Concurrent HTTP outcome uncertain; no replay or cleanup.');
  }
  if (failed || settled.length !== 2) throw new Error('Real concurrent transactions were not established; no race result claimed.');
  return settled.map(result => (result as PromiseFulfilledResult<request.Response>).value) as [request.Response, request.Response];
}

it('persists archive/restore, preserves details and history, and records the real prior status after restoration', async () => {
  const proof = await session(await user());
  let row = await create(proof, { location: 'Manila', jobUrl: 'https://example.invalid/job', notes: 'fixture notes', applicationDate: '2024-02-29' });
  row = await update(proof, row, { status: 'APPLIED' });
  const original = row, oldHistory = (await state(row.id)).history;
  time = new Date(clock.getTime() + 1000);
  row = await lifecycle(proof, row, 'archive');
  expect(row.archivedAt).toBe(time.toISOString()); expect(row.version).toBe(original.version + 1);
  expect(preserved(row)).toEqual(preserved(original)); expect((await state(row.id)).history).toEqual(oldHistory);
  expect((await state(row.id)).application).toMatchObject({ archivedAt: time, version: row.version });
  const archived = row; time = new Date(clock.getTime() + 2000);
  row = await lifecycle(proof, row, 'restore');
  expect(row.archivedAt).toBeNull(); expect(row.version).toBe(archived.version + 1);
  expect(preserved(row)).toEqual(preserved(original)); expect((await state(row.id)).history).toEqual(oldHistory);
  row = await update(proof, row, { status: 'INTERVIEW' });
  expect((await state(row.id)).history).toEqual([
    expect.objectContaining({ fromStatus: 'APPLIED', toStatus: 'INTERVIEW', applicationVersion: row.version }), ...oldHistory
  ]);
  expect((await history(proof, row)).items.map(event => event.applicationVersion)).toEqual([5, 2]);
});

it('preserves current-version no-ops but conflicts on stale repeats, archived edits and active deletes without session refresh', async () => {
  const proof = await session(await user()); const active = await create(proof);
  time = new Date(clock.getTime() + 1000);
  const initial = await state(active.id);
  expect(await lifecycle(proof, active, 'restore')).toEqual(active);
  expect((await state(active.id)).application).toEqual(initial.application);
  let old = await state(active.id);
  await operation(proof, active, 'delete').expect(409).expect(({ body }) => expect(body.conflictReason).toBe('APPLICATION_NOT_ARCHIVED'));
  expect(await state(active.id)).toEqual(old);
  const archived = await lifecycle(proof, active, 'archive');
  expect(preserved(archived)).toEqual(preserved(active));
  const beforeNoop = await state(active.id);
  time = new Date(clock.getTime() + 2000);
  expect(await lifecycle(proof, archived, 'archive')).toEqual(archived);
  expect((await state(active.id)).application).toEqual(beforeNoop.application);
  old = await state(active.id);
  for (const kind of ['archive', 'restore', 'delete', 'edit'] as const) {
    await operation(proof, active, kind).expect(409).expect(({ body }) => expect(body.conflictReason).toBe('STALE_VERSION'));
    expect(await state(active.id)).toEqual(old);
  }
  for (const changes of [{}, { notes: 'cannot edit archived' }]) {
    await request(app()).put(`${path}/${archived.id}`).set(headers(proof)).send(edit(archived, changes)).expect(409)
      .expect(({ body }) => expect(body.conflictReason).toBe('APPLICATION_ARCHIVED'));
    expect(await state(active.id)).toEqual(old);
  }
  const restored = await lifecycle(proof, archived, 'restore'); old = await state(active.id);
  await operation(proof, archived, 'restore').expect(409).expect(({ body }) => expect(body.conflictReason).toBe('STALE_VERSION'));
  expect(await state(active.id)).toEqual(old); expect(restored.version).toBe(3);
});

it('keeps foreign and missing detail/history/edit/lifecycle responses indistinguishable for both lifecycle states', async () => {
  const owner = await session(await user()), foreign = await session(await user());
  let row = await create(owner); const missing = randomUUID();
  for (const archived of [false, true]) {
    if (archived) row = await lifecycle(owner, row, 'archive');
    const owned = await request(app()).get(`${path}/${row.id}`).set(headers(owner)).expect(200);
    expect(applicationSchema.parse(owned.body.application)).toEqual(row); await history(owner, row);
    const old = await state(row.id); time = new Date(time.getTime() + 1000);
    for (const suffix of ['', '/history']) {
      const a = await request(app()).get(`${path}/${row.id}${suffix}`).set(headers(foreign)).expect(404);
      const b = await request(app()).get(`${path}/${missing}${suffix}`).set(headers(foreign)).expect(404);
      expect(a.body).toEqual(b.body);
    }
    for (const kind of ['archive', 'restore', 'delete', 'edit'] as const) {
      const a = await operation(foreign, row, kind).expect(404);
      const b = await operation(foreign, { ...row, id: missing }, kind).expect(404);
      expect(a.body).toEqual(b.body);
    }
    // Foreign requests above must not commit a refresh of the attacker's session.
    expect(await state(row.id)).toEqual(old);
  }
});

it.each([0, 1, 3])('permanently deletes only the archived owned parent and its %i history events', async count => {
  const proof = await session(await user()), other = await session(await user());
  let row = await create(proof), sibling = await create(proof), foreign = await create(other);
  for (let i = 0; i < count; i++) row = await update(proof, row, { status: i % 2 ? 'SAVED' : 'APPLIED', applicationDate: '2024-02-29' });
  sibling = await update(proof, sibling, { status: 'APPLIED', applicationDate: '2024-02-29' });
  foreign = await update(other, foreign, { status: 'OFFER', applicationDate: '2024-02-29' });
  row = await lifecycle(proof, row, 'archive');
  const unrelated = [await state(sibling.id), await state(foreign.id)];
  expect((await state(row.id)).history).toHaveLength(count);
  const response = await operation(proof, row, 'delete').expect(200);
  expect(response.body).toEqual({ deletedApplicationId: row.id });
  const deleted = await state(row.id); expect(deleted.application).toBeNull(); expect(deleted.history).toEqual([]);
  expect((await state(sibling.id)).application).toEqual(unrelated[0]!.application);
  expect((await state(sibling.id)).history).toEqual(unrelated[0]!.history);
  expect((await state(foreign.id)).application).toEqual(unrelated[1]!.application);
  expect((await state(foreign.id)).history).toEqual(unrelated[1]!.history);
  const activity = deleted.activity; time = new Date(clock.getTime() + 1000);
  await operation(proof, row, 'delete').expect(404); expect((await state(row.id)).activity).toEqual(activity);
});

it.each(['afterChildren', 'invalidDeleteResponse'] as const)('rolls back actual child deletion, parent and session activity on %s', async kind => {
  const proof = await session(await user()); let row = await create(proof);
  row = await update(proof, row, { status: 'APPLIED', applicationDate: '2024-02-29' });
  row = await update(proof, row, { status: 'INTERVIEW' }); row = await lifecycle(proof, row, 'archive');
  const old = await state(row.id), probe = fault(kind); time = new Date(clock.getTime() + 1000);
  await operation(proof, row, 'delete', probe).expect(503);
  expect(probe.childrenDeleted).toBe(2); expect(probe.parentDeleted).toBe(kind === 'invalidDeleteResponse');
  expect(await state(row.id)).toEqual(old);
});

it.each(['invalidArchiveResponse', 'updateFailure'] as const)('rolls back lifecycle update and session refresh on %s', async kind => {
  const proof = await session(await user()), row = await create(proof), old = await state(row.id), probe = fault(kind);
  time = new Date(clock.getTime() + 1000);
  await operation(proof, row, 'archive', probe).expect(503);
  expect(probe.updates).toBe(1); expect(await state(row.id)).toEqual(old);
});

it('enforces the actual RESTRICT foreign key and existing date/version/history constraints in rolled-back probes', async () => {
  const owner = await user(), proof = await session(owner); let row = await create(proof);
  row = await update(proof, row, { status: 'APPLIED', applicationDate: '2024-02-29' });
  row = await lifecycle(proof, row, 'archive'); const old = await state(row.id);
  const probes: Array<{ state: string; run: (tx: Tx) => Promise<unknown> }> = [
    { state: '23503', run: tx => tx.jobApplication.delete({ where: { id: row.id, userId: owner } }) },
    { state: '23514', run: tx => tx.jobApplication.update({ where: { id: row.id, userId: owner }, data: { version: 0 } }) },
    { state: '23514', run: tx => tx.jobApplication.update({ where: { id: row.id, userId: owner }, data: { applicationDate: null } }) }
  ];
  for (const data of [
    { applicationId: row.id, fromStatus: 'APPLIED' as const, toStatus: 'APPLIED' as const, applicationVersion: 4 },
    { applicationId: row.id, fromStatus: 'APPLIED' as const, toStatus: 'INTERVIEW' as const, applicationVersion: 1 }
  ]) {
    const id = randomUUID(); events.set(id, data);
    probes.push({ state: '23514', run: tx => tx.applicationStatusHistory.create({ data: { id, ...data } }) });
  }
  for (const probe of probes) {
    let sqlState: unknown;
    try { await fixtureWrite(async tx => { await probe.run(tx); throw new Error('Constraint probe unexpectedly passed; force rollback.'); }); }
    catch (error) { if (error && typeof error === 'object' && 'sqlState' in error) sqlState = error.sqlState; }
    expect(sqlState).toBe(probe.state); expect(await state(row.id)).toEqual(old);
  }
});

it.each([
  ['edit', 'archive'], ['archive', 'edit'], ['archive', 'archive'],
  ['archive', 'restore'], ['restore', 'archive'], ['restore', 'delete'], ['delete', 'restore']
] as Array<[Operation, Operation]>)('overlaps real PostgreSQL transactions for %s then %s', async (firstKind, secondKind) => {
  const owner = await user(), first = await session(owner), second = await session(owner);
  let row = await create(first);
  const initiallyArchived = firstKind === 'delete' || secondKind === 'delete';
  if (initiallyArchived) {
    row = await update(first, row, { status: 'APPLIED', applicationDate: '2024-02-29' });
    row = await lifecycle(first, row, 'archive');
  }
  const old = await state(row.id); time = new Date(clock.getTime() + 1000);
  const [a, b] = await contend(row, [first, second], [firstKind, secondKind]);
  expect(a.status).toBe(200);
  const noopFirst = firstKind === 'restore' && !initiallyArchived;
  const expectedLoser = firstKind === 'delete' ? 404 : 409;
  expect(b.status).toBe(noopFirst ? 200 : expectedLoser);
  const saved = await state(row.id);
  if (firstKind === 'delete') { expect(saved.application).toBeNull(); expect(saved.history).toEqual([]); }
  else {
    expect(saved.application?.version).toBe(row.version + 1);
    const winner = applicationSchema.parse((noopFirst ? b : a).body.application);
    expect(saved.application).toMatchObject({ id: row.id, status: winner.status, archivedAt: winner.archivedAt ? time : null });
    expect(preserved(winner)).toEqual({ ...preserved(row), ...(firstKind === 'edit' ? { status: 'INTERVIEW', applicationDate: '2024-02-29' } : {}) });
    if (firstKind === 'edit') expect(saved.history).toEqual([expect.objectContaining({ fromStatus: row.status, toStatus: 'INTERVIEW', applicationVersion: row.version + 1 })]);
    else expect(saved.history).toEqual(old.history);
    if (noopFirst) expect(applicationSchema.parse(a.body.application)).toEqual(row);
  }
  if (!noopFirst) {
    if (b.status === 409) expect(b.body.conflictReason).toBe('STALE_VERSION');
    expect(saved.activity.find(s => s.id === second.session.id)).toEqual(old.activity.find(s => s.id === second.session.id));
  }
  expect(saved.activity.find(s => s.id === first.session.id)?.lastSeenAt).toEqual(time);
  if (noopFirst) expect(saved.activity.find(s => s.id === second.session.id)?.lastSeenAt).toEqual(time);
}, 30000);

it('keeps active/archived cursor streams owner-scoped, ordered and stable across lifecycle changes and missing anchors', async () => {
  const owner = await user(), otherOwner = await user(), proof = await session(owner), other = await session(otherOwner);
  const ownedIds: string[] = [], foreignIds: string[] = [];
  const createdTimes = new Map<string, number>();
  await fixtureWrite(async tx => {
    const data = [owner, otherOwner].flatMap(userId => Array.from({ length: 9 }, (_, index) => {
      const id = randomUUID(); applications.set(id, userId);
      (userId === owner ? ownedIds : foreignIds).push(id);
      const createdAt = new Date(clock.getTime() - (index >= 6 ? 1000 : 0)); createdTimes.set(id, createdAt.getTime());
      return { id, userId, company: marker + 'pagination', jobTitle: `Fixture ${index}`, createdAt,
        archivedAt: index % 2 ? clock : null };
    }));
    if (await tx.jobApplication.count({ where: { id: { in: data.map(row => row.id) } } })) throw new Error('Pagination fixture collision.');
    await admit(tx); await tx.jobApplication.createMany({ data });
  });
  async function page(view: 'active' | 'archived', cursor?: string, as = proof) {
    return listApplicationsResponseSchema.parse((await request(app()).get(path).set(headers(as))
      .query({ view, limit: 2, ...(cursor ? { cursor } : {}) }).expect(200)).body);
  }
  async function walk(view: 'active' | 'archived', expected: string[]) {
    const ids: string[] = []; const cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const result = await page(view, cursor);
      for (const row of result.items) { expect(row.archivedAt === null).toBe(view === 'active'); expect(ownedIds.includes(row.id)).toBe(true); }
      ids.push(...result.items.map(row => row.id));
      cursor = result.nextCursor ?? undefined;
      if (cursor) { expect(cursors.has(cursor)).toBe(false); cursors.add(cursor); }
    } while (cursor);
    expect(ids).toEqual(expected); expect(new Set(ids).size).toBe(ids.length);
  }
  function order(a: string, b: string) { return createdTimes.get(b)! - createdTimes.get(a)! || (a < b ? 1 : -1); }
  function older(ids: string[], anchor: Application) {
    const stamp = new Date(anchor.createdAt).getTime();
    return ids.filter(id => createdTimes.get(id)! < stamp || (createdTimes.get(id) === stamp && id < anchor.id)).slice(0, 2);
  }
  const active = ownedIds.filter((_, i) => i % 2 === 0).sort(order);
  const archived = ownedIds.filter((_, i) => i % 2 === 1).sort(order);
  const defaults = listApplicationsResponseSchema.parse((await request(app()).get(path).set(headers(proof)).expect(200)).body);
  expect(defaults.items.map(row => row.id)).toEqual(active);
  await walk('active', active); await walk('archived', archived);
  // A cursor is a tuple boundary, never an owner grant. Use foreign anchors only
  // within the SAME view. Active/archived traversals each start with no cursor.
  for (const view of ['active', 'archived'] as const) {
    const foreignPage = await page(view, undefined, other); expect(foreignPage.nextCursor).not.toBeNull();
    const anchor = foreignPage.items.at(-1)!;
    const result = await page(view, foreignPage.nextCursor!);
    expect(result.items.map(row => row.id)).toEqual(older(view === 'active' ? active : archived, anchor));
    expect(result.items.some(row => foreignIds.includes(row.id))).toBe(false);
  }
  const firstPage = await page('active'), anchor = firstPage.items.at(-1)!;
  const changed = await lifecycle(proof, anchor, 'archive');
  const afterArchive = await page('active', firstPage.nextCursor!);
  expect(afterArchive.items.map(row => row.id)).toEqual(older(active, anchor));
  const restored = await lifecycle(proof, changed, 'restore'); await walk('active', active);
  const removed = await lifecycle(proof, restored, 'archive'); await operation(proof, removed, 'delete').expect(200);
  expect((await page('active', firstPage.nextCursor!)).items.map(row => row.id)).toEqual(afterArchive.items.map(row => row.id));
  await walk('active', active.filter(id => id !== anchor.id)); await walk('archived', archived);
});

it('rejects invalid sessions, CSRF, Origin and request metadata without committed effects on lifecycle endpoints', async () => {
  const owner = await user(), proof = await session(owner), anonymous = await session(null);
  const expired = await session(owner), revoked = await session(owner), row = await create(proof);
  await fixtureWrite(async tx => {
    await tx.session.update({ where: { id: expired.session.id, userId: owner, tokenHash: sessions.get(expired.session.id)!.tokenHash }, data: { expiresAt: clock } });
    await admit(tx);
    await tx.session.delete({ where: { id: revoked.session.id, userId: owner, tokenHash: sessions.get(revoked.session.id)!.tokenHash } });
  });
  const old = await state(row.id); time = new Date(clock.getTime() + 1000);
  for (const kind of ['archive', 'restore', 'delete'] as const) {
    for (const invalid of [anonymous, expired, revoked, { ...proof, token: generateToken() }]) {
      await operation(invalid, row, kind).expect(401);
    }
    await operation(proof, row, kind).unset('Cookie').expect(401);
    await operation(proof, row, kind).unset('X-CSRF-Token').expect(403);
    await operation(proof, row, kind).set('X-CSRF-Token', 'f'.repeat(64)).expect(403);
    await operation(proof, row, kind).set('Origin', 'https://untrusted.example').expect(403);
    await operation(proof, row, kind).unset('Origin').expect(403);
    await operation(proof, row, kind).unset('X-ApplyFlow-Request').expect(403);
    await operation(proof, row, kind).set('Sec-Fetch-Site', 'cross-site').expect(403);
    const plain = kind === 'delete' ? request(app()).delete(`${path}/${row.id}`) : request(app()).post(`${path}/${row.id}/${kind}`);
    await plain.set(headers(proof)).set('Content-Type', 'text/plain').send('unsupported representation').expect(415);
  }
  for (const suffix of ['', '/history']) {
    for (const invalid of [anonymous, expired, revoked]) {
      await request(app()).get(`${path}/${row.id}${suffix}`).set(headers(invalid)).expect(401);
    }
  }
  expect(await state(row.id)).toEqual(old);
});

it('strictly rejects lifecycle payloads, UUIDs, list/history queries and missing explicit deletion confirmation', async () => {
  const proof = await session(await user()), row = await create(proof), old = await state(row.id);
  time = new Date(clock.getTime() + 1000);
  for (const kind of ['archive', 'restore'] as const) {
    for (const body of [{}, { expectedVersion: '1' }, { expectedVersion: 0 }, { expectedVersion: 1.5 },
      { expectedVersion: 2147483648 }, { expectedVersion: 1, userId: proof.session.userId },
      { expectedVersion: 1, archivedAt: clock.toISOString() }, { expectedVersion: 1, version: 2 }]) {
      await request(app()).post(`${path}/${row.id}/${kind}`).set(headers(proof)).send(body).expect(400);
    }
    await request(app()).post(`${path}/invalid/${kind}`).set(headers(proof)).send({ expectedVersion: 1 }).expect(400);
    await operation(proof, row, kind).query({ extra: 'no' }).expect(400);
  }
  for (const body of [{ expectedVersion: 1 }, { expectedVersion: 1, confirmPermanentDeletion: false },
    { expectedVersion: 1, confirmPermanentDeletion: 'true' }, { expectedVersion: 1, confirmPermanentDeletion: true, userId: proof.session.userId }]) {
    await request(app()).delete(`${path}/${row.id}`).set(headers(proof)).send(body).expect(400);
  }
  await request(app()).delete(`${path}/invalid`).set(headers(proof)).send({ expectedVersion: 1, confirmPermanentDeletion: true }).expect(400);
  await operation(proof, row, 'delete').query({ force: 'true' }).expect(400);
  await request(app()).post(`${path}/${row.id}/archive`).set(headers(proof)).set('Content-Type', 'application/json')
    .send('{"expectedVersion":').expect(400);
  await request(app()).post(`${path}/${row.id}/archive`).set(headers(proof))
    .send({ expectedVersion: 1, notes: 'x'.repeat(17000) }).expect(413);
  for (const query of [{ view: 'all' }, { view: ['active', 'archived'] }, { limit: 51 }, { cursor: 'invalid' }, { ownerId: randomUUID() }]) {
    await request(app()).get(path).set(headers(proof)).query(query).expect(400);
  }
  await request(app()).get(`${path}/${row.id}/history`).set(headers(proof)).query({ view: 'archived' }).expect(400);
  expect(await state(row.id)).toEqual(old);
});

it('fails closed at INTEGER version exhaustion while retaining current-version lifecycle no-ops', async () => {
  const owner = await user(), proof = await session(owner), row = await create(proof);
  await fixtureWrite(tx => tx.jobApplication.update({ where: { id: row.id, userId: owner }, data: { version: 2147483647 } }));
  const maximum = applicationSchema.parse((await request(app()).get(`${path}/${row.id}`).set(headers(proof)).expect(200)).body.application);
  const old = await state(row.id);
  time = new Date(clock.getTime() + 1000);
  await operation(proof, maximum, 'archive').expect(503); expect(await state(row.id)).toEqual(old);
  const noop = await lifecycle(proof, maximum, 'restore'); expect(noop).toEqual(maximum);
  await fixtureWrite(tx => tx.jobApplication.update({ where: { id: row.id, userId: owner }, data: { archivedAt: clock } }));
  const archived = applicationSchema.parse((await request(app()).get(`${path}/${row.id}`).set(headers(proof)).expect(200)).body.application);
  const before = await state(row.id);
  time = new Date(clock.getTime() + 2000);
  await operation(proof, archived, 'restore').expect(503); expect(await state(row.id)).toEqual(before);
  expect(await lifecycle(proof, archived, 'archive')).toEqual(archived);
});

