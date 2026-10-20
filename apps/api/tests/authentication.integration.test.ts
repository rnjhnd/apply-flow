import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { parseAuthConfig } from '../src/config/auth.js';
import { parseEnv } from '../src/config/env.js';
import { assertDatabaseIdentity, requireTestDatabaseTarget } from '../src/config/database.js';
import { loadLocalEnvironment } from '../src/config/load-env.js';
import { openLocalDatabase } from '../src/db/client.js';
import { createAuthenticationService, type AuthenticationDatabase } from '../src/modules/auth/authentication.js';
import { createPasswordService, PasswordOperationError } from '../src/modules/auth/passwords.js';
import { ANONYMOUS_LIFETIME_MS, ABSOLUTE_LIFETIME_MS, IDLE_LIFETIME_MS, createSessionService } from '../src/modules/auth/sessions.js';
import { generateToken, hashSessionToken } from '../src/modules/auth/tokens.js';

const prefix = `auth-${randomUUID()}-`;
const password = 'A real integration password 123';
const origin = 'http://127.0.0.1:5173';
const email = (name = 'person') => `${prefix}${name}@example.invalid`;
const ownedUsers = new Set<string>();
const ownedSessions = new Set<string>();
let connection: Awaited<ReturnType<typeof openLocalDatabase>> | undefined;
let passwords: Awaited<ReturnType<typeof createPasswordService>>;
let passwordHash = '';
let time = 0;
function client() {
  requireTestDatabaseTarget(process.env);
  if (!connection) throw new Error('Test connection not initialized.');
  return connection.client;
}
function sessions() { return createSessionService(client(), { now: () => new Date(time) }); }
async function anonymous() {
  const created = await sessions().createAnonymous();
  ownedSessions.add(created.session.id);
  return created;
}
async function seedUser(name = 'person') {
  const id = randomUUID();
  ownedUsers.add(id);
  return client().user.create({ data: { id, email: email(name), passwordHash }, select: { id: true, email: true } });
}
async function authenticated(userId: string) {
  const created = await sessions().createAuthenticated(userId);
  ownedSessions.add(created.session.id);
  return created;
}
type AppOptions = { enabled?: boolean; database?: AuthenticationDatabase; passwords?: typeof passwords; token?: () => string };
function makeApp(options: AppOptions = {}) {
  const primitives = sessions();
  const authentication = createAuthenticationService(options.database ?? client(), options.passwords ?? passwords,
    { now: () => new Date(time), ...(options.token === undefined ? {} : { token: options.token }) });
  return createApp(parseEnv({ NODE_ENV: 'test' }), { config: parseAuthConfig({ NODE_ENV: 'test', ALLOW_LOCAL_REGISTRATION: String(options.enabled ?? true) }),
    now: () => new Date(time), authentication, sessions: { findValid: primitives.findValid, async createAnonymous() {
      const result = await primitives.createAnonymous(); ownedSessions.add(result.session.id); return result;
    } } });
}
type Proof = { token: string; session: { csrfToken: string } };
function headers(proof: Proof) {
  return { 'X-ApplyFlow-Request': '1', 'X-CSRF-Token': proof.session.csrfToken, Origin: origin, Cookie: `applyflow_session=${proof.token}` };
}
function cookie(response: request.Response) {
  const value = response.headers['set-cookie']?.[0]?.split(';')[0];
  if (!value) throw new Error('Expected a session cookie.');
  return value;
}
function tokenFrom(response: request.Response) { return cookie(response).slice('applyflow_session='.length); }
async function rows() {
  return {
    users: await client().user.findMany({ where: { email: { startsWith: prefix } }, orderBy: { id: 'asc' } }),
    sessions: await client().session.findMany({ where: { OR: [{ id: { in: [...ownedSessions] } }, { user: { email: { startsWith: prefix } } }] }, orderBy: { id: 'asc' } })
  };
}
function passwordSpy() { return { hash: vi.fn(passwords.hash), verify: vi.fn(passwords.verify) }; }

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
  passwords = await createPasswordService();
  passwordHash = await passwords.hash(password);
});
beforeEach(() => { time = Date.UTC(2026, 0, 1); });
afterEach(async () => {
  vi.restoreAllMocks();
  await client().$transaction(async (transaction) => {
    const identity = await transaction.$queryRaw<Array<{ database: string; username: string }>>`
      SELECT current_database()::text AS database, current_user::text AS username
    `;
    assertDatabaseIdentity(requireTestDatabaseTarget(process.env), identity[0]);
    // Registration chooses UUIDs inside the transaction; discover only this run's random email namespace.
    const createdUsers = await transaction.user.findMany({ where: { email: { startsWith: prefix } }, select: { id: true } });
    for (const user of createdUsers) ownedUsers.add(user.id);
    const createdSessions = await transaction.session.findMany({ where: { userId: { in: [...ownedUsers] } }, select: { id: true } });
    for (const session of createdSessions) ownedSessions.add(session.id);
    await transaction.session.deleteMany({ where: { id: { in: [...ownedSessions] } } });
    await transaction.user.deleteMany({ where: { id: { in: [...ownedUsers] }, email: { startsWith: prefix } } });
    expect(await transaction.user.count({ where: { email: { startsWith: prefix } } })).toBe(0);
    expect(await transaction.session.count({ where: { id: { in: [...ownedSessions] } } })).toBe(0);
  });
  ownedUsers.clear(); ownedSessions.clear();
});

