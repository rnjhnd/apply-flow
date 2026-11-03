import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { assertDatabaseIdentity, requireTestDatabaseTarget } from '../src/config/database.js';
import { parseAuthConfig } from '../src/config/auth.js';
import { parseEnv } from '../src/config/env.js';
import { loadLocalEnvironment } from '../src/config/load-env.js';
import { openLocalDatabase } from '../src/db/client.js';
import type { Prisma } from '../src/generated/prisma/client.ts';
import { createApplicationService, type ApplicationDatabase } from '../src/modules/applications/service.js';
import { createSessionService } from '../src/modules/auth/sessions.js';
import { hashSessionToken } from '../src/modules/auth/tokens.js';
import { assertApprovedChain, validateMigrationHistory, validateMigrationTables, verifyMigrationFiles,
  type MigrationHistoryRow } from '../scripts/migration-policy.js';

const path = '/api/applications';
const origin = 'http://127.0.0.1:5173';
const marker = `applications-${randomUUID()}-`;
const clock = new Date('2026-10-22T12:00:00.000Z');
let time = clock;
const ownedUsers = new Set<string>();
const ownedSessions = new Map<string, { userId: string | null; tokenHash: string }>();
const ownedApplications = new Set<string>();
let connection: Awaited<ReturnType<typeof openLocalDatabase>> | undefined;
let cleanupFailed = false;

function client() {
  requireTestDatabaseTarget(process.env);
  if (!connection) throw new Error('Guarded test connection is not initialized.');
  return connection.client;
}

async function assertConnectedIdentity(database: Pick<Prisma.TransactionClient, '$queryRaw'> = client()) {
  const rows = await database.$queryRaw<Array<{ database: string; username: string; sessionUser: string;
    version: string; port: number; address: string | null }>>`
    SELECT current_database()::text AS database, current_user::text AS username,
      session_user::text AS "sessionUser", current_setting('server_version_num') AS version,
      inet_server_port() AS port, inet_server_addr()::text AS address
  `;
  assertDatabaseIdentity(requireTestDatabaseTarget(process.env), rows[0]);
  if (rows[0]?.sessionUser !== 'applyflow_test' || !/^17\d{4}$/.test(rows[0].version)
    || rows[0].port !== 5432 || !rows[0].address) throw new Error('Unexpected PostgreSQL server identity.');
}

function sessions() { return createSessionService(client(), { now: () => time }); }

async function user() {
  const id = randomUUID();
  ownedUsers.add(id);
  await client().user.create({ data: { id, email: `${marker}${id}@example.invalid`, passwordHash: 'integration-fixture-only' } });
  return id;
}

async function session(userId: string | null) {
  const result = userId === null ? await sessions().createAnonymous() : await sessions().createAuthenticated(userId);
  ownedSessions.set(result.session.id, { userId, tokenHash: hashSessionToken(result.token) });
  return result;
}

type Proof = Awaited<ReturnType<typeof session>>;
function headers(proof: Proof) {
  return { Origin: origin, 'X-ApplyFlow-Request': '1', 'X-CSRF-Token': proof.session.csrfToken,
    Cookie: `applyflow_session=${proof.token}` };
}

function app(database: ApplicationDatabase = client()) {
  const service = createApplicationService(database, { now: () => time, timeZone: 'America/Los_Angeles' });
  return createApp(parseEnv({ NODE_ENV: 'test' }), {
    config: parseAuthConfig({ NODE_ENV: 'test' }), sessions: sessions()
  }, { applications: service });
}

async function create(proof: Proof, input: Record<string, unknown> = {}) {
  const response = await request(app()).post(path).set(headers(proof))
    .send({ company: `${marker}company`, jobTitle: 'Engineer', ...input }).expect(201);
  ownedApplications.add(response.body.application.id as string);
  return response;
}

async function application(userId: string, sequence: number, createdAt: Date) {
  const id = randomUUID();
  ownedApplications.add(id);
  await client().jobApplication.create({ data: { id, userId, company: `${marker}${sequence}`,
    jobTitle: 'Engineer', createdAt } });
  return { id, createdAt };
}

