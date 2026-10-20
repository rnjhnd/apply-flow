import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { parseEnv } from '../../config/env.js';
import { parseAuthConfig } from '../../config/auth.js';
import type { Session } from '../../generated/prisma/client.ts';
import type { AuthenticationService } from './authentication.js';
import type { BootstrapSessions } from './csrf.js';
import { ABSOLUTE_LIFETIME_MS } from './sessions.js';
import { createAuthAdmission } from './admission.js';

const token = 'a'.repeat(64);
const csrf = 'b'.repeat(64);
const origin = 'http://127.0.0.1:5173';
const user = { id: randomUUID(), email: 'person@example.invalid' };
const credentials = { email: user.email, password: 'A sufficiently long password' };
function fixture(options: { authenticated?: boolean; enabled?: boolean; production?: boolean } = {}) {
  const mode = options.production ? 'production' : 'test';
  const config = parseAuthConfig({ NODE_ENV: mode, APP_ORIGIN: options.production ? 'https://applyflow.example' : origin,
    ALLOW_LOCAL_REGISTRATION: options.production ? 'false' : String(options.enabled ?? true) });
  const time = Date.UTC(2026, 0, 1);
  const session: Session = { id: randomUUID(), userId: options.authenticated ? user.id : null,
    tokenHash: 'c'.repeat(64), csrfToken: csrf, createdAt: new Date(time), lastSeenAt: new Date(time), expiresAt: new Date(time + ABSOLUTE_LIFETIME_MS) };
  const result = { body: { user, csrfToken: 'd'.repeat(64) }, token: 'e'.repeat(64), expiresAt: new Date(time + ABSOLUTE_LIFETIME_MS) };
  const authentication = { register: vi.fn<AuthenticationService['register']>().mockResolvedValue(result),
    login: vi.fn<AuthenticationService['login']>().mockResolvedValue(result),
    me: vi.fn<AuthenticationService['me']>().mockResolvedValue({ user }),
    logout: vi.fn<AuthenticationService['logout']>().mockResolvedValue(undefined) };
  const sessions = { findValid: vi.fn<BootstrapSessions['findValid']>().mockResolvedValue(session),
    createAnonymous: vi.fn<BootstrapSessions['createAnonymous']>() };
  const app = createApp(parseEnv({ NODE_ENV: 'test' }), { config, authentication, sessions, now: () => new Date(time) });
  const headers = { 'X-ApplyFlow-Request': '1', 'X-CSRF-Token': csrf, Origin: config.appOrigin,
    Cookie: `${options.production ? '__Host-applyflow_session' : 'applyflow_session'}=${token}` };
  return { app, authentication, sessions, config, headers };
}
describe('secure authentication HTTP composition', () => {
  it.each([undefined, 'invalid', 'f'.repeat(64), csrf])('returns 401 for anonymous logout regardless of CSRF header %s', async (supplied) => {
    const { app, headers, authentication } = fixture();
    const pending = request(app).post('/api/v1/auth/logout').set(headers);
    if (supplied === undefined) pending.unset('X-CSRF-Token');
    else pending.set('X-CSRF-Token', supplied);
    const response = await pending.send({}).expect(401);
    expect(response.body.code).toBe('UNAUTHENTICATED');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(authentication.logout).not.toHaveBeenCalled();
  });
  it.each(['{', 'null', '[]', '{"allDevices":true}'])('returns 400 for malformed logout before authentication: %s', async (body) => {
    const { app, sessions, authentication } = fixture();
    const response = await request(app).post('/api/v1/auth/logout').set('X-ApplyFlow-Request', '1').set('Origin', origin)
      .set('Content-Type', 'application/json').send(body).expect(400);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sessions.findValid).not.toHaveBeenCalled();
    expect(authentication.logout).not.toHaveBeenCalled();
  });
  it.each(['csrf', 'me', 'register', 'login', 'logout'])('enforces request admission on %s in the full API composition', async (endpoint) => {
    const { app, headers, sessions, authentication } = fixture({ authenticated: endpoint === 'me' || endpoint === 'logout' });
    const pending = () => ['csrf', 'me'].includes(endpoint) ? request(app).get(`/api/v1/auth/${endpoint}`) : request(app).post(`/api/v1/auth/${endpoint}`);
    const body = endpoint === 'logout' ? {} : credentials;
    for (const rejected of [{ Origin: 'null' }, { Origin: 'https://evil.invalid' }, { 'Sec-Fetch-Site': 'same-site' }, { 'X-ApplyFlow-Request': '' }]) {
      const response = await pending().set(headers).set(rejected).send(['csrf', 'me'].includes(endpoint) ? undefined : body).expect(403);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(sessions.findValid).not.toHaveBeenCalled();
    for (const work of Object.values(authentication)) expect(work).not.toHaveBeenCalled();
  });
  it.each(['Origin', 'X-ApplyFlow-Request', 'X-CSRF-Token'])('rejects duplicate %s wire headers without authentication work', async (name) => {
    const { app, headers, authentication } = fixture({ authenticated: true });
    const value = name === 'Origin' ? origin : name === 'X-CSRF-Token' ? csrf : '1';
    const response = await request(app).post('/api/v1/auth/logout').set(headers).set({ [name]: [value, value] }).send({}).expect(403);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(authentication.logout).not.toHaveBeenCalled();
  });
  it('ignores an insecure cookie name in production mode instead of treating it as authenticated', async () => {
    const { app, headers, sessions, authentication } = fixture({ production: true, authenticated: true });
    await request(app).get('/api/v1/auth/me').set(headers).set('Cookie', `applyflow_session=${token}`).expect(401);
    expect(sessions.findValid).not.toHaveBeenCalled();
    expect(authentication.me).not.toHaveBeenCalled();
  });
  it('allows valid-session bootstrap and health while the global allocation budget is exhausted', async () => {
    const { sessions, config, authentication, headers } = fixture();
    const admission = createAuthAdmission({ now: () => new Date(0) });
    for (let ip = 1; ip <= 25; ip++) for (let count = 0; count < 20; count++) admission.reserveAnonymous(`10.0.0.${ip}`);
    const app = createApp(parseEnv({ NODE_ENV: 'test' }), { sessions, config, authentication, admission });
    const reused = await request(app).get('/api/v1/auth/csrf').set(headers).expect(200, { csrfToken: csrf });
    expect(reused.headers['set-cookie']).toBeUndefined();
    await request(app).get('/api/v1/auth/csrf').set('X-ApplyFlow-Request', '1').expect(429);
    await request(app).get('/api/v1/health/live').expect(200);
    expect(sessions.createAnonymous).not.toHaveBeenCalled();
  });
  it('normalizes registration, returns only the authenticated contract, and sets a seven-day local cookie', async () => {
    const { app, headers, authentication } = fixture();
    const response = await request(app).post('/api/v1/auth/register').set(headers).send({ ...credentials, email: ' PERSON@Example.invalid ' }).expect(201);
    expect(authentication.register).toHaveBeenCalledExactlyOnceWith(credentials, { token, csrfToken: csrf });
    expect(Object.keys(response.body).sort()).toEqual(['csrfToken', 'user']);
    expect(Object.keys(response.body.user).sort()).toEqual(['email', 'id']);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']?.[0]).toContain(`applyflow_session=${'e'.repeat(64)}; Max-Age=604800`);
    expect(response.headers['set-cookie']?.[0]).toContain('HttpOnly; SameSite=Lax');
  });
  it('uses production cookie attributes for login and clearing without enabling registration', async () => {
    const first = fixture({ production: true });
    const login = await request(first.app).post('/api/v1/auth/login').set(first.headers).send(credentials).expect(200);
    expect(login.headers['set-cookie']?.[0]).toContain('__Host-applyflow_session=');
    expect(login.headers['set-cookie']?.[0]).toContain('; Secure;');
    const second = fixture({ production: true, authenticated: true });
    const logout = await request(second.app).post('/api/v1/auth/logout').set(second.headers).send({}).expect(204);
    expect(logout.headers['set-cookie']?.[0]).toMatch(/^__Host-applyflow_session=; Max-Age=0;/);
    expect(logout.headers['set-cookie']?.[0]).toContain('; Secure;');
  });
  it.each([false, true])('rejects disabled registration before JSON/session/work (production=%s)', async (production) => {
    const { app, headers, config, sessions, authentication } = fixture({ production, enabled: false });
    if (production) config.allowLocalRegistration = true; // Defense in depth even if a caller bypassed the production parser.
    await request(app).post('/api/v1/auth/register').set(headers).set('Content-Type', 'application/json').send('{').expect(404);
    expect(sessions.findValid).not.toHaveBeenCalled();
    expect(authentication.register).not.toHaveBeenCalled();
  });
  it.each(['register', 'login', 'logout'])('rejects missing/wrong CSRF on %s before credential admission or work', async (endpoint) => {
    const { app, headers, authentication } = fixture({ authenticated: endpoint === 'logout' });
    for (const supplied of ['', 'x', 'f'.repeat(64), `${csrf}, ${csrf}`]) {
      const response = await request(app).post(`/api/v1/auth/${endpoint}`).set(headers).set('X-CSRF-Token', supplied)
        .send(endpoint === 'logout' ? {} : credentials).expect(403);
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(authentication.register).not.toHaveBeenCalled();
    expect(authentication.login).not.toHaveBeenCalled();
    expect(authentication.logout).not.toHaveBeenCalled();
  });
  it.each(['register', 'login', 'logout'])('requires a session-bound token on %s', async (endpoint) => {
    const { app, headers, sessions, authentication } = fixture();
    sessions.findValid.mockResolvedValue(null);
    await request(app).post(`/api/v1/auth/${endpoint}`).set(headers).send(endpoint === 'logout' ? {} : credentials).expect(401);
    expect(authentication[endpoint as 'register' | 'login' | 'logout']).not.toHaveBeenCalled();
  });
  it.each(['register', 'login', 'logout'])('rejects hostile origins before parsing JSON on %s', async (endpoint) => {
    const { app, headers, sessions } = fixture();
    await request(app).post(`/api/v1/auth/${endpoint}`).set(headers).set('Origin', 'https://evil.invalid')
      .set('Content-Type', 'application/json').send('{').expect(403);
    expect(sessions.findValid).not.toHaveBeenCalled();
  });
  it.each(['register', 'login', 'logout'])('requires JSON on %s before session lookup', async (endpoint) => {
    const { app, headers, sessions } = fixture();
    await request(app).post(`/api/v1/auth/${endpoint}`).set(headers).set('Content-Type', 'text/plain').send('{}').expect(415);
    expect(sessions.findValid).not.toHaveBeenCalled();
  });
  it.each(['register', 'login'])('rejects already-authenticated %s without replacing the session', async (endpoint) => {
    const { app, headers, authentication } = fixture({ authenticated: true });
    const response = await request(app).post(`/api/v1/auth/${endpoint}`).set(headers).send(credentials).expect(409);
    expect(response.body.code).toBe('ALREADY_AUTHENTICATED');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(authentication[endpoint as 'register' | 'login']).not.toHaveBeenCalled();
  });
  it.each(['get', 'head'] as const)('rejects anonymous /me with %s and never refreshes it', async (method) => {
    const { app, headers, authentication } = fixture();
    await request(app)[method]('/api/v1/auth/me').set(headers).expect(method === 'get' ? 401 : 405);
    expect(authentication.me).not.toHaveBeenCalled();
  });
  it('serves safe /me without reissuing cookies and calls logout only for the presented proof', async () => {
    const { app, headers, authentication } = fixture({ authenticated: true });
    const me = await request(app).get('/api/v1/auth/me').set(headers).expect(200, { user });
    expect(me.headers['set-cookie']).toBeUndefined();
    expect(authentication.me).toHaveBeenCalledExactlyOnceWith(token);
    await request(app).post('/api/v1/auth/logout').set(headers).send({}).expect(204);
    expect(authentication.logout).toHaveBeenCalledExactlyOnceWith({ token, csrfToken: csrf });
  });
  it('rejects missing and duplicate cookies without work', async () => {
    const { app, headers, sessions, authentication } = fixture();
    await request(app).get('/api/v1/auth/me').set('X-ApplyFlow-Request', '1').expect(401);
    await request(app).post('/api/v1/auth/login').set(headers).set('Cookie', `${headers.Cookie}; ${headers.Cookie}`).send(credentials).expect(400);
    expect(sessions.findValid).not.toHaveBeenCalled();
    expect(authentication.login).not.toHaveBeenCalled();
  });
  it('requires an empty logout body, and rejects unknown credential fields without lookup', async () => {
    const { app, headers, sessions } = fixture({ authenticated: true });
    await request(app).post('/api/v1/auth/logout').set(headers).send({ allDevices: true }).expect(400);
    await request(app).post('/api/v1/auth/login').set(headers).send({ ...credentials, admin: true }).expect(400);
    expect(sessions.findValid).not.toHaveBeenCalled();
  });
  it('rejects queries and unsupported methods before work, including HEAD activity refresh', async () => {
    const { app, headers, sessions } = fixture({ authenticated: true });
    for (const endpoint of ['register', 'login', 'logout', 'me']) {
      const pending = endpoint === 'me' ? request(app).get(`/api/v1/auth/${endpoint}?secret=value`) : request(app).post(`/api/v1/auth/${endpoint}?secret=value`);
      await pending.set(headers).send(endpoint === 'me' ? undefined : {}).expect(400);
    }
    await request(app).get('/api/v1/auth/login').set(headers).expect(405).expect('Allow', 'POST');
    await request(app).head('/api/v1/auth/me').set(headers).expect(405).expect('Allow', 'GET');
    expect(sessions.findValid).not.toHaveBeenCalled();
  });
  it('does not let CSRF failures consume the pair budget and rejects the sixth normalized login before work', async () => {
    const { app, headers, authentication } = fixture();
    for (let i = 0; i < 7; i++) await request(app).post('/api/v1/auth/login').set(headers).set('X-CSRF-Token', 'f'.repeat(64)).send(credentials).expect(403);
    for (let i = 0; i < 5; i++) await request(app).post('/api/v1/auth/login').set(headers).send({ ...credentials, email: i % 2 ? user.email.toUpperCase() : ` ${user.email} ` }).expect(200);
    await request(app).post('/api/v1/auth/login').set(headers).send(credentials).expect(429);
    expect(authentication.login).toHaveBeenCalledTimes(5);
  });
});
