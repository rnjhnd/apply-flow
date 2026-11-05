import { useLayoutEffect, useState, useSyncExternalStore } from 'react';
import { applicationStatusSchema, listApplicationsQuerySchema, listApplicationsResponseSchema, type Application, type ApplicationStatus } from '@applyflow/contracts';
import type { AuthStore } from '../../lib/auth/store';
import { ApplicationFailure, type ApplicationsApi } from '../../lib/applications/api';
import type { AppliedApplicationFilters } from './use-applications';

export const boardStatuses = applicationStatusSchema.options;
export type BoardColumn = {
  items: Application[]; nextCursor: string | null;
  phase: 'unloaded' | 'loading' | 'ready' | 'error' | 'excluded';
  loadingMore: boolean; error: ApplicationFailure | null;
};
type Columns = Record<ApplicationStatus, BoardColumn>;
type Job = { status: ApplicationStatus; cursor?: string; review?: boolean };
type Flight = { job: Job; generation: number; abort: AbortController; settled: Promise<void>; obsolete: boolean };
const mapColumns = (make: (status: ApplicationStatus) => BoardColumn): Columns => ({ SAVED: make('SAVED'), APPLIED: make('APPLIED'),
  ASSESSMENT: make('ASSESSMENT'), INTERVIEW: make('INTERVIEW'), OFFER: make('OFFER'), REJECTED: make('REJECTED'), WITHDRAWN: make('WITHDRAWN') });
const columnsFor = (filters: AppliedApplicationFilters): Columns => mapColumns(status => ({ items: [], nextCursor: null,
  phase: filters.status && filters.status !== status ? 'excluded' : 'unloaded', loadingMore: false, error: null }));

