import { useLayoutEffect, useRef, useState } from 'react';
import type { LoginRequest } from '@applyflow/contracts';
import { AuthFailure } from '../../lib/auth/api';
import { useAuth } from './use-auth';
import type { AuthState } from '../../lib/auth/store';

export type OperationKind = 'login' | 'register' | 'logout';
export type OperationFeedback = { error: AuthFailure } | { message: string } | null;

// Owned by the page, above content the guard may temporarily unmount. No credentials
// or authentication responses are retained in this hook's state or callbacks.
export function useAuthOperation() {
  const { integration } = useAuth();
  const lifetime = useRef({ active: false, ticket: 0, pending: false });
  const [pending, setPending] = useState<OperationKind | null>(null);
  const [feedback, setFeedback] = useState<OperationFeedback>(null);
  useLayoutEffect(() => {
    const owner = { active: true, ticket: 0, pending: false };
    lifetime.current = owner;
    return () => { owner.active = false; };
  }, []);

  function start(kind: OperationKind, canSubmit: () => boolean, input?: LoginRequest): boolean {
    const owner = lifetime.current;
    if (!owner.active || owner.pending || !canSubmit()) return false;
    const baseline = integration.store.getSnapshot().verifiedReadId ?? 0;
    const ticket = ++owner.ticket;
    owner.pending = true;
    setFeedback(null);
    let operation: Promise<AuthState>;
    try { operation = kind === 'logout' ? integration.store.logout() : integration.store[kind](input!); }
    catch {
      // A dependency fault cannot establish whether work reached the server. Discard
      // its exception and settle local ownership through the same sanitized path.
      // If ownership was already accepted, the live store remains busy and locked.
      operation = Promise.reject(new AuthFailure('network'));
    }
    // The accepted store marks busy synchronously only when it accepts ownership.
    // A rejected admission is not a network handoff and must not clear the password.
    const accepted = integration.store.getSnapshot().busy;
    if (accepted) setPending(kind);
    const current = () => owner.active && lifetime.current === owner && owner.ticket === ticket;
    const settle = async (error?: unknown) => {
      if (!current()) return;
      const failure = error === undefined ? null : error instanceof AuthFailure ? error : new AuthFailure('network');
      if (failure) setFeedback({ error: failure });
      const snapshot = integration.store.getSnapshot();
      // Definite outcomes still require authoritative proof. An existing reconciliation
      // receipt is reused. Ambiguous failures/cooldowns require explicit recovery instead.
      const definite = failure === null || (failure.kind === 'http' && [400, 401, 403, 404, 409].includes(failure.status));
      if (accepted && definite && (snapshot.status === 'anonymous' || snapshot.status === 'authenticated')) {
        try { await integration.verify(baseline); }
        catch { /* The guard exposes recovery; failure is never evidence of logout. */ }
      }
      if (!current()) return;
      const live = integration.store.getSnapshot();
      if (!failure && kind === 'logout' && live.status === 'authenticated' && live.verifiedReadId !== null) {
        setFeedback({ message: 'The current session is still signed in. Review it before signing out again.' });
      }
      owner.pending = false;
      setPending(null);
    };
    void operation.then(() => settle(), (error: unknown) => settle(error));
    return accepted;
  }
  return { start, pending, feedback };
}
