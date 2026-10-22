import { Button } from '../../components/ui/button';
import { AuthFeedback } from './auth-feedback';
import { AuthRoute } from './auth-route';
import { useAuthAdmission } from './auth-admission';
import { useAuth } from './use-auth';
import { useAuthOperation } from './use-auth-operation';
import { useLocation } from 'react-router';

export function WorkspacePage() {
  const location = useLocation();
  return <WorkspacePageContent key={location.key} />;
}

function WorkspacePageContent() {
  const operation = useAuthOperation();
  return <AuthRoute kind="protected" feedback={<AuthFeedback feedback={operation.feedback} />}
    pendingLabel={operation.pending ? 'Signing out' : undefined}>
    <WorkspaceView logout={(canSubmit) => operation.start('logout', canSubmit)} />
  </AuthRoute>;
}

function WorkspaceView({ logout }: { logout: (canSubmit: () => boolean) => void }) {
  const admission = useAuthAdmission();
  const { state } = useAuth();
  return <section className="space-y-8">
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">A clearer view ahead</p>
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">Your workspace</h1>
      <p className="text-sm leading-6 text-muted-foreground">Signed in as <span className="font-medium text-foreground [overflow-wrap:anywhere]">{state.user?.email}</span></p>
    </div>
    <div className="space-y-3 border-t border-border pt-7">
      <h2 className="font-heading text-xl font-semibold">One step at a time</h2>
      <p className="text-sm leading-7 text-muted-foreground">Your session is ready. Application tracking will arrive in a later milestone.</p>
    </div>
    <Button variant="outline" disabled={!admission.allowed} onClick={() => logout(admission.canSubmit)}>Sign out</Button>
    <p className="text-xs leading-6 text-muted-foreground">Signing out ends this browser’s current session. Your other devices stay signed in.</p>
  </section>;
}
