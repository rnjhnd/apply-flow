import { Link, Outlet, Route, Routes } from 'react-router';
import type { AuthStore } from './lib/auth/store';
import { WelcomePage } from './pages/welcome-page';
import { AuthProvider } from './features/auth/auth-provider';
import { AuthRoute } from './features/auth/auth-route';
import { RouteShell } from './features/auth/route-shell';

function RoutePlaceholder({ heading }: { heading: string }) {
  return <section className="space-y-5">
    <h1 className="font-heading text-3xl font-semibold tracking-tight">{heading}</h1>
    <p className="text-sm leading-6 text-muted-foreground">This route is ready. Its content will be added in the next stage.</p>
  </section>;
}

export function App({ authStore }: { authStore?: AuthStore | undefined }) {
  return <Routes>
    <Route path="/" element={<WelcomePage />} />
    <Route element={<RouteShell />}>
      <Route element={<AuthProvider store={authStore}><Outlet /></AuthProvider>}>
        <Route path="/login" element={<AuthRoute kind="guest"><RoutePlaceholder heading="Sign in" /></AuthRoute>} />
        <Route path="/register" element={<AuthRoute kind="registration"><RoutePlaceholder heading="Create an account" /></AuthRoute>} />
        <Route path="/app" element={<AuthRoute kind="protected"><RoutePlaceholder heading="Workspace route verified" /></AuthRoute>} />
      </Route>
      <Route path="*" element={<section className="space-y-5">
        <h1 className="font-heading text-3xl font-semibold tracking-tight">Page not found</h1>
        <p className="text-sm leading-6 text-muted-foreground">This page is not available.</p>
        <Link to="/" className="font-semibold text-primary underline underline-offset-4">Return home</Link>
      </section>} />
    </Route>
  </Routes>;
}