beforeAll(async () => {
  loadLocalEnvironment();
  const target = requireTestDatabaseTarget(process.env);
  if (target.host !== '127.0.0.1' || target.port !== '5433' || target.database !== 'applyflow_test'
    || target.username !== 'applyflow_test') throw new Error('Unexpected test target.');
  assertApprovedChain();
  await verifyMigrationFiles();
  connection = await openLocalDatabase('test', process.env);
  if (connection.target.host !== target.host || connection.target.port !== target.port
    || connection.target.database !== target.database || connection.target.username !== target.username) {
    throw new Error('Connected test target changed.');
  }
  await assertConnectedIdentity();
  const history = await client().$queryRaw<MigrationHistoryRow[]>`
    SELECT migration_name, checksum, started_at, finished_at, rolled_back_at, applied_steps_count, logs
    FROM public._prisma_migrations
  `;
  validateMigrationHistory(history);
  const tables = await client().$queryRaw<Array<{ name: string }>>`
    SELECT tablename::text AS name FROM pg_tables WHERE schemaname = 'public'
  `;
  validateMigrationTables(tables.map(row => row.name), 4);
  const columns = await client().$queryRaw<Array<{ name: string; data_type: string; nullable: string; maximum: number | null; precision: number | null; default: string | null }>>`
    SELECT column_name::text AS name, data_type::text AS data_type, is_nullable::text AS nullable,
      character_maximum_length AS maximum, datetime_precision AS precision, column_default AS "default" FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'JobApplication'
  `;
  const column = (name: string) => columns.find(row => row.name === name);
  if (columns.length !== 13 || column('archivedAt')?.data_type !== 'timestamp with time zone' || column('archivedAt')?.nullable !== 'YES'
    || column('archivedAt')?.precision !== 3 || column('archivedAt')?.default !== null
    || column('version')?.data_type !== 'integer' || column('version')?.nullable !== 'NO'
    || column('id')?.data_type !== 'uuid' || column('userId')?.data_type !== 'uuid'
    || column('userId')?.nullable !== 'NO' || column('company')?.maximum !== 160
    || column('jobTitle')?.maximum !== 200 || column('applicationDate')?.data_type !== 'date'
    || column('applicationDate')?.nullable !== 'YES' || column('location')?.maximum !== 200
    || column('jobUrl')?.maximum !== 2048) throw new Error('Unexpected application columns.');
  const constraints = await client().$queryRaw<Array<{ name: string; valid: boolean; definition: string }>>`
    SELECT c.conname::text AS name, c.convalidated AS valid, pg_get_constraintdef(c.oid) AS definition
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'JobApplication'
  `;
  const check = constraints.find(row => row.name === 'JobApplication_applicationDate_required_check');
  const foreignKey = constraints.find(row => row.name === 'JobApplication_userId_fkey');
  const versionCheck = constraints.find(row => row.name === 'JobApplication_version_positive_check');
  if (constraints.length !== 4 || !versionCheck?.valid || !versionCheck.definition.includes('version > 0')
    || !check?.valid || !check.definition.includes('"applicationDate" IS NOT NULL')
    || !foreignKey?.valid || !foreignKey.definition.includes('ON DELETE RESTRICT')) {
    throw new Error('Unexpected application constraints.');
  }
  const indexes = await client().$queryRaw<Array<{ name: string; valid: boolean }>>`
    SELECT i.relname::text AS name, x.indisvalid AS valid FROM pg_index x
    JOIN pg_class t ON t.oid = x.indrelid JOIN pg_class i ON i.oid = x.indexrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public' AND t.relname = 'JobApplication'
  `;
  if (indexes.length !== 2 || indexes.some(row => !row.valid)
    || !indexes.some(row => row.name === 'JobApplication_pkey')
    || !indexes.some(row => row.name === 'JobApplication_userId_createdAt_id_idx')) {
    throw new Error('Unexpected application indexes.');
  }
});

beforeEach(() => {
  if (cleanupFailed) throw new Error('A previous fixture cleanup failed; refusing further test writes.');
  time = clock;
});

