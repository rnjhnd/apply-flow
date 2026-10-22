import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { parseAuthConfig } from '../src/config/auth.js';
import { parseEnv } from '../src/config/env.js';
import { assertDatabaseIdentity, requireTestDatabaseTarget } from '../src/config/database.js';
import { loadLocalEnvironment } from '../src/config/load-env.js';
import { openLocalDatabase } from '../src/db/client.js';
import { createAuthAdmission } from '../src/modules/auth/admission.js';
import type { BootstrapSessions } from '../src/modules/auth/csrf.js';
import { ANONYMOUS_LIFETIME_MS, createSessionService, IDLE_LIFETIME_MS } from '../src/modules/auth/sessions.js';
import { hashSessionToken } from '../src/modules/auth/tokens.js';

const path = '/api/v1/auth/csrf';
const headers = { 'X-ApplyFlow-Request': '1' };
const prefix = `csrf-${randomUUID()}-`;
const ownedSessions = new Set<string>();
const ownedUsers = new Set<string>();
let connection: Awaited<ReturnType<typeof openLocalDatabase>> | undefined;
let time = 0;
function client() {
  requireTestDatabaseTarget(process.env);
  if (!connection) throw new Error('Test connection not initialized.');
  return connection.client;
}
function primitives() { return createSessionService(client(), { now: () => new Date(time) }); }
function bootstrap(sessions?: BootstrapSessions, maxKeys?: number, allowLocalRegistration = false) {
  const service = primitives();
  return createApp(parseEnv({ NODE_ENV: 'test' }), { config: parseAuthConfig({ NODE_ENV: 'test', ALLOW_LOCAL_REGISTRATION: String(allowLocalRegistration) }), now: () => new Date(time),
    admission: createAuthAdmission({ now: () => new Date(time), ...(maxKeys === undefined ? {} : { maxKeys }) }),
    sessions: sessions ?? { findValid: service.findValid, async createAnonymous() {
      const result = await service.createAnonymous();
      ownedSessions.add(result.session.id);
      return result;
    } } });
}
function sessionCookie(response: request.Response): string {
  const value = response.headers['set-cookie']?.[0]?.split(';')[0];
  if (!value) throw new Error('Expected a session cookie.');
  return value;
}
async function ownedCount() { return client().session.count({ where: { id: { in: [...ownedSessions] } } }); }

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
});
beforeEach(() => { time = Date.UTC(2026, 0, 1); });
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

