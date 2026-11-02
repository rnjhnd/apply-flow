import { useEffect, useRef, useState } from 'react';
import { updateApplicationRequestSchema } from '@applyflow/contracts';
import { Button } from '../../components/ui/button';
import { useAuthAdmission } from '../auth/auth-admission';
import { ApplicationFields } from './application-fields';
import { applicationFields, applicationLabels, statusLabel, type ApplicationFieldErrors } from './application-field-policy';
import type { ApplicationDraft } from './use-applications';
import type { ApplicationEditorController } from './use-application-editor';

const timestamp = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
export function ApplicationEditor({ controller }: { controller: ApplicationEditorController }) {
  const admission = useAuthAdmission();
  const [errors, setErrors] = useState<ApplicationFieldErrors>({});
  const summary = useRef<HTMLParagraphElement>(null);
  const focusTarget = controller.focusTarget, acknowledgeFocus = controller.acknowledgeFocus;
  useEffect(() => {
    if (!focusTarget) return;
    const element = document.getElementById(focusTarget);
    if (element) { element.focus(); acknowledgeFocus(); }
  }, [focusTarget, acknowledgeFocus]);
  const disabled = !admission.allowed || controller.saving || controller.loading || controller.historyLoading;
  const failure = controller.failure;
  return <section id="application-detail-panel" aria-labelledby="application-editor-heading" className="min-w-0 space-y-8 border-l-2 border-primary pl-5 sm:pl-6">
    <div className="space-y-3">
      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">Your next chapter</p>
      <h2 id="application-editor-heading" tabIndex={-1} className="font-heading text-2xl font-semibold outline-offset-4 focus-visible:outline-2">Edit application</h2>
      <p className="text-sm leading-6 text-muted-foreground">Keep the role in focus. Changes to status become part of its journey.</p>
      {controller.application && <p className="text-xs text-muted-foreground">Revision {controller.application.version}{controller.dirty ? ' · Unsaved changes' : ''}</p>}
    </div>
    {controller.loading && <p role="status">Loading saved application…</p>}
    {controller.detailError && <div id="application-detail-error" tabIndex={-1} role="alert" className="space-y-3 text-sm outline-offset-4 focus-visible:outline-2">
      <p>{controller.detailError === 'review' ? 'The saved version could not be loaded. Your draft is unchanged.' : 'Application details could not be loaded. Your draft has been kept if one was already open.'}</p>
      <Button variant="outline" disabled={disabled} onClick={controller.retryDetails}>Retry application details</Button>
    </div>}
    {(controller.notice || failure) && <div id="application-edit-feedback" tabIndex={-1} role={failure ? 'alert' : 'status'} className="space-y-3 border-l-2 border-accent pl-4 text-sm leading-6 outline-offset-4 focus-visible:outline-2">
      <p>{controller.notice ?? (controller.recovery === 'conflict' ? 'This application changed elsewhere. Your draft is still here. Review the saved version or explicitly reload and discard your draft.'
        : controller.recovery === 'unknown' ? 'We could not confirm whether your changes were saved. Your draft is still here. Review the saved application before making further changes; this save will not be replayed.'
        : failure?.status === 429 ? 'Too many requests. Wait before trying again.'
        : failure?.kind === 'stale' ? 'Your session changed before saving. Check your session, then review your draft.'
        : 'Changes were not accepted. Review the fields and your session before trying again.')}</p>
      {controller.recovery && <div className="flex flex-wrap gap-3">
        <Button variant="outline" disabled={disabled} onClick={controller.reviewSaved}>Review saved application</Button>
        <Button variant="outline" disabled={disabled} onClick={controller.reload}>Reload and discard draft</Button>
      </div>}
    </div>}
    {controller.review && <section aria-labelledby="application-saved-review" className="space-y-4 border-y border-border py-5">
      <h3 id="application-saved-review" tabIndex={-1} className="font-heading text-lg font-semibold outline-offset-4 focus-visible:outline-2">Saved version · Revision {controller.review.version}</h3>
      <p className="text-sm leading-6 text-muted-foreground">Read-only review. Your draft below has not been replaced.</p>
      <dl className="space-y-3 text-sm [overflow-wrap:anywhere]">{applicationFields.map(key => <div key={key}>
        <dt className="font-semibold">{applicationLabels[key]}</dt><dd className="whitespace-pre-wrap leading-6 text-muted-foreground">{key === 'status' ? statusLabel(controller.review![key]) : controller.review![key] ?? 'Not provided'}</dd>
      </div>)}</dl>
    </section>}
    {controller.draft && controller.application && <form aria-label="Edit application" noValidate className="space-y-5" onSubmit={event => {
      event.preventDefault();
      if (disabled || controller.recovery || !admission.canSubmit()) return;
      const data = new FormData(event.currentTarget);
      const draft = Object.fromEntries(applicationFields.map(key => [key, String(data.get(key) ?? '')])) as ApplicationDraft;
      controller.setDraft(draft);
      const parsed = updateApplicationRequestSchema.safeParse({ ...draft, expectedVersion: controller.application!.version });
      if (!parsed.success) {
        setErrors(Object.fromEntries(applicationFields.filter(key => parsed.error.issues.some(issue => issue.path[0] === key))
          .map(key => [key, key === 'applicationDate' ? 'Use a real date; a date is required outside Saved.' : `Review ${applicationLabels[key].toLowerCase()}.`])));
        queueMicrotask(() => summary.current?.isConnected && summary.current.focus()); return;
      }
      setErrors({}); controller.save(parsed.data, admission.canSubmit);
    }}>
      {Object.keys(errors).length > 0 && <p ref={summary} role="alert" tabIndex={-1} className="text-sm outline-offset-4 focus-visible:outline-2">Please review the fields below. Your changes have not been sent.</p>}
      <fieldset disabled={disabled || !!controller.recovery} className="min-w-0 space-y-5 border-0 p-0">
        <ApplicationFields prefix="edit-application" draft={controller.draft} setDraft={controller.setDraft}
          errors={{ ...Object.fromEntries(Object.keys(failure?.fields ?? {}).map(key => [key, 'Review this field.'])), ...errors }} />
        <Button type="submit" disabled={disabled || !!controller.recovery} className="w-full sm:w-auto">Save changes</Button>
      </fieldset>
    </form>}
    <Button variant="outline" disabled={disabled} onClick={controller.close}>Cancel</Button>
    {controller.application && <section aria-labelledby="application-history-heading" className="space-y-5 border-t border-border pt-6">
      <div className="space-y-2"><h3 id="application-history-heading" tabIndex={-1} className="font-heading text-xl font-semibold outline-offset-4 focus-visible:outline-2">Status history</h3>
        <p className="text-xs leading-5 text-muted-foreground">Newest revision first. Times shown in your local time zone.</p></div>
      {controller.historyLoading && <p role="status" className="text-sm">Loading status changes…</p>}
      {controller.historyError && <div role="alert" className="space-y-3 text-sm"><p>Status history could not be loaded. Your application and draft are unchanged.</p>
        <Button variant="outline" disabled={disabled} onClick={controller.retryHistory}>Retry status history</Button></div>}
      {!controller.historyLoading && !controller.historyError && controller.history.length === 0 && <p className="text-sm leading-6 text-muted-foreground">No status changes recorded yet. Earlier activity is not reconstructed.</p>}
      <ol className="space-y-5 border-l border-border pl-4">{controller.history.map(item => <li key={item.id} className="space-y-1 text-sm">
        <p className="font-semibold">{statusLabel(item.fromStatus)} → {statusLabel(item.toStatus)}</p>
        <p className="text-xs leading-5 text-muted-foreground">Revision {item.applicationVersion} · <time dateTime={item.changedAt}>{timestamp.format(new Date(item.changedAt))}</time></p>
      </li>)}</ol>
      {controller.historyCursor && <Button variant="outline" disabled={disabled || controller.historyError} onClick={controller.loadOlder}>Load older changes</Button>}
    </section>}
  </section>;
}
