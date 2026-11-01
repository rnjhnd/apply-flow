import { describe, expect, it, vi } from 'vitest';
import { authFixture, proof, user, deferred } from '../../test/auth-fixtures';
import { ApplicationFailure, createApplicationsApi } from './api';
import { createAuthStore } from '../auth/store';
import { AuthFailure, type AuthApi } from '../auth/api';
import type { AuthCoordination, AuthCoordinationEvent } from '../auth/coordination';

const dto = { id: 'c4974360-a70c-4a29-8b41-df95d15d7270', version: 1, company: 'Acme', jobTitle: 'Engineer', status: 'SAVED',
  applicationDate: null, location: null, jobUrl: null, notes: null, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z' };
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
async function fixture() {
  const auth = authFixture({ authenticated: true }); await auth.store.bootstrap();
  const fetcher = vi.fn<typeof fetch>(); const api = createApplicationsApi(auth.store, fetcher, () => 1000);
  return { auth, fetcher, api };
}
describe('same-origin typed applications transport', () => {
  it.each([401, 403])('reconciles GET %i once and invalidates rejected admission', async status => {
    const f = await fixture(); const invalidated: boolean[] = [];
    const off = f.auth.store.subscribe(() => invalidated.push(f.auth.store.getSnapshot().verifiedReadId === null));
    f.fetcher.mockResolvedValue(json({ code: status === 401 ? 'UNAUTHENTICATED' : 'REQUEST_REJECTED', message: 'Rejected.' }, status));
    try {
      await expect(f.api.list()).rejects.toMatchObject({ status });
      expect(invalidated).toContain(true); expect(f.auth.api.csrf).toHaveBeenCalledTimes(3);
      expect(f.auth.api.me).toHaveBeenCalledTimes(3); expect(f.fetcher).toHaveBeenCalledOnce();
      expect(f.auth.store.getSnapshot()).toMatchObject({ status: 'authenticated', outcomeUncertain: false });
    } finally { off(); f.auth.store.dispose(); }
  });
  it.each([401, 403])('settles GET %i rejection for anonymous, unavailable and replacement recovery', async status => {
    for (const outcome of ['anonymous', 'unavailable', 'replacement'] as const) {
      const f = await fixture();
      f.fetcher.mockImplementation(async () => {
        if (outcome === 'anonymous') f.auth.api.me.mockRejectedValue(new AuthFailure('http', 401, 'UNAUTHENTICATED'));
        if (outcome === 'unavailable') f.auth.api.me.mockRejectedValue(new AuthFailure('http', 503, 'SERVICE_UNAVAILABLE'));
        if (outcome === 'replacement') {
          f.auth.api.me.mockResolvedValue({ user: { ...user, id: dto.id } });
          f.auth.api.csrf.mockResolvedValue({ csrfToken: 'c'.repeat(64), registrationEnabled: true });
        }
        return json({ code: status === 401 ? 'UNAUTHENTICATED' : 'REQUEST_REJECTED', message: 'Rejected.' }, status);
      });
      try {
        await expect(f.api.list()).rejects.toMatchObject({ status });
        expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.auth.api.csrf).toHaveBeenCalledTimes(3);
        const live = f.auth.store.getSnapshot();
        expect(live.outcomeUncertain).toBe(false);
        if (outcome === 'anonymous') expect(live.status).toBe('anonymous');
        if (outcome === 'unavailable') expect(live).toMatchObject({ status: 'uncertain', user: null, verifiedReadId: null });
        if (outcome === 'replacement') expect(live.user?.id).toBe(dto.id);
      } finally { f.auth.store.dispose(); }
    }
  });
  it('submits normalized fields with private proof, no redirect following, and no ownership payload', async () => {
    const f = await fixture(); f.fetcher.mockResolvedValue(json({ application: dto }, 201));
    expect((await f.api.create({ company: ' Acme ', jobTitle: 'Engineer' })).application.company).toBe('Acme');
    const [url, options] = f.fetcher.mock.calls[0]!;
    expect(url).toBe('/api/applications'); expect(options).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', headers: { 'X-CSRF-Token': proof, 'X-ApplyFlow-Request': '1' } });
    expect(options).not.toHaveProperty('signal'); expect(options?.body).not.toContain(user.id);
    expect(JSON.stringify(f.auth.store.getSnapshot())).not.toContain(proof); f.auth.store.dispose();
  });
  it('rejects invalid input and ownership injection before fetching', async () => {
    const f = await fixture(); await expect(f.api.create({ company: 'x', jobTitle: 'y', userId: user.id })).rejects.toMatchObject({ kind: 'validation' });
    expect(f.fetcher).not.toHaveBeenCalled(); f.auth.store.dispose();
  });
  it('uses bounded list queries without CSRF proof and exposes no owner parameter', async () => {
    const f = await fixture(); f.fetcher.mockResolvedValue(json({ items: [dto], nextCursor: null }));
    const controller = new AbortController(); expect((await f.api.list({}, controller.signal)).items).toHaveLength(1);
    expect(f.fetcher).toHaveBeenCalledWith('/api/applications?limit=20', expect.objectContaining({ method: 'GET', signal: controller.signal, headers: { 'X-ApplyFlow-Request': '1' } }));
    await expect(f.api.list({ limit: 51 })).rejects.toMatchObject({ kind: 'validation' }); expect(f.fetcher).toHaveBeenCalledOnce(); f.auth.store.dispose();
  });
  it.each([new Error('PRIVATE password URL stack'), new TypeError('PRIVATE')])('never replays or leaks an ambiguous transport failure', async error => {
    const f = await fixture(); f.fetcher.mockRejectedValue(error);
    const result = await f.api.create({ company: 'Acme', jobTitle: 'Engineer' }).catch(value => value);
    expect(result).toBeInstanceOf(ApplicationFailure); expect(result.kind).toBe('unknown'); expect(JSON.stringify(result)).not.toContain('PRIVATE'); expect(String(result)).not.toContain('PRIVATE');
    expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.auth.store.getSnapshot().outcomeUncertain).toBe(false); f.auth.store.dispose();
  });
  it.each([json({ userId: user.id }, 201), new Response('<html>PRIVATE</html>', { status: 200 }), json({ application: { ...dto, userId: user.id } }, 201)])('rejects malformed or sensitive DTOs conservatively', async response => {
    const f = await fixture(); f.fetcher.mockResolvedValue(response); await expect(f.api.create({ company: 'Acme', jobTitle: 'Engineer' })).rejects.toMatchObject({ kind: 'unknown' });
    expect(f.fetcher).toHaveBeenCalledOnce(); f.auth.store.dispose();
  });
  it('sanitizes remote field errors and parses cooldown without automatic requests', async () => {
    const f = await fixture(); f.fetcher.mockResolvedValueOnce(json({ code: 'INVALID_REQUEST', message: 'PRIVATE', fieldErrors: { company: ['PRIVATE'] } }, 400));
    const result = await f.api.create({ company: 'Acme', jobTitle: 'Engineer' }).catch(value => value);
    expect(result.fields).toEqual({ company: ['Review this field.'] }); expect(JSON.stringify(result)).not.toContain('PRIVATE');
    f.fetcher.mockResolvedValueOnce(json({ code: 'RATE_LIMITED', message: 'PRIVATE' }, 429, { 'Retry-After': '5' }));
    await expect(f.api.create({ company: 'Acme', jobTitle: 'Engineer' })).rejects.toMatchObject({ status: 429, retryAt: 6000 });
    await expect(f.api.list()).rejects.toMatchObject({ status: 429, retryAt: 6000 });
    await expect(f.api.create({ company: 'Acme', jobTitle: 'Engineer' })).rejects.toMatchObject({ status: 429, retryAt: 6000 });
    expect(f.fetcher).toHaveBeenCalledTimes(2); f.auth.store.dispose();
  });
  it('rejects a late list response after invalidation', async () => {
    const f = await fixture(); const gate = deferred<Response>(); f.fetcher.mockReturnValue(gate.promise);
    const task = f.api.list();
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    f.auth.notify('suspend'); gate.resolve(json({ items: [dto], nextCursor: null }));
    await expect(task).rejects.toMatchObject({ kind: 'stale' }); f.auth.store.dispose();
  });
  it('rejects anonymous reads before any HTTP request', async () => {
    const auth = authFixture(); await auth.store.bootstrap(); const fetcher = vi.fn<typeof fetch>();
    await expect(createApplicationsApi(auth.store, fetcher).list()).rejects.toMatchObject({ kind: 'stale' }); expect(fetcher).not.toHaveBeenCalled(); auth.store.dispose();
  });
});

