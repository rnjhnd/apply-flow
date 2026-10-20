import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import express, { type ErrorRequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { parseEnv } from '../../config/env.js';
import { parseAuthConfig } from '../../config/auth.js';
import type { Session } from '../../generated/prisma/client.ts';
import { type BootstrapSessions } from './csrf.js';
import { AuthHttpError } from './http-error.js';
import { requireJsonRequest, trustedAuthRequest, validateCredentials } from './request.js';
import { ANONYMOUS_LIFETIME_MS } from './sessions.js';
import { createAuthAdmission } from './admission.js';

const token = 'a'.repeat(64);
const csrfToken = 'b'.repeat(64);
const path = '/api/v1/auth/csrf';
const origin = 'http://127.0.0.1:5173';
const cookie = `applyflow_session=${token}`;
const headers = { 'X-ApplyFlow-Request': '1' };
function fixture(mode: 'test' | 'production' = 'test') {
  let time = Date.UTC(2026, 0, 1);
  const session: Session = { id: randomUUID(), userId: null, tokenHash: 'c'.repeat(64), csrfToken,
    createdAt: new Date(time), lastSeenAt: new Date(time), expiresAt: new Date(time + ANONYMOUS_LIFETIME_MS) };
  const sessions = { findValid: vi.fn<BootstrapSessions['findValid']>().mockResolvedValue(session),
    createAnonymous: vi.fn<BootstrapSessions['createAnonymous']>().mockResolvedValue({ token, session }) };
  const config = parseAuthConfig({ NODE_ENV: mode, APP_ORIGIN: mode === 'production' ? 'https://applyflow.example' : origin });
  const app = createApp(parseEnv({ NODE_ENV: 'test' }), { config, sessions, now: () => new Date(time) });
  return { app, sessions, session, advance: (ms: number) => { time += ms; } };
}

describe('CSRF bootstrap HTTP admission without a database', () => {
  it('returns only the token with no-store, secure local cookie policy, and request quota headers', async () => {
    const { app, sessions } = fixture();
    const response = await request(app).get(path).set(headers).expect(200);
    expect(response.body).toEqual({ csrfToken });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['ratelimit-remaining']).toBe('119');
    expect(response.headers['set-cookie']).toEqual([expect.stringContaining(`applyflow_session=${token}; Max-Age=900`)]);
    expect(response.headers['set-cookie']?.[0]).toMatch(/HttpOnly; SameSite=Lax/);
    expect(response.headers['set-cookie']?.[0]).not.toMatch(/Secure|Domain=/);
    expect(sessions.findValid).not.toHaveBeenCalled();
    expect(sessions.createAnonymous).toHaveBeenCalledOnce();
  });
  it('uses the __Host secure cookie policy in production configuration without a production connection', async () => {
    const response = await request(fixture('production').app).get(path).set(headers).expect(200);
    expect(response.headers['set-cookie']?.[0]).toContain(`__Host-applyflow_session=${token}`);
    expect(response.headers['set-cookie']?.[0]).toContain('; Secure;');
  });
  it.each([undefined, 'https://evil.invalid', 'null', `${origin}.evil.invalid`, `${origin}/`, 'http://127.0.0.1:5174', `${origin}, ${origin}`])(
    'rejects an invalid custom header or hostile Origin %s before lookup/allocation', async (value) => {
      const { app, sessions } = fixture();
      const pending = request(app).get(path).set('Cookie', cookie);
      if (value !== undefined) pending.set(headers).set('Origin', value);
      const response = await pending.expect(403);
      expect(response.body).toEqual({ code: 'REQUEST_REJECTED', message: 'Authentication request rejected.' });
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers['set-cookie']).toBeUndefined();
      expect(sessions.findValid).not.toHaveBeenCalled();
      expect(sessions.createAnonymous).not.toHaveBeenCalled();
    });
  it.each(['same-site', 'cross-site', 'none', 'invalid', 'same-origin, cross-site'])(
    'rejects Fetch Metadata %s even with trusted Origin and custom header', async (site) => {
      const { app, sessions } = fixture();
      await request(app).get(path).set(headers).set('Origin', origin).set('Sec-Fetch-Site', site).expect(403);
      expect(sessions.createAnonymous).not.toHaveBeenCalled();
    });
  it.each(['0', 'true', '1, 1', ''])('rejects wrong custom header %s', async (value) => {
    const { app, sessions } = fixture();
    await request(app).get(path).set('X-ApplyFlow-Request', value).expect(403);
    expect(sessions.createAnonymous).not.toHaveBeenCalled();
  });
  it('accepts matching Origin/Fetch Metadata, and accepts legacy clients without those optional GET headers', async () => {
    const { app } = fixture();
    await request(app).get(path).set(headers).set('Origin', origin).set('Sec-Fetch-Site', 'same-origin').expect(200);
    await request(app).get(path).set(headers).expect(200);
  });
  it.each(['head', 'options', 'post'] as const)('rejects method %s without allocating', async (method) => {
    const { app, sessions } = fixture();
    const response = await request(app)[method](path).set(headers).set('Origin', origin).expect(405);
    expect(response.headers.allow).toBe('GET');
    expect(sessions.createAnonymous).not.toHaveBeenCalled();
  });
  it.each([`${path}?email=private%40example.invalid`, `${path}?csrfToken=secret`])('rejects query parameters before lookup: %s', async (url) => {
    const { app, sessions } = fixture();
    const response = await request(app).get(url).set(headers).set('Cookie', cookie).expect(400);
    expect(JSON.stringify(response.body)).not.toContain('private');
    expect(sessions.findValid).not.toHaveBeenCalled();
  });
  it('rejects GET bodies before JSON parsing and rejects duplicate cookies before lookup', async () => {
    const { app, sessions } = fixture();
    await request(app).get(path).set(headers).set('Content-Type', 'application/json').send('{invalid').expect(400);
    await request(app).get(path).set(headers).set('Cookie', `${cookie}; ${cookie}`).expect(400, {
      code: 'INVALID_COOKIE', message: 'Ambiguous session cookie.'
    });
    expect(sessions.findValid).not.toHaveBeenCalled();
    expect(sessions.createAnonymous).not.toHaveBeenCalled();
  });
  it('rejects hostile writes before parsing malformed or oversized JSON', async () => {
    const { app, sessions } = fixture();
    for (const body of ['{', JSON.stringify({ password: 'x'.repeat(17_000) })]) {
      await request(app).post(path).set(headers).set('Origin', 'https://evil.invalid')
        .set('Content-Type', 'application/json').send(body).expect(403);
    }
    expect(sessions.findValid).not.toHaveBeenCalled();
    expect(sessions.createAnonymous).not.toHaveBeenCalled();
  });
  it.each(['applyflow_session=invalid', 'applyflow_session=%61', 'unrelated=value'])('treats malformed cookie as absent without lookup: %s', async (value) => {
    const { app, sessions } = fixture();
    await request(app).get(path).set(headers).set('Cookie', value).expect(200);
    expect(sessions.findValid).not.toHaveBeenCalled();
    expect(sessions.createAnonymous).toHaveBeenCalledOnce();
  });
  it('enforces exactly 120 concurrent requests/minute, including reused sessions, with an injected boundary clock', async () => {
    const { app, sessions, advance } = fixture();
    const responses = await Promise.all(Array.from({ length: 125 }, () => request(app).get(path).set(headers).set('Cookie', cookie)));
    expect(responses.filter((response) => response.status === 200)).toHaveLength(120);
    const denied = responses.filter((response) => response.status === 429);
    expect(denied).toHaveLength(5);
    for (const response of denied) {
      expect(response.headers['retry-after']).toBe('60');
      expect(response.headers['ratelimit-remaining']).toBe('0');
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    expect(sessions.findValid).toHaveBeenCalledTimes(120);
    expect(sessions.createAnonymous).not.toHaveBeenCalled();
    advance(59_999);
    await request(app).get(path).set(headers).set('Cookie', cookie).expect(429).expect('Retry-After', '1');
    advance(1);
    await request(app).get(path).set(headers).set('Cookie', cookie).expect(200).expect('RateLimit-Remaining', '119');
  });
  it('counts hostile traffic, ignores spoofed forwarded IPs, and keeps health outside authentication limits', async () => {
    const { app, sessions } = fixture();
    for (let i = 0; i < 120; i++) await request(app).get(path).set('X-Forwarded-For', `10.0.0.${i + 1}`).expect(403);
    await request(app).get(path).set(headers).set('X-Forwarded-For', '1.1.1.1').expect(429);
    await request(app).get('/api/v1/health/live').expect(200, { status: 'ok', service: 'applyflow-api' });
    expect(sessions.createAnonymous).not.toHaveBeenCalled();
  });
  it('retains allocation reservations after database failure and emits no cookie or internal error details', async () => {
    const { app, sessions } = fixture();
    sessions.createAnonymous.mockRejectedValue(new Error('private@example.invalid database password=secret'));
    for (let i = 0; i < 20; i++) {
      const response = await request(app).get(path).set(headers).expect(503);
      expect(response.body).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Authentication storage is unavailable.' });
      expect(response.headers['set-cookie']).toBeUndefined();
    }
    await request(app).get(path).set(headers).expect(429);
    expect(sessions.createAnonymous).toHaveBeenCalledTimes(20);
  });
  it('fails closed on lookup failure without allocating a fallback session', async () => {
    const { app, sessions } = fixture();
    sessions.findValid.mockRejectedValue(new Error('private token'));
    const response = await request(app).get(path).set(headers).set('Cookie', cookie).expect(503);
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sessions.createAnonymous).not.toHaveBeenCalled();
  });
  it('fails closed with 503 before lookup/allocation if the request counter is unavailable', async () => {
    const { sessions } = fixture();
    const app = createApp(parseEnv({ NODE_ENV: 'test' }), { config: parseAuthConfig({ NODE_ENV: 'test' }), sessions,
      admission: createAuthAdmission({ now: () => new Date(NaN) }) });
    const response = await request(app).get(path).set(headers).set('Cookie', cookie).expect(503);
    expect(response.body).toEqual({ code: 'SERVICE_UNAVAILABLE', message: 'Authentication admission is unavailable.' });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(sessions.findValid).not.toHaveBeenCalled();
    expect(sessions.createAnonymous).not.toHaveBeenCalled();
  });
  it('keeps raw emails, cookies, and credentials out of the pinned limiter debug/error output', () => {
    const script = `
      import request from 'supertest';
      import { createApp } from './apps/api/src/app.ts';
      import { parseEnv } from './apps/api/src/config/env.ts';
      import { parseAuthConfig } from './apps/api/src/config/auth.ts';
      const sessions = { findValid: async () => { throw new Error('private@example.invalid credential=super-secret'); },
        createAnonymous: async () => { throw new Error('Unexpected allocation'); } };
      const app = createApp(parseEnv({NODE_ENV:'test'}), {config:parseAuthConfig({NODE_ENV:'test'}), sessions});
      await request(app).get('/api/v1/auth/csrf?email=private@example.invalid').set('X-ApplyFlow-Request','1').expect(400);
      await request(app).get('/api/v1/auth/csrf').set('X-ApplyFlow-Request','1')
        .set('Cookie','applyflow_session=${token}').expect(503);
    `;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], {
      cwd: new URL('../../../../../', import.meta.url), env: { ...process.env, DEBUG: 'express-rate-limit', DEBUG_COLORS: '0' },
      encoding: 'utf8', timeout: 10_000, windowsHide: true
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const output = `${result.stdout}${result.stderr}`;
    expect(output).toContain('express-rate-limit');
    expect(output).toContain('requested');
    expect(output).not.toContain('private@example.invalid');
    expect(output).not.toContain('super-secret');
    expect(output).not.toContain(token);
  });
  it('does not expose future endpoints and preserves API 404 and existing JSON errors', async () => {
    const { app, sessions } = fixture();
    for (const endpoint of ['register', 'login', 'logout', 'me']) {
      await request(app).get(`/api/v1/auth/${endpoint}`).set(headers).expect(404).expect('Content-Type', /json/);
    }
    await request(app).get('/api/v1/unknown').expect(404).expect('Content-Type', /json/);
    await request(app).post('/api/v1/unknown').set('Content-Type', 'application/json').send('{').expect(400, {
      code: 'INVALID_JSON', message: 'Request body must be valid JSON.'
    });
    await request(app).post('/api/v1/unknown').send({ input: 'x'.repeat(17_000) }).expect(413);
    expect(sessions.createAnonymous).not.toHaveBeenCalled();
  });
});

