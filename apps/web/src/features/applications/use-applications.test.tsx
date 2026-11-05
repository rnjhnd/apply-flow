import { StrictMode } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { authFixture, deferred, user } from '../../test/auth-fixtures';
import { ApplicationFailure, createApplicationsApi, type ApplicationsApi } from '../../lib/applications/api';
import { AuthFailure } from '../../lib/auth/api';
import type { Application } from '@applyflow/contracts';
import { useApplications } from './use-applications';
const row: Application = { id: 'c4974360-a70c-4a29-8b41-df95d15d7270', version: 1, archivedAt: null, company: 'Acme', jobTitle: 'Engineer', status: 'SAVED', applicationDate: null,
  location: null, jobUrl: null, notes: null, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z' };
const input = { company: 'Acme', jobTitle: 'Engineer', status: 'SAVED' as const, applicationDate: null, location: null, jobUrl: null, notes: null };
const fixtures: ReturnType<typeof authFixture>[] = [];
afterEach(() => { fixtures.forEach(f => f.store.dispose()); fixtures.length = 0; });
async function fixture() {
  const auth = authFixture({ authenticated: true }); fixtures.push(auth); await auth.store.bootstrap();
  const api = { create: vi.fn<ApplicationsApi['create']>().mockResolvedValue({ application: row }), list: vi.fn<ApplicationsApi['list']>().mockResolvedValue({ items: [], nextCursor: null }) };
  const hook = renderHook(() => useApplications(auth.store, api), { wrapper: StrictMode });
  return { ...hook, auth, api };
}
describe('page-owned application lifecycle', () => {
  it('starts each view with a fresh first page and never carries a cursor between views', async () => {
    const f = await fixture();
    f.api.list.mockResolvedValueOnce({ items: [row], nextCursor: 'active-cursor' });
    await act(async () => { f.result.current.enter(); });
    f.api.list.mockResolvedValueOnce({ items: [{ ...row, archivedAt: row.createdAt }], nextCursor: 'archived-cursor' });
    await act(async () => { f.result.current.switchView('archived'); });
    expect(f.api.list.mock.calls[1]![0]).toEqual({ view: 'archived' });
    f.api.list.mockResolvedValueOnce({ items: [], nextCursor: null });
    await act(async () => { f.result.current.loadMore(); });
    expect(f.api.list.mock.calls[2]![0]).toEqual({ view: 'archived', cursor: 'archived-cursor' });
    await act(async () => { f.result.current.switchView('active'); });
    expect(f.api.list.mock.calls[3]![0]).toEqual({}); expect(f.result.current.view).toBe('active');
  });
  it('ignores a late previous-view response after switching views', async () => {
    const f = await fixture(), gate = deferred<{ items: Application[]; nextCursor: string | null }>();
    f.api.list.mockReturnValueOnce(gate.promise).mockResolvedValueOnce({ items: [], nextCursor: null });
    act(() => f.result.current.enter());
    await act(async () => { f.result.current.switchView('archived'); });
    expect(f.api.list.mock.calls[0]![1]?.aborted).toBe(true);
    await act(async () => { gate.resolve({ items: [row], nextCursor: 'old-cursor' }); });
    expect(f.result.current.view).toBe('archived'); expect(f.result.current.items).toEqual([]); expect(f.result.current.nextCursor).toBeNull();
  });
  it('removes only a confirmed lifecycle target while preserving siblings and pagination', async () => {
    const f = await fixture(), sibling = { ...row, id: user.id };
    f.api.list.mockResolvedValueOnce({ items: [row, sibling], nextCursor: 'next' });
    await act(async () => { f.result.current.enter(); });
    act(() => f.result.current.replaceItem({ ...row, archivedAt: row.createdAt, version: 2 }));
    expect(f.result.current.items).toEqual([sibling]); expect(f.result.current.nextCursor).toBe('next'); expect(f.api.list).toHaveBeenCalledOnce();
    f.api.list.mockResolvedValueOnce({ items: [{ ...row, archivedAt: row.createdAt }, { ...sibling, archivedAt: row.createdAt }], nextCursor: 'older' });
    await act(async () => { f.result.current.switchView('archived'); });
    act(() => f.result.current.replaceItem({ ...row, version: 3 }));
    expect(f.result.current.items.map(item => item.id)).toEqual([sibling.id]); expect(f.result.current.nextCursor).toBe('older');
    act(() => f.result.current.removeItem(sibling.id));
    expect(f.result.current.items).toEqual([]); expect(f.result.current.nextCursor).toBe('older'); expect(f.result.current.view).toBe('archived');
  });
  it('prevents creation in Archived and clears view state on confirmed logout', async () => {
    const f = await fixture(); await act(async () => { f.result.current.switchView('archived'); });
    act(() => f.result.current.save(input, () => true)); expect(f.api.create).not.toHaveBeenCalled();
    await act(async () => { await f.auth.store.logout(); });
    expect(f.result.current.view).toBe('active'); expect(f.result.current.items).toEqual([]); expect(f.result.current.nextCursor).toBeNull();
  });
  it('defers listing until protected admission and coalesces repeated entries', async () => {
    const f = await fixture(); expect(f.api.list).not.toHaveBeenCalled();
    await act(async () => { f.result.current.enter(); f.result.current.enter(); });
    expect(f.api.list).toHaveBeenCalledOnce(); expect(f.result.current.loading).toBe(false);
  });
  it('creates once, clears drafts only on confirmed success, and refreshes without replay', async () => {
    const f = await fixture(); const gate = deferred<{ application: Application }>(); f.api.create.mockReturnValue(gate.promise);
    act(() => { f.result.current.setDraft({ ...f.result.current.draft, company: 'Acme' }); f.result.current.save(input, () => true); f.result.current.save(input, () => true); });
    expect(f.api.create).toHaveBeenCalledOnce(); expect(f.result.current.saving).toBe(true);
    await act(async () => { gate.resolve({ application: row }); });
    expect(f.result.current.message).toBe('Application saved.'); expect(f.result.current.draft.company).toBe(''); expect(f.api.list).toHaveBeenCalledOnce();
  });
  it('retains drafts for ambiguous creates and requires explicit list recovery without POST replay', async () => {
    const f = await fixture(); f.api.create.mockRejectedValue(new ApplicationFailure('unknown'));
    act(() => f.result.current.setDraft({ ...f.result.current.draft, company: 'Draft' }));
    await act(async () => { f.result.current.save(input, () => true); });
    expect(f.result.current.failure?.kind).toBe('unknown'); expect(f.result.current.draft.company).toBe('Draft');
    await act(async () => { f.result.current.enter(); }); expect(f.api.list).not.toHaveBeenCalled();
    await act(async () => { f.result.current.refresh(); }); expect(f.api.list).toHaveBeenCalledOnce(); expect(f.api.create).toHaveBeenCalledOnce();
  });
  it('preserves confirmed success when the following list refresh fails', async () => {
    const f = await fixture(); f.api.list.mockRejectedValue(new ApplicationFailure('unknown'));
    await act(async () => { f.result.current.save(input, () => true); });
    expect(f.result.current.message).toBe('Application saved.'); expect(f.result.current.listError).toBe(true); expect(f.api.create).toHaveBeenCalledOnce();
  });
  it('appends pages, deduplicates IDs and prevents duplicate pagination reads', async () => {
    const f = await fixture(); f.api.list.mockResolvedValueOnce({ items: [row], nextCursor: 'cursor' });
    await act(async () => { f.result.current.enter(); });
    const gate = deferred<{ items: Application[]; nextCursor: string | null }>(); f.api.list.mockReturnValue(gate.promise);
    act(() => { f.result.current.loadMore(); f.result.current.loadMore(); }); expect(f.api.list).toHaveBeenCalledTimes(2);
    await act(async () => { gate.resolve({ items: [row, { ...row, id: user.id, company: 'Second' }], nextCursor: null }); });
    expect(f.result.current.items.map(item => item.company)).toEqual(['Acme','Second']); expect(f.result.current.nextCursor).toBeNull();
  });
  it('replaces only a saved loaded item without changing pagination or unrelated entries', async () => {
    const f = await fixture(); f.api.list.mockResolvedValue({ items: [row, { ...row, id: user.id, company: 'Other' }], nextCursor: 'cursor' });
    await act(async () => { f.result.current.enter(); });
    act(() => f.result.current.replaceItem({ ...row, company: 'Edited', version: 2 }));
    expect(f.result.current.items.map(item => item.company)).toEqual(['Edited','Other']); expect(f.result.current.nextCursor).toBe('cursor');
    expect(f.api.list).toHaveBeenCalledOnce();
  });
  it('blocks programmatic submission without current route admission', async () => {
    const f = await fixture(); act(() => f.result.current.save(input, () => false)); expect(f.api.create).not.toHaveBeenCalled();
  });
  it('does not submit during cooldown or automatically request after expiry', async () => {
    vi.useFakeTimers(); const f = await fixture(); f.api.create.mockRejectedValue(new ApplicationFailure('http', 429, undefined, Date.now() + 3000));
    await act(async () => { f.result.current.save(input, () => true); });
    act(() => f.result.current.save(input, () => true)); expect(f.api.create).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); expect(f.result.current.cooldown).toBe(0); expect(f.api.create).toHaveBeenCalledOnce(); expect(f.api.list).not.toHaveBeenCalled();
  });
  it('cancels an old list on invalidation and rejects late callbacks without erasing the same-user draft', async () => {
    const f = await fixture(); const gate = deferred<{ items: Application[]; nextCursor: string | null }>(); f.api.list.mockReturnValue(gate.promise);
    act(() => { f.result.current.setDraft({ ...f.result.current.draft, notes: 'Keep my draft' }); f.result.current.enter(); });
    const signal = f.api.list.mock.calls[0]?.[1]; act(() => f.auth.notify('suspend')); expect(signal?.aborted).toBe(true);
    await act(async () => { gate.resolve({ items: [row], nextCursor: null }); });
    expect(f.result.current.items).toEqual([]); expect(f.result.current.draft.notes).toBe('Keep my draft');
  });
  it('clears account-owned data and drafts when authoritative verification finds a different user', async () => {
    const f = await fixture(); f.api.list.mockResolvedValue({ items: [row], nextCursor: null });
    await act(async () => { f.result.current.enter(); f.result.current.setDraft({ ...f.result.current.draft, notes: 'Private notes' }); });
    f.auth.api.me.mockResolvedValue({ user: { ...user, id: row.id } }); await act(async () => { await f.auth.store.revalidate(); });
    expect(f.result.current.items).toEqual([]); expect(f.result.current.draft.notes).toBe(''); expect(f.result.current.message).toBeNull();
  });
  it('abandons callbacks after unmount without cancelling accepted creates or issuing extra reads', async () => {
    const f = await fixture(); const gate = deferred<{ application: Application }>(); f.api.create.mockReturnValue(gate.promise);
    act(() => f.result.current.save(input, () => true)); f.unmount(); await act(async () => { gate.resolve({ application: row }); });
    expect(f.api.list).not.toHaveBeenCalled(); expect(f.api.create).toHaveBeenCalledOnce(); expect(f.auth.subscriptions()).toBe(0);
  });
});

