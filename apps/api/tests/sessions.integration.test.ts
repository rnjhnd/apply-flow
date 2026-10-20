import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { assertDatabaseIdentity, requireTestDatabaseTarget } from '../src/config/database.js';
import { loadLocalEnvironment } from '../src/config/load-env.js';
import { openLocalDatabase, openRuntimeDatabase } from '../src/db/client.js';
import { createSessionService, ABSOLUTE_LIFETIME_MS, ANONYMOUS_LIFETIME_MS, IDLE_LIFETIME_MS,
  type SessionDatabase } from '../src/modules/auth/sessions.js';
import type { Session } from '../src/generated/prisma/client.ts';
import { createPasswordService } from '../src/modules/auth/passwords.js';

const prefix = `checkpoint2b-${randomUUID()}-`;
const ownedSessions = new Set<string>();
const ownedUsers = new Set<string>();
let connection: Awaited<ReturnType<typeof openLocalDatabase>> | undefined;
let anchor = 0;
let time = 0;
let userId = '';
function client() {
  requireTestDatabaseTarget(process.env);
  if (!connection) throw new Error('Test connection not initialized.');
  return connection.client;
}
function service(database: SessionDatabase = client(), timestamp?: number) {
  return createSessionService(database, { now: () => new Date(timestamp ?? time) });
}
async function remember(pending: Promise<{ token: string; session: Session }>) {
  const result = await pending;
  ownedSessions.add(result.session.id);
  return result;
}

beforeAll(async () => {
  loadLocalEnvironment();
  requireTestDatabaseTarget(process.env);
  const sqlHash = createHash('sha256').update(readFileSync(new URL('../prisma/migrations/0001_init_auth/migration.sql', import.meta.url))).digest('hex');
  expect(sqlHash).toBe('98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840');
  connection = await openLocalDatabase('test', process.env);
  const history = await client().$queryRaw<Array<{ checksum: string; finished_at: Date | null; rolled_back_at: Date | null }>>`
    SELECT checksum, finished_at, rolled_back_at FROM public._prisma_migrations
  `;
  expect(history).toHaveLength(1);
  expect(history[0]).toMatchObject({ checksum: sqlHash, finished_at: expect.any(Date), rolled_back_at: null });
  // Keep every test clock (including +7-day boundary tests) earlier than all pre-existing timestamps.
  // Global expired-session queries can therefore select only this suite's fixtures.
  const earliest = await client().$queryRaw<Array<{ earliest: Date | null }>>`
    SELECT min(LEAST("createdAt", "lastSeenAt", "expiresAt")) AS earliest FROM public."Session"
  `;
  anchor = Math.min(Date.UTC(2020, 0, 1), earliest[0]?.earliest?.getTime() ?? Infinity) - 30 * IDLE_LIFETIME_MS;
});
beforeEach(async () => {
  time = anchor;
  userId = randomUUID();
  ownedUsers.add(userId);
  await client().user.create({ data: { id: userId, email: `${prefix}${userId}@example.invalid`, passwordHash: 'persistence-fixture-not-an-authentication-hash' } });
});
afterEach(async () => {
  await client().$transaction(async (transaction) => {
    const identities = await transaction.$queryRaw<Array<{ database: string; username: string }>>`
      SELECT current_database()::text AS database, current_user::text AS username
    `;
    assertDatabaseIdentity(requireTestDatabaseTarget(process.env), identities[0]);
    await transaction.session.deleteMany({ where: { id: { in: [...ownedSessions] } } });
    await transaction.user.deleteMany({ where: { id: { in: [...ownedUsers] }, email: { startsWith: prefix } } });
    expect(await transaction.session.count({ where: { id: { in: [...ownedSessions] } } })).toBe(0);
    expect(await transaction.user.count({ where: { id: { in: [...ownedUsers] } } })).toBe(0);
  });
  ownedSessions.clear(); ownedUsers.clear();
});
afterAll(async () => { await connection?.client.$disconnect(); });