// Feature-local scheduling only. Every actual request still uses ApplicationsApi
// and its existing AuthStore lock/verification path. No auth capability is cached.
function createBoard(store: AuthStore, api: Pick<ApplicationsApi, 'list'>) {
  let active = false, enabled = false, blocked = true, generation = 0, accountGeneration = 0;
  let userId: string | null = null, filters: AppliedApplicationFilters = {};
  let columns = columnsFor(filters), queue: Job[] = [], flight: Flight | null = null;
  let retryAt = 0, scheduled = false;
  const observed = new Map<string, Application>();
  const minimumVersions = new Map<string, number>();
  const disagreements = new Map<string, Set<ApplicationStatus>>();
  const deleted = new Set<string>();
  const listeners = new Set<() => void>();
  let snapshot = { columns, available: false, enabled, blocked, retryAt, accountGeneration };
  function admitted() {
    const auth = store.getSnapshot();
    return active && auth.status === 'authenticated' && auth.user?.id === userId && !auth.busy && auth.verifiedReadId !== null
      && (auth.retryAt === null || auth.retryAt <= Date.now());
  }
  function publish() {
    const auth = store.getSnapshot();
    const available = active && auth.status === 'authenticated' && auth.user?.id === userId && auth.verifiedReadId !== null;
    const hidden = mapColumns(status => ({ ...columns[status], items: [], nextCursor: null }));
    snapshot = { columns: available ? columns : hidden, available, enabled, blocked, retryAt, accountGeneration };
    listeners.forEach(listener => listener());
  }
  function enqueue(job: Job) {
    if (columns[job.status].phase !== 'excluded' && !queue.some(entry => entry.status === job.status)) queue.push(job);
  }
  function obsolete() {
    generation++;
    if (flight) { flight.obsolete = true; flight.abort.abort(); }
  }
  function invalidate(statuses: readonly ApplicationStatus[]) {
    const interrupted = flight && !flight.obsolete ? flight.job : null;
    obsolete();
    queue = queue.filter(job => !statuses.includes(job.status));
    columns = { ...columns };
    for (const status of statuses) {
      columns[status] = columnsFor(filters)[status];
      if (enabled) enqueue({ status });
    }
    if (interrupted && !statuses.includes(interrupted.status)) {
      columns[interrupted.status] = { ...columns[interrupted.status], phase: columns[interrupted.status].items.length ? 'ready' : 'unloaded', loadingMore: false };
      enqueue(interrupted);
    }
    publish(); schedule();
  }
  function disputed(statuses: ApplicationStatus[], id: string) {
    observed.delete(id);
    const affected = new Set([...(disagreements.get(id) ?? []), ...statuses]);
    disagreements.set(id, affected);
    for (const status of affected) {
      if (columns[status].phase === 'excluded') continue;
      columns[status] = { ...columns[status], items: columns[status].items.filter(row => row.id !== id), nextCursor: null,
        phase: 'error', loadingMore: false, error: new ApplicationFailure('stale') };
    }
    queue = queue.filter(job => !affected.has(job.status));
  }
  async function run(current: Flight) {
    const { job } = current;
    const valid = () => active && enabled && !current.obsolete && current.generation === generation;
    try {
      const result = listApplicationsResponseSchema.parse(await api.list({ view: 'active', status: job.status, limit: 20,
        ...(filters.q ? { q: filters.q } : {}), ...(job.cursor ? { cursor: job.cursor } : {}) }, current.abort.signal));
      if (!valid() || !admitted()) return;
      if (result.items.length > 20 || result.items.some(row => row.archivedAt !== null || row.status !== job.status)
        || (result.nextCursor !== null && (result.items.length === 0 || result.nextCursor === job.cursor))) throw new ApplicationFailure('unknown');
      columns = { ...columns };
      const accepted: Application[] = [];
      for (const row of result.items) {
        if (disagreements.has(row.id)) {
          if (!job.review) { disputed([job.status], row.id); continue; }
          disagreements.delete(row.id);
        }
        const previous = observed.get(row.id);
        if (previous && previous.status === job.status && previous.archivedAt === null && previous.version > row.version
          && columns[job.status].items.some(item => item.id === row.id)) {
          accepted.push(previous); continue;
        }
        if (deleted.has(row.id) || (minimumVersions.get(row.id) ?? 0) > row.version
          || (previous && (previous.archivedAt !== null || previous.status !== row.status || previous.version > row.version))) {
          disputed(previous ? [job.status, previous.status] : [job.status], row.id);
          continue;
        }
        observed.set(row.id, row); accepted.push(row);
      }
      if (columns[job.status].error) return;
      const rows = new Map((job.cursor ? columns[job.status].items : []).map(row => [row.id, row]));
      for (const row of accepted) {
        const previous = rows.get(row.id);
        if (!previous || previous.version <= row.version) rows.set(row.id, row);
      }
      columns[job.status] = { items: [...rows.values()], nextCursor: result.nextCursor, phase: 'ready', loadingMore: false, error: null };
    } catch (error) {
      if (!valid()) return;
      const failure = error instanceof ApplicationFailure ? error : new ApplicationFailure('unknown');
      retryAt = Math.max(retryAt, failure.retryAt ?? 0);
      columns = { ...columns, [job.status]: { ...columns[job.status], phase: 'error', loadingMore: false, error: failure } };
      if ([401, 403].includes(failure.status)) { queue = []; observed.clear(); columns = columnsFor(filters); }
    } finally {
      if (flight === current) flight = null;
      publish(); schedule();
    }
  }
  function schedule() {
    if (scheduled || !active) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (!active || !enabled || blocked || flight || !admitted() || retryAt > Date.now()) return;
      const job = queue.shift(); if (!job) return;
      columns = { ...columns, [job.status]: { ...columns[job.status], phase: 'loading', loadingMore: !!job.cursor, error: null } };
      // Set ownership before AuthStore synchronously publishes its busy state.
      const current: Flight = { job, generation, abort: new AbortController(), settled: Promise.resolve(), obsolete: false };
      flight = current; publish(); current.settled = run(current);
    });
  }
  function notifications() {
    const epoch = accountGeneration, owner = userId;
    const valid = () => active && owner !== null && userId === owner && epoch === accountGeneration;
    return {
      confirmedSaved(row: Application, previous?: Application) {
        if (!valid() || deleted.has(row.id) || Math.max(observed.get(row.id)?.version ?? 0, minimumVersions.get(row.id) ?? 0) > row.version) return;
        const old = previous ?? observed.get(row.id);
        observed.set(row.id, row); minimumVersions.set(row.id, row.version); disagreements.delete(row.id);
        columns = { ...columns };
        if (row.archivedAt !== null) { remove(row.id); return; }
        if (!old || old.status !== row.status || old.company !== row.company || old.jobTitle !== row.jobTitle) {
          // Only server queries establish search membership/destination placement.
          for (const status of boardStatuses) columns[status] = { ...columns[status], items: columns[status].items.filter(item => item.id !== row.id) };
          invalidate([...new Set([row.status, ...(old ? [old.status] : [])])]);
        } else {
          // Cancel older in-flight snapshots without resetting unrelated pages.
          const interrupted = flight && !flight.obsolete ? flight.job : null; obsolete();
          columns = Object.fromEntries(boardStatuses.map(status => [status, { ...columns[status],
            items: columns[status].items.map(item => item.id === row.id ? row : item) }])) as Columns;
          if (interrupted) { columns[interrupted.status] = { ...columns[interrupted.status],
            phase: columns[interrupted.status].items.length ? 'ready' : 'unloaded', loadingMore: false }; enqueue(interrupted); }
          publish(); schedule();
        }
      },
      confirmedCreated(row: Application) { if (valid() && row.archivedAt === null) invalidate([row.status]); },
      confirmedArchived(row: Application) {
        if (valid() && row.archivedAt !== null && row.version >= Math.max(observed.get(row.id)?.version ?? 0, minimumVersions.get(row.id) ?? 0)) {
          observed.set(row.id, row); minimumVersions.set(row.id, row.version); remove(row.id);
        }
      },
      confirmedDeleted(id: string) { if (valid()) { deleted.add(id); observed.delete(id); disagreements.delete(id); remove(id); } }
    };
  }
  function remove(id: string) {
    const interrupted = flight && !flight.obsolete ? flight.job : null; obsolete();
    columns = Object.fromEntries(boardStatuses.map(status => [status, { ...columns[status], items: columns[status].items.filter(row => row.id !== id) }])) as Columns;
    if (interrupted) { columns[interrupted.status] = { ...columns[interrupted.status], phase: columns[interrupted.status].items.length ? 'ready' : 'unloaded', loadingMore: false }; enqueue(interrupted); }
    publish(); schedule();
  }
  return {
    getSnapshot: () => snapshot,
    hasPendingRead: () => flight !== null,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect() {
      active = true; userId = store.getSnapshot().user?.id ?? null;
      const unsubscribe = store.subscribe(() => {
        const auth = store.getSnapshot();
        if (auth.status === 'anonymous' || (auth.status === 'authenticated' && auth.user?.id !== userId)) {
          obsolete(); accountGeneration++; userId = auth.user?.id ?? null; enabled = false; blocked = true;
          queue = []; filters = {}; retryAt = 0; observed.clear(); minimumVersions.clear(); disagreements.clear(); deleted.clear(); columns = columnsFor(filters);
        } else if (flight && !flight.obsolete && !['authenticated', 'initializing'].includes(auth.status)) {
          // Interrupted admission is a failed read, not permission for a loop.
          const status = flight.job.status; obsolete();
          columns = { ...columns, [status]: { ...columns[status], phase: 'error', loadingMore: false, error: new ApplicationFailure('stale') } };
        }
        publish(); schedule();
      });
      const clock = setInterval(() => {
        if (retryAt !== 0 && retryAt <= Date.now()) { retryAt = 0; publish(); }
        schedule();
      }, 1000);
      publish(); schedule();
      return () => { active = false; obsolete(); unsubscribe(); clearInterval(clock); };
    },
    configure(input: { enabled: boolean; filters: AppliedApplicationFilters }) {
      const parsed = listApplicationsQuerySchema.parse(input.filters);
      const next = { ...(parsed.q ? { q: parsed.q } : {}), ...(parsed.status ? { status: parsed.status } : {}) };
      if (enabled === input.enabled && filters.q === next.q && filters.status === next.status) return;
      obsolete(); enabled = input.enabled; filters = next; queue = []; observed.clear(); disagreements.clear(); columns = columnsFor(filters);
      if (enabled) boardStatuses.forEach(status => enqueue({ status }));
      publish(); schedule();
    },
    async pause() {
      blocked = true;
      if (flight && !flight.obsolete) {
        const { job } = flight; obsolete();
        columns = { ...columns, [job.status]: { ...columns[job.status], phase: columns[job.status].items.length ? 'ready' : 'unloaded', loadingMore: false } };
        queue.unshift(job);
      }
      publish(); await flight?.settled;
    },
    resume() { blocked = false; publish(); schedule(); },
    refresh() { if (enabled) { observed.clear(); disagreements.clear(); invalidate(boardStatuses); } },
    loadMore(status: ApplicationStatus) {
      const column = columns[status];
      if (!enabled || column.phase !== 'ready' || !column.nextCursor || flight?.job.status === status) return;
      enqueue({ status, cursor: column.nextCursor }); schedule();
    },
    retry(status: ApplicationStatus) {
      const column = columns[status];
      if (!enabled || column.phase !== 'error' || retryAt > Date.now()) return;
      // Membership disagreement invalidates its cursor; other failed pages keep it.
      enqueue({ status, review: true, ...(column.nextCursor ? { cursor: column.nextCursor } : {}) }); schedule();
    },
    notifications
  };
}

/** Own beside the editor, above AuthRoute. Configure from Active's existing
 * applied filters. Await pause() before editor work; resume only once detail,
 * history and mutation work has settled. No automatic mutation is performed. */
export function useApplicationBoard(store: AuthStore, api: Pick<ApplicationsApi, 'list'>) {
  const [board] = useState(() => createBoard(store, api));
  const state = useSyncExternalStore(board.subscribe, board.getSnapshot);
  useLayoutEffect(() => board.connect(), [board]);
  return { ...state, configure: board.configure, pause: board.pause, resume: board.resume, refresh: board.refresh,
    loadMore: board.loadMore, retry: board.retry, hasPendingRead: board.hasPendingRead, ...board.notifications() };
}
export type ApplicationBoardController = ReturnType<typeof useApplicationBoard>;
