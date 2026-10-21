import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Navigate, useLocation } from 'react-router';
import { Button } from '../../components/ui/button';
import { AuthFailure } from '../../lib/auth/api';
import { useAuth } from './use-auth';
import type { AuthState } from '../../lib/auth/store';

type Kind = 'guest' | 'registration' | 'protected';

export function AuthRoute({ kind, children }: { kind: Kind; children: ReactNode }) {
  const location = useLocation();
  return <SessionBoundary key={location.key} kind={kind}>{children}</SessionBoundary>;
}

function SessionBoundary({ kind, children }: { kind: Kind; children: ReactNode }) {
  const { state, integration } = useAuth();
  const [baseline] = useState(() => state.verifiedReadId ?? 0);
  const [entry, setEntry] = useState<'checking' | 'verified' | 'failed'>('checking');
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<{ error: AuthFailure; snapshot: AuthState } | null>(null);
  const [time, setTime] = useState(Date.now);
  const active = useRef(false);
  const lastForeground = useRef(0);
  const guestEligible = state.status === 'anonymous' && (kind !== 'registration' || state.registrationEnabled === true);
  const [retainGuest, setRetainGuest] = useState(false);
  // DOM retention only, never authorization: hidden controls remain inert and disabled.
  if (guestEligible && !retainGuest && kind !== 'protected') setRetainGuest(true);

  const recordFailure = useCallback((error: unknown) => {
    setFailure({ error: error instanceof AuthFailure ? error : new AuthFailure('coordination'),
      snapshot: integration.store.getSnapshot() });
    setEntry('failed');
  }, [integration]);

  useEffect(() => {
    let subscribed = true;
    const release = integration.retain();
    active.current = true;
    lastForeground.current = Date.now();
    void integration.verify(baseline).then(() => {
      if (subscribed) { setEntry('verified'); setFailure(null); }
    }).catch((error: unknown) => { if (subscribed) recordFailure(error); });

    const foreground = () => {
      const current = integration.store.getSnapshot();
      const now = Date.now();
      if (document.visibilityState !== 'visible' || current.busy
        || (current.retryAt !== null && current.retryAt > now) || now - lastForeground.current < 30_000) return;
      lastForeground.current = now;
      setChecking(true);
      void integration.verify().then(() => {
        if (subscribed) { setEntry('verified'); setFailure(null); }
      }).catch((error: unknown) => { if (subscribed) recordFailure(error); })
        .finally(() => { if (subscribed) setChecking(false); });
    };
    window.addEventListener('focus', foreground);
    document.addEventListener('visibilitychange', foreground);
    return () => {
      subscribed = false; active.current = false;
      release();
      window.removeEventListener('focus', foreground);
      document.removeEventListener('visibilitychange', foreground);
    };
  }, [baseline, integration, recordFailure]);

  useEffect(() => {
    if (state.retryAt === null) return;
    const deadline = state.retryAt;
    const timer = setInterval(() => {
      const now = Date.now(); setTime(now);
      if (now >= deadline) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [state.retryAt]);

  const seconds = state.retryAt === null ? 0 : Math.max(0, Math.ceil((state.retryAt - time) / 1000));
  // Only a newer, still-valid receipt satisfies this history entry, including external recovery.
  const fresh = state.verifiedReadId !== null && state.verifiedReadId > baseline;
  const pending = checking || state.busy || (entry === 'checking' && !fresh);
  const ready = fresh && (state.status === 'anonymous' || state.status === 'authenticated');
  const error = failure?.snapshot === state ? failure.error : state.error;

  function recover() {
    if (pending || seconds > 0) return;
    setChecking(true); lastForeground.current = Date.now();
    void integration.verify().then(() => {
      if (active.current) { setEntry('verified'); setFailure(null); }
    }).catch((reason: unknown) => { if (active.current) recordFailure(reason); })
      .finally(() => { if (active.current) setChecking(false); });
  }

  if (ready && !pending) {
    if (kind === 'protected' && state.status === 'anonymous') return <Navigate to="/login" replace />;
    if (kind !== 'protected' && state.status === 'authenticated') return <Navigate to="/app" replace />;
  }

  const showGuest = ready && guestEligible && kind !== 'protected';
  const showProtected = ready && state.status === 'authenticated' && kind === 'protected' && !pending;
  const registrationDisabled = ready && state.status === 'anonymous' && kind === 'registration' && state.registrationEnabled === false;
  const uncertain = state.status === 'uncertain' || state.outcomeUncertain;
  const heading = pending ? 'Checking your session' : uncertain ? 'We could not confirm the result'
    : error?.kind === 'coordination' ? 'Browser coordination unavailable' : 'Check your session to continue';

  return (
    <div className="space-y-6" aria-busy={pending}>
      {uncertain && <p role="status" className="border-l-2 border-accent pl-4 text-sm leading-6">
        Your current session and the outcome of an earlier request may differ. Check your session before trying again.
      </p>}
      {(!showGuest && !showProtected && !registrationDisabled) && <section aria-labelledby="session-heading" className="space-y-5">
        <h1 id="session-heading" className="font-heading text-3xl font-semibold tracking-tight">{heading}</h1>
        <p role="status" className="text-sm leading-6 text-muted-foreground">
          {state.waiting ? 'This is taking longer than expected. The operation is still running; please wait.'
            : pending ? 'Please wait while ApplyFlow verifies the session.'
            : error?.kind === 'coordination' ? 'Use a supported browser on a secure connection, then reload this page.'
            : 'Your session has not been verified. This does not mean you have been signed out.'}
        </p>
        {!pending && error?.kind !== 'coordination' && <Button onClick={recover} disabled={seconds > 0}>Check session</Button>}
        {seconds > 0 && <p role="status" className="text-sm text-muted-foreground">Try again in {seconds} seconds.</p>}
      </section>}
      {registrationDisabled && <section className="space-y-5">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Account creation is unavailable</h1>
        <p className="text-sm leading-6 text-muted-foreground">Account creation is not enabled here. You can sign in to an existing account.</p>
        <Button asChild><Link to="/login">Sign in</Link></Button>
      </section>}
      {kind !== 'protected' && retainGuest && !(kind === 'registration' && state.registrationEnabled === false) &&
        <fieldset className="min-w-0 space-y-5 border-0 p-0" hidden={!showGuest} inert={!showGuest || pending}
          disabled={!showGuest || pending}>{children}</fieldset>}
      {showProtected && children}
      {showGuest && pending && <p role="status" className="text-sm leading-6 text-muted-foreground">
        {state.waiting ? 'This is taking longer than expected. Please wait.' : 'Checking your session…'}
      </p>}
    </div>
  );
}