describe('session primitives on isolated PostgreSQL', () => {
  it('persists and verifies the real Argon2id hash without storing the password', async () => {
    const passwords = await createPasswordService();
    const password = 'Real hash persistence fixture only';
    const hash = await passwords.hash(password);
    await client().user.update({ where: { id: userId }, data: { passwordHash: hash } });
    const user = await client().user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.passwordHash).not.toContain(password);
    expect(await passwords.verify(user.passwordHash, password)).toBe(true);
    expect(await passwords.verify(user.passwordHash, 'Incorrect fixture password')).toBe(false);
  });
  it('uses the runtime test path without a development fallback', async () => {
    const runtime = await openRuntimeDatabase(process.env);
    try { expect(runtime.target).toMatchObject({ name: 'test', database: 'applyflow_test', username: 'applyflow_test', port: '5433' }); }
    finally { await runtime.client.$disconnect(); }
  });
  it('stores only the session hash and independent CSRF token with a fixed 15-minute lifetime', async () => {
    const { token, session } = await remember(service().createAnonymous());
    expect(session.userId).toBeNull();
    expect(session.tokenHash).toBe(createHash('sha256').update(token).digest('hex'));
    expect(session.csrfToken).not.toBe(token);
    expect(JSON.stringify(await client().session.findUniqueOrThrow({ where: { id: session.id } }))).not.toContain(token);
    expect(session.expiresAt.getTime() - anchor).toBe(ANONYMOUS_LIFETIME_MS);
    time += ANONYMOUS_LIFETIME_MS - 1;
    expect(await service().findValid(token)).toEqual(session);
    expect(await service().refreshAuthenticated(token)).toBeNull();
    time++;
    expect(await service().findValid(token)).toBeNull();
    expect(await service().cleanupExpired()).toBe(1);
  });
  it.each([-1, 0, 1])('enforces anonymous expiration boundary offset %i', async (offset) => {
    const { token } = await remember(service().createAnonymous());
    time += ANONYMOUS_LIFETIME_MS + offset;
    expect((await service().findValid(token)) !== null).toBe(offset < 0);
    expect(await service().cleanupExpired()).toBe(offset < 0 ? 0 : 1);
  });
  it('does not extend anonymous lifetime even if lastSeenAt and expiresAt are later', async () => {
    const { token, session } = await remember(service().createAnonymous());
    await client().session.update({ where: { id: session.id }, data: {
      lastSeenAt: new Date(anchor + ANONYMOUS_LIFETIME_MS - 1), expiresAt: new Date(anchor + IDLE_LIFETIME_MS)
    } });
    time += ANONYMOUS_LIFETIME_MS;
    expect(await service().findValid(token)).toBeNull();
    expect(await service().cleanupExpired()).toBe(1);
  });
  it.each([-1, 0, 1])('enforces authenticated idle boundary offset %i without revival', async (offset) => {
    const { token } = await remember(service().createAuthenticated(userId));
    time += IDLE_LIFETIME_MS + offset;
    expect((await service().refreshAuthenticated(token)) !== null).toBe(offset < 0);
    expect(await service().cleanupExpired()).toBe(offset < 0 ? 0 : 1);
  });
  it.each([-1, 0, 1])('enforces absolute boundary offset %i even with fresh activity and a later expiresAt', async (offset) => {
    const { token, session } = await remember(service().createAuthenticated(userId));
    await client().session.update({ where: { id: session.id }, data: {
      lastSeenAt: new Date(anchor + ABSOLUTE_LIFETIME_MS - 1000), expiresAt: new Date(anchor + ABSOLUTE_LIFETIME_MS * 2)
    } });
    time += ABSOLUTE_LIFETIME_MS + offset;
    expect((await service().refreshAuthenticated(token)) !== null).toBe(offset < 0);
    expect(await service().cleanupExpired()).toBe(offset < 0 ? 0 : 1);
  });
  it('refreshes activity without extending absolute expiry and does not touch on read', async () => {
    const { token, session } = await remember(service().createAuthenticated(userId));
    time += 1000;
    expect((await service().findValid(token))?.lastSeenAt).toEqual(session.createdAt);
    const refreshed = await service().refreshAuthenticated(token);
    expect(refreshed?.lastSeenAt).toEqual(new Date(time));
    expect(refreshed?.expiresAt).toEqual(session.expiresAt);
    time = anchor + IDLE_LIFETIME_MS;
    expect(await service().cleanupExpired()).toBe(0);
    expect(await service().findValid(token)).not.toBeNull();
  });
  it('preserves greatest activity under concurrent requests with different sampled clocks', async () => {
    const { token, session } = await remember(service().createAuthenticated(userId));
    await Promise.all([service(client(), anchor + 2000).refreshAuthenticated(token), service(client(), anchor + 1000).refreshAuthenticated(token)]);
    await service(client(), anchor + 500).refreshAuthenticated(token);
    expect((await client().session.findUniqueOrThrow({ where: { id: session.id } })).lastSeenAt).toEqual(new Date(anchor + 2000));
  });
  it('revokes one session idempotently and cannot recreate it during refresh', async () => {
    const first = await remember(service().createAuthenticated(userId));
    const second = await remember(service().createAuthenticated(userId));
    expect(await service().revoke(first.token)).toBe(true);
    expect(await service().revoke(first.token)).toBe(false);
    expect(await service().refreshAuthenticated(first.token)).toBeNull();
    expect(await service().findValid(second.token)).not.toBeNull();
  });
  it('cannot resurrect a session when revocation races activity refresh', async () => {
    const { token, session } = await remember(service().createAuthenticated(userId));
    time += 1000;
    await Promise.all([service().refreshAuthenticated(token), service().revoke(token)]);
    expect(await client().session.findUnique({ where: { id: session.id } })).toBeNull();
    expect(await service().refreshAuthenticated(token)).toBeNull();
  });
  it('respects an explicitly earlier expiresAt', async () => {
    const { token, session } = await remember(service().createAuthenticated(userId));
    await client().session.update({ where: { id: session.id }, data: { expiresAt: new Date(time) } });
    expect(await service().findValid(token)).toBeNull();
    expect(await service().refreshAuthenticated(token)).toBeNull();
    expect(await service().cleanupExpired()).toBe(1);
  });
  it('bounds cleanup batches and preserves live anonymous and authenticated sessions', async () => {
    for (let index = 0; index < 3; index++) await remember(service().createAnonymous());
    time += ANONYMOUS_LIFETIME_MS;
    const liveAnonymous = await remember(service().createAnonymous());
    const liveAuth = await remember(service().createAuthenticated(userId));
    const counts = await Promise.all([service().cleanupExpired(2), service().cleanupExpired(2)]);
    expect(counts.sort()).toEqual([1, 2]);
    expect(await service().findValid(liveAnonymous.token)).not.toBeNull();
    expect(await service().findValid(liveAuth.token)).not.toBeNull();
    await expect(service().cleanupExpired(101)).rejects.toThrow(/batch/);
    await expect(service().cleanupExpired(0)).rejects.toThrow(/batch/);
  });
  it('skips an in-flight valid refresh and retains it after commit instead of deleting from stale activity', async () => {
    const { token, session } = await remember(service().createAuthenticated(userId));
    let release!: () => void;
    let locked!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const refresh = client().$transaction(async (transaction) => {
      const result = await service(transaction, anchor + IDLE_LIFETIME_MS - 1).refreshAuthenticated(token);
      expect(result).not.toBeNull();
      locked();
      await hold;
    });
    try {
      await Promise.race([ready, refresh]);
      time = anchor + IDLE_LIFETIME_MS + 1;
      expect(await service().cleanupExpired()).toBe(0);
    } finally { release(); await refresh; }
    expect(await service().cleanupExpired()).toBe(0);
    expect((await client().session.findUniqueOrThrow({ where: { id: session.id } })).lastSeenAt)
      .toEqual(new Date(anchor + IDLE_LIFETIME_MS - 1));
  });
  it('rolls back a session created inside a caller-owned transaction', async () => {
    const failure = new Error('Intentional transaction failure');
    let sessionId = '';
    await expect(client().$transaction(async (transaction) => {
      const created = await remember(service(transaction).createAuthenticated(userId));
      sessionId = created.session.id;
      throw failure;
    })).rejects.toBe(failure);
    expect(await client().session.findUnique({ where: { id: sessionId } })).toBeNull();
  });
  it('rejects invalid entropy and owners without leaving partial session state', async () => {
    await expect(createSessionService(client(), { token: () => 'a'.repeat(64) }).createAnonymous()).rejects.toThrow(/entropy/);
    await expect(createSessionService(client(), { now: () => new Date(NaN) }).createAnonymous()).rejects.toThrow(/clock/);
    expect(() => service().createAuthenticated('invalid-owner')).toThrow(/owner/);
    const before = await client().session.count();
    await expect(service().createAuthenticated(randomUUID())).rejects.toMatchObject({ code: 'P2003' });
    expect(await client().session.count()).toBe(before);
    expect(await service().findValid('malformed')).toBeNull();
    expect(await service().refreshAuthenticated('malformed')).toBeNull();
    expect(await service().revoke('malformed')).toBe(false);
  });
});
