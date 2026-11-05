import { useEffect } from 'react';
import { applicationStatusSchema } from '@applyflow/contracts';
import { Button } from '../../components/ui/button';
import { fieldClass } from '../auth/password-field';
import { statusLabel } from './application-field-policy';
import type { ApplicationsController, ApplicationFilterDraft } from './use-applications';

export function ApplicationFilters({ controller, disabled }: { controller: ApplicationsController; disabled: boolean }) {
  const target = controller.focusTarget, acknowledge = controller.acknowledgeFilterFocus;
  useEffect(() => {
    if (!target || controller.loading) return;
    const element = document.getElementById(target);
    // A coordinated read may unmount protected content. Restore only an explicit
    // search action's lost focus; never displace the editor or another control.
    if (element && (document.activeElement === document.body || controller.filterError)) element.focus();
    acknowledge();
  }, [target, controller.loading, controller.filterError, acknowledge]);
  function focusIntent() {
    const id = document.activeElement?.id;
    return id?.startsWith('application-search-') ? id : undefined;
  }
  const applied = controller.appliedFilters;
  return <form role="search" aria-label="Search applications" noValidate className="space-y-4 border-y border-border py-5"
    onSubmit={event => {
      event.preventDefault(); if (disabled) return;
      const data = new FormData(event.currentTarget);
      controller.setFilterDraft({ q: String(data.get('q') ?? ''), status: String(data.get('status') ?? '') as ApplicationFilterDraft['status'] });
      controller.applyFilters(focusIntent());
    }}>
    <fieldset disabled={disabled || controller.saving || controller.cooldown > 0} className="min-w-0 space-y-4 border-0 p-0">
      <legend className="sr-only">Find an application in this view</legend>
      <div className="grid min-w-0 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,0.7fr)]">
        <div className="min-w-0 space-y-2">
          <label htmlFor="application-search-q" className="block text-sm font-semibold">Search company or job title</label>
          <input id="application-search-q" name="q" type="search" className={fieldClass} value={controller.filterDraft.q}
            aria-describedby={controller.filterError ? 'application-search-error' : 'application-search-hint'}
            aria-invalid={controller.filterError || undefined}
            onChange={event => controller.setFilterDraft({ ...controller.filterDraft, q: event.target.value })} />
        </div>
        <div className="min-w-0 space-y-2">
          <label htmlFor="application-search-status" className="block text-sm font-semibold">Filter by status</label>
          <select id="application-search-status" name="status" className={fieldClass} value={controller.filterDraft.status}
            onChange={event => controller.setFilterDraft({ ...controller.filterDraft, status: event.target.value as ApplicationFilterDraft['status'] })}>
            <option value="">All statuses</option>
            {applicationStatusSchema.options.map(status => <option key={status} value={status}>{statusLabel(status)}</option>)}
          </select>
        </div>
      </div>
      <p id="application-search-hint" className="text-xs leading-5 text-muted-foreground">Search a phrase, then press Enter or Search. Your open application and draft stay here.</p>
      {controller.filterError && <p id="application-search-error" role="alert" className="text-sm">Use at most 200 valid Unicode characters without NUL and one listed status. No search was sent.</p>}
      <div className="flex flex-wrap gap-3">
        <Button id="application-search-submit" type="submit">Search</Button>
        <Button id="application-search-clear" type="button" variant="outline" onClick={() => controller.clearFilters(focusIntent())}>Clear filters</Button>
      </div>
    </fieldset>
    <p className="text-sm leading-6 text-muted-foreground [overflow-wrap:anywhere]">
      Applied to {controller.view === 'active' ? 'Active' : 'Archived'}: {applied.q ? `“${applied.q}”` : 'Any company or job title'} · {applied.status ? statusLabel(applied.status) : 'All statuses'}.
      {controller.filtersChanged && <span className="block font-medium text-foreground">Filter changes have not been applied. Press Search to update results.</span>}
    </p>
  </form>;
}