afterEach(async () => {
  if (cleanupFailed || (!ownedUsers.size && !ownedSessions.size && !ownedApplications.size)) return;
  const userIds = [...ownedUsers];
  const unexpected = { applications: new Set<string>(), sessions: new Set<string>(), users: new Set<string>() };
  try {
    await client().$transaction(async transaction => {
      await assertConnectedIdentity(transaction);
      const rows = await transaction.jobApplication.findMany({ where: { OR: [
        { userId: { in: userIds } }, { id: { in: [...ownedApplications] } }
      ] }, select: { id: true, userId: true, company: true } });
      for (const row of rows) {
        if (!ownedApplications.has(row.id) || !ownedUsers.has(row.userId) || !row.company.startsWith(marker)) {
          unexpected.applications.add(row.id);
        }
      }
      const liveSessions = await transaction.session.findMany({ where: { OR: [
        { id: { in: [...ownedSessions.keys()] } }, { userId: { in: userIds } }
      ] },
        select: { id: true, userId: true, tokenHash: true } });
      for (const row of liveSessions) {
        const expected = ownedSessions.get(row.id);
        if (!expected || row.userId !== expected.userId || row.tokenHash !== expected.tokenHash) {
          unexpected.sessions.add(row.id);
        }
      }
      const liveUsers = await transaction.user.findMany({ where: { OR: [
        { id: { in: userIds } }, { email: { startsWith: marker } }
      ] },
        select: { id: true, email: true } });
      for (const row of liveUsers) {
        if (!ownedUsers.has(row.id) || row.email !== `${marker}${row.id}@example.invalid`) {
          unexpected.users.add(row.id);
        }
      }
      if (unexpected.applications.size || unexpected.sessions.size || unexpected.users.size) {
        throw new Error('Unexpected fixture-linked rows; cleanup stopped.');
      }
      await transaction.jobApplication.deleteMany({ where: { id: { in: [...ownedApplications] },
        userId: { in: userIds }, company: { startsWith: marker } } });
      if (ownedSessions.size) {
        await transaction.session.deleteMany({ where: { OR: [...ownedSessions].map(([id, value]) => ({
          id, userId: value.userId, tokenHash: value.tokenHash
        })) } });
      }
      await transaction.user.deleteMany({ where: { id: { in: userIds }, email: { startsWith: marker } } });
      expect(await transaction.jobApplication.count({ where: { id: { in: [...ownedApplications] } } })).toBe(0);
      expect(await transaction.session.count({ where: { id: { in: [...ownedSessions.keys()] } } })).toBe(0);
      expect(await transaction.user.count({ where: { id: { in: userIds } } })).toBe(0);
    });
    ownedApplications.clear(); ownedSessions.clear(); ownedUsers.clear();
  } catch (error) {
    cleanupFailed = true;
    console.error('Application integration cleanup incomplete. Owned IDs:', {
      users: userIds, sessions: [...ownedSessions.keys()], applications: [...ownedApplications],
      unexpected: { applications: [...unexpected.applications], sessions: [...unexpected.sessions], users: [...unexpected.users] }
    });
    throw error;
  }
});

afterAll(async () => { await connection?.client.$disconnect(); });

it('commits an authenticated create, preserves DATE, and returns public fields through another connection', async () => {
  const owner = await user();
  const proof = await session(owner);
  const response = await create(proof, { status: 'APPLIED', applicationDate: '2024-02-29',
    notes: 'private formatting\nretained' });
  expect(response.headers['set-cookie']).toBeUndefined();
  expect(response.body.application).toMatchObject({ company: `${marker}company`, status: 'APPLIED',
    applicationDate: '2024-02-29', notes: 'private formatting\nretained' });
  expect(Object.keys(response.body.application).sort()).toEqual([
    'applicationDate', 'archivedAt', 'company', 'createdAt', 'id', 'jobTitle', 'jobUrl', 'location', 'notes', 'status', 'updatedAt', 'version'
  ]);
  const other = await openLocalDatabase('test', process.env);
  try {
    await assertConnectedIdentity(other.client);
    const saved = await other.client.jobApplication.findUniqueOrThrow({ where: { id: response.body.application.id as string } });
    expect(saved.userId).toBe(owner);
    expect(saved.applicationDate?.toISOString()).toBe('2024-02-29T00:00:00.000Z');
  } finally { await other.client.$disconnect(); }
  const listed = await request(app()).get(path).set(headers(proof)).expect(200);
  expect(listed.body.items).toEqual([response.body.application]);
});

