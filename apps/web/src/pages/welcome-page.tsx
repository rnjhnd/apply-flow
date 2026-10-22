import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { checkApiHealth } from '@/lib/api';

type Connection =
  | { kind: 'checking' }
  | { kind: 'connected'; checkedAt: Date }
  | { kind: 'unavailable' };

export function WelcomePage() {
  useEffect(() => { document.title = 'ApplyFlow — A focused job search'; }, []);
  const [connection, setConnection] = useState<Connection>({ kind: 'checking' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    void checkApiHealth(controller.signal).then(() => {
      if (!controller.signal.aborted) setConnection({ kind: 'connected', checkedAt: new Date() });
    }).catch(() => {
      if (!controller.signal.aborted) setConnection({ kind: 'unavailable' });
    });
    return () => controller.abort();
  }, [attempt]);

  const status = connection.kind === 'checking' ? 'Checking connection…'
    : connection.kind === 'connected' ? 'API available' : 'API unavailable';

  function retry() {
    setConnection({ kind: 'checking' });
    setAttempt((value) => value + 1);
  }

  return (
    <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-6 sm:px-12 lg:px-20">
      <a href="#main" className="skip-link">Skip to content</a>
      <header className="flex items-center justify-between gap-4 border-b border-border py-7 sm:py-9">
        <span className="flex items-center gap-3 font-heading text-xl font-bold tracking-tight">
          <svg aria-hidden="true" viewBox="0 0 32 32" className="size-8 text-primary" fill="none">
            <path d="M5 25V14a7 7 0 0 1 14 0v11M12 25V8a7 7 0 0 1 14 0v17" stroke="currentColor" strokeWidth="3" />
          </svg>
          ApplyFlow
        </span>
        <div className="flex flex-wrap items-center justify-end gap-4">
          <span className="text-right text-xs font-medium text-muted-foreground sm:text-sm">Foundation preview</span>
          <Button asChild size="sm" variant="outline"><Link to="/login">Sign in</Link></Button>
        </div>
      </header>

      <main id="main" className="grid flex-1 items-center gap-12 py-16 sm:py-24 lg:grid-cols-[1.25fr_1fr] lg:gap-20">
        <section aria-labelledby="welcome-heading">
          <p className="mb-6 flex items-center gap-3 text-xs font-semibold uppercase tracking-[0.18em] text-primary">
            <span aria-hidden="true" className="h-px w-9 bg-accent" /> A little more clarity
          </p>
          <h1 id="welcome-heading" className="max-w-xl font-heading text-4xl leading-[1.12] font-semibold tracking-[-0.045em] sm:text-6xl">
            Your next chapter,<br />with a clearer view.
          </h1>
          <p className="mt-7 max-w-md text-base leading-7 text-muted-foreground sm:text-lg sm:leading-8">
            A calm, focused workspace for your job search. ApplyFlow is taking shape, one thoughtful step at a time.
          </p>
          <p className="mt-8 max-w-md border-l-2 border-accent pl-4 text-sm leading-6 text-muted-foreground">
            This preview checks the connection to the API. Application tracking will arrive in a later milestone.
          </p>
        </section>

        <section aria-labelledby="connection-heading" className="rounded-2xl border border-border bg-surface p-7 sm:p-9">
          <p className="mb-5 text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Connection check</p>
          <h2 id="connection-heading" className="font-heading text-2xl font-semibold tracking-tight">A steady starting point.</h2>
          <p className="mt-3 text-sm leading-6 text-muted-foreground">A live check that this page can reach the ApplyFlow API.</p>
          <div role="status" aria-live="polite" aria-atomic="true" className="my-7 border-y border-border py-5">
            <p className="flex items-center gap-3 text-sm font-semibold">
              <span aria-hidden="true" className={`size-2.5 shrink-0 rounded-full ${connection.kind === 'connected' ? 'bg-primary' : 'bg-accent'}`} />
              {status}
            </p>
            <p className="mt-2 text-sm leading-6 text-muted-foreground">
              {connection.kind === 'checking' && 'Waiting for a response from the server.'}
              {connection.kind === 'connected' && <>Last checked <time dateTime={connection.checkedAt.toISOString()}>{connection.checkedAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</time>. The server responded successfully.</>}
              {connection.kind === 'unavailable' && 'We couldn’t reach the API. Check that the server is running, then try again.'}
            </p>
          </div>
          <Button onClick={retry} disabled={connection.kind === 'checking'} className="w-full sm:w-auto">
            {connection.kind === 'checking' ? 'Checking…' : 'Check connection'}
            <span aria-hidden="true">↗</span>
          </Button>
        </section>
      </main>

      <footer className="border-t border-border py-6 text-xs leading-6 text-muted-foreground">
        A focused space for your job search.
      </footer>
    </div>
  );
}
