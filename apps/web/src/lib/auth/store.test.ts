import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthFailure, type AuthApi } from './api';
import { createAuthStore, getAuthStore } from './store';
import type { AuthCoordination, AuthCoordinationEvent } from './coordination';

const proof = 'a'.repeat(64);
const rotated = 'b'.repeat(64);
const user = { id: '7bf22ee7-a3be-40de-957e-89fca7bac5ad', email: 'a@example.com' };
const credentials = { email: user.email, password: 'a long test password' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function transport() {
  return {
    csrf: vi.fn<AuthApi['csrf']>().mockResolvedValue({ csrfToken: proof, registrationEnabled: true }),
    me: vi.fn<AuthApi['me']>().mockRejectedValue(new AuthFailure('http', 401, 'UNAUTHENTICATED')),
    login: vi.fn<AuthApi['login']>().mockResolvedValue({ user, csrfToken: rotated }),
    register: vi.fn<AuthApi['register']>().mockResolvedValue({ user, csrfToken: rotated }),
    logout: vi.fn<AuthApi['logout']>().mockResolvedValue(undefined)
  };
}
// A shared FIFO lock and separate channels model tabs sharing one cookie jar.
function browser() {
  let tail = Promise.resolve(); let held = 0; let maximum = 0;
  const channels = new Map<AuthCoordination, Set<(event: AuthCoordinationEvent) => void>>();
  const messages: unknown[] = [];
  function tab(): AuthCoordination {
    const listeners = new Set<(event: AuthCoordinationEvent) => void>();
    const channel: AuthCoordination = {
      exclusive(work) {
        const task = tail.then(async () => { held++; maximum = Math.max(maximum, held); try { return await work(); } finally { held--; } });
        tail = task.then(() => undefined, () => undefined);
        return task;
      },
      publish() {
        messages.push('invalidate');
        for (const [other, subscribers] of channels) if (other !== channel) for (const callback of subscribers) callback('invalidate');
      },
      subscribe(callback) { listeners.add(callback); return () => { listeners.delete(callback); }; },
      close() { channels.delete(channel); }
    };
    channels.set(channel, listeners); return channel;
  }
  return { tab, messages, held: () => held, maximum: () => maximum };
}
afterEach(() => { vi.useRealTimers(); });

describe('authoritative verification receipts', () => {
  it('publishes only after coordinated verification settles; cached bootstrap cannot issue another receipt', async () => {
    const api = transport(); const gate = deferred<Awaited<ReturnType<AuthApi['me']>>>();
    api.me.mockReturnValueOnce(gate.promise);
    const store = createAuthStore({ api, coordination: browser().tab() });
    const seen: ReturnType<typeof store.getSnapshot>[] = [];
    const off = store.subscribe(() => seen.push(store.getSnapshot()));
    expect(store.getSnapshot().verifiedReadId).toBeNull();
    const operation = store.bootstrap(); expect(store.bootstrap()).toBe(operation);
    await vi.waitFor(() => expect(api.me).toHaveBeenCalledOnce());
    expect(store.getSnapshot().verifiedReadId).toBeNull();
    gate.resolve({ user }); await operation;
    expect(store.getSnapshot()).toMatchObject({ verifiedReadId: 1, status: 'authenticated', busy: false });
    expect(seen.filter((snapshot) => snapshot.verifiedReadId !== null).every((snapshot) => !snapshot.busy)).toBe(true);
    await store.bootstrap(); expect(store.getSnapshot().verifiedReadId).toBe(1); expect(api.csrf).toHaveBeenCalledOnce();
    await store.revalidate(); expect(store.getSnapshot().verifiedReadId).toBe(2); expect(api.csrf).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(store.getSnapshot())).not.toContain(proof);
    off(); store.dispose();
  });
  it.each(['login', 'register', 'logout'] as const)('invalidates on %s dispatch and never issues a receipt from success or joining the mutation', async (kind) => {
    const api = transport(); const gate = deferred<void>();
    if (kind === 'logout') api.me.mockResolvedValue({ user });
    api.login.mockImplementation(async () => { await gate.promise; return { user, csrfToken: rotated }; });
    api.register.mockImplementation(async () => { await gate.promise; return { user, csrfToken: rotated }; });
    api.logout.mockReturnValue(gate.promise);
    const store = createAuthStore({ api, coordination: browser().tab() });
    await store.bootstrap(); expect(store.getSnapshot().verifiedReadId).toBe(1);
    const operation = kind === 'logout' ? store.logout() : store[kind](credentials);
    await vi.waitFor(() => expect(api[kind]).toHaveBeenCalledOnce());
    expect(store.getSnapshot()).toMatchObject({ verifiedReadId: null, busy: true });
    const joined = store.bootstrap(); gate.resolve(); await operation; await joined;
    expect(store.getSnapshot()).toMatchObject({ verifiedReadId: null, busy: false });
    await store.bootstrap();
    // Login/register retain private proof but cached bootstrap still cannot manufacture read freshness.
    expect(store.getSnapshot().verifiedReadId).toBe(kind === 'logout' ? 2 : null);
    await store.revalidate(); expect(store.getSnapshot().verifiedReadId).toBe(kind === 'logout' ? 3 : 2);
    store.dispose(); expect(store.getSnapshot().verifiedReadId).toBeNull();
  });
  it('rejects stale generations and never reuses a receipt after repeated invalidation', async () => {
    const api = transport(); const tabs = browser(); const other = tabs.tab();
    const store = createAuthStore({ api, coordination: tabs.tab() }); await store.bootstrap();
    const gate = deferred<Awaited<ReturnType<AuthApi['me']>>>();
    api.me.mockReturnValueOnce(gate.promise).mockImplementationOnce(async () => { other.publish(); return { user }; });
    const seen: (number | null)[] = []; const off = store.subscribe(() => seen.push(store.getSnapshot().verifiedReadId));
    const operation = store.revalidate(); const rejected = expect(operation).rejects.toMatchObject({ kind: 'stale' });
    await vi.waitFor(() => expect(api.me).toHaveBeenCalledTimes(2));
    other.publish(); expect(store.getSnapshot().verifiedReadId).toBeNull(); seen.length = 0;
    gate.resolve({ user }); await rejected;
    expect(seen.every((id) => id === null)).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ verifiedReadId: null, status: 'unavailable', busy: false });
    await store.revalidate(); expect(store.getSnapshot().verifiedReadId).toBe(2);
    off(); store.dispose();
  });
  it('clears receipts on suspension, failure and disposal while keeping the lifetime counter monotonic', async () => {
    const api = transport(); const coordination = browser().tab();
    let notify!: (event: AuthCoordinationEvent) => void;
    coordination.subscribe = (listener) => { notify = listener; return () => {}; };
    const store = createAuthStore({ api, coordination }); await store.bootstrap();
    notify('suspend'); expect(store.getSnapshot().verifiedReadId).toBeNull();
    notify('invalidate'); expect(store.getSnapshot().verifiedReadId).toBeNull();
    notify('resume'); await store.bootstrap(); expect(store.getSnapshot().verifiedReadId).toBe(2);
    api.me.mockRejectedValueOnce(new AuthFailure('http', 503));
    await expect(store.revalidate()).rejects.toMatchObject({ status: 503 });
    expect(store.getSnapshot().verifiedReadId).toBeNull();
    await store.revalidate(); expect(store.getSnapshot().verifiedReadId).toBe(3);
    store.dispose(); expect(store.getSnapshot().verifiedReadId).toBeNull();
  });
  it('does not reuse a receipt invalidated reentrantly at publication', async () => {
    const api = transport(); const coordination = browser().tab();
    let notify!: (event: AuthCoordinationEvent) => void;
    coordination.subscribe = (listener) => { notify = listener; return () => {}; };
    const store = createAuthStore({ api, coordination });
    const off = store.subscribe(() => { if (store.getSnapshot().verifiedReadId === 1) notify('suspend'); });
    await store.revalidate(); expect(store.getSnapshot()).toMatchObject({ verifiedReadId: null, status: 'unavailable' });
    off(); notify('resume'); await store.bootstrap(); expect(store.getSnapshot().verifiedReadId).toBe(2);
    store.dispose();
  });
  it('issues a receipt for real post-mutation reconciliation without resolving an ambiguous registration outcome', async () => {
    const api = transport(); const store = createAuthStore({ api, coordination: browser().tab() });
    await store.bootstrap();
    api.register.mockImplementation(async () => {
      api.me.mockResolvedValue({ user }); api.csrf.mockResolvedValue({ csrfToken: rotated, registrationEnabled: true });
      throw new AuthFailure('network');
    });
    await expect(store.register(credentials)).rejects.toMatchObject({ kind: 'network' });
    expect(store.getSnapshot()).toMatchObject({ status: 'authenticated', outcomeUncertain: true, verifiedReadId: 2 });
    expect(api.me).toHaveBeenCalledTimes(3); expect(api.register).toHaveBeenCalledOnce();
    await store.bootstrap(); expect(store.getSnapshot().verifiedReadId).toBe(2);
    await store.revalidate(); expect(store.getSnapshot()).toMatchObject({ verifiedReadId: 3, outcomeUncertain: true });
    store.dispose();
  });
  it('rechecks generation when receipt invalidation notifies observers before mutation dispatch', async () => {
    const api = transport(); const tabs = browser(); const other = tabs.tab();
    const store = createAuthStore({ api, coordination: tabs.tab() }); await store.bootstrap();
    let invalidated = false;
    const off = store.subscribe(() => {
      const snapshot = store.getSnapshot();
      if (!invalidated && snapshot.busy && snapshot.status === 'anonymous' && snapshot.verifiedReadId === null) {
        invalidated = true; other.publish();
      }
    });
    await expect(store.login(credentials)).rejects.toMatchObject({ kind: 'stale' });
    expect(invalidated).toBe(true); expect(api.login).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({ verifiedReadId: null, status: 'unavailable', busy: false });
    off(); store.dispose();
  });
  it('invalidates an old receipt when verification replaces its session proof before publishing the new receipt', async () => {
    const api = transport(); const store = createAuthStore({ api, coordination: browser().tab() });
    await store.bootstrap(); expect(store.getSnapshot().verifiedReadId).toBe(1);
    api.csrf.mockResolvedValue({ csrfToken: rotated, registrationEnabled: true }); api.me.mockResolvedValue({ user });
    const seen: ReturnType<typeof store.getSnapshot>[] = [];
    const off = store.subscribe(() => seen.push(store.getSnapshot()));
    await store.revalidate();
    const replaced = seen.filter((snapshot) => snapshot.busy && snapshot.status === 'authenticated');
    expect(replaced.length).toBeGreaterThan(0); expect(replaced.every((snapshot) => snapshot.verifiedReadId === null)).toBe(true);
    expect(store.getSnapshot()).toMatchObject({ verifiedReadId: 2, status: 'authenticated', busy: false });
    off(); store.dispose();
  });
});