// Cookie changes and notifications are deliberately independent. Both stores
// share one lock, just as browser tabs share the authentication Web Lock.
async function cookieFixture() {
  const replacement = { ...user, id: dto.id, email: 'replacement@example.invalid' };
  let principal: typeof user | null = user; let csrf = proof; let tail = Promise.resolve();
  const notifications: Array<() => void> = []; const listeners = new Set<(event: AuthCoordinationEvent) => void>();
  function channel(): AuthCoordination {
    return { exclusive(work) { const task = tail.then(work); tail = task.then(() => undefined, () => undefined); return task; },
      publish() { for (const listener of listeners) notifications.push(() => listener('invalidate')); },
      subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; }, close() {} };
  }
  const auth: AuthApi = { csrf: async () => ({ csrfToken: csrf, registrationEnabled: true }),
    me: async () => { if (!principal) throw new AuthFailure('http', 401, 'UNAUTHENTICATED'); return { user: principal }; },
    logout: async () => { principal = null; csrf = 'b'.repeat(64); },
    login: async () => { principal = replacement; csrf = 'c'.repeat(64); return { user: replacement, csrfToken: csrf }; },
    register: async () => { throw new Error('Not used.'); } };
  const lock = channel();
  const first = createAuthStore({ api: auth, coordination: lock });
  const second = createAuthStore({ api: auth, coordination: channel() });
  await first.bootstrap(); await second.bootstrap();
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => json({ items: [{ ...dto, company: principal?.id === user.id ? 'A only' : 'B only' }], nextCursor: null }));
  return { first, second, replacement, fetcher, api: createApplicationsApi(first, fetcher),
    flush: () => { notifications.splice(0).reverse().forEach(notify => notify()); },
    replace: async () => { await second.logout(); await second.revalidate(); await second.login({ email: replacement.email, password: 'A fake password' }); await second.revalidate(); },
    replaceQueued: (change = true) => {
      const ready = deferred<void>(); const release = deferred<void>();
      const work = lock.exclusive(async () => { ready.resolve(); await release.promise; if (change) { principal = replacement; csrf = 'c'.repeat(64); } });
      return { ready: ready.promise, release: () => release.resolve(), work };
    },
    dispose: () => { first.dispose(); second.dispose(); } };
}

