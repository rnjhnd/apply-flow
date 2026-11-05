import { StrictMode, useEffect, useState, useSyncExternalStore } from 'react';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Application, ApplicationStatus } from '@applyflow/contracts';
import { authFixture, deferred, user } from '../../test/auth-fixtures';
import { AuthFailure } from '../../lib/auth/api';
import { createApplicationsApi } from '../../lib/applications/api';
import { boardStatuses, useApplicationBoard } from './use-application-board';
import { useApplications, type AppliedApplicationFilters } from './use-applications';
import { useApplicationEditor } from './use-application-editor';

type Page = { items: Application[]; nextCursor: string | null };
const page = (items: Application[] = [], nextCursor: string | null = null): Page => ({ items, nextCursor });
const row = (number = 1, status: ApplicationStatus = 'SAVED', version = 1): Application => ({
  id: `c4974360-a70c-4a29-8b41-${String(number).padStart(12, '0')}`, company: 'Acme', jobTitle: 'Engineer', status,
  version, archivedAt: null, applicationDate: status === 'SAVED' ? null : '2026-10-20', location: null, jobUrl: null, notes: null,
  createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z'
});
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json', ...headers }
});
const fixtures: ReturnType<typeof authFixture>[] = [];
afterEach(() => { fixtures.splice(0).forEach(f => f.store.dispose()); vi.useRealTimers(); });

async function fixture() {
  const auth = authFixture({ authenticated: true }); fixtures.push(auth); await auth.store.bootstrap();
  let respond: (query: URLSearchParams, signal?: AbortSignal | null, path?: string) => Page | Response | Promise<Page | Response> = () => page();
  let concurrent = 0, maximum = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    concurrent++; maximum = Math.max(maximum, concurrent);
    try {
      const parsed = new URL(String(url), 'http://127.0.0.1');
      const response = await respond(parsed.searchParams, init?.signal, parsed.pathname);
      return response instanceof Response ? response : json(response);
    } finally { concurrent--; }
  });
  const api = createApplicationsApi(auth.store, fetcher, () => Date.now());
  const hook = renderHook(() => useApplicationBoard(auth.store, api), { wrapper: StrictMode });
  const start = async (filters: AppliedApplicationFilters = {}) => {
    await act(async () => { hook.result.current.configure({ enabled: true, filters }); hook.result.current.resume(); });
  };
  return { ...hook, auth, api, fetcher, start, maximum: () => maximum, respond: (next: typeof respond) => { respond = next; },
    queries: () => fetcher.mock.calls.map(([url]) => Object.fromEntries(new URL(String(url), 'http://127.0.0.1').searchParams)) };
}

