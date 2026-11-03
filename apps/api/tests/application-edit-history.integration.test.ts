import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { applicationSchema, listApplicationHistoryResponseSchema, type Application, type ApplicationStatus,
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
const marker = `edit-history-${randomUUID()}-`;
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
  console.error('Recorded/possible residual edit/history fixture IDs; no broader cleanup authorized:', {
    users: [...users], sessions: [...sessions.keys()], applications: [...applications.keys()], history: [...events.keys()],
    unexpected: Object.fromEntries(Object.entries(unexpected).map(([key, ids]) => [key, [...ids]]))
  });
}
async function identity(database: Pick<Tx, '$queryRaw'>) {
  const rows = await database.$queryRaw<Array<{ database: string; username: string; sessionUser: string;
    version: string; port: number; address: string | null; isolation: string; pid: number }>>`
    SELECT current_database()::text AS database, current_user::text AS username, session_user::text AS "sessionUser",
      current_setting('server_version_num') AS version, inet_server_port() AS port, inet_server_addr()::text AS address,
      current_setting('transaction_isolation') AS isolation, pg_backend_pid() AS pid
  `;
  const row = rows[0];
  assertDatabaseIdentity(requireTestDatabaseTarget(process.env), row);
  if (rows.length !== 1 || row?.sessionUser !== 'applyflow_test' || !/^17\d{4}$/.test(row.version)
    || row.port !== 5432 || !row.address || row.isolation !== 'read committed') throw new Error('Unexpected connected test identity/settings.');
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
    client(); assertApprovedChain(); await identity(database); await historyAdmission(database); await inventory(database);
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
  try {
    return await client().$transaction(async tx => {
      entered = true; await admit(tx);
      const result = await work(tx); await admit(tx); completed = true; return result;
    }, { timeout: 8000, maxWait: 3000, isolationLevel: 'ReadCommitted' });
  } catch (error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
      && typeof error.code === 'string' && /^P\d{4}$/.test(error.code) ? error.code : undefined;
    const originalCode = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } } | null)
      ?.meta?.driverAdapterError?.cause?.originalCode;
    const sqlState = typeof originalCode === 'string' && ['23514','23503','23505'].includes(originalCode) ? originalCode : undefined;
    // A rejection after the callback returned may be an ambiguous commit. Do
    // not attempt cleanup or another write after that, or a connection failure.
    if (!entered || completed || (code && (/^P10/.test(code) || code === 'P2028'))) stopped = true;
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
type Fault = { enabled: boolean; inserted: boolean; rejected: boolean };
function guardedDatabase(fault?: Fault): ApplicationDatabase {
  return { $transaction: work => fixtureWrite(async tx => {
    const guarded: ApplicationTransaction = {
      session: tx.session,
      // Forward actual Prisma SQL unchanged; this is admission, not a SQL mock.
      $queryRaw: (async (query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => {
        await admit(tx); return tx.$queryRaw(query, ...values);
      }) as ApplicationTransaction['$queryRaw'],
      jobApplication: new Proxy(tx.jobApplication, { get(target, key) {
        if (key === 'create') return async (args: Prisma.JobApplicationCreateArgs) => {
          await admit(tx);
          const owner = args.data.userId;
          if (!owner || !users.has(owner) || !args.data.company.startsWith(marker)) throw new Error('Unowned HTTP create rejected.');
          const id = randomUUID(); applications.set(id, owner);
          return target.create({ ...args, data: { ...args.data, id } });
        };
        if (key === 'update') return async (args: Prisma.JobApplicationUpdateArgs) => {
          await admit(tx);
          if (!args.where.id || applications.get(args.where.id) !== args.where.userId) throw new Error('Unowned HTTP update rejected.');
          return target.update(args);
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
          const created = await target.create({ ...args, data: { ...data, id } });
          if (fault?.enabled) {
            fault.inserted = true;
            await admit(tx);
            const duplicate = randomUUID(); events.set(duplicate, events.get(id)!);
            try { await target.create({ data: { ...data, id: duplicate } }); }
            catch (error) {
              fault.rejected = typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
            }
            // Force rollback even if the expected database rejection is absent.
            throw new Error('History insertion failure probe forced rollback.');
          }
          return created;
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

beforeAll(async () => {
  loadLocalEnvironment();
  const target = requireTestDatabaseTarget(process.env);
  if (target.host !== '127.0.0.1' || target.port !== '5433' || target.database !== 'applyflow_test' || target.username !== 'applyflow_test') throw new Error('Unexpected target.');
  assertApprovedChain(); await verifyMigrationFiles();
  connection = await openLocalDatabase('test', process.env);
  await admit(client());
  try { await schemaAdmission(client()); }
  catch { stopped = true; throw new Error('Test catalog admission failed; writes stopped.'); }
  const peers = await client().$queryRaw<Array<{ others: number }>>`
    SELECT count(*)::int AS others FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type='client backend'
  `;
  if (peers[0]?.others !== 0) { stopped = true; throw new Error('Competing test database clients found.'); }
});
beforeEach(async () => {
  if (stopped) throw new Error('Suite stopped; refusing further test writes.');
  time = clock;
  await admit(client());
  try { await schemaAdmission(client()); }
  catch { stopped = true; throw new Error('Test catalog admission failed; writes stopped.'); }
});
afterEach(async context => {
  if (stopped) { reportResiduals(); return; }
  try {
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
    users.clear(); sessions.clear(); applications.clear(); events.clear();
  } catch {
    stopped = true; reportResiduals(); throw new Error('Owned fixture cleanup not proven complete; no retry or wider deletion attempted.');
  }
  if (context.task.result?.state === 'fail') stopped = true;
});
afterAll(async () => {
  if (stopped && (users.size || sessions.size || applications.size || events.size
    || Object.values(unexpected).some(ids => ids.size))) reportResiduals();
  try { await connection?.client.$disconnect(); }
  catch { throw new Error('Test database connection closure could not be confirmed.'); }
});

it('retrieves an authenticated owned detail with its persisted version and public fields', async () => {
  const owner = await user(); const proof = await session(owner); const row = await create(proof);
  const response = await request(app()).get(`${path}/${row.id}`).set(headers(proof)).expect(200);
  expect(response.body).toEqual({ application: row }); expect(row.version).toBe(1);
  expect(Object.keys(row).sort()).toEqual(['applicationDate','company','createdAt','id','jobTitle','jobUrl','location','notes','status','updatedAt','version']);
  expect((await state(row.id)).history).toEqual([]);
});

it('returns indistinguishable missing/foreign 404s for detail, PUT and history', async () => {
  const first = await session(await user()), second = await session(await user()); const row = await create(first);
  const old = await state(row.id); const missing = randomUUID();
  for (const id of [row.id, missing]) {
    for (const response of [await request(app()).get(`${path}/${id}`).set(headers(second)).expect(404),
      await request(app()).put(`${path}/${id}`).set(headers(second)).send(edit(row)).expect(404),
      await request(app()).get(`${path}/${id}/history`).set(headers(second)).expect(404)]) {
      expect(response.body).toEqual({ code: 'NOT_FOUND', message: 'Application not found.' });
    }
  }
  expect(await state(row.id)).toEqual(old);
});

it('increments once for a non-status edit without history and preserves a complete normalized no-op', async () => {
  const proof = await session(await user()); const row = await create(proof); const original = await state(row.id);
  time = new Date(clock.getTime() + 1000);
  const noop = await update(proof, row, { company: ` ${row.company} `, location: ' ', notes: '' });
  expect(noop).toEqual(row); expect((await state(row.id)).application).toEqual(original.application);
  const changed = await update(proof, row, { company: marker + 'edited', notes: ' exact\nnotes ' });
  expect(changed).toMatchObject({ id: row.id, version: 2, createdAt: row.createdAt, updatedAt: time.toISOString(), notes: ' exact\nnotes ' });
  expect((await state(row.id)).history).toEqual([]);
});

it('records one real previous status per transition, retains dates and adds no duplicate history for unchanged status', async () => {
  const proof = await session(await user()); let row = await create(proof);
  for (const status of ['APPLIED','ASSESSMENT','INTERVIEW','OFFER','REJECTED','WITHDRAWN','SAVED','APPLIED'] as const) {
    const previous = (await state(row.id)).application!;
    row = await update(proof, row, { status, applicationDate: row.applicationDate ?? '2024-02-29' });
    const stored = await state(row.id);
    expect(stored.history[0]).toMatchObject({ fromStatus: previous.status, toStatus: status, applicationVersion: previous.version + 1 });
    expect(row.version).toBe(previous.version + 1); expect(row.applicationDate).toBe('2024-02-29');
    expect(stored.history).toHaveLength(row.version - 1);
  }
  const old = await state(row.id);
  await update(proof, row);
  expect((await state(row.id)).history).toEqual(old.history);
});

it('commits exactly one competing update after two real sessions wait for the owned application row lock', async () => {
  const owner = await user(); const first = await session(owner), second = await session(owner); const row = await create(first);
  time = new Date(clock.getTime() + 1000); const old = await state(row.id);
  let release!: () => void; let ready!: (pid: number) => void;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gate = new Promise<void>((resolve, reject) => { release = resolve; timer = setTimeout(() => reject(new Error('Owned lock gate timed out.')), 4000); });
  // Attach immediately even if admission fails before the holder awaits it.
  void gate.catch(() => undefined);
  const locked = new Promise<number>(resolve => { ready = resolve; });
  const holder = client().$transaction(async tx => {
    await admit(tx);
    await tx.$queryRaw`SELECT id FROM public."JobApplication" WHERE id=${row.id}::uuid AND "userId"=${owner}::uuid FOR UPDATE`;
    const pid = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    ready(pid[0]!.pid); await gate;
  }, { timeout: 6000, maxWait: 3000, isolationLevel: 'ReadCommitted' });
  let settlement = Promise.resolve<PromiseSettledResult<request.Response>[]>([]);
  let settled!: PromiseSettledResult<request.Response>[];
  let failed = false;
  try {
    const blocker = await Promise.race([locked, holder.then(() => { throw new Error('Lock ended before requests.'); })]);
    settlement = Promise.allSettled([first, second].map((proof, index) => request(app()).put(`${path}/${row.id}`).set(headers(proof))
      .send(edit(row, { status: index === 0 ? 'APPLIED' : 'INTERVIEW', applicationDate: '2024-02-29' })).then(response => response)));
    let bothWaiting = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const result = await client().$queryRaw<Array<{ waiting: number }>>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname=current_database() AND pid<>${blocker}
          AND pid=ANY(${[...pids]}::int[]) AND wait_event_type='Lock'
          AND query LIKE '%public."JobApplication"%' AND query LIKE '%FOR UPDATE%'
      `;
      if (result[0]?.waiting === 2) { bothWaiting = true; break; }
      await delay(30);
    }
    expect(bothWaiting).toBe(true);
  } catch {
    failed = true;
  } finally {
    clearTimeout(timer); release();
    try { await holder; }
    catch { failed = true; }
    settled = await settlement;
  }
  if (settled.some(result => result.status === 'rejected')) { stopped = true; throw new Error('Concurrent HTTP outcome uncertain; no retry or cleanup.'); }
  if (failed) throw new Error('Two requests were not proven to wait on the real application lock before release.');
  const results = settled.map(result => (result as PromiseFulfilledResult<request.Response>).value);
  expect(results.map(response => response.status).sort()).toEqual([200,409]);
  const loserIndex = results.findIndex(response => response.status === 409);
  expect(results[loserIndex]!.body.code).toBe('APPLICATION_CONFLICT');
  const winner = applicationSchema.parse(results.find(response => response.status === 200)!.body.application);
  const stored = await state(row.id);
  expect(stored.application).toMatchObject({ version: 2, status: winner.status });
  expect(stored.history).toEqual([expect.objectContaining({ fromStatus: 'SAVED', toStatus: winner.status, applicationVersion: 2 })]);
  const losingId = [first,second][loserIndex]!.session.id;
  expect(stored.activity.find(value => value.id === losingId)).toEqual(old.activity.find(value => value.id === losingId));
}, 20_000);

it('rolls back committed session activity as well as application/history effects on stale conflict', async () => {
  const proof = await session(await user()); const row = await create(proof);
  await update(proof, row, { status: 'APPLIED', applicationDate: '2024-02-29' });
  const old = await state(row.id); time = new Date(clock.getTime() + 2000);
  const response = await request(app()).put(`${path}/${row.id}`).set(headers(proof)).send(edit(row, { notes: 'stale' })).expect(409);
  expect(response.body.code).toBe('APPLICATION_CONFLICT'); expect(await state(row.id)).toEqual(old);
});

it('rolls back application, version, real history insert and session refresh when a second history insert violates uniqueness', async () => {
  const proof = await session(await user()); const row = await create(proof); const old = await state(row.id);
  time = new Date(clock.getTime() + 1000);
  const fault: Fault = { enabled: true, inserted: false, rejected: false };
  const response = await request(app(fault)).put(`${path}/${row.id}`).set(headers(proof))
    .send(edit(row, { status: 'APPLIED', applicationDate: '2024-02-29' })).expect(503);
  expect(fault.inserted).toBe(true); expect(fault.rejected).toBe(true);
  expect(response.body).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Applications are temporarily unavailable.' });
  expect(response.headers['set-cookie'] === undefined).toBe(true); expect(await state(row.id)).toEqual(old);
});

it('orders and walks history by revision despite timestamp ties and revision gaps', async () => {
  const owner = await user(); const proof = await session(owner); const row = await create(proof);
  const revisions = Array.from({ length: 52 }, (_, index) => index * 2 + 2);
  await fixtureWrite(async tx => {
    const data = revisions.map((applicationVersion, index) => {
      const value = { applicationId: row.id, applicationVersion, fromStatus: index % 2 === 0 ? 'SAVED' as const : 'APPLIED' as const,
        toStatus: index % 2 === 0 ? 'APPLIED' as const : 'SAVED' as const };
      const id = randomUUID(); events.set(id, value); return { id, ...value, changedAt: clock };
    });
    await tx.applicationStatusHistory.createMany({ data });
    await admit(tx);
    await tx.jobApplication.update({ where: { id: row.id, userId: owner }, data: { version: 104 } });
  });
  const get = async (query: string) => {
    const response = await request(app()).get(`${path}/${row.id}/history${query}`).set(headers(proof)).expect(200);
    return listApplicationHistoryResponseSchema.parse(response.body);
  };
  expect((await get('')).items).toHaveLength(20);
  const first = await get('?limit=50'); expect(first.items.map(value => value.applicationVersion)).toEqual([...revisions].reverse().slice(0,50));
  const last = await get(`?limit=50&cursor=${first.nextCursor!}`);
  expect(last.items.map(value => value.applicationVersion)).toEqual([4,2]); expect(last.nextCursor).toBeNull();
  expect(new Set([...first.items,...last.items].map(value => value.id)).size).toBe(52);
  expect(Object.keys(first.items[0]!).sort()).toEqual(['applicationVersion','changedAt','fromStatus','id','toStatus']);
  for (const query of ['?limit=51','?cursor=01','?cursor=invalid','?userId=other']) await request(app()).get(`${path}/${row.id}/history${query}`).set(headers(proof)).expect(400);
});

it('retains create/list version defaults, DATE round trips and application cursor pagination', async () => {
  const owner = await user(); const proof = await session(owner);
  await fixtureWrite(async tx => {
    const data = Array.from({ length: 20 }, (_, index) => {
      const id = randomUUID(); applications.set(id, owner); return { id, userId: owner, company: marker + index, jobTitle: 'Engineer', createdAt: clock };
    });
    await tx.jobApplication.createMany({ data });
  });
  const row = await create(proof, { status: 'APPLIED', applicationDate: '2024-02-29' });
  expect(row.version).toBe(1); expect((await state(row.id)).application?.applicationDate?.toISOString()).toBe('2024-02-29T00:00:00.000Z');
  const first = await request(app()).get(path).set(headers(proof)).expect(200);
  expect(first.body.items).toHaveLength(20);
  const last = await request(app()).get(`${path}?cursor=${first.body.nextCursor as string}`).set(headers(proof)).expect(200);
  expect(last.body.items).toHaveLength(1); expect(last.body.nextCursor).toBeNull();
  const all = [...first.body.items,...last.body.items].map(value => applicationSchema.parse(value));
  expect(all.every(value => value.version === 1)).toBe(true);
  expect(all.map(value => value.id).sort()).toEqual([...applications.keys()].sort());
});

it('retains session, CSRF and date rejection without committing any update or refresh', async () => {
  const owner = await user(); const proof = await session(owner); const row = await create(proof);
  const anonymous = await session(null), expired = await session(owner), revoked = await session(owner);
  await fixtureWrite(tx => tx.session.update({ where: { id: expired.session.id }, data: { expiresAt: clock } }));
  await fixtureWrite(tx => tx.session.delete({ where: { id: revoked.session.id } }));
  const old = await state(row.id); time = new Date(clock.getTime() + 1000);
  for (const value of [anonymous, expired, revoked]) {
    await request(app()).get(`${path}/${row.id}`).set(headers(value)).expect(401);
    await request(app()).get(`${path}/${row.id}/history`).set(headers(value)).expect(401);
    await request(app()).put(`${path}/${row.id}`).set(headers(value)).send(edit(row)).expect(401);
  }
  await request(app()).put(`${path}/${row.id}`).set(headers(proof)).unset('Cookie').send(edit(row)).expect(401);
  for (const csrf of [undefined, 'f'.repeat(64)]) {
    const pending = request(app()).put(`${path}/${row.id}`).set(headers(proof));
    if (csrf === undefined) pending.unset('X-CSRF-Token'); else pending.set('X-CSRF-Token', csrf);
    await pending.send(edit(row, { notes: 'rejected' })).expect(403);
  }
  await request(app()).put(`${path}/${row.id}`).set(headers(proof)).set('Origin', 'https://untrusted.example').send(edit(row)).expect(403);
  await request(app()).put(`${path}/${row.id}`).set(headers(proof)).unset('X-ApplyFlow-Request').send(edit(row)).expect(403);
  await request(app()).get(`${path}/invalid-uuid`).set(headers(proof)).expect(400);
  await request(app()).get(`${path}/invalid-uuid/history`).set(headers(proof)).expect(400);
  await request(app()).put(`${path}/invalid-uuid`).set(headers(proof)).send(edit(row)).expect(400);
  const incomplete = { ...edit(row) } as Partial<UpdateApplicationRequest>; delete incomplete.notes;
  for (const payload of [incomplete, { ...edit(row), userId: owner }, { ...edit(row), version: 2 }]) {
    await request(app()).put(`${path}/${row.id}`).set(headers(proof)).send(payload).expect(400);
  }
  for (const changes of [{ status: 'APPLIED' as const }, { applicationDate: '2026-02-30' }, { applicationDate: '2026-10-23' }]) {
    await request(app()).put(`${path}/${row.id}`).set(headers(proof)).send(edit(row, changes)).expect(400);
  }
  expect(await state(row.id)).toEqual(old);
});

it('enforces version/status/history/FK constraints in deliberately rolled-back owned probes', async () => {
  const owner = await user(); const proof = await session(owner); const row = await create(proof);
  const old = await state(row.id);
  const data = { applicationId: row.id, fromStatus: 'SAVED' as const, toStatus: 'APPLIED' as const, applicationVersion: 2 };
  const probes: Array<{ expected: '23514' | '23503'; run: (tx: Tx) => Promise<unknown> }> = [
    { expected: '23514', run: tx => tx.jobApplication.update({ where: { id: row.id, userId: owner }, data: { version: 0 } }) },
    { expected: '23514', run: tx => tx.jobApplication.update({ where: { id: row.id, userId: owner }, data: { status: 'APPLIED', applicationDate: null } }) },
    ...[{ ...data, toStatus: 'SAVED' as const }, { ...data, applicationVersion: 1 }, { ...data, applicationId: randomUUID() }].map(value => {
      const id = randomUUID(); events.set(id, value); return {
        expected: value.applicationId === row.id ? '23514' as const : '23503' as const,
        run: (tx: Tx) => tx.applicationStatusHistory.create({ data: { id, ...value } })
      };
    })
  ];
  for (const probe of probes) {
    let rejected = false;
    try { await fixtureWrite(async tx => { await probe.run(tx); throw new Error('Probe unexpectedly succeeded; force rollback.'); }); }
    catch (error) {
      rejected = typeof error === 'object' && error !== null && 'sqlState' in error && error.sqlState === probe.expected;
    }
    expect(rejected).toBe(true);
  }
  expect(await state(row.id)).toEqual(old);
});