describe('authentication state and operation ordering', () => {
  it('settles invalidation during 429 cooldown and recovers explicitly at the exact deadline', async () => {
    vi.useFakeTimers();
    let time = 1000;
    const api = transport(); const tabs = browser();
    const store = createAuthStore({ api, coordination: tabs.tab(), now: () => time });
    await store.bootstrap(); api.login.mockRejectedValueOnce(new AuthFailure('http', 429, 'RATE_LIMITED', 3000));
    await expect(store.login(credentials)).rejects.toMatchObject({ status: 429 });
    const calls = api.csrf.mock.calls.length;
    tabs.tab().publish(); tabs.tab().publish(); await Promise.resolve();
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable', user: null, busy: false, retryAt: 3000 });
    time = 2999;
    await expect(store.revalidate()).rejects.toMatchObject({ kind: 'cooldown', retryAt: 3000 });
    time = 3000; await vi.advanceTimersByTimeAsync(60_000);
    expect(api.csrf).toHaveBeenCalledTimes(calls); expect(api.login).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable', busy: false });
    await expect(store.login(credentials)).rejects.toMatchObject({ kind: 'stale' });
    expect(await store.bootstrap()).toMatchObject({ status: 'anonymous', busy: false, retryAt: null });
    expect(api.csrf).toHaveBeenCalledTimes(calls + 1); expect(api.login).toHaveBeenCalledOnce();
  });
  it('settles pending login invalidation followed by 400, without assuming logout on recovery failure', async () => {
    const api = transport(); const tabs = browser(); const store = createAuthStore({ api, coordination: tabs.tab() });
    await store.bootstrap(); const gate = deferred<Awaited<ReturnType<AuthApi['login']>>>(); api.login.mockReturnValue(gate.promise);
    const task = store.login(credentials); const rejected = expect(task).rejects.toMatchObject({ status: 400 });
    await vi.waitFor(() => expect(api.login).toHaveBeenCalledOnce());
    tabs.tab().publish(); gate.reject(new AuthFailure('http', 400, 'INVALID_REQUEST')); await rejected;
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable', user: null, busy: false, error: { status: 400 } });
    expect(api.csrf).toHaveBeenCalledTimes(2); expect(api.login).toHaveBeenCalledOnce();
    api.me.mockRejectedValueOnce(new AuthFailure('http', 503, 'SERVICE_UNAVAILABLE'));
    await expect(store.revalidate()).rejects.toMatchObject({ status: 503 });
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable', user: null, busy: false });
    expect(await store.revalidate()).toMatchObject({ status: 'anonymous', busy: false });
    expect(api.login).toHaveBeenCalledOnce();
  });
  it('bounds repeated invalidation of reconciliation and never publishes the stale user', async () => {
    const api = transport(); const tabs = browser(); const other = tabs.tab();
    const store = createAuthStore({ api, coordination: tabs.tab() }); const seen: string[] = [];
    store.subscribe(() => seen.push(store.getSnapshot().status));
    api.me.mockImplementation(async () => { other.publish(); return { user }; });
    await expect(store.bootstrap()).rejects.toMatchObject({ kind: 'stale' });
    expect(api.csrf).toHaveBeenCalledTimes(2); expect(api.me).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable', user: null, busy: false });
    expect(seen).not.toContain('authenticated');
  });
  it.each(['login', 'register', 'logout'] as const)(
    'clears prior registration uncertainty only after confirmed %s and valid reconciliation', async (kind) => {
      const api = transport(); const tabs = browser(); const other = tabs.tab();
      const store = createAuthStore({ api, coordination: tabs.tab() }); await store.bootstrap();
      api.register.mockRejectedValueOnce(new AuthFailure('network'));
      await expect(store.register(credentials)).rejects.toMatchObject({ kind: 'network' });
      expect(store.getSnapshot().outcomeUncertain).toBe(true);
      if (kind === 'logout') { api.me.mockResolvedValue({ user }); await store.revalidate(); }
      const gate = deferred<Awaited<ReturnType<AuthApi['me']>>>();
      function invalidateAfterSuccess() {
        other.publish(); api.csrf.mockResolvedValue({ csrfToken: rotated, registrationEnabled: true });
        api.me.mockReturnValue(gate.promise);
      }
      if (kind === 'logout') api.logout.mockImplementation(async () => { invalidateAfterSuccess(); });
      else api[kind].mockImplementation(async () => { invalidateAfterSuccess(); return { user, csrfToken: rotated }; });
      const meCalls = api.me.mock.calls.length;
      const task = kind === 'logout' ? store.logout() : store[kind](credentials);
      await vi.waitFor(() => expect(api.me).toHaveBeenCalledTimes(meCalls + 2));
      expect(store.getSnapshot()).toMatchObject({ user: null, busy: true, outcomeUncertain: true });
      if (kind === 'logout') gate.reject(new AuthFailure('http', 401, 'UNAUTHENTICATED'));
      else gate.resolve({ user });
      expect(await task).toMatchObject({ status: kind === 'logout' ? 'anonymous' : 'authenticated',
        busy: false, error: null, outcomeUncertain: false });
      expect(api[kind]).toHaveBeenCalledTimes(kind === 'register' ? 2 : 1);
    });
  it('preserves ambiguous registration through concurrent invalidation and successful authenticated reads', async () => {
    const api = transport(); const tabs = browser(); const other = tabs.tab();
    const store = createAuthStore({ api, coordination: tabs.tab() }); await store.bootstrap();
    api.register.mockImplementation(async () => {
      other.publish(); api.csrf.mockResolvedValue({ csrfToken: rotated, registrationEnabled: true });
      api.me.mockResolvedValue({ user }); throw new AuthFailure('network');
    });
    await expect(store.register(credentials)).rejects.toMatchObject({ kind: 'network' });
    expect(store.getSnapshot()).toMatchObject({ status: 'authenticated', user, outcomeUncertain: true, busy: false });
    expect((await store.revalidate()).outcomeUncertain).toBe(true); expect(api.register).toHaveBeenCalledOnce();
  });
  it('keeps failed reconciliation uncertain after confirmed login without committing the invalidated user', async () => {
    const api = transport(); const tabs = browser(); const other = tabs.tab();
    const store = createAuthStore({ api, coordination: tabs.tab() }); await store.bootstrap();
    api.register.mockRejectedValueOnce(new AuthFailure('network'));
    await expect(store.register(credentials)).rejects.toMatchObject({ kind: 'network' });
    const seen: string[] = []; store.subscribe(() => seen.push(store.getSnapshot().status));
    api.login.mockImplementation(async () => {
      other.publish(); api.me.mockRejectedValue(new AuthFailure('http', 503, 'SERVICE_UNAVAILABLE'));
      return { user, csrfToken: rotated };
    });
    await expect(store.login(credentials)).rejects.toMatchObject({ status: 503 });
    expect(store.getSnapshot()).toMatchObject({ status: 'uncertain', user: null, busy: false, outcomeUncertain: true });
    expect(seen).not.toContain('authenticated'); expect(api.login).toHaveBeenCalledOnce();
    expect(api.csrf).toHaveBeenCalledTimes(5);
  });
  it('does not clear uncertainty when a confirmed reconciliation is invalidated before the caller resumes', async () => {
    const api = transport(); const tabs = browser(); const other = tabs.tab();
    const store = createAuthStore({ api, coordination: tabs.tab() }); await store.bootstrap();
    api.login.mockImplementation(async () => {
      other.publish(); api.me.mockResolvedValue({ user }); return { user, csrfToken: rotated };
    });
    let invalidated = false;
    store.subscribe(() => {
      if (!invalidated && store.getSnapshot().status === 'authenticated') {
        invalidated = true; other.publish();
      }
    });
    await expect(store.login(credentials)).rejects.toMatchObject({ kind: 'stale' });
    expect(store.getSnapshot()).toMatchObject({ status: 'uncertain', user: null, busy: false, outcomeUncertain: true });
    expect(api.login).toHaveBeenCalledOnce(); expect(api.csrf).toHaveBeenCalledTimes(3);
  });
  it('publishes the pending operation before notifying reentrant observers', async () => {
    const api = transport(); const store = createAuthStore({ api, coordination: browser().tab() });
    let nested: Promise<unknown> | undefined;
    const unsubscribe = store.subscribe(() => { if (store.getSnapshot().busy && !nested) nested = store.bootstrap(); });
    const task = store.bootstrap(); expect(nested).toBe(task); await task; unsubscribe();
    expect(api.csrf).toHaveBeenCalledOnce();
  });
  it('sanitizes lock acquisition failures without any API work', async () => {
    const api = transport(); const coordination = browser().tab();
    coordination.exclusive = () => Promise.reject(new Error('private credentials'));
    const store = createAuthStore({ api, coordination });
    await expect(store.bootstrap()).rejects.toEqual(new AuthFailure('coordination'));
    expect(store.getSnapshot().status).toBe('unavailable'); expect(api.csrf).not.toHaveBeenCalled();
  });
  it('suspends without allocating on page exit and revalidates only on restoration', async () => {
    const api = transport(); const coordination = browser().tab();
    let notify!: (event: AuthCoordinationEvent) => void;
    coordination.subscribe = (listener) => { notify = listener; return () => undefined; };
    const store = createAuthStore({ api, coordination }); await store.bootstrap(); api.csrf.mockClear();
    notify('suspend'); expect(store.getSnapshot()).toMatchObject({ status: 'unavailable', user: null });
    await expect(store.login(credentials)).rejects.toMatchObject({ kind: 'coordination' });
    notify('invalidate');
    await expect(store.bootstrap()).rejects.toMatchObject({ kind: 'coordination' });
    expect(api.csrf).not.toHaveBeenCalled(); notify('resume'); await store.bootstrap();
    expect(api.csrf).toHaveBeenCalledOnce(); expect(store.getSnapshot().status).toBe('anonymous');
  });
  it('does not publish an invalidated mutation response as authenticated before reconciliation', async () => {
    const api = transport(); const tabs = browser(); const store = createAuthStore({ api, coordination: tabs.tab() });
    await store.bootstrap(); const gate = deferred<Awaited<ReturnType<AuthApi['login']>>>(); api.login.mockReturnValue(gate.promise);
    const states: string[] = []; store.subscribe(() => states.push(store.getSnapshot().status));
    const task = store.login(credentials); await vi.waitFor(() => expect(api.login).toHaveBeenCalledOnce());
    tabs.tab().publish(); gate.resolve({ user, csrfToken: rotated }); await task;
    expect(states).not.toContain('authenticated'); expect(store.getSnapshot().status).toBe('anonymous');
  });
  it('makes at most one recovery attempt when a successful response was invalidated', async () => {
    const api = transport(); const tabs = browser(); const store = createAuthStore({ api, coordination: tabs.tab() });
    await store.bootstrap(); api.login.mockImplementation(async () => {
      tabs.tab().publish(); api.csrf.mockRejectedValue(new AuthFailure('network')); return { user, csrfToken: rotated };
    });
    await expect(store.login(credentials)).rejects.toMatchObject({ kind: 'network' });
    expect(api.csrf).toHaveBeenCalledTimes(3); expect(api.login).toHaveBeenCalledOnce();
    expect(store.getSnapshot().status).toBe('uncertain');
  });
  it('read reconciliation cannot prove that an ambiguously delivered registration did not create an account', async () => {
    const api = transport(); const store = createAuthStore({ api, coordination: browser().tab() }); await store.bootstrap();
    api.register.mockRejectedValue(new AuthFailure('network'));
    await expect(store.register(credentials)).rejects.toMatchObject({ kind: 'network' });
    expect((await store.revalidate()).outcomeUncertain).toBe(true); expect(api.register).toHaveBeenCalledOnce();
  });
  it('preserves unresolved registration across later read outages and rejected mutations', async () => {
    const api = transport(); const store = createAuthStore({ api, coordination: browser().tab() }); await store.bootstrap();
    api.register.mockRejectedValue(new AuthFailure('network'));
    await expect(store.register(credentials)).rejects.toMatchObject({ kind: 'network' });
    api.me.mockRejectedValueOnce(new AuthFailure('http', 503, 'SERVICE_UNAVAILABLE'));
    await expect(store.revalidate()).rejects.toMatchObject({ status: 503 });
    expect(store.getSnapshot()).toMatchObject({ status: 'uncertain', outcomeUncertain: true });
    await store.revalidate(); api.login.mockRejectedValueOnce(new AuthFailure('http', 403, 'REQUEST_REJECTED'));
    await expect(store.login(credentials)).rejects.toMatchObject({ status: 403 });
    expect(store.getSnapshot().outcomeUncertain).toBe(true);
    await store.login(credentials); expect(store.getSnapshot().outcomeUncertain).toBe(false);
  });
  it('keeps failed bootstrap uncertain without allocating a fallback or retrying automatically', async () => {
    const api = transport(); api.csrf.mockRejectedValue(new AuthFailure('network'));
    const store = createAuthStore({ api, coordination: browser().tab() });
    await expect(store.bootstrap()).rejects.toMatchObject({ kind: 'network' });
    expect(store.getSnapshot()).toMatchObject({ status: 'uncertain', user: null, busy: false });
    expect(api.csrf).toHaveBeenCalledOnce(); expect(api.me).not.toHaveBeenCalled();
  });
  it('does not turn broadcast invalidations during cooldown into automatic requests', async () => {
    const api = transport(); const tabs = browser(); const store = createAuthStore({ api, coordination: tabs.tab(), now: () => 1000 });
    await store.bootstrap(); api.login.mockRejectedValue(new AuthFailure('http', 429, 'RATE_LIMITED', 3000));
    await expect(store.login(credentials)).rejects.toMatchObject({ status: 429 }); const calls = api.csrf.mock.calls.length;
    tabs.tab().publish(); tabs.tab().publish(); await Promise.resolve();
    expect(api.csrf).toHaveBeenCalledTimes(calls); expect(api.login).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject({ user: null, retryAt: 3000 });
  });
  it('single-flights bootstrap across StrictMode-style subscribe/unsubscribe/remount without canceling', async () => {
    const api = transport(); const gate = deferred<Awaited<ReturnType<AuthApi['csrf']>>>();
    api.csrf.mockReturnValue(gate.promise);
    const store = createAuthStore({ api, coordination: browser().tab() });
    const unsubscribe = store.subscribe(vi.fn());
    const first = store.bootstrap(); unsubscribe(); store.subscribe(vi.fn());
    expect(store.bootstrap()).toBe(first);
    gate.resolve({ csrfToken: proof, registrationEnabled: true });
    expect(await first).toMatchObject({ status: 'anonymous', busy: false });
    await store.bootstrap(); expect(api.csrf).toHaveBeenCalledOnce();
  });
  it('uses one lazy module singleton and fails closed without browser APIs', async () => {
    expect(getAuthStore()).toBe(getAuthStore());
    const api = transport(); const store = createAuthStore({ api, coordination: undefined });
    expect(store.getSnapshot().status).toBe('unavailable');
    await expect(store.bootstrap()).rejects.toMatchObject({ kind: 'coordination' });
    await expect(store.login(credentials)).rejects.toMatchObject({ kind: 'coordination' });
    expect(api.csrf).not.toHaveBeenCalled(); expect(api.login).not.toHaveBeenCalled();
  });
  it('keeps user/proof unknown on service failure instead of treating it as anonymous', async () => {
    const api = transport(); api.me.mockRejectedValue(new AuthFailure('http', 503, 'SERVICE_UNAVAILABLE'));
    const store = createAuthStore({ api, coordination: browser().tab() });
    await expect(store.bootstrap()).rejects.toMatchObject({ status: 503 });
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable', user: null, registrationEnabled: null });
    api.me.mockRejectedValue(new AuthFailure('http', 401, 'UNAUTHENTICATED'));
    expect(await store.bootstrap()).toMatchObject({ status: 'anonymous' });
  });
  it('validates credentials before any preflight request', async () => {
    const api = transport(); const store = createAuthStore({ api, coordination: browser().tab() });
    await store.bootstrap(); api.csrf.mockClear();
    await expect(store.register({ email: 'invalid', password: 'SECRET' })).rejects.toMatchObject({ kind: 'validation' });
    expect(api.csrf).not.toHaveBeenCalled(); expect(api.register).not.toHaveBeenCalled();
  });
  it('authenticates using rotated proof, handles 204, then permits a new anonymous bootstrap', async () => {
    const api = transport(); const tabs = browser(); const store = createAuthStore({ api, coordination: tabs.tab() });
    await store.bootstrap(); await store.login(credentials);
    expect(store.getSnapshot()).toMatchObject({ status: 'authenticated', user });
    api.csrf.mockResolvedValue({ csrfToken: rotated, registrationEnabled: true }); api.me.mockResolvedValue({ user });
    await store.logout(); expect(api.logout).toHaveBeenCalledExactlyOnceWith(rotated);
    expect(store.getSnapshot()).toMatchObject({ status: 'anonymous', user: null });
    api.me.mockRejectedValue(new AuthFailure('http', 401, 'UNAUTHENTICATED'));
    await store.bootstrap(); expect(api.csrf).toHaveBeenCalledTimes(4);
    expect(tabs.messages).toEqual(['invalidate', 'invalidate']);
    expect(JSON.stringify(store.getSnapshot())).not.toContain(rotated);
    expect(JSON.stringify(tabs.messages)).not.toMatch(/csrf|password|@|user|token/);
  });
  it('rejects registration when current server capability is false', async () => {
    const api = transport(); api.csrf.mockResolvedValue({ csrfToken: proof, registrationEnabled: false });
    const store = createAuthStore({ api, coordination: browser().tab() }); await store.bootstrap();
    await expect(store.register(credentials)).rejects.toMatchObject({ status: 404 });
    expect(api.register).not.toHaveBeenCalled();
  });
  it('keeps the cross-tab lock after eight seconds and rejects duplicate mutation intent', async () => {
    vi.useFakeTimers();
    const api = transport(); const tabs = browser(); const store = createAuthStore({ api, coordination: tabs.tab() });
    await store.bootstrap(); const gate = deferred<Awaited<ReturnType<AuthApi['login']>>>(); api.login.mockReturnValue(gate.promise);
    const task = store.login(credentials); await vi.advanceTimersByTimeAsync(7999);
    expect(tabs.held()).toBe(1); expect(store.getSnapshot().waiting).toBe(false);
    await vi.advanceTimersByTimeAsync(1); expect(store.getSnapshot()).toMatchObject({ waiting: true, busy: true });
    await expect(store.login(credentials)).rejects.toMatchObject({ kind: 'busy' });
    const other = createAuthStore({ api: transport(), coordination: tabs.tab() }); const waiting = other.bootstrap();
    await vi.advanceTimersByTimeAsync(20_000); expect(tabs.held()).toBe(1);
    gate.resolve({ user, csrfToken: rotated }); await task; await waiting;
    expect(tabs.maximum()).toBe(1); expect(api.login).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toMatchObject({ waiting: false, busy: false });
  });
  it('holds a slow bootstrap lock too', async () => {
    vi.useFakeTimers(); const api = transport(); const gate = deferred<Awaited<ReturnType<AuthApi['csrf']>>>();
    api.csrf.mockReturnValue(gate.promise); const tabs = browser(); const store = createAuthStore({ api, coordination: tabs.tab() });
    const task = store.bootstrap(); await vi.advanceTimersByTimeAsync(8000);
    expect(store.getSnapshot().waiting).toBe(true); expect(tabs.held()).toBe(1);
    gate.resolve({ csrfToken: proof, registrationEnabled: false }); await task;
  });
  it('serializes two initial bootstraps across tabs so the second observes the existing cookie', async () => {
    const tabs = browser(); let allocations = 0; let cookie = false;
    const api = transport(); api.csrf.mockImplementation(async () => {
      await Promise.resolve(); if (!cookie) { allocations++; cookie = true; }
      return { csrfToken: proof, registrationEnabled: true };
    });
    const a = createAuthStore({ api, coordination: tabs.tab() }); const b = createAuthStore({ api, coordination: tabs.tab() });
    await Promise.all([a.bootstrap(), b.bootstrap()]); expect(allocations).toBe(1); expect(tabs.maximum()).toBe(1);
  });
  it('cancels queued login when another tab authenticated, even if its broadcast was missed', async () => {
    const tabs = browser(); const api = transport(); const store = createAuthStore({ api, coordination: tabs.tab() });
    await store.bootstrap(); const gate = deferred<void>(); const owner = tabs.tab().exclusive(() => gate.promise);
    const task = store.login(credentials);
    api.csrf.mockResolvedValue({ csrfToken: rotated, registrationEnabled: true }); api.me.mockResolvedValue({ user });
    gate.resolve(); await owner;
    await expect(task).rejects.toMatchObject({ kind: 'stale' }); expect(api.login).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toMatchObject({ status: 'authenticated', user });
  });
  it('does not send stale logout to a replacement session belonging to the same user', async () => {
    const api = transport(); api.me.mockResolvedValue({ user }); const store = createAuthStore({ api, coordination: browser().tab() });
    await store.bootstrap(); api.csrf.mockResolvedValue({ csrfToken: rotated, registrationEnabled: true });
    await expect(store.logout()).rejects.toMatchObject({ kind: 'stale' }); expect(api.logout).not.toHaveBeenCalled();
    expect(store.getSnapshot().status).toBe('authenticated');
  });
  it('invalidates an authenticated snapshot immediately on broadcast and obtains fresh proof', async () => {
    const api = transport(); api.me.mockResolvedValue({ user }); const tabs = browser();
    const store = createAuthStore({ api, coordination: tabs.tab() }); await store.bootstrap();
    api.me.mockRejectedValue(new AuthFailure('http', 401, 'UNAUTHENTICATED'));
    tabs.tab().publish(); expect(store.getSnapshot()).toMatchObject({ status: 'unavailable', user: null });
    await store.bootstrap(); expect(store.getSnapshot().status).toBe('anonymous');
  });
  it('discards stale authenticated reads after invalidation and reconciles once', async () => {
    const api = transport(); const gate = deferred<Awaited<ReturnType<AuthApi['me']>>>();
    api.me.mockReturnValueOnce(gate.promise); const tabs = browser(); const store = createAuthStore({ api, coordination: tabs.tab() });
    const seen: string[] = []; store.subscribe(() => seen.push(store.getSnapshot().status));
    const task = store.bootstrap(); await vi.waitFor(() => expect(api.me).toHaveBeenCalledOnce());
    tabs.tab().publish(); gate.resolve({ user }); await task;
    expect(seen).not.toContain('authenticated'); expect(store.getSnapshot().status).toBe('anonymous');
    expect(api.csrf).toHaveBeenCalledTimes(2);
  });
  it.each([400, 401, 403, 409, 429, 503])('never replays a login rejected with %s', async (status) => {
    const api = transport(); const store = createAuthStore({ api, coordination: browser().tab(), now: () => 1000 });
    await store.bootstrap(); api.login.mockRejectedValue(new AuthFailure('http', status,
      status === 401 ? 'INVALID_CREDENTIALS' : 'INVALID_REQUEST', status === 429 ? 3000 : null));
    await expect(store.login(credentials)).rejects.toMatchObject({ status });
    expect(api.login).toHaveBeenCalledOnce();
    expect(api.csrf).toHaveBeenCalledTimes([403, 409, 503].includes(status) ? 3 : 2);
  });
  it('blocks retries during 429 cooldown and admits only a new explicit action at its boundary', async () => {
    const api = transport(); let time = 1000; const store = createAuthStore({ api, coordination: browser().tab(), now: () => time });
    await store.bootstrap(); api.login.mockRejectedValueOnce(new AuthFailure('http', 429, 'RATE_LIMITED', 3000));
    await expect(store.login(credentials)).rejects.toMatchObject({ status: 429 }); time = 2999;
    await expect(store.login(credentials)).rejects.toMatchObject({ kind: 'cooldown' }); expect(api.login).toHaveBeenCalledOnce();
    time = 3000; await store.login(credentials); expect(api.login).toHaveBeenCalledTimes(2);
  });
  it.each(['register', 'login', 'logout'] as const)('reconciles ambiguous %s once without replaying it', async (kind) => {
    const api = transport(); if (kind === 'logout') api.me.mockResolvedValue({ user });
    const store = createAuthStore({ api, coordination: browser().tab() }); await store.bootstrap();
    api[kind].mockRejectedValue(new AuthFailure('network'));
    await expect(kind === 'logout' ? store.logout() : store[kind](credentials)).rejects.toMatchObject({ kind: 'network' });
    expect(api[kind]).toHaveBeenCalledOnce(); expect(api.csrf).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().outcomeUncertain).toBe(true);
  });
  it('retains uncertain state when ambiguous mutation cannot be reconciled', async () => {
    const api = transport(); const store = createAuthStore({ api, coordination: browser().tab() }); await store.bootstrap();
    api.login.mockImplementation(async () => {
      api.csrf.mockRejectedValue(new AuthFailure('network')); throw new AuthFailure('network');
    });
    await expect(store.login(credentials)).rejects.toMatchObject({ kind: 'network' });
    expect(store.getSnapshot()).toMatchObject({ status: 'uncertain', user: null, outcomeUncertain: true });
    expect(api.login).toHaveBeenCalledOnce();
  });
  it('does not infer logout success from a failed request; a still-valid device remains authenticated', async () => {
    const api = transport(); api.me.mockResolvedValue({ user }); api.logout.mockRejectedValue(new AuthFailure('http', 503));
    const store = createAuthStore({ api, coordination: browser().tab() }); await store.bootstrap();
    await expect(store.logout()).rejects.toMatchObject({ status: 503 }); expect(store.getSnapshot().status).toBe('authenticated');
  });
  it('disposal never releases an in-flight mutation lock or restores a stale authenticated snapshot', async () => {
    const api = transport(); const tabs = browser(); const store = createAuthStore({ api, coordination: tabs.tab() });
    await store.bootstrap(); const gate = deferred<Awaited<ReturnType<AuthApi['login']>>>(); api.login.mockReturnValue(gate.promise);
    const task = store.login(credentials); await vi.waitFor(() => expect(api.login).toHaveBeenCalledOnce());
    store.dispose(); expect(tabs.held()).toBe(1);
    gate.resolve({ user, csrfToken: rotated }); await expect(task).rejects.toMatchObject({ kind: 'stale' });
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable', user: null });
    expect(tabs.held()).toBe(0);
  });
});