describe('workspace-owned board scheduling and pagination', () => {
  it('loads seven independent columns sequentially through actual authenticated admission', async () => {
    const f = await fixture();
    f.respond(query => page([row(boardStatuses.indexOf(query.get('status') as ApplicationStatus) + 1, query.get('status') as ApplicationStatus)]));
    await f.start();
    expect(f.queries().map(query => query.status)).toEqual(boardStatuses);
    expect(f.maximum()).toBe(1); expect(f.auth.api.me).toHaveBeenCalledTimes(8); expect(f.auth.api.csrf).toHaveBeenCalledTimes(8);
    for (const status of boardStatuses) expect(f.result.current.columns[status]).toMatchObject({ phase: 'ready', items: [expect.objectContaining({ status })], nextCursor: null });
    expect(f.auth.held()).toBe(0);
  });
  it.each(boardStatuses)('fetches only %s and marks other columns excluded', async status => {
    const f = await fixture(); await f.start({ status, q: '  Acme  ' });
    expect(f.queries()).toEqual([{ limit: '20', status, q: 'Acme' }]);
    for (const other of boardStatuses.filter(value => value !== status)) {
      expect(f.result.current.columns[other].phase).toBe('excluded');
      act(() => { f.result.current.loadMore(other); f.result.current.retry(other); });
    }
    expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('distinguishes unloaded, loading, empty and per-column failure without automatic retry', async () => {
    const f = await fixture(), gate = deferred<Page>();
    act(() => f.result.current.configure({ enabled: true, filters: {} }));
    expect(f.result.current.columns.SAVED.phase).toBe('unloaded'); expect(f.fetcher).not.toHaveBeenCalled();
    f.respond(query => query.get('status') === 'SAVED' ? gate.promise : page());
    act(() => f.result.current.resume());
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    expect(f.result.current.columns.SAVED.phase).toBe('loading'); expect(f.result.current.columns.APPLIED.phase).toBe('unloaded');
    await act(async () => { gate.reject(new Error('private driver error')); });
    expect(f.result.current.columns.SAVED.phase).toBe('error'); expect(f.result.current.columns.APPLIED.phase).toBe('ready');
    expect(f.result.current.columns.APPLIED.items).toEqual([]); expect(f.fetcher).toHaveBeenCalledTimes(7);
    f.respond(() => page([row()]));
    await act(async () => { f.result.current.retry('SAVED'); f.result.current.retry('SAVED'); });
    expect(f.fetcher).toHaveBeenCalledTimes(8); expect(f.result.current.columns.SAVED.items).toEqual([row()]);
  });
  it('pages 51 cards without a fetch-all or 50-record column ceiling', async () => {
    const f = await fixture(); const rows = Array.from({ length: 51 }, (_, i) => row(i + 1));
    f.respond(query => query.get('cursor') === 'last' ? page(rows.slice(40)) : query.get('cursor') === 'middle'
      ? page(rows.slice(20, 40), 'last') : page(rows.slice(0, 20), 'middle'));
    await f.start({ status: 'SAVED' });
    await act(async () => { f.result.current.loadMore('SAVED'); f.result.current.loadMore('SAVED'); });
    await act(async () => { f.result.current.loadMore('SAVED'); });
    expect(f.result.current.columns.SAVED.items).toEqual(rows); expect(f.result.current.columns.SAVED.nextCursor).toBeNull();
    expect(f.queries().map(query => query.cursor)).toEqual([undefined, 'middle', 'last']);
  });
  it('keeps independent cursors, original ordering and duplicate-free pages', async () => {
    const f = await fixture();
    f.respond(query => {
      const status = query.get('status') as ApplicationStatus;
      const number = boardStatuses.indexOf(status) * 10 + 1;
      return query.has('cursor') ? page([row(number, status), row(number + 1, status)]) : page([row(number, status)], `${status}-next`);
    });
    await f.start(); await act(async () => { f.result.current.loadMore('SAVED'); });
    expect(f.result.current.columns.SAVED.items.map(item => item.id)).toEqual([row().id, row(2).id]);
    expect(f.result.current.columns.APPLIED.nextCursor).toBe('APPLIED-next');
    expect(f.queries().at(-1)).toMatchObject({ status: 'SAVED', cursor: 'SAVED-next' });
  });
  it('retries a failed extra page at its original cursor and preserves loaded cards', async () => {
    const f = await fixture(); f.respond(() => page([row()], 'next')); await f.start({ status: 'SAVED' });
    f.respond(() => json({ code: 'SERVICE_UNAVAILABLE', message: 'Unavailable' }, 503));
    await act(async () => { f.result.current.loadMore('SAVED'); });
    expect(f.result.current.columns.SAVED.items).toEqual([row()]); expect(f.result.current.columns.SAVED.phase).toBe('error');
    f.respond(() => page([row(2)])); await act(async () => { f.result.current.retry('SAVED'); });
    expect(f.queries().at(-1)?.cursor).toBe('next'); expect(f.result.current.columns.SAVED.items).toEqual([row(), row(2)]);
  });
  it('respects Retry-After and pauses other queued columns without retrying the failed column', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-05T12:00:00Z')); const f = await fixture();
    f.respond(query => query.get('status') === 'SAVED' ? json({ code: 'RATE_LIMITED', message: 'Wait' }, 429, { 'Retry-After': '2' }) : page());
    await f.start(); expect(f.fetcher).toHaveBeenCalledOnce(); expect(f.result.current.retryAt).toBe(Date.now() + 2000);
    act(() => f.result.current.retry('SAVED')); expect(f.fetcher).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(f.queries().map(query => query.status)).toEqual(boardStatuses); expect(f.result.current.columns.SAVED.phase).toBe('error');
    f.respond(() => page()); await act(async () => { f.result.current.retry('SAVED'); }); expect(f.fetcher).toHaveBeenCalledTimes(8);
  });
  it('full refresh restarts first pages, and repeated configuration does not refetch on remount', async () => {
    const f = await fixture(); await f.start();
    await act(async () => { for (let i = 0; i < 5; i++) { f.result.current.configure({ enabled: true, filters: {} }); f.result.current.resume(); } });
    f.rerender(); expect(f.fetcher).toHaveBeenCalledTimes(7);
    await act(async () => { f.result.current.refresh(); }); expect(f.fetcher).toHaveBeenCalledTimes(14);
    expect(f.queries().every(query => !query.cursor)).toBe(true);
  });
});

describe('board handoffs, filters and account boundaries', () => {
  it('waits for an ignored abort to settle before admitting editor detail/history work', async () => {
    const f = await fixture(), gate = deferred<Page>(); f.respond(() => gate.promise);
    act(() => { f.result.current.configure({ enabled: true, filters: {} }); f.result.current.resume(); });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    let handedOff = false;
    let handoff!: Promise<void>;
    act(() => { handoff = f.result.current.pause().then(() => { handedOff = true; }); });
    expect(f.fetcher.mock.calls[0]![1]?.signal?.aborted).toBe(true); expect(handedOff).toBe(false); expect(f.auth.held()).toBe(1);
    await act(async () => { gate.resolve(page([row()])); await handoff; });
    expect(handedOff).toBe(true); expect(f.auth.held()).toBe(0); expect(f.result.current.columns.SAVED.items).toEqual([]);
    const detail = vi.fn().mockResolvedValue(row());
    await act(async () => { await f.auth.store.authenticatedRequest(detail); });
    expect(detail).toHaveBeenCalledOnce(); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('invalidates filter and presentation work without overlapping an obsolete request', async () => {
    const f = await fixture(), gate = deferred<Page>(); f.respond(() => gate.promise);
    act(() => { f.result.current.configure({ enabled: true, filters: { q: 'old' } }); f.result.current.resume(); });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    act(() => { f.result.current.configure({ enabled: false, filters: {} }); f.result.current.configure({ enabled: true, filters: { q: 'new', status: 'APPLIED' } }); });
    expect(f.fetcher).toHaveBeenCalledOnce(); f.respond(() => page([row(2, 'APPLIED')]));
    await act(async () => { gate.resolve(page([row()], 'old-cursor')); });
    expect(f.queries()).toEqual([{ limit: '20', status: 'SAVED', q: 'old' }, { limit: '20', status: 'APPLIED', q: 'new' }]);
    expect(f.result.current.columns.SAVED.items).toEqual([]); expect(f.result.current.columns.APPLIED.items).toEqual([row(2, 'APPLIED')]);
    expect(f.maximum()).toBe(1);
  });
  it('awaits an obsolete List read before handing the same authenticated transport to Board', async () => {
    const f = await fixture(), gate = deferred<Page>(); f.respond(() => gate.promise);
    const list = renderHook(() => useApplications(f.auth.store, f.api));
    act(() => list.result.current.enter());
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    let transferred = false, handoff!: Promise<void>;
    act(() => { handoff = list.result.current.setCollectionEnabled(false).then(() => { transferred = true; }); });
    expect(transferred).toBe(false); expect(f.auth.held()).toBe(1);
    await act(async () => { gate.resolve(page([row()], 'list-cursor')); await handoff; });
    expect(transferred).toBe(true); expect(list.result.current.items).toEqual([]); expect(list.result.current.nextCursor).toBeNull();
    f.respond(() => page()); await f.start({ status: 'APPLIED' });
    expect(f.queries()).toEqual([{ limit: '20' }, { limit: '20', status: 'APPLIED' }]);
    await act(async () => { f.result.current.configure({ enabled: false, filters: {} }); await list.result.current.setCollectionEnabled(true); list.result.current.enter(); });
    expect(f.queries().at(-1)).toEqual({ limit: '20' }); expect(f.maximum()).toBe(1); list.unmount();
  });
  it('shares Active applied filters while unsubmitted draft and Archived criteria stay independent', async () => {
    const f = await fixture();
    const list = renderHook(() => useApplications(f.auth.store, f.api));
    await act(async () => { await list.result.current.setCollectionEnabled(false); });
    act(() => list.result.current.setFilterDraft({ q: 'Acme', status: 'INTERVIEW' }));
    await act(async () => { f.result.current.configure({ enabled: true, filters: list.result.current.activeFilters.applied }); f.result.current.resume(); });
    expect(f.queries().map(query => query.q)).toEqual(Array(7).fill(undefined));
    await act(async () => { list.result.current.applyFilters(); f.result.current.configure({ enabled: true, filters: list.result.current.activeFilters.applied }); });
    // Read the newly rendered shared snapshot, as future workspace effects will.
    await act(async () => f.result.current.configure({ enabled: true, filters: list.result.current.activeFilters.applied }));
    expect(f.queries().at(-1)).toMatchObject({ q: 'Acme', status: 'INTERVIEW' });
    act(() => list.result.current.setFilterDraft({ q: 'unsubmitted', status: 'SAVED' }));
    await act(async () => f.result.current.configure({ enabled: true, filters: list.result.current.activeFilters.applied }));
    expect(f.fetcher).toHaveBeenCalledTimes(8);
    await act(async () => { list.result.current.switchView('archived'); list.result.current.setFilterDraft({ q: 'Archived', status: 'OFFER' }); list.result.current.applyFilters(); });
    expect(list.result.current.activeFilters.applied).toEqual({ q: 'Acme', status: 'INTERVIEW' });
    await act(async () => { list.result.current.switchView('active'); list.result.current.clearFilters(); });
    await act(async () => f.result.current.configure({ enabled: true, filters: list.result.current.activeFilters.applied }));
    expect(f.fetcher).toHaveBeenCalledTimes(15); list.unmount();
  });
  it('preserves valid same-account data but hides it during unavailable authentication', async () => {
    const f = await fixture(); f.respond(() => page([row()])); await f.start({ status: 'SAVED' });
    await act(async () => { await f.auth.store.revalidate(); });
    expect(f.result.current.columns.SAVED.items).toEqual([row()]); expect(f.fetcher).toHaveBeenCalledOnce();
    act(() => f.auth.notify('suspend'));
    expect(f.result.current.available).toBe(false); expect(f.result.current.columns.SAVED.items).toEqual([]);
    await act(async () => { f.auth.notify('resume'); });
    expect(f.result.current.columns.SAVED.items).toEqual([row()]); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it.each(['logout', 'replace'] as const)('clears private pages and rejects old notifications after %s', async operation => {
    const f = await fixture(); f.respond(() => page([row()])); await f.start({ status: 'SAVED' });
    const old = f.result.current.confirmedCreated;
    await act(async () => {
      if (operation === 'logout') await f.auth.store.logout();
      else { f.auth.api.me.mockResolvedValue({ user: { ...user, id: row(99).id } }); await f.auth.store.revalidate(); }
    });
    expect(f.result.current.enabled).toBe(false); expect(f.result.current.columns.SAVED.items).toEqual([]); expect(f.result.current.columns.SAVED.nextCursor).toBeNull();
    act(() => old(row())); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('rejects a late read when session verification discovers another account', async () => {
    const f = await fixture(), gate = deferred<{ user: typeof user }>();
    f.auth.api.me.mockReturnValueOnce(gate.promise);
    act(() => { f.result.current.configure({ enabled: true, filters: {} }); f.result.current.resume(); });
    await act(async () => { gate.resolve({ user: { ...user, id: row(99).id } }); });
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.result.current.enabled).toBe(false);
  });
  it('stops on rejected session verification without repeatedly retrying admission', async () => {
    const f = await fixture(); f.auth.api.csrf.mockRejectedValueOnce(new AuthFailure('network'));
    await f.start(); expect(f.fetcher).not.toHaveBeenCalled(); expect(f.result.current.available).toBe(false);
    expect(f.result.current.columns.SAVED.phase).toBe('error');
    await act(async () => { await f.auth.store.revalidate(); });
    expect(f.queries().map(query => query.status)).toEqual(boardStatuses.slice(1));
    expect(f.result.current.columns.SAVED.phase).toBe('error');
  });
  it('waits for an existing authentication operation before starting the first board query', async () => {
    const f = await fixture(), gate = deferred<{ user: typeof user }>();
    f.auth.api.me.mockReturnValueOnce(gate.promise);
    let verification!: ReturnType<typeof f.auth.store.revalidate>;
    act(() => { verification = f.auth.store.revalidate(); });
    await act(async () => { f.result.current.configure({ enabled: true, filters: {} }); f.result.current.resume(); });
    expect(f.fetcher).not.toHaveBeenCalled();
    await act(async () => { gate.resolve({ user }); await verification; });
    expect(f.fetcher).toHaveBeenCalledTimes(7); expect(f.maximum()).toBe(1);
  });
  it('keeps data ownership above repeated protected-content remounts', async () => {
    const f = await fixture(); let mounts = 0;
    function ProtectedChild() { useEffect(() => { mounts++; }, []); return null; }
    function ProtectedConsumer() {
      const state = useSyncExternalStore(f.auth.store.subscribe, f.auth.store.getSnapshot);
      return state.status === 'authenticated' && !state.busy && state.verifiedReadId !== null ? <ProtectedChild /> : null;
    }
    const child = render(<ProtectedConsumer />);
    const gates = boardStatuses.map(() => deferred<Page>());
    f.respond(query => gates[boardStatuses.indexOf(query.get('status') as ApplicationStatus)]!.promise);
    act(() => { f.result.current.configure({ enabled: true, filters: {} }); f.result.current.resume(); });
    for (let i = 0; i < 7; i++) {
      await waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(i + 1));
      await act(async () => { gates[i]!.resolve(page()); });
    }
    expect(mounts).toBeGreaterThan(1); expect(f.fetcher).toHaveBeenCalledTimes(7);
    await act(async () => { f.rerender(); }); expect(f.fetcher).toHaveBeenCalledTimes(7);
    child.unmount();
  });
});

describe('confirmed mutation reconciliation', () => {
  it('refreshes only affected status columns after editor/history settlement', async () => {
    const f = await fixture(); f.respond(query => {
      const status = query.get('status') as ApplicationStatus;
      return page([row(boardStatuses.indexOf(status) + 1, status)], `${status}-next`);
    }); await f.start();
    await act(async () => { await f.result.current.pause(); });
    const updated = row(1, 'APPLIED', 2);
    act(() => f.result.current.confirmedSaved(updated, row()));
    expect(f.fetcher).toHaveBeenCalledTimes(7); expect(f.result.current.columns.OFFER.nextCursor).toBe('OFFER-next');
    f.respond(query => page(query.get('status') === 'APPLIED' ? [updated] : []));
    await act(async () => { await f.auth.store.authenticatedRequest(async () => undefined); }); // History/detail handoff.
    expect(f.fetcher).toHaveBeenCalledTimes(7);
    await act(async () => f.result.current.resume());
    expect(f.queries().slice(7).map(query => query.status)).toEqual(['APPLIED', 'SAVED']);
    expect(f.result.current.columns.APPLIED.items).toEqual([updated]); expect(f.result.current.columns.SAVED.items).toEqual([]);
  });
  it.each(['company', 'jobTitle'] as const)('refreshes the included column after a confirmed %s edit', async field => {
    const f = await fixture(); f.respond(() => page([row()], 'next')); await f.start({ status: 'SAVED', q: 'Acme' });
    await act(async () => { await f.result.current.pause(); });
    act(() => f.result.current.confirmedSaved({ ...row(), [field]: 'Changed', version: 2 }, row()));
    f.respond(() => page()); await act(async () => f.result.current.resume());
    expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.queries()[1]?.cursor).toBeUndefined();
  });
  it('updates notes without resetting pages or accepting an older confirmed version', async () => {
    const f = await fixture(); f.respond(() => page([row()], 'next')); await f.start({ status: 'SAVED' });
    const updated = { ...row(), version: 3, notes: 'Saved' };
    act(() => { f.result.current.confirmedSaved(updated); f.result.current.confirmedSaved({ ...row(), version: 2 }); });
    expect(f.result.current.columns.SAVED.items).toEqual([updated]); expect(f.result.current.columns.SAVED.nextCursor).toBe('next'); expect(f.fetcher).toHaveBeenCalledOnce();
  });
  it('keeps confirmed mutation outcomes separate from a failed follow-up read', async () => {
    const f = await fixture(); f.respond(() => page([row()])); await f.start({ status: 'SAVED' });
    await act(async () => { await f.result.current.pause(); });
    act(() => f.result.current.confirmedSaved({ ...row(), company: 'New', version: 2 }, row()));
    f.respond(() => json({ code: 'SERVICE_UNAVAILABLE', message: 'Unavailable' }, 503));
    await act(async () => f.result.current.resume());
    expect(f.result.current.columns.SAVED.phase).toBe('error'); expect(f.fetcher).toHaveBeenCalledTimes(2);
    expect(f.fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
  });
  it('does not label an interrupted first page as a successfully loaded empty column', async () => {
    const f = await fixture(), gate = deferred<Page>(); f.respond(() => gate.promise);
    act(() => { f.result.current.configure({ enabled: true, filters: { status: 'SAVED' } }); f.result.current.resume(); });
    await waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    act(() => f.result.current.confirmedSaved({ ...row(), notes: 'Confirmed', version: 2 }, row()));
    expect(f.result.current.columns.SAVED.phase).toBe('unloaded');
    let pause!: Promise<void>;
    act(() => { pause = f.result.current.pause(); });
    await act(async () => { gate.resolve(page([row()])); await pause; });
    expect(f.result.current.columns.SAVED.phase).toBe('unloaded');
    expect(f.result.current.columns.SAVED.items).toEqual([]);
  });
  it('refreshes creation, removes only archive/delete targets and preserves unrelated cursors', async () => {
    const f = await fixture(); f.respond(() => page([row(), row(2), row(3)], 'next')); await f.start({ status: 'SAVED' });
    act(() => f.result.current.confirmedArchived({ ...row(), version: 2, archivedAt: row().createdAt }));
    act(() => f.result.current.confirmedDeleted(row(2).id));
    expect(f.result.current.columns.SAVED.items).toEqual([row(3)]); expect(f.result.current.columns.SAVED.nextCursor).toBe('next');
    f.respond(() => page([row(3), row(4)])); await act(async () => f.result.current.confirmedCreated(row(4)));
    expect(f.result.current.columns.SAVED.items).toEqual([row(3), row(4)]); expect(f.fetcher).toHaveBeenCalledTimes(2);
  });
  it('does not guess membership from disagreeing cross-column reads or loop on disagreement', async () => {
    const f = await fixture();
    f.respond(query => page(query.get('status') === 'SAVED' ? [row()] : query.get('status') === 'APPLIED' ? [row(1, 'APPLIED', 2)] : []));
    await f.start();
    expect(f.result.current.columns.SAVED).toMatchObject({ phase: 'error', items: [], nextCursor: null });
    expect(f.result.current.columns.APPLIED).toMatchObject({ phase: 'error', items: [], nextCursor: null });
    expect(f.fetcher).toHaveBeenCalledTimes(7);
    await act(async () => f.result.current.retry('APPLIED'));
    expect(f.result.current.columns.APPLIED.items).toEqual([row(1, 'APPLIED', 2)]);
  });
  it('never overwrites a newer confirmed card with an older database read', async () => {
    const f = await fixture(); f.respond(() => page([row()], 'next')); await f.start({ status: 'SAVED' });
    act(() => f.result.current.confirmedSaved({ ...row(), version: 3, notes: 'New' }));
    f.respond(() => page([row()]));
    await act(async () => f.result.current.loadMore('SAVED'));
    expect(f.result.current.columns.SAVED.items).toEqual([{ ...row(), version: 3, notes: 'New' }]);
    expect(f.result.current.columns.SAVED.phase).toBe('ready');
    f.respond(() => page([row()])); await act(async () => f.result.current.refresh());
    expect(f.result.current.columns.SAVED.phase).toBe('error');
  });
  it('keeps a disputed identity quarantined when a third column returns another membership', async () => {
    const f = await fixture();
    f.respond(query => {
      const status = query.get('status') as ApplicationStatus;
      return page(['SAVED', 'APPLIED', 'INTERVIEW'].includes(status) ? [row(1, status, boardStatuses.indexOf(status) + 1)] : []);
    });
    await f.start();
    for (const status of ['SAVED', 'APPLIED', 'INTERVIEW'] as const) expect(f.result.current.columns[status]).toMatchObject({ phase: 'error', items: [] });
    expect(f.fetcher).toHaveBeenCalledTimes(7);
    await act(async () => f.result.current.retry('INTERVIEW'));
    expect(f.result.current.columns.INTERVIEW.items).toEqual([row(1, 'INTERVIEW', 4)]);
  });
  it('keeps the existing editor draft and history through controller presentation changes', async () => {
    const auth = authFixture({ authenticated: true }); fixtures.push(auth); await auth.store.bootstrap();
    const api = { ...createApplicationsApi(auth.store), get: vi.fn().mockResolvedValue({ application: row() }),
      history: vi.fn().mockResolvedValue({ items: [], nextCursor: null }), list: vi.fn().mockResolvedValue(page()) };
    const hook = renderHook(() => {
      const [presentation, setPresentation] = useState(false);
      const board = useApplicationBoard(auth.store, api);
      const editor = useApplicationEditor(auth.store, api, (application, lifecycle, previous) => {
        if (lifecycle === 'archive') board.confirmedArchived(application);
        else if (!lifecycle) board.confirmedSaved(application, previous);
      }, board.confirmedDeleted);
      return { presentation, setPresentation, board, editor };
    });
    await act(async () => hook.result.current.editor.open(row().id));
    act(() => hook.result.current.editor.setDraft({ ...hook.result.current.editor.draft!, notes: 'Unsaved' }));
    await act(async () => { hook.result.current.setPresentation(true); hook.result.current.board.configure({ enabled: true, filters: {} }); hook.result.current.board.resume(); });
    act(() => hook.result.current.board.configure({ enabled: false, filters: {} }));
    expect(hook.result.current.editor.selectedId).toBe(row().id); expect(hook.result.current.editor.draft?.notes).toBe('Unsaved');
    expect(api.get).toHaveBeenCalledOnce(); expect(api.history).toHaveBeenCalledOnce(); hook.unmount();
  });
  it('waits for real editor save and follow-up history transport before refreshing affected columns', async () => {
    const f = await fixture(), historyGate = deferred<Response>();
    const saved = row(1, 'APPLIED', 2); let historyReads = 0;
    f.respond((query, _signal, path) => {
      if (path?.endsWith('/history')) return ++historyReads === 1 ? json(page()) : historyGate.promise;
      if (path === `/api/applications/${row().id}`) return json({ application: historyReads ? saved : row() });
      return page(query.get('status') === 'SAVED' ? [row()] : []);
    });
    await f.start();
    const editor = renderHook(() => useApplicationEditor(f.auth.store, f.api, (application, _lifecycle, previous) => f.result.current.confirmedSaved(application, previous)));
    await act(async () => { await f.result.current.pause(); editor.result.current.open(row().id); });
    const initialCalls = f.fetcher.mock.calls.length;
    act(() => editor.result.current.save({ company: saved.company, jobTitle: saved.jobTitle, status: saved.status,
      applicationDate: saved.applicationDate, location: saved.location, jobUrl: saved.jobUrl, notes: saved.notes,
      expectedVersion: saved.version - 1 }, () => true));
    await waitFor(() => expect(historyReads).toBe(2));
    expect(editor.result.current.historyLoading).toBe(true); expect(editor.result.current.application?.version).toBe(2);
    expect(f.fetcher.mock.calls.length).toBe(initialCalls + 2); // One PUT and one history GET, no collection read.
    f.respond((query, _signal, path) => path?.endsWith('/history') ? json(page()) : page(query.get('status') === 'APPLIED' ? [saved] : []));
    await act(async () => { historyGate.resolve(json(page())); });
    expect(editor.result.current.historyLoading).toBe(false);
    await act(async () => f.result.current.resume());
    expect(editor.result.current.selectedId).toBe(saved.id); expect(f.result.current.columns.APPLIED.items).toEqual([saved]);
    expect(f.fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT')).toHaveLength(1); editor.unmount();
  });
});
