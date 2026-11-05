import { Button } from '../../components/ui/button';
import { AuthFeedback } from './auth-feedback';
import { AuthRoute } from './auth-route';
import { useAuthAdmission } from './auth-admission';
import { useAuth } from './use-auth';
import { useAuthOperation } from './use-auth-operation';
import { useEffect, useState } from 'react';
import { createApplicationsApi } from '../../lib/applications/api';
import { ApplicationForm } from '../applications/application-form';
import { ApplicationList } from '../applications/application-list';
import { useApplicationWorkspace, type ApplicationWorkspaceController } from '../applications/use-application-workspace';
import { ApplicationEditor } from '../applications/application-editor';
import { ApplicationBoard } from '../applications/application-board';

const mutationLabels = { save: 'Saving your application', archive: 'Archiving your application',
  restore: 'Restoring your application', delete: 'Waiting for deletion confirmation' };

export function WorkspacePage() {
  return <WorkspacePageContent />;
}

function WorkspacePageContent() {
  const operation = useAuthOperation();
  const { integration } = useAuth();
  const [api] = useState(() => createApplicationsApi(integration.store));
  const workspace = useApplicationWorkspace(integration.store, api);
  const { applications, editor } = workspace;
  return <AuthRoute kind="protected" feedback={<AuthFeedback feedback={operation.feedback} />}
    pendingLabel={operation.pending ? 'Signing out' : editor.saving ? mutationLabels[editor.mutationKind ?? 'save']
      : applications.saving ? 'Saving your application' : undefined}>
    <WorkspaceView workspace={workspace} logout={(canSubmit) => operation.start('logout', canSubmit)} />
  </AuthRoute>;
}

function WorkspaceView({ logout, workspace }: { logout: (canSubmit: () => boolean) => void; workspace: ApplicationWorkspaceController }) {
  const { applications, editor, board, isBoard, editorIdle, handoff } = workspace;
  const admission = useAuthAdmission();
  const { state } = useAuth();
  const enter = applications.enter;
  const enterWorkspace = workspace.enter;
  useEffect(() => { enterWorkspace(); if (!isBoard && !handoff) enter(editorIdle); }, [enterWorkspace, enter, editorIdle, isBoard, handoff]);
  const target = editor.focusTarget, acknowledgeFocus = editor.acknowledgeFocus;
  useEffect(() => {
    if (editor.selectedId || !target) return;
    const element = document.getElementById(target) ?? document.getElementById('applications-heading');
    if (element) { element.focus(); acknowledgeFocus(); }
  }, [editor.selectedId, target, acknowledgeFocus]);
  useEffect(() => { if (!editor.focusTarget && !applications.focusTarget) workspace.restoreFocus(); });
  return <section className="min-w-0 space-y-8" onFocusCapture={event => workspace.rememberFocus(event.target.id)}>
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
    <div role="group" aria-label="Application views" className="flex flex-wrap gap-3">
      {(['active', 'archived'] as const).map(view => <Button key={view} variant={applications.view === view ? 'default' : 'outline'}
        aria-pressed={applications.view === view} disabled={!admission.allowed || applications.saving || editor.saving || editor.deleteConfirm || handoff}
        onClick={() => workspace.switchView(view)}>
        {view === 'active' ? 'Active' : 'Archived'}</Button>)}
    </div>
    {applications.view === 'active' && <div role="group" aria-label="Application presentation" className="flex flex-wrap gap-3">
      {(['list', 'board'] as const).map(presentation => <Button id={`presentation-${presentation}`} key={presentation}
        aria-pressed={workspace.presentation === presentation} variant={workspace.presentation === presentation ? 'default' : 'outline'}
        disabled={!admission.allowed || applications.saving || editor.saving || editor.deleteConfirm || handoff}
        onClick={() => workspace.selectPresentation(presentation)}>{presentation === 'list' ? 'List' : 'Board'}</Button>)}
    </div>}
    <div className={`grid min-w-0 gap-12 border-t border-border pt-8 ${isBoard ? '' : 'lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16'}`}>
      {editor.selectedId ? <ApplicationEditor controller={editor} /> : applications.view === 'active' ? <ApplicationForm controller={applications} />
        : <div className="space-y-3"><h2 className="font-heading text-2xl font-semibold">Kept for later</h2>
          <p className="text-sm leading-7 text-muted-foreground">Archived applications keep their details, status and history. Open one to restore it or permanently remove it.</p></div>}
      {isBoard ? <ApplicationBoard controller={board} applications={applications} onEdit={editor.open} selectedId={editor.selectedId}
        disabled={!admission.allowed || !editorIdle || handoff || applications.saving} />
        : <ApplicationList controller={applications} onEdit={editor.open} selectedId={editor.selectedId} editBusy={!admission.allowed || !editorIdle || handoff} />}
    </div>
    <Button variant="outline" disabled={!admission.allowed || editor.saving || handoff} onClick={() => workspace.guardMutation(() => { if (editor.confirmLeave()) logout(admission.canSubmit); })}>Sign out</Button>
    <p className="text-xs leading-6 text-muted-foreground">Signing out ends this browser’s current session. Your other devices stay signed in.</p>
  </section>;
}