// A test-only route exercises future write middleware without exposing a credential endpoint in the application.
function credentialProbe(kind: 'login' | 'registration' = 'login') {
  const app = express();
  const work = vi.fn();
  app.use(trustedAuthRequest(parseAuthConfig({ NODE_ENV: 'test' })), requireJsonRequest, express.json({ limit: '16kb' }), validateCredentials(kind));
  app.post('/probe', (_req, res) => { work(res.locals.credentials); res.sendStatus(204); });
  const handler: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    void _next; // Express identifies error middleware by its four-argument signature.
    if (error instanceof AuthHttpError) res.status(error.status).json({ code: error.code, message: error.message });
    else res.status(400).json({ code: 'INVALID_JSON' });
  };
  app.use(handler);
  return { app, work };
}
describe('write request validation primitives (test-only probe)', () => {
  it('requires Origin even for nonbrowser clients before credential work', async () => {
    const { app, work } = credentialProbe();
    await request(app).post('/probe').set(headers).send({ email: 'user@example.invalid', password: 'password' }).expect(403);
    expect(work).not.toHaveBeenCalled();
  });
  it.each(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data'])('rejects simple content type %s before work', async (type) => {
    const { app, work } = credentialProbe();
    await request(app).post('/probe').set(headers).set('Origin', origin).set('Content-Type', type).send('email=private@example.invalid').expect(415);
    expect(work).not.toHaveBeenCalled();
  });
  it.each([{}, { email: 'invalid', password: 'secret' }, { email: 'user@example.invalid', password: 'secret', admin: true }, [], null])(
    'rejects invalid and extra fields without leaking credentials: %j', async (body) => {
      const { app, work } = credentialProbe();
      const response = await request(app).post('/probe').set(headers).set('Origin', origin).set('Content-Type', 'application/json').send(JSON.stringify(body)).expect(400);
      expect(JSON.stringify(response.body)).not.toContain('secret');
      expect(work).not.toHaveBeenCalled();
    });
  it('normalizes email and preserves password bytes after all request checks', async () => {
    const { app, work } = credentialProbe();
    await request(app).post('/probe').set(headers).set('Origin', origin).set('Content-Type', 'application/json; charset=utf-8')
      .send({ email: '  PERSON@Example.invalid ', password: ' Exact password ' }).expect(204);
    expect(work).toHaveBeenCalledExactlyOnceWith({ email: 'person@example.invalid', password: ' Exact password ' });
  });
  it('applies the stronger registration password contract', async () => {
    const { app, work } = credentialProbe('registration');
    await request(app).post('/probe').set(headers).set('Origin', origin).send({ email: 'user@example.invalid', password: 'short' }).expect(400);
    expect(work).not.toHaveBeenCalled();
  });
});