describe('workspace-owned search and filter state', () => {
  it('keeps draft changes local and paginates using the applied filter snapshot', async () => {
    const f = await fixture();
    act(() => f.result.current.setFilterDraft({ q: ' Acme ', status: 'SAVED' }));
    expect(f.api.list).not.toHaveBeenCalled(); expect(f.result.current.appliedFilters).toEqual({});
    f.api.list.mockResolvedValueOnce({ items: [row], nextCursor: 'next' });
    await act(async () => { f.result.current.applyFilters(); });
    expect(f.api.list.mock.calls[0]![0]).toEqual({ q: 'Acme', status: 'SAVED' });
    expect(f.result.current.filterDraft).toEqual({ q: 'Acme', status: 'SAVED' });
    act(() => f.result.current.setFilterDraft({ q: 'Unsubmitted', status: 'INTERVIEW' }));
    await act(async () => { f.result.current.loadMore(); });
    expect(f.api.list.mock.calls[1]![0]).toEqual({ q: 'Acme', status: 'SAVED', cursor: 'next' });
    expect(f.result.current.filtersChanged).toBe(true);
  });
  it('clears draft and applied filters immediately, starts page one and rejects late canceled pages', async () => {
    const f = await fixture(); f.api.list.mockResolvedValueOnce({ items: [row], nextCursor: 'next' });
    act(() => f.result.current.setFilterDraft({ q: 'Acme', status: 'SAVED' }));
    await act(async () => { f.result.current.applyFilters(); });
    const gate = deferred<{ items: Application[]; nextCursor: string | null }>();
    f.api.list.mockReturnValueOnce(gate.promise).mockResolvedValueOnce({ items: [], nextCursor: null });
    act(() => f.result.current.loadMore()); expect(f.result.current.loadingMore).toBe(true);
    await act(async () => { f.result.current.clearFilters(); });
    expect(f.api.list.mock.calls[1]![1]?.aborted).toBe(true); expect(f.api.list.mock.calls[2]![0]).toEqual({});
    await act(async () => { gate.resolve({ items: [row], nextCursor: 'late' }); });
    expect(f.result.current.items).toEqual([]); expect(f.result.current.nextCursor).toBeNull();
    expect(f.result.current.filterDraft).toEqual({ q: '', status: '' }); expect(f.result.current.appliedFilters).toEqual({});
  });
  it('rejects late first-page successes and errors after new filters, even when the port ignores abort', async () => {
    const f = await fixture(), old = deferred<{ items: Application[]; nextCursor: string | null }>();
    f.api.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ items: [row], nextCursor: null });
    act(() => { f.result.current.setFilterDraft({ q: 'Old', status: '' }); f.result.current.applyFilters(); });
    await act(async () => { f.result.current.setFilterDraft({ q: 'New', status: '' }); f.result.current.applyFilters(); });
    await act(async () => { old.reject(new ApplicationFailure('http', 503)); });
    expect(f.result.current.items).toEqual([row]); expect(f.result.current.appliedFilters).toEqual({ q: 'New' }); expect(f.result.current.listError).toBe(false);
    const late = deferred<{ items: Application[]; nextCursor: string | null }>(); f.api.list.mockReturnValueOnce(late.promise);
    act(() => f.result.current.refresh());
    await act(async () => { f.result.current.setFilterDraft({ q: 'Newest', status: '' }); f.result.current.applyFilters(); });
    await act(async () => { late.resolve({ items: [], nextCursor: 'wrong' }); });
    expect(f.result.current.items).toEqual([]); expect(f.result.current.nextCursor).toBeNull(); expect(f.result.current.appliedFilters).toEqual({ q: 'Newest' });
  });
  it('remembers independent draft/applied filters but never caches inactive pages or cursors', async () => {
    const f = await fixture();
    act(() => { f.result.current.setFilterDraft({ q: 'Active', status: 'SAVED' }); });
    await act(async () => { f.result.current.applyFilters(); });
    act(() => f.result.current.setFilterDraft({ q: 'Active draft', status: '' }));
    await act(async () => { f.result.current.switchView('archived'); });
    expect(f.result.current.filterDraft).toEqual({ q: '', status: '' });
    act(() => f.result.current.setFilterDraft({ q: 'Archived', status: 'OFFER' }));
    await act(async () => { f.result.current.applyFilters(); });
    act(() => f.result.current.setFilterDraft({ q: 'Archived draft', status: '' }));
    await act(async () => { f.result.current.switchView('active'); });
    expect(f.result.current.filterDraft.q).toBe('Active draft'); expect(f.api.list.mock.calls.at(-1)![0]).toEqual({ q: 'Active', status: 'SAVED' });
    await act(async () => { f.result.current.switchView('archived'); });
    expect(f.result.current.filterDraft.q).toBe('Archived draft'); expect(f.api.list.mock.calls.at(-1)![0]).toEqual({ view: 'archived', q: 'Archived', status: 'OFFER' });
  });
  it.each(['logout', 'replacement'] as const)('clears both views and rejects late search results after %s', async outcome => {
    const f = await fixture();
    act(() => f.result.current.setFilterDraft({ q: 'A private', status: 'SAVED' }));
    await act(async () => { f.result.current.applyFilters(); f.result.current.switchView('archived'); });
    act(() => f.result.current.setFilterDraft({ q: 'A archived', status: 'OFFER' }));
    const late = deferred<{ items: Application[]; nextCursor: string | null }>(); f.api.list.mockReturnValueOnce(late.promise);
    act(() => f.result.current.applyFilters());
    if (outcome === 'logout') await act(async () => { await f.auth.store.logout(); });
    else { f.auth.api.me.mockResolvedValue({ user: { ...user, id: row.id } }); await act(async () => { await f.auth.store.revalidate(); }); }
    await act(async () => { late.resolve({ items: [row], nextCursor: 'A-only' }); });
    expect(f.result.current.view).toBe('active'); expect(f.result.current.items).toEqual([]); expect(f.result.current.appliedFilters).toEqual({});
    expect(f.result.current.filterDraft).toEqual({ q: '', status: '' });
    if (outcome === 'replacement') { await act(async () => { f.result.current.switchView('archived'); }); expect(f.result.current.filterDraft.q).toBe(''); expect(f.result.current.hasFilters).toBe(false); }
  });
  it('preserves draft and applied values through same-account verification', async () => {
    const f = await fixture();
    act(() => f.result.current.setFilterDraft({ q: 'Applied', status: 'SAVED' }));
    await act(async () => { f.result.current.applyFilters(); });
    act(() => f.result.current.setFilterDraft({ q: 'Private draft', status: 'OFFER' }));
    await act(async () => { await f.auth.store.revalidate(); });
    expect(f.result.current.filterDraft.q).toBe('Private draft'); expect(f.result.current.appliedFilters).toEqual({ q: 'Applied', status: 'SAVED' });
  });
  it('validates without dispatch and preserves applied filters when the draft is invalid', async () => {
    const f = await fixture();
    act(() => { f.result.current.setFilterDraft({ q: '\ud83d\ude00'.repeat(201), status: '' }); f.result.current.applyFilters(); });
    expect(f.result.current.filterError).toBe(true); expect(f.result.current.focusTarget).toBe('application-search-q'); expect(f.api.list).not.toHaveBeenCalled();
    act(() => f.result.current.setFilterDraft({ q: '\ud83d\ude00'.repeat(200), status: '' }));
    await act(async () => { f.result.current.applyFilters(); }); expect(f.api.list).toHaveBeenCalledOnce();
  });
  it('defers filter-relevant edit reconciliation until editor work settles and keeps save success separate from read failure', async () => {
    const f = await fixture();
    act(() => f.result.current.setFilterDraft({ q: 'Acme', status: 'SAVED' }));
    f.api.list.mockResolvedValueOnce({ items: [row], nextCursor: 'next' });
    await act(async () => { f.result.current.applyFilters(); });
    act(() => { f.result.current.replaceItem({ ...row, company: 'Changed', version: 2 }, undefined, row); f.result.current.enter(false); });
    expect(f.api.list).toHaveBeenCalledOnce();
    f.api.list.mockRejectedValueOnce(new ApplicationFailure('http', 503));
    await act(async () => { f.result.current.enter(true); });
    expect(f.api.list.mock.calls[1]![0]).toEqual({ q: 'Acme', status: 'SAVED' });
    expect(f.result.current.listError).toBe(true); expect(f.result.current.failure).toBeNull(); expect(f.result.current.nextCursor).toBeNull();
    await act(async () => { f.result.current.enter(); }); expect(f.api.list).toHaveBeenCalledTimes(2);
  });
  it('retains filters on creation success even if refreshing them fails; never replays the create', async () => {
    const f = await fixture();
    act(() => f.result.current.setFilterDraft({ q: 'Other', status: 'OFFER' }));
    await act(async () => { f.result.current.applyFilters(); });
    f.api.list.mockRejectedValueOnce(new ApplicationFailure('http', 503));
    await act(async () => { f.result.current.save(input, () => true); });
    expect(f.result.current.message).toContain('Application saved.'); expect(f.result.current.message).toContain('filters are still applied');
    expect(f.result.current.listError).toBe(true); expect(f.result.current.appliedFilters).toEqual({ q: 'Other', status: 'OFFER' });
    expect(f.api.create).toHaveBeenCalledOnce(); expect(f.result.current.failure).toBeNull();
  });
  it('keeps loaded items and the applied cursor after a load-more error', async () => {
    const f = await fixture(); f.api.list.mockResolvedValueOnce({ items: [row], nextCursor: 'next' });
    await act(async () => { f.result.current.enter(); });
    f.api.list.mockRejectedValueOnce(new ApplicationFailure('http', 503));
    await act(async () => { f.result.current.loadMore(); });
    expect(f.result.current.items).toEqual([row]); expect(f.result.current.nextCursor).toBe('next'); expect(f.result.current.loadMoreError).toBe(true);
  });
  it('quarantines a rejected pagination read and offers first-page recovery rather than an unavailable cursor', async () => {
    const f = await fixture(); f.api.list.mockResolvedValueOnce({ items: [row], nextCursor: 'next' });
    await act(async () => { f.result.current.enter(); });
    f.api.list.mockRejectedValueOnce(new ApplicationFailure('http', 403));
    await act(async () => { f.result.current.loadMore(); });
    expect(f.result.current.items).toEqual([]); expect(f.result.current.nextCursor).toBeNull();
    expect(f.result.current.listError).toBe(true); expect(f.result.current.loadMoreError).toBe(false);
  });
});

