import { vi } from 'vitest';
import { AuthFailure, type AuthApi } from '../lib/auth/api';
import { createAuthStore } from '../lib/auth/store';
import type { AuthCoordination, AuthCoordinationEvent } from '../lib/auth/coordination';

export const proof = 'a'.repeat(64);
export const rotated = 'b'.repeat(64);
export const user = { id: '7bf22ee7-a3be-40de-957e-89fca7bac5ad', email: 'fixture@example.invalid' };
export const credentials = { email: user.email, password: 'Only a test fixture password' };
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function authFixture(options: { authenticated?: boolean; registration?: boolean; unsupported?: boolean } = {}) {
  const api = {
    csrf: vi.fn<AuthApi['csrf']>().mockResolvedValue({ csrfToken: proof, registrationEnabled: options.registration ?? false }),
    me: vi.fn<AuthApi['me']>(),
    login: vi.fn<AuthApi['login']>().mockResolvedValue({ user, csrfToken: rotated }),
    register: vi.fn<AuthApi['register']>().mockResolvedValue({ user, csrfToken: rotated }),
    logout: vi.fn<AuthApi['logout']>().mockResolvedValue(undefined)
  };
  if (options.authenticated) api.me.mockResolvedValue({ user });
  else api.me.mockRejectedValue(new AuthFailure('http', 401, 'UNAUTHENTICATED'));
  const listeners = new Set<(event: AuthCoordinationEvent) => void>();
  let tail = Promise.resolve();
  let held = 0;
  const coordination: AuthCoordination = {
    exclusive(work) {
      const task = tail.then(async () => { held++; try { return await work(); } finally { held--; } });
      tail = task.then(() => undefined, () => undefined);
      return task;
    },
    publish: vi.fn(),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close() { listeners.clear(); }
  };
  const store = createAuthStore({ api, coordination: options.unsupported ? undefined : coordination });
  const subscribe = store.subscribe;
  let subscriptions = 0;
  store.subscribe = (listener) => {
    subscriptions++;
    const unsubscribe = subscribe(listener);
    let active = true;
    return () => { if (active) { active = false; subscriptions--; unsubscribe(); } };
  };
  return {
    api,
    store,
    subscriptions: () => subscriptions,
    held: () => held,
    notify(event: AuthCoordinationEvent) { for (const listener of listeners) listener(event); }
  };
}
