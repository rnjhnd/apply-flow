import { useLayoutEffect, useRef, useState } from 'react';
import type { Application, CreateApplicationRequest } from '@applyflow/contracts';
import type { AuthStore } from '../../lib/auth/store';
import { ApplicationFailure, type ApplicationsApi } from '../../lib/applications/api';

export type ApplicationDraft = { company: string; jobTitle: string; status: string; applicationDate: string;
  location: string; jobUrl: string; notes: string };
const emptyDraft: ApplicationDraft = { company: '', jobTitle: '', status: 'SAVED', applicationDate: '', location: '', jobUrl: '', notes: '' };
export type ApplicationsView = 'active' | 'archived';

// The page owns drafts and outcomes above temporarily unmounted protected content.
export function useApplications(store: AuthStore, api: Pick<ApplicationsApi, 'create' | 'list'>) {
  const [draft, setDraft] = useState<ApplicationDraft>({ ...emptyDraft });
  const [view, setView] = useState<ApplicationsView>('active');
  const [items, setItems] = useState<Application[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [listError, setListError] = useState(false);
  const [failure, setFailure] = useState<ApplicationFailure | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [time, setTime] = useState(Date.now);
  const lifetime = useRef({ active: false, userId: null as string | null, view: 'active' as ApplicationsView, operation: 0, request: 0,
    saving: false, attempted: false, reading: false, rejectedRead: false, settlingRead: null as number | null, abort: null as AbortController | null });
  useLayoutEffect(() => {
    const owner = { active: true, userId: store.getSnapshot().user?.id ?? null, view: 'active' as ApplicationsView, operation: 0, request: 0,
      saving: false, attempted: false, reading: false, rejectedRead: false, settlingRead: null as number | null, abort: null as AbortController | null };
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
        owner.userId = state.user?.id ?? null; owner.operation++; owner.attempted = owner.rejectedRead; owner.saving = false;
        setDraft({ ...emptyDraft }); setItems([]); setNextCursor(null); setFailure(null); setMessage(null); setSaving(false); setListError(owner.rejectedRead);
      }
      // A coordinated GET owns busy itself. Cancel on proof loss/replacement,
      // not on its own busy notification. No POST is aborted by this controller.
      if (changedUser || (state.busy && !owner.reading) || state.verifiedReadId === null) {
        owner.abort?.abort(); owner.abort = null; owner.request++;
        if (owner.reading) { owner.attempted = owner.rejectedRead; owner.reading = false; setLoading(false); }
      }
    });
    const clock = setInterval(() => setTime(Date.now()), 1000);
    return () => { owner.active = false; owner.abort?.abort(); unsubscribe(); clearInterval(clock); };
  }, [store]);
  function admitted() {
    const state = store.getSnapshot();
    return state.status === 'authenticated' && state.user?.id === lifetime.current.userId && !state.busy && state.verifiedReadId !== null;
  }
  function load(cursor?: string) {
    const owner = lifetime.current;
    if (!owner.active || owner.saving || owner.reading || !admitted() || (failure?.retryAt !== null && failure?.retryAt !== undefined && failure.retryAt > Date.now())) return;
    owner.attempted = true; owner.reading = true; owner.rejectedRead = false;
    const ticket = ++owner.request, requestedView = owner.view;
    owner.settlingRead = ticket;
    const abort = new AbortController(); owner.abort = abort;
    setLoading(true); setListError(false);
    const current = () => owner.active && lifetime.current === owner && ticket === owner.request && owner.view === requestedView;
    void api.list({ ...(cursor ? { cursor } : {}), ...(requestedView === 'archived' ? { view: requestedView } : {}) }, abort.signal).then(result => {
      if (!current() || !admitted()) return;
      setItems(previous => [...new Map((cursor ? [...previous, ...result.items] : result.items).map(item => [item.id, item])).values()]);
      setNextCursor(result.nextCursor);
    }).catch(error => { if (current()) {
      setListError(true);
      if (error instanceof ApplicationFailure && [401, 403].includes(error.status)) { owner.rejectedRead = true; setItems([]); setNextCursor(null); }
      if (error instanceof ApplicationFailure && error.status === 429) setFailure(error);
    } })
      .finally(() => {
        if (owner.settlingRead === ticket) owner.settlingRead = null;
        if (current()) { owner.reading = false; owner.abort = null; setLoading(false); }
      });
  }
  function enter() { if (!lifetime.current.attempted && !lifetime.current.rejectedRead) load(); }
  function save(input: CreateApplicationRequest, canSubmit: () => boolean) {
    const owner = lifetime.current;
    if (!owner.active || owner.saving || owner.view !== 'active' || !admitted() || !canSubmit() || (failure?.retryAt !== null && failure?.retryAt !== undefined && failure.retryAt > Date.now())) return;
    owner.saving = true;
    const ticket = ++owner.operation;
    setSaving(true); setFailure(null); setMessage(null);
    const current = () => owner.active && lifetime.current === owner && ticket === owner.operation;
    void api.create(input).then(() => {
      if (!current()) return;
      if (!admitted()) { setFailure(new ApplicationFailure('unknown')); return; }
      setDraft({ ...emptyDraft }); setMessage('Application saved.');
      owner.saving = false; owner.attempted = true;
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
    owner.abort?.abort(); owner.abort = null; owner.request++; owner.reading = false; owner.settlingRead = null;
    owner.view = next; owner.attempted = false; owner.rejectedRead = false;
    setView(next); setItems([]); setNextCursor(null); setListError(false); setMessage(null); setLoading(false);
    load();
  }
  return { draft, setDraft, view, switchView, items, nextCursor, loading, saving, listError, failure, message, enter, save,
    removeItem: (id: string) => { if (admitted()) { setItems(previous => previous.filter(item => item.id !== id)); setMessage('Application permanently deleted.'); } },
    replaceItem: (application: Application, lifecycle?: 'archive' | 'restore') => {
      if (!admitted()) return;
      const visible = (application.archivedAt === null) === (lifetime.current.view === 'active');
      setItems(previous => visible ? previous.map(item => item.id === application.id ? application : item) : previous.filter(item => item.id !== application.id));
      if (!visible || lifecycle) setMessage(application.archivedAt ? 'Application archived. Its details and history are preserved.'
        : lifetime.current.view === 'archived' ? 'Application restored. Refresh Active applications to see it in its original order.'
        : 'Application restored. Its original creation order is preserved.');
    },
    cooldown: failure?.retryAt ? Math.max(0, Math.ceil((failure.retryAt - time) / 1000)) : 0,
    refresh: () => load(), loadMore: () => { if (nextCursor) load(nextCursor); } };
}
export type ApplicationsController = ReturnType<typeof useApplications>;
