import type { Dispatch, SetStateAction } from 'react';
import { applicationStatusSchema } from '@applyflow/contracts';
import { fieldClass } from '../auth/password-field';
import type { ApplicationDraft } from './use-applications';
import { applicationFields, applicationLabels, statusLabel, type ApplicationFieldErrors } from './application-field-policy';

// Shared by creation and editing; field policy remains in the Zod contracts.
export function ApplicationFields({ prefix, draft, setDraft, errors }: { prefix: string; draft: ApplicationDraft;
  setDraft: Dispatch<SetStateAction<ApplicationDraft>>; errors: ApplicationFieldErrors }) {
  return applicationFields.map(key => {
    const error = errors[key], id = `${prefix}-${key}`;
    const common = { id, name: key, value: draft[key], className: fieldClass,
      'aria-invalid': error ? true as const : undefined,
      'aria-describedby': error ? `${id}-error` : key === 'applicationDate' ? `${prefix}-date-hint` : undefined,
      onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
        setDraft(previous => ({ ...previous, [key]: event.target.value })) };
    return <div key={key} className="min-w-0 space-y-2">
      <label htmlFor={id} className="block text-sm font-semibold">{applicationLabels[key]}{['location', 'jobUrl', 'notes'].includes(key) ? ' (optional)' : ''}</label>
      {key === 'status' ? <select {...common}>{applicationStatusSchema.options.map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}</select>
        : key === 'notes' ? <textarea {...common} rows={5} />
        : <input {...common} type={key === 'applicationDate' ? 'date' : key === 'jobUrl' ? 'url' : 'text'}
          required={key === 'company' || key === 'jobTitle' || (key === 'applicationDate' && draft.status !== 'SAVED')} />}
      {key === 'applicationDate' && <p id={`${prefix}-date-hint`} className="text-xs leading-5 text-muted-foreground">Optional for Saved; required for every other status. Future dates cannot be saved.</p>}
      {error && <p id={`${id}-error`} className="text-sm font-medium">{error}</p>}
    </div>;
  });
}
