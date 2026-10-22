import { createContext, useContext, useSyncExternalStore } from 'react';
import type { AuthState, AuthStore } from '../../lib/auth/store';
import { AuthFailure } from '../../lib/auth/api';

type Verification = {
  promise: Promise<AuthState>;
  started: boolean;
  baseline: number;
  unsubscribe: () => void;
  reject: (error: AuthFailure) => void;
};
const integrations = new WeakMap<AuthStore, ReturnType<typeof makeAuthIntegration>>();

export function createAuthIntegration(store: AuthStore) {
  let integration = integrations.get(store);
  if (!integration) { integration = makeAuthIntegration(store); integrations.set(store, integration); }
  return integration;
}

function makeAuthIntegration(store: AuthStore) {
  let consumers = 0;
  let pending: Verification | undefined;
  return {
    store,
    retain() {
      consumers++;
      let released = false;
      return () => {
        if (released) return;
        released = true; consumers--;
        if (consumers === 0 && pending && !pending.started) {
          const abandoned = pending;
          pending = undefined; abandoned.unsubscribe(); abandoned.reject(new AuthFailure('stale'));
        }
        // Dispatched work still owns its request and Web Lock until settlement.
      };
    },
    verify(baseline = store.getSnapshot().verifiedReadId ?? 0): Promise<AuthState> {
      if (!consumers) return Promise.reject(new AuthFailure('stale'));
      if (pending && (!pending.started || store.getSnapshot().busy)) {
        if (!pending.started) pending.baseline = Math.max(pending.baseline, baseline);
        return pending.promise;
      }
      let resolveTask!: (state: AuthState) => void;
      let rejectTask!: (error: AuthFailure) => void;
      const promise = new Promise<AuthState>((resolve, reject) => { resolveTask = resolve; rejectTask = reject; });
      const task: Verification = { promise, started: false, baseline, unsubscribe: () => {}, reject: rejectTask };
      pending = task;
      const finish = () => { task.unsubscribe(); if (pending === task) pending = undefined; };
      const run = () => {
        const snapshot = store.getSnapshot();
        if (pending !== task || !consumers || snapshot.busy) return;
        task.unsubscribe();
        if (snapshot.verifiedReadId !== null && snapshot.verifiedReadId > task.baseline
          && (snapshot.status === 'anonymous' || snapshot.status === 'authenticated')) {
          finish(); resolveTask(snapshot); return;
        }
        task.started = true;
        // Never mistake mutation completion for a fresh verification.
        void store.revalidate().then((state) => { finish(); resolveTask(state); }, (error: unknown) => {
          finish(); rejectTask(error instanceof AuthFailure ? error : new AuthFailure('coordination'));
        });
      };
      // StrictMode cleanup can cancel this demand before any subscription/request starts.
      queueMicrotask(() => {
        if (pending !== task || !consumers) return;
        if (store.getSnapshot().busy) task.unsubscribe = store.subscribe(run);
        else run();
      });
      return promise;
    }
  };
}

export const AuthContext = createContext<ReturnType<typeof createAuthIntegration> | null>(null);

export function useAuth() {
  const integration = useContext(AuthContext);
  if (!integration) throw new Error('Authentication routes require their provider.');
  const state = useSyncExternalStore(integration.store.subscribe, integration.store.getSnapshot);
  return { state, integration };
}