describe('authentication rate limits and concurrent session consumption', () => {
  it('limits normalized email/IP attempts before the sixth verification and resets at the exact boundary', async () => {
    await seedUser();
    const proof = await anonymous();
    const spy = passwordSpy();
    const app = makeApp({ passwords: spy });
    for (let i = 0; i < 5; i++) await request(app).post('/api/v1/auth/login').set(headers(proof))
      .send({ email: i % 2 ? email().toUpperCase() : ` ${email()} `, password: 'incorrect' }).expect(401);
    const limited = await request(app).post('/api/v1/auth/login').set(headers(proof)).send({ email: email(), password }).expect(429);
    expect(limited.body.code).toBe('RATE_LIMITED');
    expect(limited.headers['retry-after']).toBe('900');
    expect(limited.headers['set-cookie']).toBeUndefined();
    expect(spy.verify).toHaveBeenCalledTimes(5);
    time += ANONYMOUS_LIFETIME_MS - 1;
    await request(app).post('/api/v1/auth/login').set(headers(proof)).send({ email: email(), password }).expect(429).expect('Retry-After', '1');
    time++;
    const fresh = await anonymous();
    await request(app).post('/api/v1/auth/login').set(headers(fresh)).send({ email: email(), password: 'incorrect' }).expect(401);
    expect(spy.verify).toHaveBeenCalledTimes(6);
    expect(await sessions().findValid(fresh.token)).toEqual(fresh.session);
  });
  it('enforces the 30/IP login budget across distinct emails before another verification', async () => {
    const proof = await anonymous();
    const spy = passwordSpy();
    const app = makeApp({ passwords: spy });
    for (let i = 0; i < 30; i++) await request(app).post('/api/v1/auth/login').set(headers(proof))
      .send({ email: email(`unknown${i}`), password: 'incorrect' }).expect(401);
    await request(app).post('/api/v1/auth/login').set(headers(proof)).send({ email: email('last'), password: 'incorrect' }).expect(429);
    expect(spy.verify).toHaveBeenCalledTimes(30);
  });
  it('enforces five registration attempts/IP/hour, including duplicates, without consuming the anonymous session on failure', async () => {
    await seedUser();
    const proof = await anonymous();
    const spy = passwordSpy();
    const app = makeApp({ passwords: spy });
    for (let i = 0; i < 5; i++) {
      const duplicate = await request(app).post('/api/v1/auth/register').set(headers(proof)).send({ email: email(), password }).expect(409);
      expect(duplicate.body).toEqual({ code: 'ACCOUNT_UNAVAILABLE', message: 'Unable to create an account with those details.' });
      expect(duplicate.headers['set-cookie']).toBeUndefined();
    }
    await request(app).post('/api/v1/auth/register').set(headers(proof)).send({ email: email('new'), password }).expect(429).expect('Retry-After', '3600');
    expect(spy.hash).toHaveBeenCalledTimes(5);
    expect(await sessions().findValid(proof.token)).toEqual(proof.session);
    expect(await client().user.count({ where: { email: { startsWith: prefix } } })).toBe(1);
  });
  it('enforces concurrent pair admission before password work, retaining reservations on overload', async () => {
    await seedUser();
    const proof = await anonymous();
    const spy = passwordSpy();
    const app = makeApp({ passwords: spy });
    const responses = await Promise.all(Array.from({ length: 6 }, () => request(app).post('/api/v1/auth/login').set(headers(proof)).send({ email: email(), password: 'incorrect' })));
    expect(responses.filter((response) => response.status === 429)).toHaveLength(1);
    expect(responses.some((response) => response.status === 401)).toBe(true);
    for (const response of responses) {
      expect([401, 429, 503]).toContain(response.status);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(spy.verify).toHaveBeenCalledTimes(5);
    await request(app).post('/api/v1/auth/login').set(headers(proof)).send({ email: email(), password }).expect(429);
    expect(spy.verify).toHaveBeenCalledTimes(5);
    expect(await sessions().findValid(proof.token)).toEqual(proof.session);
  });
  function pairBarrier() {
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    return async () => { if (++arrivals === 2) release(); await gate; };
  }
  it.each(['login', 'register', 'mixed'] as const)('consumes an anonymous session only once for concurrent %s', async (scenario) => {
    await seedUser();
    const proof = await anonymous();
    const wait = pairBarrier();
    const synchronized = {
      async hash(value: string) { const hash = await passwords.hash(value); await wait(); return hash; },
      async verify(digest: string | null, value: string) { const valid = await passwords.verify(digest, value); await wait(); return valid; }
    };
    const app = makeApp({ passwords: synchronized });
    const firstKind = scenario === 'register' ? 'register' : 'login';
    const secondKind = scenario === 'login' ? 'login' : 'register';
    const responses = await Promise.all([
      request(app).post(`/api/v1/auth/${firstKind}`).set(headers(proof)).send({ email: firstKind === 'login' ? email() : email('first'), password }),
      request(app).post(`/api/v1/auth/${secondKind}`).set(headers(proof)).send({ email: secondKind === 'login' ? email() : email('second'), password })
    ]);
    const successful = responses.filter((response) => [200, 201].includes(response.status));
    expect(successful).toHaveLength(1);
    const rejected = responses.find((response) => response.status === 409);
    expect(rejected?.body.code).toBe('SESSION_CHANGED');
    expect(rejected?.headers['set-cookie']).toBeUndefined();
    expect(await sessions().findValid(proof.token)).toBeNull();
    const state = await rows();
    expect(state.sessions).toHaveLength(1);
    expect(state.users).toHaveLength(scenario === 'login' || successful[0]?.status === 200 ? 1 : 2);
  });
  it('resolves concurrent normalized duplicate registration with one user and one intact losing anonymous session', async () => {
    const first = await anonymous();
    const second = await anonymous();
    const wait = pairBarrier();
    const app = makeApp({ passwords: { verify: passwords.verify, async hash(value) { const hash = await passwords.hash(value); await wait(); return hash; } } });
    const responses = await Promise.all([
      request(app).post('/api/v1/auth/register').set(headers(first)).send({ email: email(), password }),
      request(app).post('/api/v1/auth/register').set(headers(second)).send({ email: ` ${email().toUpperCase()} `, password })
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    const losingIndex = responses.findIndex((response) => response.status === 409);
    expect(responses[losingIndex]?.body.code).toBe('ACCOUNT_UNAVAILABLE');
    expect(responses[losingIndex]?.headers['set-cookie']).toBeUndefined();
    const losingProof = losingIndex === 0 ? first : second;
    expect(await sessions().findValid(losingProof.token)).toEqual(losingProof.session);
    expect(await client().user.count({ where: { email: email() } })).toBe(1);
    expect((await rows()).sessions).toHaveLength(2);
  });
});

describe('authentication expiration and activity', () => {
  it.each([-1, 0, 1])('enforces the fixed anonymous deadline at offset %i before login password work', async (offset) => {
    await seedUser();
    const proof = await anonymous();
    const spy = passwordSpy();
    const app = makeApp({ passwords: spy });
    time += ANONYMOUS_LIFETIME_MS + offset;
    const response = await request(app).post('/api/v1/auth/login').set(headers(proof)).send({ email: email(), password }).expect(offset < 0 ? 200 : 401);
    expect(spy.verify).toHaveBeenCalledTimes(offset < 0 ? 1 : 0);
    if (offset >= 0) expect(response.headers['set-cookie']).toBeUndefined();
  });
  it.each([-1, 0, 1])('enforces authenticated idle expiry at offset %i and refreshes only a valid /me', async (offset) => {
    const user = await seedUser();
    const proof = await authenticated(user.id);
    time += IDLE_LIFETIME_MS + offset;
    const response = await request(makeApp()).get('/api/v1/auth/me').set(headers(proof)).expect(offset < 0 ? 200 : 401);
    expect(response.headers['set-cookie']).toBeUndefined();
    const row = await client().session.findUniqueOrThrow({ where: { id: proof.session.id } });
    expect(row.lastSeenAt).toEqual(offset < 0 ? new Date(time) : proof.session.lastSeenAt);
    expect(row.expiresAt).toEqual(proof.session.expiresAt);
  });
  it.each([-1, 0, 1])('enforces seven-day absolute expiry at offset %i even with recent activity and later stored expiry', async (offset) => {
    const user = await seedUser();
    const proof = await authenticated(user.id);
    const stored = await client().session.update({ where: { id: proof.session.id }, data: {
      lastSeenAt: new Date(time + ABSOLUTE_LIFETIME_MS - 1000), expiresAt: new Date(time + ABSOLUTE_LIFETIME_MS * 2)
    } });
    time += ABSOLUTE_LIFETIME_MS + offset;
    const response = await request(makeApp()).get('/api/v1/auth/me').set(headers(proof)).expect(offset < 0 ? 200 : 401);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect((await client().session.findUniqueOrThrow({ where: { id: stored.id } })).lastSeenAt).toEqual(offset < 0 ? new Date(time) : stored.lastSeenAt);
  });
  it.each([-1, 0, 1])('enforces an earlier stored deadline at offset %i', async (offset) => {
    const user = await seedUser();
    const proof = await authenticated(user.id);
    await client().session.update({ where: { id: proof.session.id }, data: { expiresAt: new Date(time + 1000) } });
    time += 1000 + offset;
    await request(makeApp()).get('/api/v1/auth/me').set(headers(proof)).expect(offset < 0 ? 200 : 401);
  });
  it('revalidates anonymous expiry after password verification without consuming the expired row', async () => {
    await seedUser();
    const proof = await anonymous();
    const app = makeApp({ passwords: { hash: passwords.hash, async verify(digest, value) {
      const valid = await passwords.verify(digest, value);
      time += ANONYMOUS_LIFETIME_MS;
      return valid;
    } } });
    const response = await request(app).post('/api/v1/auth/login').set(headers(proof)).send({ email: email(), password }).expect(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await client().session.findUniqueOrThrow({ where: { id: proof.session.id } })).toEqual(proof.session);
  });
  it('does not resurrect a session when /me races logout, and keeps a second device valid', async () => {
    const user = await seedUser();
    const proof = await authenticated(user.id);
    const other = await authenticated(user.id);
    time += 1000;
    const app = makeApp();
    const [me, logout] = await Promise.all([
      request(app).get('/api/v1/auth/me').set(headers(proof)),
      request(app).post('/api/v1/auth/logout').set(headers(proof)).send({})
    ]);
    expect([200, 401, 409]).toContain(me.status);
    expect(logout.status).toBe(204);
    expect(me.headers['set-cookie']).toBeUndefined();
    expect(await client().session.findUnique({ where: { id: proof.session.id } })).toBeNull();
    expect(await sessions().findValid(other.token)).toEqual(other.session);
  });
  it('does not refresh or revoke an expired session on logout', async () => {
    const user = await seedUser();
    const proof = await authenticated(user.id);
    time += IDLE_LIFETIME_MS;
    const response = await request(makeApp()).post('/api/v1/auth/logout').set(headers(proof)).send({}).expect(401);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await client().session.findUniqueOrThrow({ where: { id: proof.session.id } })).toEqual(proof.session);
  });
});

describe('authentication transaction failure and cookie delivery', () => {
  it.each(['register', 'login'] as const)('rolls back %s on a real session-token uniqueness violation', async (kind) => {
    if (kind === 'login') await seedUser();
    const proof = await anonymous();
    const collision = await anonymous();
    let entropyCalls = 0;
    const app = makeApp({ token: () => ++entropyCalls === 1 ? collision.token : generateToken() });
    const before = await rows();
    const response = await request(app).post(`/api/v1/auth/${kind}`).set(headers(proof)).send({ email: email(), password }).expect(503);
    expect(response.body).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Authentication is temporarily unavailable.' });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await rows()).toEqual(before);
  });
  it.each(['register', 'login', 'logout', 'me'] as const)('rolls back all %s writes if the transaction fails after its callback work', async (kind) => {
    const user = kind === 'register' ? null : await seedUser();
    const proof = user && (kind === 'logout' || kind === 'me') ? await authenticated(user.id) : await anonymous();
    const database: AuthenticationDatabase = { user: client().user, $transaction: (work) => client().$transaction(async (transaction) => {
      await work(transaction);
      throw new Error('private@example.invalid password=secret commit-failure');
    }) };
    const app = makeApp({ database });
    time += 1000;
    const before = await rows();
    const pending = kind === 'me' ? request(app).get('/api/v1/auth/me') : request(app).post(`/api/v1/auth/${kind}`);
    const response = await pending.set(headers(proof)).send(kind === 'me' ? undefined : kind === 'logout' ? {} : { email: email(), password }).expect(503);
    expect(response.body).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Authentication is temporarily unavailable.' });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await rows()).toEqual(before);
  });
  it.each(['register', 'login', 'logout'] as const)('sends no %s cookie/response until the real transaction commits', async (kind) => {
    const user = kind === 'register' ? null : await seedUser();
    const proof = user && kind === 'logout' ? await authenticated(user.id) : await anonymous();
    let ready!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => { ready = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const database: AuthenticationDatabase = { user: client().user, $transaction: (work) => client().$transaction(async (transaction) => {
      const result = await work(transaction);
      ready();
      await gate;
      return result;
    }) };
    const app = makeApp({ database });
    const before = await rows();
    let completed = false;
    let receivedHeaders = false;
    const pending = request(app).post(`/api/v1/auth/${kind}`).set(headers(proof)).send(kind === 'logout' ? {} : { email: email(), password })
      .on('request', (outgoing: request.Test) => { outgoing.req.on('response', () => { receivedHeaders = true; }); })
      .then((response) => { completed = true; return response; });
    try {
      await Promise.race([reached, pending.then(() => { throw new Error('HTTP response arrived before the commit gate.'); })]);
      expect(completed).toBe(false);
      expect(await rows()).toEqual(before); // Another connection sees only committed original state.
      expect(receivedHeaders).toBe(false); // Raw HTTP headers, not merely the parsed body, must await commit.
    } finally { release(); await pending; }
    const response = await pending;
    expect(receivedHeaders).toBe(true);
    expect(response.status).toBe(kind === 'register' ? 201 : kind === 'login' ? 200 : 204);
    expect(cookie(response)).toMatch(kind === 'logout' ? /^applyflow_session=$/ : /^applyflow_session=[a-f0-9]{64}$/);
    expect(await sessions().findValid(proof.token)).toBeNull();
  });
  it('sanitizes database read failures before verification and preserves the anonymous session', async () => {
    const proof = await anonymous();
    const spy = passwordSpy();
    const app = makeApp({ passwords: spy });
    const before = await rows();
    vi.spyOn(client().user, 'findUnique').mockRejectedValueOnce(new Error('private@example.invalid password=secret'));
    const response = await request(app).post('/api/v1/auth/login').set(headers(proof)).send({ email: email(), password }).expect(503);
    expect(response.body).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Authentication is temporarily unavailable.' });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(spy.verify).not.toHaveBeenCalled();
    expect(await rows()).toEqual(before);
  });
  it('sanitizes password admission failure without starting a transaction or changing state', async () => {
    await seedUser();
    const proof = await anonymous();
    const spy = passwordSpy();
    spy.verify.mockRejectedValueOnce(new PasswordOperationError('BUSY'));
    const transaction = vi.fn();
    const app = makeApp({ passwords: spy, database: { user: client().user, async $transaction() {
      transaction();
      throw new Error('Unexpected transaction after password admission failure.');
    } } });
    const before = await rows();
    const response = await request(app).post('/api/v1/auth/login').set(headers(proof)).send({ email: email(), password }).expect(503);
    expect(response.body.code).toBe('SERVICE_UNAVAILABLE');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(transaction).not.toHaveBeenCalled();
    expect(await rows()).toEqual(before);
  });
  it('rejects a hash changed during verification instead of authenticating with a stale credential', async () => {
    const user = await seedUser();
    const proof = await anonymous();
    const app = makeApp({ passwords: { hash: passwords.hash, async verify(digest, value) {
      const valid = await passwords.verify(digest, value);
      await client().user.update({ where: { id: user.id }, data: { passwordHash: 'changed-by-this-fixture' } });
      return valid;
    } } });
    const response = await request(app).post('/api/v1/auth/login').set(headers(proof)).send({ email: email(), password }).expect(401);
    expect(response.body.code).toBe('INVALID_CREDENTIALS');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(await sessions().findValid(proof.token)).toEqual(proof.session);
    expect((await rows()).sessions).toHaveLength(1);
  });
  it.each(['register', 'login'] as const)('revalidates session-bound CSRF inside the %s transaction after password work', async (kind) => {
    if (kind === 'login') await seedUser();
    const proof = await anonymous();
    const changed = generateToken();
    const changeCsrf = () => client().session.update({ where: { id: proof.session.id }, data: { csrfToken: changed } });
    const app = makeApp({ passwords: {
      async hash(value) { const hash = await passwords.hash(value); await changeCsrf(); return hash; },
      async verify(digest, value) { const valid = await passwords.verify(digest, value); await changeCsrf(); return valid; }
    } });
    const response = await request(app).post(`/api/v1/auth/${kind}`).set(headers(proof)).send({ email: email(), password }).expect(403);
    expect(response.body.code).toBe('REQUEST_REJECTED');
    expect(response.headers['set-cookie']).toBeUndefined();
    const state = await rows();
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toEqual({ ...proof.session, csrfToken: changed });
    expect(state.users).toHaveLength(kind === 'login' ? 1 : 0);
  });
});
afterAll(async () => { await connection?.client.$disconnect(); });

describe('secure authentication on isolated PostgreSQL', () => {
  it('uses the connected dedicated test identity and refuses development targeting', async () => {
    expect(connection?.target).toMatchObject({ host: '127.0.0.1', port: '5433', database: 'applyflow_test', username: 'applyflow_test' });
    await expect(openLocalDatabase('development', process.env)).rejects.toThrow();
  });
  it('registers through bootstrap, rotates session/CSRF, stores a real password hash, and returns a safe user DTO', async () => {
    const app = makeApp();
    const boot = await request(app).get('/api/v1/auth/csrf').set('X-ApplyFlow-Request', '1').expect(200);
    const proof = { token: tokenFrom(boot), session: { csrfToken: boot.body.csrfToken as string } };
    const response = await request(app).post('/api/v1/auth/register').set(headers(proof)).send({ email: ` ${email().toUpperCase()} `, password }).expect(201);
    expect(Object.keys(response.body).sort()).toEqual(['csrfToken', 'user']);
    expect(Object.keys(response.body.user).sort()).toEqual(['email', 'id']);
    expect(response.body.user.email).toBe(email());
    expect(response.body.csrfToken).not.toBe(boot.body.csrfToken);
    expect(tokenFrom(response)).not.toBe(proof.token);
    expect(JSON.stringify(response.body)).not.toContain(tokenFrom(response));
    expect(JSON.stringify(response.body)).not.toContain(password);
    const user = await client().user.findUniqueOrThrow({ where: { email: email() } });
    expect(user.passwordHash).toMatch(/^\$argon2id\$v=19\$/);
    expect(await passwords.verify(user.passwordHash, password)).toBe(true);
    expect(await sessions().findValid(proof.token)).toBeNull();
    const session = await sessions().findValid(tokenFrom(response));
    expect(session?.userId).toBe(user.id);
    expect(session?.csrfToken).toBe(response.body.csrfToken);
    expect(session?.tokenHash).toBe(hashSessionToken(tokenFrom(response)));
    expect(response.headers['set-cookie']?.[0]).toContain('Max-Age=604800');
    await request(app).get('/api/v1/auth/me').set('X-ApplyFlow-Request', '1').set('Cookie', cookie(response)).expect(200, { user: response.body.user });
    await request(app).get('/api/v1/auth/me').set(headers(proof)).expect(401);
  });
  it('logs in with normalized email, rotates the anonymous session, and preserves another device', async () => {
    const user = await seedUser();
    const other = await authenticated(user.id);
    const previous = await anonymous();
    const app = makeApp();
    const response = await request(app).post('/api/v1/auth/login').set(headers(previous)).send({ email: ` ${user.email.toUpperCase()} `, password }).expect(200);
    expect(response.body.user).toEqual(user);
    expect(response.body.csrfToken).not.toBe(previous.session.csrfToken);
    expect(tokenFrom(response)).not.toBe(previous.token);
    expect(await sessions().findValid(previous.token)).toBeNull();
    expect(await sessions().findValid(other.token)).toEqual(other.session);
    expect(await sessions().findValid(tokenFrom(response))).toMatchObject({ userId: user.id, csrfToken: response.body.csrfToken });
    const boot = await request(app).get('/api/v1/auth/csrf').set('X-ApplyFlow-Request', '1').set('Cookie', cookie(response)).expect(200);
    expect(boot.body.csrfToken).toBe(response.body.csrfToken);
    expect(boot.headers['set-cookie']).toBeUndefined();
    await request(app).post('/api/v1/auth/logout').set(headers(previous)).set('Cookie', cookie(response)).send({}).expect(403);
    expect(await sessions().findValid(tokenFrom(response))).not.toBeNull();
    await request(app).post('/api/v1/auth/logout').set(headers(previous)).set('Cookie', cookie(response))
      .set('X-CSRF-Token', response.body.csrfToken as string).send({}).expect(204);
    expect(await sessions().findValid(other.token)).toEqual(other.session);
  });
  it('returns identical invalid-credential responses for unknown account and wrong password, performing real verification in both cases', async () => {
    await seedUser();
    const proof = await anonymous();
    const spy = passwordSpy();
    const app = makeApp({ passwords: spy });
    const before = await rows();
    const wrong = await request(app).post('/api/v1/auth/login').set(headers(proof)).send({ email: email(), password: 'incorrect' }).expect(401);
    const unknown = await request(app).post('/api/v1/auth/login').set(headers(proof)).send({ email: email('unknown'), password: 'incorrect' }).expect(401);
    expect(wrong.body).toEqual({ code: 'INVALID_CREDENTIALS', message: 'Email or password is incorrect.' });
    expect(unknown.body).toEqual(wrong.body);
    expect(wrong.headers['set-cookie']).toBeUndefined();
    expect(unknown.headers['set-cookie']).toBeUndefined();
    expect(spy.verify).toHaveBeenCalledTimes(2);
    expect(spy.verify).toHaveBeenNthCalledWith(1, passwordHash, 'incorrect');
    expect(spy.verify).toHaveBeenNthCalledWith(2, null, 'incorrect');
    expect(await rows()).toEqual(before);
  });
  it('keeps disabled registration unavailable without session reads, hashing, or writes', async () => {
    const spy = passwordSpy();
    const before = await rows();
    await request(makeApp({ enabled: false, passwords: spy })).post('/api/v1/auth/register')
      .set('X-ApplyFlow-Request', '1').set('Origin', origin).set('Content-Type', 'application/json').send('{').expect(404);
    expect(spy.hash).not.toHaveBeenCalled();
    expect(await rows()).toEqual(before);
  });
  it('rejects malformed, hostile, and CSRF-invalid requests without hashing, verification, or state change', async () => {
    const proof = await anonymous();
    const wrongSession = await anonymous();
    const spy = passwordSpy();
    const app = makeApp({ passwords: spy });
    const before = await rows();
    const body = { email: email(), password };
    await request(app).post('/api/v1/auth/register').set(headers(proof)).set('Origin', 'https://evil.invalid').send(body).expect(403);
    await request(app).post('/api/v1/auth/register').set(headers(proof)).set('Sec-Fetch-Site', 'cross-site').send(body).expect(403);
    await request(app).post('/api/v1/auth/register').set(headers(proof)).set('X-CSRF-Token', wrongSession.session.csrfToken).send(body).expect(403);
    await request(app).post('/api/v1/auth/login').set(headers(proof)).set('X-CSRF-Token', '').send(body).expect(403);
    await request(app).post('/api/v1/auth/login').set(headers(proof)).send({ ...body, role: 'admin' }).expect(400);
    await request(app).post('/api/v1/auth/login').set(headers(proof)).set('Content-Type', 'text/plain').send(JSON.stringify(body)).expect(415);
    await request(app).post('/api/v1/auth/login').set(headers(proof)).set('Content-Type', 'application/json').send('{').expect(400);
    await request(app).post('/api/v1/auth/login').set(headers(proof)).send({ email: email(), password: 'x'.repeat(17_000) }).expect(413);
    expect(spy.hash).not.toHaveBeenCalled();
    expect(spy.verify).not.toHaveBeenCalled();
    expect(await rows()).toEqual(before);
  });
  it('rejects attempts to switch an already-authenticated session without logout', async () => {
    const user = await seedUser();
    const proof = await authenticated(user.id);
    const spy = passwordSpy();
    const app = makeApp({ passwords: spy });
    for (const endpoint of ['register', 'login']) {
      const response = await request(app).post(`/api/v1/auth/${endpoint}`).set(headers(proof)).send({ email: email(), password }).expect(409);
      expect(response.body.code).toBe('ALREADY_AUTHENTICATED');
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(await sessions().findValid(proof.token)).toEqual(proof.session);
    expect(spy.hash).not.toHaveBeenCalled(); expect(spy.verify).not.toHaveBeenCalled();
  });
  it('logs out only the current authenticated session and leaves another device unchanged', async () => {
    const user = await seedUser();
    const first = await authenticated(user.id);
    const second = await authenticated(user.id);
    const app = makeApp();
    await request(app).post('/api/v1/auth/logout').set(headers(first)).set('X-CSRF-Token', second.session.csrfToken).send({}).expect(403);
    expect(await sessions().findValid(first.token)).toEqual(first.session);
    const response = await request(app).post('/api/v1/auth/logout').set(headers(first)).send({}).expect(204);
    expect(response.text).toBe('');
    expect(response.headers['set-cookie']?.[0]).toMatch(/^applyflow_session=; Max-Age=0;/);
    expect(response.headers['set-cookie']?.[0]).toContain('HttpOnly; SameSite=Lax');
    expect(await sessions().findValid(first.token)).toBeNull();
    expect(await sessions().findValid(second.token)).toEqual(second.session);
    await request(app).get('/api/v1/auth/me').set(headers(first)).expect(401);
    await request(app).get('/api/v1/auth/me').set(headers(second)).expect(200, { user });
    const stale = await request(app).post('/api/v1/auth/logout').set(headers(first)).send({}).expect(401);
    expect(stale.headers['set-cookie']).toBeUndefined();
  });
  it('rejects anonymous /me and logout without refreshing or revoking the anonymous session', async () => {
    const proof = await anonymous();
    const app = makeApp();
    await request(app).get('/api/v1/auth/me').set(headers(proof)).expect(401);
    const logout = await request(app).post('/api/v1/auth/logout').set(headers(proof)).send({}).expect(401);
    expect(logout.headers['set-cookie']).toBeUndefined();
    expect(await sessions().findValid(proof.token)).toEqual(proof.session);
  });
});