describe('list authority independent of broadcast delivery', () => {
  it.each(['delayed', 'missed'] as const)('never accepts B-cookie pagination under A after a %s broadcast', async delivery => {
    const f = await cookieFixture();
    try {
      expect((await f.api.list()).items[0]?.company).toBe('A only'); await f.replace();
      await expect(f.api.list({ cursor: 'cursor' })).rejects.toMatchObject({ kind: 'stale' });
      expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.first.getSnapshot().user?.id).toBe(f.replacement.id);
      if (delivery === 'delayed') { f.flush(); await f.first.revalidate(); }
    } finally { f.dispose(); }
  });
  it('rechecks a GET queued behind replacement before any HTTP dispatch', async () => {
    const f = await cookieFixture();
    try {
      const replacement = f.replaceQueued(); await replacement.ready;
      const result = f.api.list().then(() => 'accepted', error => error.kind);
      const dispatchedWhileQueued = f.fetcher.mock.calls.length; replacement.release(); await replacement.work;
      expect(dispatchedWhileQueued).toBe(0);
      expect(await result).toBe('stale'); expect(f.fetcher).not.toHaveBeenCalled();
    } finally { f.dispose(); }
  });
  it('holds the shared lock through a pending GET so replacement cannot change its dispatch principal', async () => {
    const f = await cookieFixture(); const gate = deferred<Response>(); f.fetcher.mockReturnValueOnce(gate.promise);
    try {
      const read = f.api.list(); await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
      const replacement = f.replaceQueued(); let entered = false; void replacement.ready.then(() => { entered = true; });
      await Promise.resolve(); expect(entered).toBe(false);
      gate.resolve(json({ items: [{ ...dto, company: 'A only' }], nextCursor: null }));
      expect((await read).items[0]?.company).toBe('A only');
      await replacement.ready; replacement.release(); await replacement.work;
      await expect(f.api.list()).rejects.toMatchObject({ kind: 'stale' }); expect(f.fetcher).toHaveBeenCalledOnce();
    } finally { f.dispose(); }
  });
  it('does not dispatch a queued GET after its route cancels the read', async () => {
    const f = await cookieFixture();
    const replacement = f.replaceQueued(false); await replacement.ready;
    const controller = new AbortController();
    const read = f.api.list({}, controller.signal).catch(error => error);
    controller.abort(); replacement.release(); await replacement.work;
    try { expect(await read).toMatchObject({ kind: 'stale' }); expect(f.fetcher).not.toHaveBeenCalled(); }
    finally { f.dispose(); }
  });
});
