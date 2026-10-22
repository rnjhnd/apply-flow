import type { AuthUser, LoginRequest, RegisterRequest } from '@applyflow/contracts';
import { AuthFailure, createAuthApi, validateCredentials, type AuthApi } from './api';
import { createBrowserCoordination, type AuthCoordination } from './coordination';

export type AuthState = Readonly<{
  status: 'initializing' | 'anonymous' | 'authenticated' | 'unavailable' | 'uncertain';
  user: Readonly<AuthUser> | null;
  registrationEnabled: boolean | null;
  busy: boolean;
  waiting: boolean;
  retryAt: number | null;
  error: AuthFailure | null;
  // Persistent authentication-mutation ambiguity, not a failed session read.
  outcomeUncertain: boolean;
  verifiedReadId: number | null;
}>;

export function createAuthStore(options: { api: AuthApi; coordination: AuthCoordination | undefined; now?: () => number }) {
  const { api, coordination } = options;
  const now = options.now ?? Date.now;
  let state: AuthState = Object.freeze({ status: coordination ? 'initializing' : 'unavailable', user: null,
    registrationEnabled: null, busy: false, waiting: false, retryAt: null,
    error: coordination ? null : new AuthFailure('coordination'), outcomeUncertain: false, verifiedReadId: null });
  let csrfToken: string | null = null;
  let generation = 0;
  let readCounter = 0;
  let verifiedGeneration: number | null = null;
  let disposed = false;
  let suspended = false;
  let pending: Promise<AuthState> | undefined;
  const listeners = new Set<() => void>();
  function update(patch: Partial<AuthState>) {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of listeners) {
      try { listener(); } catch { /* An observer must not release an authentication lock. */ }
    }
  }
  function invalidate(rejection?: AuthFailure) {
    generation++;
    csrfToken = null;
    verifiedGeneration = null;
    // Missing proof preserves the need for revalidation even when a pending operation or cooldown blocks it.
    // Do not claim initialization is running: recovery may require an explicit action after admission resumes.
    const error = rejection ?? (state.retryAt !== null && state.retryAt > now()
      ? new AuthFailure('cooldown', 429, 'RATE_LIMITED', state.retryAt) : new AuthFailure('stale'));
    update({ status: state.outcomeUncertain ? 'uncertain' : 'unavailable', user: null, registrationEnabled: null,
      verifiedReadId: null, error });
  }
  function usable() {
    if (disposed || suspended || !coordination) throw new AuthFailure('coordination');
    if (state.retryAt !== null && state.retryAt > now()) throw new AuthFailure('cooldown', 429, 'RATE_LIMITED', state.retryAt);
  }
  async function synchronize() {
    if (disposed || suspended) throw new AuthFailure('coordination');
    const epoch = generation;
    const proof = await api.csrf();
    let user: AuthUser | null = null;
    try { user = (await api.me()).user; }
    catch (error) {
      if (!(error instanceof AuthFailure && error.status === 401 && error.code === 'UNAUTHENTICATED')) throw error;
    }
    if (disposed || suspended || epoch !== generation) throw new AuthFailure('stale');
    const replacesProof = csrfToken !== proof.csrfToken || state.user?.id !== user?.id;
    csrfToken = proof.csrfToken;
    // A candidate is private until the coordinated operation settles. A later POST consumes it.
    verifiedGeneration = epoch;
    update({ status: user ? 'authenticated' : 'anonymous', user: user ? Object.freeze({ ...user }) : null,
      registrationEnabled: proof.registrationEnabled, ...(replacesProof ? { verifiedReadId: null } : {}) });
  }
  function unavailable(error: AuthFailure, uncertainty: 'read' | 'mutation' | null) {
    csrfToken = null;
    verifiedGeneration = null;
    // A read can make the session indeterminate without inventing a potentially
    // committed authentication mutation. Existing mutation ambiguity survives it.
    const unresolvedMutation = uncertainty === 'mutation' || state.outcomeUncertain;
    update({ status: uncertainty !== null || unresolvedMutation ? 'uncertain' : 'unavailable', user: null, registrationEnabled: null,
      error, outcomeUncertain: unresolvedMutation, retryAt: error.retryAt, verifiedReadId: null });
  }
  function start(work: () => Promise<void>): Promise<AuthState> {
    try { usable(); } catch (error) { return Promise.reject(error); }
    const timer = setTimeout(() => { if (!disposed) update({ waiting: true }); }, 8000);
    const task = Promise.resolve().then(() => coordination!.exclusive(work)).catch((error: unknown) => {
      if (error instanceof AuthFailure) throw error;
      const failure = new AuthFailure('coordination');
      unavailable(failure, null);
      throw failure;
    }).finally(() => {
      clearTimeout(timer);
      const verifiedReadId = verifiedGeneration === generation && csrfToken !== null && !disposed && !suspended
        && (state.status === 'anonymous' || state.status === 'authenticated') ? ++readCounter : null;
      verifiedGeneration = null;
      pending = undefined;
      update({ busy: false, waiting: false, verifiedReadId });
    }).then(() => state);
    pending = task;
    verifiedGeneration = null;
    update({ busy: true, waiting: false, error: null, retryAt: null });
    return task;
  }
  function bootstrap(force = false): Promise<AuthState> {
    if (pending) return pending;
    if (!force && csrfToken && (state.status === 'anonymous' || state.status === 'authenticated')) return Promise.resolve(state);
    return start(async () => {
      try {
        try { await synchronize(); }
        catch (error) {
          if (!(error instanceof AuthFailure && error.kind === 'stale') || disposed) throw error;
          await synchronize(); // One bounded read reconciliation after an invalidation, never a POST replay.
        }
        // Read reconciliation cannot prove whether an ambiguous registration created an account.
      }
      catch (error) {
        const failure = error instanceof AuthFailure ? error : new AuthFailure('network');
        unavailable(failure, failure.kind === 'network' || failure.kind === 'protocol' ? 'read' : null);
        throw failure;
      }
    });
  }
  async function mutation(kind: 'login' | 'register' | 'logout', input?: LoginRequest | RegisterRequest): Promise<AuthState> {
    if (pending) throw new AuthFailure('busy');
    usable();
    const credentials = kind === 'logout' ? undefined : validateCredentials(kind, input);
    const intendedProof = csrfToken;
    const intendedUser = state.user?.id ?? null;
    if (!intendedProof || (kind === 'logout' ? state.status !== 'authenticated' : state.status !== 'anonymous')) {
      throw new AuthFailure('stale');
    }
    return start(async () => {
      let dispatched = false;
      let reconciled = false;
      try {
        // Re-read after the cross-tab lock: another tab may have replaced the cookie while we waited.
        await synchronize();
        if (csrfToken !== intendedProof || (state.user?.id ?? null) !== intendedUser) throw new AuthFailure('stale');
        if (kind === 'register' && !state.registrationEnabled) throw new AuthFailure('validation', 404, 'NOT_FOUND');
        const epoch = generation;
        // Preflight verification cannot authorize the session after a cookie-changing POST.
        verifiedGeneration = null;
        update({ verifiedReadId: null });
        if (epoch !== generation || csrfToken !== intendedProof) throw new AuthFailure('stale');
        dispatched = true;
        if (kind === 'logout') {
          await api.logout(csrfToken);
          if (disposed) throw new AuthFailure('stale');
          if (epoch === generation) {
            csrfToken = null;
            update({ status: 'anonymous', user: null, outcomeUncertain: false });
          }
        } else {
          const result = await api[kind](credentials!, csrfToken);
          if (disposed) throw new AuthFailure('stale');
          if (epoch === generation) {
            csrfToken = result.csrfToken;
            update({ status: 'authenticated', user: Object.freeze({ ...result.user }), outcomeUncertain: false });
          }
        }
        coordination!.publish();
        if (epoch !== generation) {
          reconciled = true;
          const recoveryGeneration = generation;
          await synchronize();
          if (recoveryGeneration !== generation) throw new AuthFailure('stale');
          // Only this confirmed mutation plus successful current-generation verification resolves prior uncertainty.
          update({ error: null, outcomeUncertain: false });
        }
      } catch (error) {
        const failure = error instanceof AuthFailure ? error : new AuthFailure('network');
        const ambiguous = dispatched && (failure.kind === 'network' || failure.kind === 'protocol' || failure.status >= 500);
        if (reconciled) unavailable(failure, 'mutation');
        else if (failure.status === 429) update({ error: failure, retryAt: failure.retryAt ?? now() + 60_000 });
        else if (dispatched && (ambiguous || [401, 403, 409].includes(failure.status))
          && failure.code !== 'INVALID_CREDENTIALS') {
          invalidate();
          coordination!.publish();
          try { await synchronize(); update({ error: failure, outcomeUncertain: ambiguous || state.outcomeUncertain }); }
          catch (recovery) {
            const recoveryFailure = recovery instanceof AuthFailure ? recovery : new AuthFailure('network');
            unavailable(recoveryFailure, ambiguous ? 'mutation' : null);
          }
        } else if (!dispatched && failure.kind !== 'stale' && failure.kind !== 'validation') {
          unavailable(failure, failure.kind === 'network' || failure.kind === 'protocol' ? 'read' : null);
        }
        else update({ error: failure });
        throw failure;
      }
    });
  }
  // Only the feature transport consumes this callback. Proof never enters public
  // snapshots or component state. Feature requests cannot rotate the cookie and
  // its failure must not create registration/authentication mutation uncertainty.
  async function authenticatedRequest<T>(send: (proof: string) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (pending) throw new AuthFailure('busy');
    usable();
    const intendedUser = state.user?.id;
    const intendedProof = csrfToken;
    const epoch = generation;
    if (state.status !== 'authenticated' || state.verifiedReadId === null || !intendedUser || !intendedProof) throw new AuthFailure('stale');
    function authority() {
      usable();
      if (signal?.aborted || epoch !== generation || state.status !== 'authenticated'
        || state.user?.id !== intendedUser || csrfToken !== intendedProof) throw new AuthFailure('stale');
    }
    authority();
    let result: { value: T } | undefined;
    let rejected = false;
    let reason: unknown;
    const completed = await start(async () => {
      // Abandoned reads waiting for another tab's lock must not dispatch work.
      authority();
      try { await synchronize(); usable(); }
      catch (error) {
        const failure = error instanceof AuthFailure ? error : new AuthFailure('network');
        unavailable(failure, 'read'); throw failure;
      }
      authority();
      try { result = { value: await send(csrfToken!) }; }
      catch (error) {
        rejected = true; reason = error;
        const status = error instanceof Error && 'status' in error ? error.status : undefined;
        if (status === 401 || status === 403) {
          // Publish rejection together with loss of proof so feature consumers
          // quarantine rows before reconciliation can complete or fail.
          invalidate(new AuthFailure('http', status, status === 401 ? 'UNAUTHENTICATED' : 'REQUEST_REJECTED'));
          try { await synchronize(); }
          catch (recovery) { unavailable(recovery instanceof AuthFailure ? recovery : new AuthFailure('network'), 'read'); }
        }
      }
      if (disposed || suspended || signal?.aborted || epoch !== generation || state.user?.id !== intendedUser) {
        result = undefined;
        if (!rejected) { rejected = true; reason = new AuthFailure('stale'); }
      }
    });
    if (rejected) throw reason;
    // The lock-release continuation and synchronous subscribers may invalidate
    // an otherwise successful transport result. A receipt is not a capability
    // detached from the current user, proof, generation and operation admission.
    authority();
    if (state.busy || state.verifiedReadId === null || state.verifiedReadId !== completed.verifiedReadId) throw new AuthFailure('stale');
    if (!result) throw new AuthFailure('stale');
    return result.value;
  }
  const unsubscribe = coordination?.subscribe((event) => {
    if (disposed) return;
    if (event === 'suspend') suspended = true;
    else if (event === 'resume') suspended = false;
    invalidate();
    if (suspended) return; // Do not start cookie allocations while the page is leaving.
    // No messages are authentication evidence. Coalesce notifications into one pending operation.
    void bootstrap(true).catch(() => { /* State already records a sanitized failure. */ });
  });
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    bootstrap,
    revalidate: () => bootstrap(true),
    authenticatedRequest,
    login: (input: LoginRequest) => mutation('login', input),
    register: (input: RegisterRequest) => mutation('register', input),
    logout: () => mutation('logout'),
    dispose() {
      disposed = true; generation++; csrfToken = null;
      verifiedGeneration = null;
      unsubscribe?.(); coordination?.close(); listeners.clear();
      update({ status: 'unavailable', user: null, registrationEnabled: null, verifiedReadId: null,
        error: new AuthFailure('coordination') });
      // Never abort an in-flight request or release its lock early.
    }
  };
}

export type AuthStore = ReturnType<typeof createAuthStore>;
let browserStore: AuthStore | undefined;
// Lazy singleton: React remount/unsubscribe does not destroy the shared operation or cookie ordering.
export function getAuthStore(): AuthStore {
  return browserStore ??= createAuthStore({ api: createAuthApi(), coordination: createBrowserCoordination() });
}
