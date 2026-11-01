import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import { parseEnv } from '../../config/env.js';
import { parseAuthConfig } from '../../config/auth.js';
import { ApplicationHttpError } from './http-error.js';
import type { ApplicationService } from './service.js';

const token = 'a'.repeat(64), csrf = 'b'.repeat(64), origin = 'http://127.0.0.1:5173';
function fixture() {
  const service = { create: vi.fn<ApplicationService['create']>().mockResolvedValue({ application: {
    id: 'c4974360-a70c-4a29-8b41-df95d15d7270', version: 1, company: 'Acme', jobTitle: 'Engineer', status: 'SAVED',
    applicationDate: null, location: null, jobUrl: null, notes: null, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z' } }),
    list: vi.fn<ApplicationService['list']>().mockResolvedValue({ items: [], nextCursor: null }),
    get: vi.fn<ApplicationService['get']>(), update: vi.fn<ApplicationService['update']>(),
    history: vi.fn<ApplicationService['history']>().mockResolvedValue({ items: [], nextCursor: null }) };
  service.get.mockResolvedValue(applicationResponse());
  service.update.mockResolvedValue(applicationResponse());
  const sessions = { findValid: vi.fn(), createAnonymous: vi.fn() };
  return { app: createApp(parseEnv({ NODE_ENV: 'test' }), { config: parseAuthConfig({ NODE_ENV: 'test' }), sessions }, { applications: service }), service, sessions };
}
function applicationResponse() {
  return { application: { id: 'c4974360-a70c-4a29-8b41-df95d15d7270', version: 1,
    company: 'Acme', jobTitle: 'Engineer', status: 'SAVED' as const, applicationDate: null,
    location: null, jobUrl: null, notes: null, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z' } };
}
const headers = { Origin: origin, 'X-ApplyFlow-Request': '1', 'X-CSRF-Token': csrf, Cookie: `applyflow_session=${token}` };
const detail = '/api/applications/c4974360-a70c-4a29-8b41-df95d15d7270';
describe('protected application HTTP composition (injected service)', () => {
  it('mounts create/list before API fallback, uses the cookie proof, and never changes cookies', async () => {
    const f = fixture(); const created = await request(f.app).post('/api/applications').set(headers).send({ company: 'Acme', jobTitle: 'Engineer' }).expect(201);
    expect(created.headers['cache-control']).toBe('no-store'); expect(created.headers['set-cookie']).toBeUndefined();
    expect(f.service.create).toHaveBeenCalledWith({ company: 'Acme', jobTitle: 'Engineer' }, { token, csrfToken: csrf });
    await request(f.app).get('/api/applications?limit=1').set(headers).expect(200, { items: [], nextCursor: null });
    expect(f.service.list).toHaveBeenCalledWith({ limit: '1' }, { token, csrfToken: csrf });
    expect(f.sessions.createAnonymous).not.toHaveBeenCalled();
  });
  it('rejects missing or duplicate cookies without invoking the service', async () => {
    const f = fixture(); await request(f.app).get('/api/applications').set('X-ApplyFlow-Request', '1').expect(401);
    await request(f.app).get('/api/applications').set(headers).set('Cookie', `${headers.Cookie}; ${headers.Cookie}`).expect(400);
    expect(f.service.list).not.toHaveBeenCalled();
  });
  it.each(['Origin', 'X-ApplyFlow-Request'])('rejects missing %s before JSON parsing', async key => {
    const f = fixture(); await request(f.app).post('/api/applications').set(headers).unset(key).set('Content-Type', 'application/json').send('{').expect(403);
    expect(f.service.create).not.toHaveBeenCalled();
  });
  it.each([{ Origin: 'https://evil.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }])('rejects untrusted browser metadata %j', async extra => {
    const f = fixture(); await request(f.app).get('/api/applications').set(headers).set(extra).expect(403); expect(f.service.list).not.toHaveBeenCalled();
  });
  it('retains JSON, body-size, method and API 404 handling', async () => {
    const f = fixture();
    await request(f.app).post('/api/applications').set(headers).set('Content-Type', 'text/plain').send('x').expect(415);
    await request(f.app).post('/api/applications').set(headers).set('Content-Type', 'application/json').send('{').expect(400);
    await request(f.app).post('/api/applications').set(headers).send({ notes: 'x'.repeat(17000) }).expect(413);
    await request(f.app).post('/api/applications?userId=evil').set(headers).send({}).expect(400);
    await request(f.app).head('/api/applications').set(headers).expect(405);
    await request(f.app).patch('/api/applications').set(headers).send({}).expect(405);
    await request(f.app).get('/api/applications/unknown').set(headers).expect(400).expect('Content-Type', /json/);
    expect(f.service.create).not.toHaveBeenCalled();
  });
  it.each([401, 403, 503])('returns safe service error %i with no cookie mutation', async status => {
    const f = fixture(); f.service.create.mockRejectedValueOnce(new ApplicationHttpError(status, status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'REQUEST_REJECTED' : 'SERVICE_UNAVAILABLE', 'Request unavailable.'));
    const response = await request(f.app).post('/api/applications').set(headers).send({}).expect(status);
    expect(response.body).toEqual({ code: status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'REQUEST_REJECTED' : 'SERVICE_UNAVAILABLE', message: 'Request unavailable.' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });
  it('mounts detail/update/history with fixed method, path, query and proof forwarding', async () => {
    const f = fixture();
    const body = { company: 'Acme', jobTitle: 'Engineer', status: 'SAVED', applicationDate: null,
      location: null, jobUrl: null, notes: null, expectedVersion: 1 };
    for (const response of [await request(f.app).get(detail).set(headers).expect(200),
      await request(f.app).put(detail).set(headers).send(body).expect(200),
      await request(f.app).get(detail + '/history?limit=50&cursor=6').set(headers).expect(200)]) {
      expect(response.headers['cache-control']).toBe('no-store'); expect(response.headers['set-cookie']).toBeUndefined();
    }
    const id = detail.split('/').at(-1);
    expect(f.service.get).toHaveBeenCalledWith(id, { token, csrfToken: csrf });
    expect(f.service.update).toHaveBeenCalledWith(id, body, { token, csrfToken: csrf });
    expect(f.service.history).toHaveBeenCalledWith(id, { limit: '50', cursor: '6' }, { token, csrfToken: csrf });
  });
  it('rejects unsafe methods, invalid UUIDs, update/detail queries and malformed JSON before service access', async () => {
    const f = fixture();
    await request(f.app).get('/api/applications/not-a-uuid/history').set(headers).expect(400);
    await request(f.app).put('/api/applications/not-a-uuid').set(headers).send({}).expect(400);
    await request(f.app).get(detail + '?ownerId=x').set(headers).expect(400);
    await request(f.app).put(detail + '?version=1').set(headers).send({}).expect(400);
    await request(f.app).head(detail).set(headers).expect(405).expect('Allow', 'GET, PUT');
    await request(f.app).patch(detail).set(headers).send({}).expect(405);
    await request(f.app).delete(detail).set(headers).expect(405);
    await request(f.app).post(detail + '/history').set(headers).send({}).expect(405).expect('Allow', 'GET');
    await request(f.app).put(detail).set(headers).set('Content-Type', 'text/plain').send('x').expect(415);
    await request(f.app).put(detail).set(headers).set('Content-Type', 'application/json').send('{').expect(400);
    await request(f.app).put(detail).set(headers).send({ notes: 'x'.repeat(17000) }).expect(413);
    expect(f.service.get).not.toHaveBeenCalled(); expect(f.service.update).not.toHaveBeenCalled(); expect(f.service.history).not.toHaveBeenCalled();
  });
  it.each(['get', 'update', 'history'] as const)('rejects missing/ambiguous cookies and untrusted requests on %s', async method => {
    const f = fixture();
    const pending = () => method === 'update' ? request(f.app).put(detail).send({}) : request(f.app).get(detail + (method === 'history' ? '/history' : ''));
    await pending().set(headers).unset('Cookie').expect(401);
    await pending().set(headers).set('Cookie', `${headers.Cookie}; ${headers.Cookie}`).expect(400);
    await pending().set(headers).set('Origin', 'https://evil.invalid').expect(403);
    await pending().set(headers).set('Sec-Fetch-Site', 'cross-site').expect(403);
    await pending().set(headers).unset('X-ApplyFlow-Request').expect(403);
    if (method === 'update') await pending().set(headers).unset('Origin').expect(403);
    expect(f.service[method]).not.toHaveBeenCalled();
  });
  it('passes a stale conflict through as a sanitized 409 without cookie mutation', async () => {
    const f = fixture(); f.service.update.mockRejectedValueOnce(new ApplicationHttpError(409, 'APPLICATION_CONFLICT', 'Application changed.'));
    const response = await request(f.app).put(detail).set(headers).send({}).expect(409);
    expect(response.body).toEqual({ code: 'APPLICATION_CONFLICT', message: 'Application changed.' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
