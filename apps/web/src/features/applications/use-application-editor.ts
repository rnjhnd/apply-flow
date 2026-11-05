import { useContext, useLayoutEffect, useRef, useState, type SetStateAction } from 'react';
import type { Application, ApplicationStatusHistory, UpdateApplicationRequest } from '@applyflow/contracts';
import type { AuthStore } from '../../lib/auth/store';
import { ApplicationFailure, type ApplicationsApi } from '../../lib/applications/api';
import type { ApplicationDraft } from './use-applications';
import { WorkspaceNavigationContext } from './workspace-navigation-context';

function draftOf(row: Application): ApplicationDraft {
  return { company: row.company, jobTitle: row.jobTitle, status: row.status, applicationDate: row.applicationDate ?? '',
    location: row.location ?? '', jobUrl: row.jobUrl ?? '', notes: row.notes ?? '' };
}
type EditorState = { selectedId: string | null; application: Application | null; draft: ApplicationDraft | null;
  loading: boolean; saving: boolean; detailError: 'load' | 'review' | 'unavailable' | null; failure: ApplicationFailure | null;
  mutationKind: 'save' | 'archive' | 'restore' | 'delete' | null; deleteConfirm: boolean;
  recovery: 'conflict' | 'unknown' | null; review: Application | null; notice: string | null;
  history: ApplicationStatusHistory[]; historyCursor: string | null; historyLoading: boolean; historyError: boolean; historyRetryCursor: string | null;
  focusTarget: string | null };
const empty = (): EditorState => ({ selectedId: null, application: null, draft: null, loading: false, saving: false,
  detailError: null, failure: null, recovery: null, review: null, notice: null, mutationKind: null, deleteConfirm: false, history: [], historyCursor: null,
  historyLoading: false, historyError: false, historyRetryCursor: null, focusTarget: null });