describe('CSRF bootstrap on the isolated PostgreSQL test database', () => {
  it.each([false, true])('reports server registration capability %s on allocated and reused sessions', async (enabled) => {
    const app = bootstrap(undefined, undefined, enabled);
    const first = await request(app).get(path).set(headers).expect(200);
    expect(first.body).toEqual({ csrfToken: expect.stringMatching(/^[a-f0-9]{64}$/), registrationEnabled: enabled });
    const before = await client().session.findMany({ where: { id: { in: [...ownedSessions] } } });
    const reused = await request(app).get(path).set(headers).set('Cookie', sessionCookie(first)).expect(200);
    expect(reused.body).toEqual(first.body); expect(reused.headers['set-cookie']).toBeUndefined();
    expect(await client().session.findMany({ where: { id: { in: [...ownedSessions] } } })).toEqual(before);
  });
  it('validates the actual connected test identity and rejects development runtime selection', async () => {
    expect(connection?.target).toMatchObject({ name: 'test', host: '127.0.0.1', port: '5433', database: 'applyflow_test', username: 'applyflow_test' });
    await expect(openLocalDatabase('development', process.env)).rejects.toThrow();
    expect(await ownedCount()).toBe(0);
  });
  it('commits a hashed anonymous session with a fixed 15-minute cookie and independent CSRF token', async () => {
    const response = await request(bootstrap()).get(path).set(headers).expect(200);
    const cookie = sessionCookie(response);
    const token = cookie.slice(cookie.indexOf('=') + 1);
    const session = await client().session.findUniqueOrThrow({ where: { tokenHash: hashSessionToken(token) } });
    expect(ownedSessions.has(session.id)).toBe(true);
    expect(session.userId).toBeNull();
    expect(session.csrfToken).toBe(response.body.csrfToken);
    expect(session.csrfToken).not.toBe(token);
    expect(JSON.stringify(session)).not.toContain(token);
    expect(session.createdAt).toEqual(new Date(time));
    expect(session.lastSeenAt).toEqual(session.createdAt);
    expect(session.expiresAt.getTime()).toBe(time + ANONYMOUS_LIFETIME_MS);
    expect(response.headers['set-cookie']?.[0]).toContain('Max-Age=900');
    expect(await ownedCount()).toBe(1);
  });
  it('reuses valid anonymous sessions without Set-Cookie or any timestamp change, even one millisecond before expiry', async () => {
    const app = bootstrap();
    const first = await request(app).get(path).set(headers).expect(200);
    const before = await client().session.findMany({ where: { id: { in: [...ownedSessions] } } });
    time += ANONYMOUS_LIFETIME_MS - 1;
    for (let i = 0; i < 22; i++) {
      const reused = await request(app).get(path).set(headers).set('Cookie', sessionCookie(first)).expect(200);
      expect(reused.body).toEqual(first.body);
      expect(reused.headers['set-cookie']).toBeUndefined();
    }
    expect(await client().session.findMany({ where: { id: { in: [...ownedSessions] } } })).toEqual(before);
    expect(await ownedCount()).toBe(1);
  });
  it.each([0, 1])('replaces an expired cookie at boundary offset %i without modifying the old session', async (offset) => {
    const app = bootstrap();
    const first = await request(app).get(path).set(headers).expect(200);
    const oldId = [...ownedSessions][0]!;
    const oldSession = await client().session.findUniqueOrThrow({ where: { id: oldId } });
    time += ANONYMOUS_LIFETIME_MS + offset;
    const second = await request(app).get(path).set(headers).set('Cookie', sessionCookie(first)).expect(200);
    expect(second.body.csrfToken).not.toBe(first.body.csrfToken);
    expect(sessionCookie(second)).not.toBe(sessionCookie(first));
    expect(await client().session.findUniqueOrThrow({ where: { id: oldId } })).toEqual(oldSession);
    expect(await ownedCount()).toBe(2);
  });
  it('returns an existing authenticated CSRF token without refreshing its idle deadline or exposing user data', async () => {
    const id = randomUUID();
    ownedUsers.add(id);
    await client().user.create({ data: { id, email: `${prefix}${id}@example.invalid`, passwordHash: 'fixture-only' } });
    const existing = await primitives().createAuthenticated(id);
    ownedSessions.add(existing.session.id);
    time += IDLE_LIFETIME_MS - 1;
    const response = await request(bootstrap()).get(path).set(headers).set('Cookie', `applyflow_session=${existing.token}`).expect(200);
    expect(response.body).toEqual({ csrfToken: existing.session.csrfToken, registrationEnabled: false });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await client().session.findUniqueOrThrow({ where: { id: existing.session.id } })).toEqual(existing.session);
    expect(await ownedCount()).toBe(1);
  });
  it('treats a valid-format unknown token as stale and allocates a different session', async () => {
    const response = await request(bootstrap()).get(path).set(headers).set('Cookie', `applyflow_session=${'e'.repeat(64)}`).expect(200);
    expect(sessionCookie(response)).not.toContain('e'.repeat(64));
    expect(await ownedCount()).toBe(1);
  });
  it('rejects hostile/malformed requests without writing any sessions', async () => {
    const app = bootstrap();
    const baseline = await client().session.count();
    await request(app).get(path).expect(403);
    await request(app).get(path).set(headers).set('Origin', 'https://evil.invalid').expect(403);
    await request(app).get(path).set(headers).set('Sec-Fetch-Site', 'cross-site').expect(403);
    await request(app).get(`${path}?credential=secret`).set(headers).expect(400);
    await request(app).get(path).set(headers).set('Cookie', 'applyflow_session=x; applyflow_session=y').expect(400);
    await request(app).get(path).set(headers).send({ input: true }).expect(400);
    await request(app).head(path).set(headers).expect(405);
    await request(app).options(path).set(headers).expect(405);
    await request(app).post(path).set(headers).set('Origin', 'http://127.0.0.1:5173').send({}).expect(405);
    expect(await client().session.count()).toBe(baseline);
    expect(await ownedCount()).toBe(0);
  });
  it('admits exactly 20 concurrent allocations, preserves reuse, and opens the quota at exactly 15 minutes', async () => {
    const app = bootstrap();
    const responses = await Promise.all(Array.from({ length: 25 }, () => request(app).get(path).set(headers)));
    const successful = responses.filter((response) => response.status === 200);
    expect(successful).toHaveLength(20);
    expect(new Set(successful.map(sessionCookie)).size).toBe(20);
    const denied = responses.filter((response) => response.status === 429);
    expect(denied).toHaveLength(5);
    for (const response of denied) {
      expect(response.headers['retry-after']).toBe('900');
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(await ownedCount()).toBe(20);
    const cookie = sessionCookie(successful[0]!);
    await request(app).get(path).set(headers).set('Cookie', cookie).expect(200);
    time += ANONYMOUS_LIFETIME_MS - 1;
    await request(app).get(path).set(headers).expect(429).expect('Retry-After', '1');
    time++;
    await request(app).get(path).set(headers).expect(200);
    expect(await ownedCount()).toBe(21);
  });
  it('does not send a response/cookie or expose an uncommitted row before the creation transaction commits', async () => {
    let ready!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { ready = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let completed = false;
    const app = bootstrap({ findValid: primitives().findValid, createAnonymous: () => client().$transaction(async (transaction) => {
      const created = await createSessionService(transaction, { now: () => new Date(time) }).createAnonymous();
      ownedSessions.add(created.session.id);
      ready();
      await gate;
      return created;
    }) });
    const pending = request(app).get(path).set(headers).then((response) => { completed = true; return response; });
    try {
      await reached;
      expect(completed).toBe(false);
      expect(await ownedCount()).toBe(0);
    } finally { release(); await pending; }
    const response = await pending;
    expect(response.status).toBe(200);
    expect(sessionCookie(response)).toMatch(/^applyflow_session=[a-f0-9]{64}$/);
    expect(await ownedCount()).toBe(1);
  });
  it('returns sanitized 503 without a cookie on transaction rollback, leaving no partial row', async () => {
    const app = bootstrap({ findValid: primitives().findValid, createAnonymous: () => client().$transaction(async (transaction) => {
      const created = await createSessionService(transaction, { now: () => new Date(time) }).createAnonymous();
      ownedSessions.add(created.session.id);
      throw new Error('private@example.invalid credential=secret');
    }) });
    const response = await request(app).get(path).set(headers).expect(503);
    expect(response.body).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Authentication storage is unavailable.' });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await ownedCount()).toBe(0);
  });
  it('preserves health and API JSON 404 without anonymous allocation', async () => {
    const app = bootstrap();
    await request(app).get('/api/v1/health/live').expect(200, { status: 'ok', service: 'applyflow-api' });
    await request(app).get('/api/v1/unknown').expect(404).expect('Content-Type', /json/);
    await request(app).post('/api/v1/auth/login').set(headers).set('Origin', 'http://127.0.0.1:5173').send({}).expect(404);
    expect(await ownedCount()).toBe(0);
  });
});