describe('workspace integration with route receipts and private coordinator', () => {
  it('keeps rejection terminal for automatic reads when a broadcast cancels the request first', async () => {
    const auth = authFixture({ authenticated: true }); fixtures.push(auth); await auth.store.bootstrap();
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    const late = deferred<Response>();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ items: [row], nextCursor: null }))
      .mockReturnValueOnce(late.promise).mockImplementation(async () => json({ items: [], nextCursor: null }));
    const api = createApplicationsApi(auth.store, fetcher); const hook = renderHook(() => useApplications(auth.store, api));
    await act(async () => { hook.result.current.enter(); });
    act(() => hook.result.current.refresh());
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    act(() => auth.notify('invalidate'));
    await act(async () => { late.resolve(json({ code: 'UNAUTHENTICATED', message: 'Rejected.' }, 401)); });
    expect(auth.store.getSnapshot().status).toBe('authenticated');
    expect(hook.result.current.items).toEqual([]); expect(hook.result.current.listError).toBe(true);
    await act(async () => { hook.result.current.enter(); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([401, 403].flatMap(status => ['anonymous', 'unavailable', 'replacement'].map(outcome => ({ status, outcome }))))(
    'does not refetch after GET $status recovery to $outcome', async ({ status, outcome }) => {
      const auth = authFixture({ authenticated: true }); fixtures.push(auth);
      const replacement = { ...user, id: row.id, email: 'replacement@example.invalid' };
      const json = (body: unknown, code = 200) => new Response(JSON.stringify(body), { status: code, headers: { 'Content-Type': 'application/json' } });
      const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ items: [row], nextCursor: null })).mockImplementation(async () => {
        if (outcome === 'anonymous') auth.api.me.mockRejectedValue(new AuthFailure('http', 401, 'UNAUTHENTICATED'));
        if (outcome === 'unavailable') auth.api.me.mockRejectedValue(new AuthFailure('http', 503, 'SERVICE_UNAVAILABLE'));
        if (outcome === 'replacement') auth.api.me.mockResolvedValue({ user: replacement });
        return json({ code: status === 401 ? 'UNAUTHENTICATED' : 'REQUEST_REJECTED', message: 'Rejected.' }, status);
      });
      vi.stubGlobal('fetch', fetcher);
      render(<StrictMode><MemoryRouter initialEntries={['/app']}><App authStore={auth.store} /></MemoryRouter></StrictMode>);
      await screen.findByText('Acme');
      await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh applications' })); });
      expect(screen.queryByText('Acme')).toBeNull(); expect(fetcher).toHaveBeenCalledTimes(2);
      if (outcome === 'anonymous') expect(await screen.findByRole('form', { name: 'Sign in' })).toBeTruthy();
      if (outcome === 'replacement') {
        expect(await screen.findByText(replacement.email)).toBeTruthy();
        expect(screen.getByText(/Applications could not be loaded/)).toBeTruthy();
      }
      if (outcome === 'unavailable') {
        const check = await screen.findByRole('button', { name: 'Check session' });
        expect(auth.store.getSnapshot()).toMatchObject({ verifiedReadId: null, user: null });
        auth.api.me.mockResolvedValue({ user });
        await act(async () => { fireEvent.click(check); });
        expect(await screen.findByRole('heading', { name: 'Your workspace' })).toBeTruthy();
        expect(screen.getByText(/Applications could not be loaded/)).toBeTruthy();
      }
      await act(async () => { await Promise.resolve(); });
      expect(fetcher).toHaveBeenCalledTimes(2); expect(auth.api.login).not.toHaveBeenCalled(); expect(auth.api.register).not.toHaveBeenCalled();
    });
  it('rejects an older read completion while authoritative rejection recovery is still pending', async () => {
    const f = await fixture(); f.api.list.mockResolvedValueOnce({ items: [row], nextCursor: 'cursor' });
    await act(async () => { f.result.current.enter(); });
    const late = deferred<{ items: Application[]; nextCursor: string | null }>();
    f.api.list.mockReturnValueOnce(late.promise); act(() => f.result.current.loadMore());
    const recovery = deferred<{ user: typeof user }>();
    let rejected: Promise<unknown>;
    await act(async () => {
      rejected = f.auth.store.authenticatedRequest(async () => {
        f.auth.api.me.mockReturnValueOnce(recovery.promise); throw new ApplicationFailure('http', 401);
      }).catch(() => undefined);
    });
    expect(f.auth.store.getSnapshot()).toMatchObject({ busy: true, verifiedReadId: null });
    expect(f.result.current.items).toEqual([]);
    await act(async () => { late.resolve({ items: [row], nextCursor: null }); });
    expect(f.result.current.items).toEqual([]);
    await act(async () => { recovery.resolve({ user }); await rejected; f.result.current.enter(); });
    expect(f.result.current.items).toEqual([]); expect(f.api.list).toHaveBeenCalledTimes(2); expect(f.api.create).not.toHaveBeenCalled();
  });
  it('clears A rows before accepting a B-cookie page even with no broadcast', async () => {
    const auth = authFixture({ authenticated: true }); fixtures.push(auth); await auth.store.bootstrap();
    let replaced = false;
    auth.api.me.mockImplementation(async () => ({ user: replaced ? { ...user, id: row.id } : user }));
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({
      items: [{ ...row, id: replaced ? 'd4974360-a70c-4a29-8b41-df95d15d7270' : row.id, company: replaced ? 'B only' : 'A only' }], nextCursor: replaced ? null : 'cursor'
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    const api = createApplicationsApi(auth.store, fetcher);
    const hook = renderHook(() => useApplications(auth.store, api));
    await act(async () => { hook.result.current.enter(); }); expect(hook.result.current.items[0]?.company).toBe('A only');
    replaced = true;
    await act(async () => { hook.result.current.loadMore(); });
    expect(hook.result.current.items).toEqual([]); expect(fetcher).toHaveBeenCalledOnce();
    expect(auth.store.getSnapshot().user?.id).toBe(row.id);
    await act(async () => { hook.result.current.refresh(); });
    expect(hook.result.current.items.map(item => item.company)).toEqual(['B only']);
  });
  it.each([401, 403])('quarantines rows on GET %i and does not loop after recovery to the original account', async status => {
    const auth = authFixture({ authenticated: true }); fixtures.push(auth);
    const fetcher = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ items: [row], nextCursor: 'cursor' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    })).mockImplementation(async () => new Response(JSON.stringify({ code: status === 401 ? 'UNAUTHENTICATED' : 'REQUEST_REJECTED', message: 'Rejected.' }), {
      status, headers: { 'Content-Type': 'application/json' }
    }));
    vi.stubGlobal('fetch', fetcher);
    render(<StrictMode><MemoryRouter initialEntries={['/app']}><App authStore={auth.store} /></MemoryRouter></StrictMode>);
    await screen.findByText('Acme');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh applications' })); });
    expect(screen.queryByText('Acme')).toBeNull();
    expect(await screen.findByText(/Applications could not be loaded/)).toBeTruthy();
    await act(async () => { await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(auth.api.csrf).toHaveBeenCalledTimes(4);
    expect(auth.store.getSnapshot()).toMatchObject({ status: 'authenticated', outcomeUncertain: false });
    fetcher.mockImplementation(async () => new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh applications' })); });
    expect(fetcher).toHaveBeenCalledTimes(3); expect(screen.getByText(/No applications saved yet/)).toBeTruthy();
  });
  it('preserves an edited draft across background verification and creates through the real gateway', async () => {
    const auth = authFixture({ authenticated: true }); fixtures.push(auth);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Response(JSON.stringify(init?.method === 'POST' ? { application: row } : { items: [], nextCursor: null }), { status: init?.method === 'POST' ? 201 : 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);
    render(<StrictMode><MemoryRouter initialEntries={['/app']}><App authStore={auth.store} /></MemoryRouter></StrictMode>);
    await screen.findByRole('form', { name: 'Add application' });
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Draft company' } }); fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Engineer' } });
    await act(async () => { await auth.store.revalidate(); });
    expect((await screen.findByLabelText('Company') as HTMLInputElement).value).toBe('Draft company');
    await waitFor(() => expect(fetcher).toHaveBeenCalled());
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Add application' })); });
    await screen.findByText('Application saved.'); expect((screen.getByLabelText('Company') as HTMLInputElement).value).toBe('');
    expect(fetcher.mock.calls.filter(([,init]) => init?.method === 'POST')).toHaveLength(1); expect(auth.store.getSnapshot().outcomeUncertain).toBe(false);
  });
});