// Lives above AuthRoute's temporary unmounts. Drafts stay in memory only and are
// never persisted to browser storage or transferred to another account.
export function useApplicationEditor(store: AuthStore, api: ApplicationsApi, onSaved: (row: Application, lifecycle?: 'archive' | 'restore', previous?: Application) => void, onDeleted?: (id: string) => void) {
  const [state, setState] = useState(empty);
  const navigation = useContext(WorkspaceNavigationContext);
  const lifetime = useRef({ active: false, userId: null as string | null, selectedId: null as string | null,
    selection: 0, read: 0, mutation: 0, reading: null as 'load' | 'review' | 'history' | null,
    saving: false, abort: null as AbortController | null });
  useLayoutEffect(() => {
    const owner = { active: true, userId: store.getSnapshot().user?.id ?? null, selectedId: null as string | null,
      selection: 0, read: 0, mutation: 0, reading: null as 'load' | 'review' | 'history' | null,
      saving: false, abort: null as AbortController | null };
    lifetime.current = owner;
    const unsubscribe = store.subscribe(() => {
      const auth = store.getSnapshot();
      if (auth.status === 'anonymous' || (auth.status === 'authenticated' && auth.user?.id !== owner.userId)) {
        owner.userId = auth.user?.id ?? null; owner.selectedId = null; owner.selection++; owner.mutation++;
        owner.abort?.abort(); owner.abort = null; owner.read++; owner.reading = null; owner.saving = false;
        setState(empty());
      } else if (auth.verifiedReadId === null || (auth.busy && !owner.reading && !owner.saving)) {
        const interrupted = owner.reading;
        owner.abort?.abort(); owner.abort = null; owner.read++; owner.reading = null;
        if (interrupted) setState(previous => ({ ...previous, loading: false, historyLoading: false,
          ...(interrupted === 'history' ? { historyError: true } : { detailError: interrupted }) }));
      }
    });
    return () => { owner.active = false; owner.abort?.abort(); unsubscribe(); };
  }, [store]);
  function admitted() {
    const auth = store.getSnapshot();
    return auth.status === 'authenticated' && auth.user?.id === lifetime.current.userId && !auth.busy
      && auth.verifiedReadId !== null && (auth.retryAt === null || auth.retryAt <= Date.now());
  }
  const dirty = !!state.application && !!state.draft && JSON.stringify(state.draft) !== JSON.stringify(draftOf(state.application));
  const guardedDraft = dirty || state.recovery !== null || state.saving;
  useLayoutEffect(() => {
    const message = 'Leave this workspace and discard your draft? An earlier operation may already have succeeded.';
    return navigation?.register({ dirty: guardedDraft, confirm: () => window.confirm(message) });
  }, [guardedDraft, navigation]);
  function consent() {
    return !(dirty || state.recovery) || window.confirm(state.recovery === 'unknown'
      ? 'Discard this draft? An earlier operation may already have succeeded. Review the saved application before making further changes.'
      : 'Discard your unsaved application changes?');
  }
  function beginRead(kind: 'load' | 'review' | 'history') {
    const owner = lifetime.current;
    if (!owner.active || !owner.selectedId || owner.saving || owner.reading || !admitted()) return null;
    if (state.failure?.retryAt && state.failure.retryAt > Date.now()) return null;
    owner.reading = kind;
    const ticket = ++owner.read, selection = owner.selection, id = owner.selectedId;
    const abort = new AbortController(); owner.abort = abort;
    return { id, signal: abort.signal, current: () => owner.active && lifetime.current === owner && owner.selection === selection && owner.read === ticket,
      finish: () => { if (owner.read === ticket) { owner.reading = null; owner.abort = null; } } };
  }
  async function history(append = false, cursor: string | null = null, focus = false) {
    if (append && !cursor) return;
    const read = beginRead('history'); if (!read) return;
    setState(previous => ({ ...previous, historyLoading: true, historyError: false, historyRetryCursor: append ? cursor : null,
      ...(focus ? { focusTarget: 'application-history-heading' } : {}) }));
    try {
      const result = await api.history(read.id, append ? { cursor } : {}, read.signal);
      if (!read.current() || !admitted()) return;
      setState(previous => ({ ...previous,
        history: [...new Map((append ? [...previous.history, ...result.items] : result.items).map(item => [item.id, item])).values()]
          .sort((a,b) => b.applicationVersion - a.applicationVersion), historyCursor: result.nextCursor, historyRetryCursor: null }));
    } catch { if (read.current()) setState(previous => ({ ...previous, historyError: true })); }
    finally { if (read.current()) setState(previous => ({ ...previous, historyLoading: false })); read.finish(); }
  }
  async function details(review = false) {
    const read = beginRead(review ? 'review' : 'load'); if (!read) return;
    let loaded = false;
    setState(previous => ({ ...previous, loading: true, detailError: null }));
    try {
      const { application } = await api.get(read.id, read.signal);
      if (!read.current() || !admitted()) return;
      loaded = true;
      setState(previous => review ? { ...previous, review: application, focusTarget: 'application-saved-review' }
        : { ...previous, application, draft: draftOf(application), recovery: null, review: null, failure: null, notice: null, mutationKind: null, deleteConfirm: false,
          history: [], historyCursor: null, historyError: false, focusTarget: 'application-editor-heading' });
    } catch (error) { if (read.current()) setState(previous => ({ ...previous,
      detailError: error instanceof ApplicationFailure && error.status === 404 ? 'unavailable' : review ? 'review' : 'load', focusTarget: 'application-detail-error' })); }
    finally { if (read.current()) setState(previous => ({ ...previous, loading: false })); read.finish(); }
    if (loaded && !review && read.current()) void history();
  }
  function open(id: string) {
    const owner = lifetime.current;
    if (!owner.active || owner.saving || !admitted()) return;
    if (owner.selectedId === id && state.application) { setState(previous => ({ ...previous, focusTarget: 'application-editor-heading' })); return; }
    if (!consent()) return;
    owner.abort?.abort(); owner.read++; owner.reading = null; owner.selectedId = id; owner.selection++;
    setState({ ...empty(), selectedId: id, focusTarget: 'application-editor-heading' }); void details();
  }
  function close(restoreFocus = true) {
    const owner = lifetime.current;
    if (owner.saving || !admitted() || !consent()) return false;
    const id = owner.selectedId;
    owner.abort?.abort(); owner.read++; owner.reading = null; owner.selectedId = null; owner.selection++;
    setState({ ...empty(), focusTarget: restoreFocus ? `edit-application-${id}` : null });
    return true;
  }
  function setDraft(value: SetStateAction<ApplicationDraft>) {
    if (state.selectedId !== lifetime.current.selectedId || lifetime.current.saving || state.recovery || state.deleteConfirm || state.application?.archivedAt || !admitted()) return;
    setState(previous => previous.draft ? { ...previous, draft: typeof value === 'function' ? value(previous.draft) : value, notice: null } : previous);
  }
  function save(input: UpdateApplicationRequest, canSubmit: () => boolean) {
    const owner = lifetime.current;
    if (!owner.active || !owner.selectedId || owner.saving || owner.reading || !state.application || state.application.id !== owner.selectedId || state.application.archivedAt || state.deleteConfirm || state.recovery
      || !admitted() || !canSubmit() || input.expectedVersion !== state.application.version
      || (state.failure?.retryAt && state.failure.retryAt > Date.now())) return;
    const id = owner.selectedId, selection = owner.selection, ticket = ++owner.mutation, previous = state.application;
    owner.saving = true;
    setState(current => ({ ...current, saving: true, mutationKind: 'save', failure: null, notice: null, review: null }));
    const current = () => owner.active && lifetime.current === owner && owner.selection === selection && owner.mutation === ticket;
    let statusChanged = false;
    void api.update(id, input).then(({ application }) => {
      if (!current()) return;
      if (!admitted()) throw new ApplicationFailure('unknown');
      statusChanged = previous.status !== application.status;
      if (previous.company !== application.company || previous.jobTitle !== application.jobTitle || statusChanged) onSaved(application, undefined, previous);
      else onSaved(application);
      setState(value => ({ ...value, application, draft: draftOf(application), recovery: null,
        notice: application.version === previous.version ? 'No changes needed. Your application is up to date.' : 'Changes saved.',
        focusTarget: 'application-edit-feedback', ...(statusChanged ? { history: [], historyCursor: null } : {}) }));
    }).catch(error => {
      if (!current()) return;
      const failure = error instanceof ApplicationFailure ? error : new ApplicationFailure('unknown');
      setState(value => ({ ...value, failure, focusTarget: 'application-edit-feedback',
        recovery: failure.kind === 'unknown' ? 'unknown' : failure.status === 409 && failure.code === 'APPLICATION_CONFLICT' ? 'conflict' : null }));
    }).finally(() => {
      if (!current()) return;
      owner.saving = false; setState(value => ({ ...value, saving: false }));
      if (statusChanged) void history();
    });
  }
  function changeLifecycle(kind: 'archive' | 'restore' | 'delete', canSubmit: () => boolean) {
    const owner = lifetime.current, previous = state.application;
    if (!owner.active || !owner.selectedId || owner.saving || owner.reading || !previous || previous.id !== owner.selectedId || state.recovery
      || !admitted() || !canSubmit() || (state.failure?.retryAt && state.failure.retryAt > Date.now())) return;
    if (kind === 'archive' ? previous.archivedAt !== null : previous.archivedAt === null) return;
    if (state.deleteConfirm && kind !== 'delete') return;
    if (kind === 'delete' && !state.deleteConfirm) return;
    if (kind === 'archive' && !consent()) return;
    const id = owner.selectedId, selection = owner.selection, ticket = ++owner.mutation;
    owner.saving = true;
    setState(value => ({ ...value, saving: true, mutationKind: kind, failure: null, notice: null, review: null }));
    const current = () => owner.active && lifetime.current === owner && owner.selection === selection && owner.mutation === ticket;
    const result = kind === 'delete' ? api.delete(id, { expectedVersion: previous.version, confirmPermanentDeletion: true })
      : api[kind](id, { expectedVersion: previous.version });
    void result.then(response => {
      if (!current()) return;
      if (!admitted()) throw new ApplicationFailure('unknown');
      if ('application' in response) onSaved(response.application, kind === 'delete' ? undefined : kind); else onDeleted?.(response.deletedApplicationId);
      // Confirmed success is the first point at which the draft may be discarded.
      owner.selectedId = null; owner.selection++; owner.saving = false;
      setState({ ...empty(), focusTarget: 'applications-heading' });
    }).catch(error => {
      if (!current()) return;
      const failure = error instanceof ApplicationFailure ? error : new ApplicationFailure('unknown');
      setState(value => ({ ...value, failure, deleteConfirm: false, focusTarget: 'application-edit-feedback',
        recovery: failure.kind === 'unknown' ? 'unknown' : failure.status === 404 || failure.status === 409 ? 'conflict' : null }));
    }).finally(() => { if (current()) { owner.saving = false; setState(value => ({ ...value, saving: false })); } });
  }
  return { ...state, dirty, open, close, setDraft, save, confirmLeave: consent,
    closeForView: () => close(false),
    archive: (canSubmit: () => boolean) => changeLifecycle('archive', canSubmit),
    restore: (canSubmit: () => boolean) => changeLifecycle('restore', canSubmit),
    deletePermanently: (canSubmit: () => boolean) => changeLifecycle('delete', canSubmit),
    requestDeletion: () => {
      if (admitted() && state.application?.id === lifetime.current.selectedId && !lifetime.current.saving && !lifetime.current.reading && !state.recovery && state.application?.archivedAt)
        setState(previous => ({ ...previous, deleteConfirm: true, focusTarget: 'application-delete-cancel' }));
    },
    cancelDeletion: () => { if (!lifetime.current.saving) setState(previous => ({ ...previous, deleteConfirm: false, focusTarget: 'application-delete-action' })); },
    acknowledgeFocus: () => setState(previous => ({ ...previous, focusTarget: null })),
    retryDetails: () => { void details(state.recovery !== null || state.detailError === 'review'); },
    reload: () => { if (!lifetime.current.saving && !lifetime.current.reading && admitted() && consent()) void details(); },
    reviewSaved: () => { void details(true); },
    retryHistory: () => { void history(state.historyRetryCursor !== null, state.historyRetryCursor, true); },
    loadOlder: () => { void history(true, state.historyCursor, true); } };
}
export type ApplicationEditorController = ReturnType<typeof useApplicationEditor>;
