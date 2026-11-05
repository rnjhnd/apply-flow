import { useLayoutEffect, useRef, useState } from 'react';
import { listApplicationsQuerySchema, type Application, type ApplicationStatus, type CreateApplicationRequest } from '@applyflow/contracts';
import type { AuthStore } from '../../lib/auth/store';
import { ApplicationFailure, type ApplicationsApi } from '../../lib/applications/api';

export type ApplicationDraft = { company: string; jobTitle: string; status: string; applicationDate: string;
  location: string; jobUrl: string; notes: string };
const emptyDraft: ApplicationDraft = { company: '', jobTitle: '', status: 'SAVED', applicationDate: '', location: '', jobUrl: '', notes: '' };
export type ApplicationsView = 'active' | 'archived';
export type AppliedApplicationFilters = { q?: string; status?: ApplicationStatus };
export type ApplicationFilterDraft = { q: string; status: '' | ApplicationStatus };
const emptyFilters = () => ({ draft: { q: '', status: '' } as ApplicationFilterDraft, applied: {} as AppliedApplicationFilters, error: false });
const emptyViews = () => ({ active: emptyFilters(), archived: emptyFilters() });
function newLifetime(userId: string | null = null) {
  return { active: true, userId, view: 'active' as ApplicationsView, operation: 0, request: 0,
    saving: false, attempted: false, reading: false, rejectedRead: false, settlingRead: null as number | null,
    abort: null as AbortController | null, filters: emptyViews(), needsRefresh: false,
    collectionEnabled: true, settlement: null as Promise<void> | null };
}

