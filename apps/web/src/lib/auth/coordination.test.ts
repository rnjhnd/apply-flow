import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserCoordination } from './coordination';
import { AuthFailure, type AuthApi } from './api';
import { createAuthStore } from './store';

afterEach(() => { vi.unstubAllGlobals(); });
function browser() {
  const events = new Map<string, (event: unknown) => void>();
  const postMessage = vi.fn(); const close = vi.fn();
  const channels: Array<{ onmessage: ((event: { data: unknown }) => void) | null }> = [];
  const request = vi.fn(async (_name: string, _options: unknown, work: () => Promise<unknown>) => work());
  const removeEventListener = vi.fn((name: string) => events.delete(name));
  vi.stubGlobal('window', { isSecureContext: true, addEventListener: (name: string, listener: (event: unknown) => void) => events.set(name, listener), removeEventListener });
  vi.stubGlobal('navigator', { locks: { request } });
  vi.stubGlobal('BroadcastChannel', class {
    onmessage = null;
    postMessage = postMessage;
    close = close;
    constructor(readonly name: string) { channels.push(this); }
  });
  return { events, postMessage, close, request, channel: () => channels[0]!, removeEventListener };
}
describe('browser coordination and lifecycle adapter', () => {
  it('does not let pagehide then broadcasts resume bootstrap before BFCache restoration', async () => {
    const native = browser();
    const api = {
      csrf: vi.fn<AuthApi['csrf']>().mockResolvedValue({ csrfToken: 'a'.repeat(64), registrationEnabled: false }),
      me: vi.fn<AuthApi['me']>().mockRejectedValue(new AuthFailure('http', 401, 'UNAUTHENTICATED')),
      login: vi.fn<AuthApi['login']>(), register: vi.fn<AuthApi['register']>(), logout: vi.fn<AuthApi['logout']>()
    };
    const store = createAuthStore({ api, coordination: createBrowserCoordination() }); await store.bootstrap();
    native.events.get('pagehide')?.({});
    for (let count = 0; count < 3; count++) native.channel().onmessage?.({ data: 'invalidate' });
    await expect(store.bootstrap()).rejects.toMatchObject({ kind: 'coordination' });
    expect(store.getSnapshot()).toMatchObject({ status: 'unavailable', user: null, busy: false });
    expect(api.csrf).toHaveBeenCalledOnce();
    native.events.get('pageshow')?.({ persisted: false });
    await expect(store.bootstrap()).rejects.toMatchObject({ kind: 'coordination' });
    expect(api.csrf).toHaveBeenCalledOnce();
    native.events.get('pageshow')?.({ persisted: true });
    expect(await store.bootstrap()).toMatchObject({ status: 'anonymous', busy: false });
    expect(api.csrf).toHaveBeenCalledTimes(2); expect(api.login).not.toHaveBeenCalled(); store.dispose();
  });
  it('uses exclusive named locks and broadcasts only a fixed invalidation value', async () => {
    const native = browser(); const adapter = createBrowserCoordination()!;
    expect(await adapter.exclusive(async () => 'result')).toBe('result');
    expect(native.request).toHaveBeenCalledWith('applyflow-auth', { mode: 'exclusive' }, expect.any(Function));
    adapter.publish(); expect(native.postMessage).toHaveBeenCalledExactlyOnceWith('invalidate');
    adapter.close();
  });
  it('ignores arbitrary messages and never accepts broadcast user data as proof', () => {
    const native = browser(); const adapter = createBrowserCoordination()!; const listener = vi.fn();
    const unsubscribe = adapter.subscribe(listener);
    for (const data of [{ type: 'invalidate', user: 'admin' }, { csrfToken: 'secret' }, null, 'authenticated']) {
      native.channel().onmessage?.({ data });
    }
    expect(listener).not.toHaveBeenCalled(); native.channel().onmessage?.({ data: 'invalidate' });
    expect(listener).toHaveBeenCalledExactlyOnceWith('invalidate');
    unsubscribe(); native.channel().onmessage?.({ data: 'invalidate' }); expect(listener).toHaveBeenCalledOnce();
    adapter.close();
  });
  it('suspends on pagehide, revalidates on BFCache restore, and removes lifecycle handlers on disposal', () => {
    const native = browser(); const adapter = createBrowserCoordination()!; const listener = vi.fn(); adapter.subscribe(listener);
    native.events.get('pagehide')?.({}); expect(listener).toHaveBeenLastCalledWith('suspend');
    native.events.get('pageshow')?.({ persisted: false }); expect(listener).toHaveBeenCalledOnce();
    native.events.get('pageshow')?.({ persisted: true }); expect(listener).toHaveBeenLastCalledWith('resume');
    adapter.close(); expect(native.events.size).toBe(0); expect(native.close).toHaveBeenCalledOnce();
    expect(native.postMessage).not.toHaveBeenCalled();
  });
  it.each(['insecure', 'locks', 'channel', 'throws'])('fails closed if coordination is unavailable: %s', (missing) => {
    browser();
    if (missing === 'insecure') vi.stubGlobal('window', { isSecureContext: false });
    if (missing === 'locks') vi.stubGlobal('navigator', {});
    if (missing === 'channel') vi.stubGlobal('BroadcastChannel', undefined);
    if (missing === 'throws') vi.stubGlobal('BroadcastChannel', class { constructor() { throw new Error('disabled'); } });
    expect(createBrowserCoordination()).toBeUndefined();
  });
});
