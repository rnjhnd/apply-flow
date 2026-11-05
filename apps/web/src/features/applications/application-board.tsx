import { Button } from '../../components/ui/button';
import { ApplicationFilters } from './application-filters';
import { statusLabel } from './application-field-policy';
import { boardStatuses, type ApplicationBoardController } from './use-application-board';
import type { ApplicationsController } from './use-applications';

export function ApplicationBoard({ controller, applications, onEdit, selectedId, disabled }: {
  controller: ApplicationBoardController; applications: ApplicationsController;
  onEdit: (id: string) => void; selectedId: string | null; disabled: boolean;
}) {
  const coolingDown = controller.retryAt !== 0;
  const complete = boardStatuses.every(status => controller.columns[status].phase === 'excluded'
    || (controller.columns[status].phase === 'ready' && controller.columns[status].nextCursor === null));
  return <section aria-labelledby="applications-heading" className="min-w-0 space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="applications-heading" tabIndex={-1} className="font-heading text-2xl font-semibold outline-offset-4 focus-visible:outline-2">Application board</h2>
      <Button variant="outline" disabled={disabled || coolingDown || !controller.available} onClick={controller.refresh}>Refresh board</Button>
    </div>
    <ApplicationFilters controller={applications} disabled={disabled} />
    <p id="board-reading-hint" className="text-sm leading-6 text-muted-foreground">Active applications, grouped by status. Each column loads separately in creation order; shown counts are not totals. Open an application to edit its status.</p>
    {selectedId && complete && !boardStatuses.some(status => controller.columns[status].items.some(row => row.id === selectedId))
      && <p className="text-sm text-muted-foreground">Your selected application is not in the current results. Its editor and draft remain open.</p>}
    <div id="application-board-scroll" role="region" aria-label="Application status columns" aria-describedby="board-reading-hint" tabIndex={0}
      className="grid min-w-0 gap-6 outline-offset-4 focus-visible:outline-2 lg:flex lg:overflow-x-auto lg:pb-4">
      {boardStatuses.map(status => {
        const column = controller.columns[status], label = statusLabel(status);
        return <section key={status} aria-labelledby={`board-column-${status}`} className="min-w-0 space-y-4 border-t-2 border-primary bg-surface p-4 lg:w-72 lg:shrink-0">
          <h3 id={`board-column-${status}`} className="font-heading text-lg font-semibold">{label}</h3>
          {column.phase === 'excluded' ? <p className="text-sm leading-6 text-muted-foreground">Not included by the current status filter.</p> : <>
            {column.phase === 'unloaded' && <p className="text-sm text-muted-foreground">Not loaded yet.</p>}
            {column.phase === 'loading' && <p role="status" className="text-sm text-muted-foreground">{column.loadingMore ? `Loading more ${label} applications…` : `Loading ${label} applications…`}</p>}
            {(column.phase === 'ready' || column.items.length > 0) && <p role="status" className="text-xs text-muted-foreground">{column.items.length} shown{column.nextCursor ? '; more available' : ''}.</p>}
            {column.phase === 'ready' && column.items.length === 0 && <p className="text-sm leading-6 text-muted-foreground">{column.nextCursor
              ? 'No applications currently shown. Load more to continue this column.'
              : applications.hasFilters ? 'No matching applications in this column.' : 'No active applications in this status.'}</p>}
            {column.phase === 'error' && <div role="alert" className="space-y-3 text-sm leading-6">
              <p>{column.error?.status === 429 ? 'Too many requests. Wait before retrying.' : column.error?.kind === 'stale'
                ? 'These applications changed between reads. Retry this column to review it.' : 'This column could not be loaded. Your saved changes are unaffected.'}</p>
              <Button variant="outline" disabled={disabled || coolingDown || !controller.available} onClick={() => controller.retry(status)}>Retry {label}</Button>
            </div>}
            <ul className="space-y-3">{column.items.map(row => <li key={row.id} className="border border-border">
              <button id={`edit-application-${row.id}`} type="button" disabled={disabled || !controller.available}
                aria-label={`Edit application: ${row.jobTitle} at ${row.company}`} aria-expanded={selectedId === row.id}
                aria-controls={selectedId === row.id ? 'application-detail-panel' : undefined} onClick={() => onEdit(row.id)}
                className="block w-full space-y-2 p-4 text-left outline-offset-4 focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-60 [overflow-wrap:anywhere]">
                <span className="block font-heading font-semibold">{row.jobTitle}</span><span className="block text-sm font-medium">{row.company}</span>
                {row.location && <span className="block text-sm text-muted-foreground">{row.location}</span>}
                {row.applicationDate && <span className="block text-xs text-muted-foreground">Applied <time dateTime={row.applicationDate}>{row.applicationDate}</time></span>}
              </button>
            </li>)}</ul>
            {column.nextCursor && column.phase !== 'error' && <Button variant="outline" disabled={disabled || coolingDown || !controller.available || column.phase === 'loading'}
              onClick={() => controller.loadMore(status)}>Load more {label} applications</Button>}
          </>}
        </section>;
      })}
    </div>
  </section>;
}