// The page owns drafts and outcomes above temporarily unmounted protected content.
export function useApplications(store: AuthStore, api: Pick<ApplicationsApi, 'create' | 'list'>, onCreated?: (application: Application) => void) {
  const [draft, setDraft] = useState<ApplicationDraft>({ ...emptyDraft });
  const [view, setView] = useState<ApplicationsView>('active');
  const [items, setItems] = useState<Application[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [filters, setFilters] = useState(emptyViews);
  const [focusTarget, setFocusTarget] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [listError, setListError] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const [failure, setFailure] = useState<ApplicationFailure | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [time, setTime] = useState(Date.now);
  const lifetime = useRef(newLifetime());
  useLayoutEffect(() => {
    const owner = newLifetime(store.getSnapshot().user?.id ?? null);
    lifetime.current = owner;
    const unsubscribe = store.subscribe(() => {
      const state = store.getSnapshot();
      const rejected = state.error?.status === 401 || state.error?.status === 403;
      // Rejection may arrive after a broadcast already cancelled presentation.
      // Keep settlement ownership until the read promise finishes, without
      // confusing unrelated logout errors with application-list failures.
      if (owner.settlingRead !== null && rejected && state.verifiedReadId === null) {
        owner.rejectedRead = true; owner.attempted = true;
        setItems([]); setNextCursor(null); setListError(true);
      }
      const changedUser = state.status === 'anonymous' || (state.status === 'authenticated' && state.user?.id !== owner.userId);
      if (changedUser) {
        owner.view = 'active'; setView('active');
        owner.filters = emptyViews(); owner.needsRefresh = false; setFilters(owner.filters); setFocusTarget(null); setHasLoaded(false); setLoadMoreError(false);
        owner.userId = state.user?.id ?? null; owner.operation++; owner.attempted = owner.rejectedRead; owner.saving = false;
        setDraft({ ...emptyDraft }); setItems([]); setNextCursor(null); setFailure(null); setMessage(null); setSaving(false); setListError(owner.rejectedRead);
      }
      // A coordinated GET owns busy itself. Cancel on proof loss/replacement,
      // not on its own busy notification. No POST is aborted by this controller.
      if (changedUser || (state.busy && !owner.reading) || state.verifiedReadId === null) {
        owner.abort?.abort(); owner.abort = null; owner.request++;
        if (owner.reading) { owner.attempted = owner.rejectedRead; owner.reading = false; setLoading(false); setLoadingMore(false); }
      }
    });
    const clock = setInterval(() => setTime(Date.now()), 1000);
    return () => { owner.active = false; owner.abort?.abort(); unsubscribe(); clearInterval(clock); };
  }, [store]);
  function admitted() {
    const state = store.getSnapshot();
    return state.status === 'authenticated' && state.user?.id === lifetime.current.userId && !state.busy && state.verifiedReadId !== null
      && (state.retryAt === null || state.retryAt <= Date.now());
  }
  function load(cursor?: string) {
    const owner = lifetime.current;
    if (!owner.active || !owner.collectionEnabled || owner.saving || owner.reading || !admitted() || (failure?.retryAt !== null && failure?.retryAt !== undefined && failure.retryAt > Date.now())) return;
    owner.attempted = true; owner.reading = true; owner.rejectedRead = false;
    const ticket = ++owner.request, requestedView = owner.view, requestedUser = owner.userId, applied = owner.filters[requestedView].applied;
    owner.settlingRead = ticket;
    const abort = new AbortController(); owner.abort = abort;
    setLoading(true); setLoadingMore(!!cursor); setListError(false); setLoadMoreError(false);
    if (!cursor) { setItems([]); setNextCursor(null); setHasLoaded(false); }
    const current = () => owner.active && lifetime.current === owner && ticket === owner.request && owner.view === requestedView
      && owner.userId === requestedUser && owner.filters[requestedView].applied === applied;
    const settlement = api.list({ ...applied, ...(cursor ? { cursor } : {}), ...(requestedView === 'archived' ? { view: requestedView } : {}) }, abort.signal).then(result => {
      if (!current() || !admitted()) return;
      setItems(previous => [...new Map((cursor ? [...previous, ...result.items] : result.items).map(item => [item.id, item])).values()]);
      setNextCursor(result.nextCursor);
      setHasLoaded(true);
    }).catch(error => { if (current()) {
      setListError(true); setLoadMoreError(!!cursor);
      if (error instanceof ApplicationFailure && [401, 403].includes(error.status)) { owner.rejectedRead = true; setItems([]); setNextCursor(null); setLoadMoreError(false); }
      if (error instanceof ApplicationFailure && error.status === 429) setFailure(error);
    } })
      .finally(() => {
        if (owner.settlement === settlement) owner.settlement = null;
        if (owner.settlingRead === ticket) owner.settlingRead = null;
        if (current()) { owner.reading = false; owner.abort = null; setLoading(false); setLoadingMore(false); }
      });
    owner.settlement = settlement;
  }
  function enter(allowRead = true) {
    const owner = lifetime.current;
    if (!allowRead || !admitted() || owner.reading || owner.saving) return;
    if (owner.needsRefresh) { owner.needsRefresh = false; load(); }
    else if (!owner.attempted && !owner.rejectedRead) load();
  }
  function cancelRead() {
    const owner = lifetime.current;
    owner.abort?.abort(); owner.abort = null; owner.request++; owner.reading = false; owner.settlingRead = null;
    setLoading(false); setLoadingMore(false);
  }
  function setFilterDraft(draft: ApplicationFilterDraft) {
    const owner = lifetime.current;
    if (!owner.active || owner.saving || !admitted()) return;
    owner.filters = { ...owner.filters, [owner.view]: { ...owner.filters[owner.view], draft, error: false } };
    setFilters(owner.filters);
  }
  function applyFilters(clear = false, focus?: string) {
    const owner = lifetime.current;
    if (!owner.active || owner.saving || !admitted() || (failure?.retryAt && failure.retryAt > Date.now())) return;
    const draft = clear ? emptyFilters().draft : owner.filters[owner.view].draft;
    const parsed = listApplicationsQuerySchema.safeParse({ q: draft.q, ...(draft.status ? { status: draft.status } : {}) });
    if (!parsed.success) {
      owner.filters = { ...owner.filters, [owner.view]: { ...owner.filters[owner.view], error: true } };
      setFilters(owner.filters); setFocusTarget('application-search-q'); return;
    }
    const applied: AppliedApplicationFilters = { ...(parsed.data.q ? { q: parsed.data.q } : {}), ...(parsed.data.status ? { status: parsed.data.status } : {}) };
    owner.filters = { ...owner.filters, [owner.view]: { applied, draft: { q: applied.q ?? '', status: applied.status ?? '' }, error: false } };
    setFilters(owner.filters); owner.needsRefresh = false;
    cancelRead(); setMessage(null); setFocusTarget(focus ?? null); load();
  }
  function save(input: CreateApplicationRequest, canSubmit: () => boolean) {
    const owner = lifetime.current;
    if (!owner.active || owner.saving || owner.view !== 'active' || !admitted() || !canSubmit() || (failure?.retryAt !== null && failure?.retryAt !== undefined && failure.retryAt > Date.now())) return;
    owner.saving = true;
    const ticket = ++owner.operation;
    setSaving(true); setFailure(null); setMessage(null);
    const current = () => owner.active && lifetime.current === owner && ticket === owner.operation;
    void api.create(input).then(({ application }) => {
      if (!current()) return;
      if (!admitted()) { setFailure(new ApplicationFailure('unknown')); return; }
      setDraft({ ...emptyDraft }); setMessage(Object.keys(owner.filters[owner.view].applied).length
        ? 'Application saved. Your filters are still applied; the new application may not appear in these results.' : 'Application saved.');
      owner.saving = false; owner.attempted = true;
      onCreated?.(application);
      load();
    }).catch(error => {
      if (current()) {
        setFailure(error instanceof ApplicationFailure ? error : new ApplicationFailure('unknown'));
        // A remount is not permission to retry or infer an ambiguous create outcome.
        owner.attempted = true;
      }
    }).finally(() => { if (current()) { owner.saving = false; setSaving(false); } });
  }
  function switchView(next: ApplicationsView) {
    const owner = lifetime.current;
    if (!owner.active || owner.saving || !admitted() || next === owner.view) return;
    cancelRead(); owner.needsRefresh = false; setFocusTarget(null);
    owner.view = next; owner.attempted = false; owner.rejectedRead = false;
    setView(next); setItems([]); setNextCursor(null); setHasLoaded(false); setListError(false); setLoadMoreError(false); setMessage(null); setLoading(false);
    load();
  }
  const currentFilters = filters[view], hasFilters = !!(currentFilters.applied.q || currentFilters.applied.status);
  return { draft, setDraft, view, switchView, items, nextCursor, loading, loadingMore, hasLoaded, saving, listError, loadMoreError, failure, message, enter, save,
    activeFilters: filters.active,
    settleCollectionRead: () => lifetime.current.settlement ?? Promise.resolve(),
    hasPendingCollectionRead: () => lifetime.current.settlement !== null,
    // Future presentation integration awaits this before admitting Board/editor
    // reads. Abort alone does not release AuthStore's authenticated request lock.
    setCollectionEnabled: async (enabled: boolean) => {
      const owner = lifetime.current;
      if (owner.collectionEnabled === enabled) { if (!enabled) await owner.settlement; return; }
      owner.collectionEnabled = enabled;
      cancelRead(); owner.attempted = false;
      setItems([]); setNextCursor(null); setHasLoaded(false); setListError(false); setLoadMoreError(false);
      await owner.settlement;
    },
    filterDraft: currentFilters.draft, appliedFilters: currentFilters.applied, filterError: currentFilters.error, hasFilters,
    filtersChanged: currentFilters.draft.q !== (currentFilters.applied.q ?? '') || currentFilters.draft.status !== (currentFilters.applied.status ?? ''),
    setFilterDraft, applyFilters: (focus?: string) => applyFilters(false, focus), clearFilters: (focus?: string) => applyFilters(true, focus),
    focusTarget, acknowledgeFilterFocus: () => setFocusTarget(null),
    removeItem: (id: string) => { if (admitted()) { setItems(previous => previous.filter(item => item.id !== id)); setMessage('Application permanently deleted.'); } },
    replaceItem: (application: Application, lifecycle?: 'archive' | 'restore', previous?: Application) => {
      if (!admitted()) return;
      const visible = (application.archivedAt === null) === (lifetime.current.view === 'active');
      setItems(previous => visible ? previous.map(item => item.id === application.id ? application : item) : previous.filter(item => item.id !== application.id));
      // Queue a read only after the editor's save/history lifecycle settles.
      if (!lifecycle && previous && (previous.company !== application.company || previous.jobTitle !== application.jobTitle || previous.status !== application.status)) {
        lifetime.current.needsRefresh = true;
      }
      if (!visible || lifecycle) setMessage(application.archivedAt ? 'Application archived. Its details and history are preserved.'
        : lifetime.current.view === 'archived' ? 'Application restored. Refresh Active applications to see it in its original order.'
        : 'Application restored. Its original creation order is preserved.');
    },
    cooldown: failure?.retryAt ? Math.max(0, Math.ceil((failure.retryAt - time) / 1000)) : 0,
    refresh: () => load(), loadMore: () => { if (nextCursor) load(nextCursor); } };
}
export type ApplicationsController = ReturnType<typeof useApplications>;