it('isolates two owners and rejects client-supplied owner data', async () => {
  const firstId = await user(), secondId = await user();
  const first = await session(firstId), second = await session(secondId);
  const a = await create(first), b = await create(second);
  const firstList = await request(app()).get(path).set(headers(first)).expect(200);
  const secondList = await request(app()).get(path).set(headers(second)).expect(200);
  expect(firstList.body.items.map((row: { id: string }) => row.id)).toEqual([a.body.application.id]);
  expect(secondList.body.items.map((row: { id: string }) => row.id)).toEqual([b.body.application.id]);
  const rejected = await request(app()).post(path).set(headers(first))
    .send({ company: `${marker}injected`, jobTitle: 'Engineer', userId: secondId }).expect(400);
  expect(rejected.body.code).toBe('INVALID_REQUEST');
  expect(await client().jobApplication.count({ where: { userId: secondId } })).toBe(1);
});

it('pages by descending timestamp and UUID, with owner-scoped cursor boundaries', async () => {
  const firstId = await user(), secondId = await user();
  const first = await session(firstId), second = await session(secondId);
  const tie = new Date('2026-01-01T00:00:00.000Z');
  const created = [];
  for (let index = 0; index < 52; index++) created.push(await application(firstId, index, tie));
  await application(secondId, 99, new Date('2026-02-01T00:00:00.000Z'));
  const expected = created.map(row => row.id).sort().reverse();
  const defaultPage = await request(app()).get(path).set(headers(first)).expect(200);
  expect(defaultPage.body.items.map((row: { id: string }) => row.id)).toEqual(expected.slice(0, 20));
  const firstPage = await request(app()).get(`${path}?limit=50`).set(headers(first)).expect(200);
  expect(firstPage.body.items.map((row: { id: string }) => row.id)).toEqual(expected.slice(0, 50));
  expect(firstPage.body.nextCursor).toEqual(expect.any(String));
  const lastPage = await request(app()).get(`${path}?limit=50&cursor=${firstPage.body.nextCursor as string}`)
    .set(headers(first)).expect(200);
  expect(lastPage.body.items.map((row: { id: string }) => row.id)).toEqual(expected.slice(50));
  expect(lastPage.body.nextCursor).toBeNull();
  const foreignCursor = await request(app()).get(`${path}?cursor=${firstPage.body.nextCursor as string}`)
    .set(headers(second)).expect(200);
  expect(foreignCursor.body.items).toEqual([]);
  await request(app()).get(`${path}?limit=51`).set(headers(first)).expect(400);
  await request(app()).get(`${path}?cursor=invalid`).set(headers(first)).expect(400);
});

it('rejects missing, expired and revoked sessions without creating applications', async () => {
  const owner = await user();
  const expired = await session(owner), revoked = await session(owner);
  await client().session.update({ where: { id: expired.session.id }, data: { expiresAt: clock } });
  await client().session.delete({ where: { id: revoked.session.id } });
  await request(app()).get(path).set('X-ApplyFlow-Request', '1').expect(401);
  await request(app()).post(path).set({ Origin: origin, 'X-ApplyFlow-Request': '1' })
    .send({ company: `${marker}no-cookie`, jobTitle: 'Engineer' }).expect(401);
  for (const proof of [expired, revoked]) {
    await request(app()).get(path).set(headers(proof)).expect(401);
    await request(app()).post(path).set(headers(proof))
      .send({ company: `${marker}rejected`, jobTitle: 'Engineer' }).expect(401);
  }
  expect(await client().jobApplication.count({ where: { userId: owner } })).toBe(0);
});

it('requires session-bound CSRF and rolls back activity on rejection', async () => {
  const owner = await user();
  const proof = await session(owner);
  const before = await client().session.findUniqueOrThrow({ where: { id: proof.session.id } });
  time = new Date(clock.getTime() + 1_000);
  for (const csrf of [undefined, 'f'.repeat(64)]) {
    const pending = request(app()).post(path).set(headers(proof));
    if (csrf === undefined) pending.unset('X-CSRF-Token');
    else pending.set('X-CSRF-Token', csrf);
    const response = await pending.send({ company: `${marker}rejected`, jobTitle: 'Engineer' }).expect(403);
    expect(response.body).toEqual({ code: 'REQUEST_REJECTED', message: 'Application request rejected.' });
    expect(response.headers['set-cookie']).toBeUndefined();
  }
  expect(await client().jobApplication.count({ where: { userId: owner } })).toBe(0);
  expect(await client().session.findUniqueOrThrow({ where: { id: proof.session.id } })).toEqual(before);
  await create(proof);
});

