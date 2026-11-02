import { Button } from '../../components/ui/button';
import type { ApplicationsController } from './use-applications';

export function ApplicationList({ controller, onEdit, selectedId = null, editBusy = false }: { controller: ApplicationsController;
  onEdit: (id: string) => void; selectedId?: string | null; editBusy?: boolean }) {
  return <section aria-labelledby="applications-heading" className="min-w-0 space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 id="applications-heading" tabIndex={-1} className="font-heading text-2xl font-semibold outline-offset-4 focus-visible:outline-2">Your applications</h2>
      <Button variant="outline" disabled={editBusy || controller.loading || controller.saving || controller.cooldown > 0} onClick={controller.refresh}>Refresh applications</Button>
    </div>
    {controller.loading && <p role="status" className="text-sm text-muted-foreground">Loading applications…</p>}
    {controller.listError && <p role="alert" className="text-sm">Applications could not be loaded. Use Refresh applications to try again.</p>}
    {!controller.loading && !controller.listError && controller.items.length === 0 && <div className="space-y-3 border-t border-border py-8">
      <h3 className="font-heading text-xl font-semibold">A place for your next opportunity</h3>
      <p className="text-sm leading-7 text-muted-foreground">No applications saved yet. Add the first company and role to begin.</p>
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
        aria-label={`Edit application: ${item.jobTitle} at ${item.company}`} onClick={() => onEdit(item.id)}>Edit application</Button>
    </li>)}</ul>
    {controller.nextCursor && <Button variant="outline" disabled={editBusy || controller.loading || controller.saving || controller.cooldown > 0} onClick={controller.loadMore}>Load more applications</Button>}
  </section>;
}
