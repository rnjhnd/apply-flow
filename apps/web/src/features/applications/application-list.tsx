import { Button } from '../../components/ui/button';
import type { ApplicationsController } from './use-applications';
import { ApplicationFilters } from './application-filters';

export function ApplicationList({ controller, onEdit, selectedId = null, editBusy = false }: { controller: ApplicationsController;
  onEdit: (id: string) => void; selectedId?: string | null; editBusy?: boolean }) {
  return <section aria-labelledby="applications-heading" className="min-w-0 space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="applications-heading" tabIndex={-1} className="font-heading text-2xl font-semibold outline-offset-4 focus-visible:outline-2">{controller.view === 'archived' ? 'Archived applications' : 'Your applications'}</h2>
      <Button variant="outline" disabled={editBusy || controller.loading || controller.saving || controller.cooldown > 0} onClick={controller.refresh}>Refresh applications</Button>
    </div>
    <ApplicationFilters controller={controller} disabled={editBusy} />
    {controller.loading && <p role="status" className="text-sm text-muted-foreground">{controller.loadingMore ? 'Loading more applications…' : 'Loading applications…'}</p>}
    {!controller.loading && !controller.listError && controller.hasLoaded && <p role="status" className="text-sm text-muted-foreground">Showing {controller.items.length} {controller.items.length === 1 ? 'application' : 'applications'}{controller.nextCursor ? '; more available' : ''}.</p>}
    {selectedId && controller.hasLoaded && !controller.loading && !controller.listError && !controller.nextCursor
      && !controller.items.some(item => item.id === selectedId) && <p className="text-sm text-muted-foreground">Your selected application is not in the current results. Its editor and draft remain open.</p>}
    {controller.listError && <p role="alert" className="text-sm">{controller.loadMoreError ? 'More applications could not be loaded. Use Load more applications to try again.' : 'Applications could not be loaded. Use Refresh applications to try again.'}</p>}
    {controller.hasLoaded && !controller.loading && !controller.listError && controller.items.length === 0 && <div className="space-y-3 border-t border-border py-8">
      <h3 className="font-heading text-xl font-semibold">{controller.hasFilters ? 'No matching applications' : controller.view === 'archived' ? 'Nothing set aside' : 'A place for your next opportunity'}</h3>
      <p className="text-sm leading-7 text-muted-foreground">{controller.hasFilters ? 'Try another search or status, or use Clear filters to see this view without filters.' : controller.view === 'archived' ? 'No archived applications. Your active applications stay in the Active view.' : 'No applications saved yet. Add the first company and role to begin.'}</p>
    </div>}
    <ul className="divide-y divide-border">{controller.items.map(item => <li key={item.id} className="min-w-0 space-y-3 py-6 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1">
        <h3 className="font-heading text-xl font-semibold">{item.jobTitle}</h3><p className="font-medium">{item.company}</p>
      </div><span className="border-l-2 border-accent pl-3 text-sm font-semibold">{item.status.charAt(0) + item.status.slice(1).toLowerCase()}</span></div>
      {(item.location || item.applicationDate) && <p className="text-sm text-muted-foreground">{item.location}{item.location && item.applicationDate ? ' · ' : ''}{item.applicationDate && <>Applied <time dateTime={item.applicationDate}>{item.applicationDate}</time></>}</p>}
      {item.jobUrl && <a href={item.jobUrl} target="_blank" rel="noopener noreferrer" className="inline-block text-sm font-semibold text-primary underline underline-offset-4">View job posting<span className="sr-only"> for {item.company} (opens in a new tab)</span></a>}
      {item.notes && <p className="whitespace-pre-wrap text-sm leading-7 text-muted-foreground">{item.notes}</p>}
      <Button id={`edit-application-${item.id}`} variant="outline" size="sm" disabled={editBusy || controller.saving || controller.loading}
        aria-expanded={selectedId === item.id} aria-controls={selectedId === item.id ? 'application-detail-panel' : undefined}
        aria-label={`${item.archivedAt ? 'View archived application' : 'Edit application'}: ${item.jobTitle} at ${item.company}`} onClick={() => onEdit(item.id)}>{item.archivedAt ? 'View archived application' : 'Edit application'}</Button>
    </li>)}</ul>
    {controller.nextCursor && <Button variant="outline" disabled={editBusy || controller.loading || controller.saving || controller.cooldown > 0} onClick={controller.loadMore}>Load more applications</Button>}
  </section>;
}
