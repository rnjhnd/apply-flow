import { Link, Outlet, Route, Routes } from 'react-router';
import type { AuthStore } from './lib/auth/store';
import { WelcomePage } from './pages/welcome-page';
import { AuthProvider } from './features/auth/auth-provider';
import { AuthPage } from './features/auth/auth-page';
import { WorkspacePage } from './features/auth/workspace-page';
import { RouteShell } from './features/auth/route-shell';

export function App({ authStore }: { authStore?: AuthStore | undefined }) {
  return <Routes>
    <Route path="/" element={<WelcomePage />} />
    <Route element={<RouteShell />}>
      <Route element={<AuthProvider store={authStore}><Outlet /></AuthProvider>}>
        <Route path="/login" element={<AuthPage key="login" mode="login" />} />
        <Route path="/register" element={<AuthPage key="register" mode="register" />} />
        <Route path="/app" element={<WorkspacePage />} />
      </Route>
      <Route path="*" element={<section className="space-y-5">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Page not found</h1>
        <p className="text-sm leading-6 text-muted-foreground">This page is not available.</p>
        <Link to="/" className="font-semibold text-primary underline underline-offset-4">Return home</Link>
      </section>} />
    </Route>
  </Routes>;
}
