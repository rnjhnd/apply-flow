import { useEffect } from 'react';
import { Link, Outlet, useLocation } from 'react-router';

export function RouteShell() {
  const location = useLocation();
  useEffect(() => {
    const titles: Record<string, string> = { '/login': 'Sign in', '/register': 'Create an account', '/app': 'Workspace' };
    document.title = `${titles[location.pathname] ?? 'Page not found'} — ApplyFlow`;
    document.getElementById('main')?.focus();
  }, [location.pathname]);
  return <div className="mx-auto flex min-h-dvh max-w-7xl flex-col px-6 sm:px-12 lg:px-20">
    <a href="#main" className="skip-link">Skip to content</a>
    <header className="flex items-center justify-between gap-4 border-b border-border py-7 sm:py-9">
      <Link to="/" className="font-heading text-xl font-bold tracking-tight">ApplyFlow</Link>
      <span className="text-xs text-muted-foreground">A focused space for your job search</span>
    </header>
    <main id="main" tabIndex={-1} className="flex-1 py-16 sm:py-24"><div className="max-w-xl"><Outlet /></div></main>
    <footer className="border-t border-border py-6 text-xs text-muted-foreground">Your next chapter, with a clearer view.</footer>
  </div>;
}
