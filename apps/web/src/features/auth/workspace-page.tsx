import { Button } from '../../components/ui/button';
import { AuthFeedback } from './auth-feedback';
import { AuthRoute } from './auth-route';
import { useAuthAdmission } from './auth-admission';
import { useAuth } from './use-auth';
import { useAuthOperation } from './use-auth-operation';
import { useLocation } from 'react-router';
import { useEffect, useState } from 'react';
import { createApplicationsApi } from '../../lib/applications/api';
import { ApplicationForm } from '../applications/application-form';
import { ApplicationList } from '../applications/application-list';
import { useApplications, type ApplicationsController } from '../applications/use-applications';

export function WorkspacePage() {
  const location = useLocation();
  return <WorkspacePageContent key={location.key} />;
}

function WorkspacePageContent() {
  const operation = useAuthOperation();
  const { integration } = useAuth();
  const [api] = useState(() => createApplicationsApi(integration.store));
  const applications = useApplications(integration.store, api);
  return <AuthRoute kind="protected" feedback={<AuthFeedback feedback={operation.feedback} />}
    pendingLabel={operation.pending ? 'Signing out' : applications.saving ? 'Saving your application' : undefined}>
    <WorkspaceView applications={applications} logout={(canSubmit) => operation.start('logout', canSubmit)} />
  </AuthRoute>;
}

function WorkspaceView({ logout, applications }: { logout: (canSubmit: () => boolean) => void; applications: ApplicationsController }) {
  const admission = useAuthAdmission();
  const { state } = useAuth();
  const enter = applications.enter;
  useEffect(() => { enter(); }, [enter]);
  return <section className="space-y-8">
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-primary">A clearer view ahead</p>
      <h1 className="font-heading text-3xl font-semibold tracking-tight sm:text-4xl">Your workspace</h1>
      <p className="text-sm leading-6 text-muted-foreground">Signed in as <span className="font-medium text-foreground [overflow-wrap:anywhere]">{state.user?.email}</span></p>
    </div>
    {applications.message && <p role="status" className="border-l-2 border-primary pl-4 text-sm">{applications.message}</p>}
    {applications.failure && <div role="alert" className="space-y-2 border-l-2 border-accent pl-4 text-sm leading-6">
      <p>{applications.failure.kind === 'unknown' ? 'We could not confirm whether your application was saved. Check your applications before submitting again; another submission may create a duplicate.'
        : applications.failure.status === 429 ? 'Too many requests. Wait before trying again.'
        : applications.failure.kind === 'stale' ? 'Your session changed before submission. Check your session before trying again.' : 'The application was not accepted. Review the fields and try again.'}</p>
      {applications.cooldown > 0 && <p aria-live="off">Try again in {applications.cooldown} seconds.</p>}
    </div>}
    <div className="grid min-w-0 gap-12 border-t border-border pt-8 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
      <ApplicationForm controller={applications} />
      <ApplicationList controller={applications} />
    </div>
    <Button variant="outline" disabled={!admission.allowed} onClick={() => logout(admission.canSubmit)}>Sign out</Button>
    <p className="text-xs leading-6 text-muted-foreground">Signing out ends this browser’s current session. Your other devices stay signed in.</p>
  </section>;
}
