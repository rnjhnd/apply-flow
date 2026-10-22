import { useRef, useState } from 'react';
import { applicationStatusSchema, createApplicationRequestSchema } from '@applyflow/contracts';
import { Button } from '../../components/ui/button';
import { useAuthAdmission } from '../auth/auth-admission';
import { fieldClass } from '../auth/password-field';
import type { ApplicationsController, ApplicationDraft } from './use-applications';

const fields = ['company', 'jobTitle', 'status', 'applicationDate', 'location', 'jobUrl', 'notes'] as const;
const labels = { company: 'Company', jobTitle: 'Job title', status: 'Status', applicationDate: 'Application date',
  location: 'Location', jobUrl: 'Job URL', notes: 'Notes' };

export function ApplicationForm({ controller }: { controller: ApplicationsController }) {
  const admission = useAuthAdmission();
  const [errors, setErrors] = useState<Partial<Record<keyof ApplicationDraft, string>>>({});
  const summary = useRef<HTMLParagraphElement>(null);
  return <section aria-labelledby="add-application-heading" className="min-w-0 space-y-6">
    <div className="space-y-2"><h2 id="add-application-heading" className="font-heading text-2xl font-semibold">Add an application</h2>
      <p className="text-sm leading-6 text-muted-foreground">Keep the next opportunity in view. Start with a company and role.</p></div>
    <form aria-label="Add application" method="post" noValidate className="space-y-5" onSubmit={event => {
      event.preventDefault();
      if (!admission.canSubmit() || controller.saving || controller.cooldown > 0) return;
      const data = new FormData(event.currentTarget);
      const draft = Object.fromEntries(fields.map(key => [key, String(data.get(key) ?? '')])) as ApplicationDraft;
      controller.setDraft(draft);
      const parsed = createApplicationRequestSchema.safeParse(draft);
      if (!parsed.success) {
        setErrors(Object.fromEntries(fields.filter(key => parsed.error.issues.some(issue => issue.path[0] === key)).map(key => [key,
          key === 'applicationDate' ? 'Use a real date; a date is required outside Saved.' : `Review ${labels[key].toLowerCase()}.`])));
        queueMicrotask(() => { if (summary.current?.isConnected) summary.current.focus(); }); return;
      }
      setErrors({}); controller.save(parsed.data, admission.canSubmit);
    }}>
      {Object.keys(errors).length > 0 && <p ref={summary} role="alert" tabIndex={-1} className="border-l-2 border-primary pl-3 text-sm outline-offset-4 focus-visible:outline-2">Please review the fields below. Your application has not been sent.</p>}
      <fieldset className="min-w-0 space-y-5 border-0 p-0" disabled={!admission.allowed || controller.saving || controller.cooldown > 0}>
        {fields.map(key => {
          const error = errors[key] ?? (controller.failure?.fields?.[key] ? 'Review this field.' : undefined);
          const id = `application-${key}`;
          const common = { id, name: key, value: controller.draft[key], className: fieldClass,
            'aria-invalid': error ? true as const : undefined, 'aria-describedby': error ? `${id}-error` : key === 'applicationDate' ? 'application-date-hint' : undefined,
            onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => controller.setDraft(previous => ({ ...previous, [key]: event.target.value })) };
          return <div key={key} className="min-w-0 space-y-2">
            <label htmlFor={id} className="block text-sm font-semibold">{labels[key]}{['location', 'jobUrl', 'notes'].includes(key) ? ' (optional)' : ''}</label>
            {key === 'status' ? <select {...common}>{applicationStatusSchema.options.map(status => <option key={status} value={status}>{status.charAt(0) + status.slice(1).toLowerCase()}</option>)}</select>
              : key === 'notes' ? <textarea {...common} rows={5} />
              : <input {...common} type={key === 'applicationDate' ? 'date' : key === 'jobUrl' ? 'url' : 'text'}
                required={key === 'company' || key === 'jobTitle' || (key === 'applicationDate' && controller.draft.status !== 'SAVED')} />}
            {key === 'applicationDate' && <p id="application-date-hint" className="text-xs leading-5 text-muted-foreground">Optional for Saved; required for every other status. Future dates cannot be saved.</p>}
            {error && <p id={`${id}-error`} className="text-sm font-medium">{error}</p>}
          </div>;
        })}
        <Button type="submit" className="w-full sm:w-auto">Save application</Button>
      </fieldset>
    </form>
  </section>;
}