it('waits for an owned session row lock and rechecks validity after release', async () => {
  const owner = await user();
  const proof = await session(owner);
  let release!: () => void;
  let locked!: (pid: number) => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<number>(resolve => { locked = resolve; });
  const holder = client().$transaction(async transaction => {
    const rows = await transaction.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
    await transaction.session.update({ where: { id: proof.session.id }, data: { expiresAt: clock } });
    locked(rows[0]!.pid);
    await gate;
  }, { timeout: 6_000 });
  let pending: Promise<request.Response> | undefined;
  try {
    const blocker = await Promise.race([ready, holder.then(() => { throw new Error('Row lock ended before admission.'); })]);
    pending = request(app()).post(path).set(headers(proof))
      .send({ company: `${marker}locked`, jobTitle: 'Engineer' }).then(response => response);
    let blocked = false;
    for (let attempt = 0; attempt < 30; attempt++) {
      const rows = await client().$queryRaw<Array<{ waiting: boolean }>>`
        SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND ${blocker} = ANY(pg_blocking_pids(pid))) AS waiting
      `;
      if (rows[0]?.waiting) { blocked = true; break; }
      await delay(50);
    }
    expect(blocked).toBe(true);
  } finally {
    release();
    try { await holder; }
    finally { if (pending) await pending; }
  }
  const response = await pending;
  expect(response?.status).toBe(401);
  expect(response?.body).toEqual({ code: 'UNAUTHENTICATED', message: 'A valid authenticated session is required.' });
  expect(await client().jobApplication.count({ where: { userId: owner } })).toBe(0);
});

it('enforces PostgreSQL CHECK, FK and length constraints on owned probes', async () => {
  const owner = await user();
  for (const data of [
    { userId: owner, status: 'APPLIED' as const, applicationDate: null, company: `${marker}check`, jobTitle: 'Engineer' },
    { userId: randomUUID(), status: 'SAVED' as const, company: `${marker}fk`, jobTitle: 'Engineer' },
    { userId: owner, status: 'SAVED' as const, company: `${marker}${'x'.repeat(161)}`, jobTitle: 'Engineer' }
  ]) {
    const id = randomUUID();
    ownedApplications.add(id);
    await expect(client().$transaction(async transaction => {
      await assertConnectedIdentity(transaction);
      await transaction.jobApplication.create({ data: { id, ...data } });
    })).rejects.toThrow();
    expect(await client().jobApplication.findUnique({ where: { id } })).toBeNull();
  }
});

it('rolls back application and session activity after an injected transaction failure', async () => {
  const owner = await user();
  const proof = await session(owner);
  const before = await client().session.findUniqueOrThrow({ where: { id: proof.session.id } });
  time = new Date(clock.getTime() + 1_000);
  const failing: ApplicationDatabase = { $transaction: async work => client().$transaction(async transaction => {
    await assertConnectedIdentity(transaction);
    await work(transaction);
    const rows = await transaction.jobApplication.findMany({ where: { userId: owner,
      company: { startsWith: marker } }, select: { id: true } });
    for (const row of rows) ownedApplications.add(row.id);
    throw new Error('private storage failure with credential=secret');
  }) };
  const response = await request(app(failing)).post(path).set(headers(proof))
    .send({ company: `${marker}rollback`, jobTitle: 'Engineer' }).expect(503);
  expect(response.body).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Applications are temporarily unavailable.' });
  expect(JSON.stringify(response.body)).not.toContain('credential=secret');
  expect(response.headers['set-cookie']).toBeUndefined();
  expect(await client().jobApplication.count({ where: { userId: owner } })).toBe(0);
  expect(await client().session.findUniqueOrThrow({ where: { id: proof.session.id } })).toEqual(before);
});
