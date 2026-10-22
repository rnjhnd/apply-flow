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
    id: 'c4974360-a70c-4a29-8b41-df95d15d7270', company: 'Acme', jobTitle: 'Engineer', status: 'SAVED',
    applicationDate: null, location: null, jobUrl: null, notes: null, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z' } }),
    list: vi.fn<ApplicationService['list']>().mockResolvedValue({ items: [], nextCursor: null }) };
  const sessions = { findValid: vi.fn(), createAnonymous: vi.fn() };
  return { app: createApp(parseEnv({ NODE_ENV: 'test' }), { config: parseAuthConfig({ NODE_ENV: 'test' }), sessions }, { applications: service }), service, sessions };
}
const headers = { Origin: origin, 'X-ApplyFlow-Request': '1', 'X-CSRF-Token': csrf, Cookie: `applyflow_session=${token}` };
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
    await request(f.app).get('/api/applications/unknown').set(headers).expect(404).expect('Content-Type', /json/);
    expect(f.service.create).not.toHaveBeenCalled();
  });
  it.each([401, 403, 503])('returns safe service error %i with no cookie mutation', async status => {
    const f = fixture(); f.service.create.mockRejectedValueOnce(new ApplicationHttpError(status, status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'REQUEST_REJECTED' : 'SERVICE_UNAVAILABLE', 'Request unavailable.'));
    const response = await request(f.app).post('/api/applications').set(headers).send({}).expect(status);
    expect(response.body).toEqual({ code: status === 401 ? 'UNAUTHENTICATED' : status === 403 ? 'REQUEST_REJECTED' : 'SERVICE_UNAVAILABLE', message: 'Request unavailable.' });
    expect(response.headers['set-cookie']).toBeUndefined();
  });
});
