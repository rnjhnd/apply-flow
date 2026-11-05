import { StrictMode } from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Application, ApplicationStatus, ApplicationStatusHistory } from '@applyflow/contracts';
import { App } from '../../App';
import { authFixture, deferred, user } from '../../test/auth-fixtures';
import { AuthFailure } from '../../lib/auth/api';
import { createApplicationsApi } from '../../lib/applications/api';
import { useApplicationWorkspace } from './use-application-workspace';
import { boardStatuses } from './use-application-board';
import { statusLabel } from './application-field-policy';

const makeRow = (number = 1, status: ApplicationStatus = 'SAVED'): Application => ({
  id: `c4974360-a70c-4a29-8b41-${String(number).padStart(12, '0')}`, company: number === 1 ? 'Acme' : 'Other', jobTitle: 'Engineer',
  status, applicationDate: status === 'SAVED' ? null : '2026-10-20', version: 1, notes: 'Saved notes', archivedAt: null,
  location: null, jobUrl: null, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z'
});
const json = (body: unknown, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
const fixtures: ReturnType<typeof authFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.store.dispose()));

// Controlled in-memory HTTP responses, real AuthStore/ApplicationApi/Workspace.
// No server, browser, database, production matcher or SQL performance evidence.
async function setup(renderUI = true) {
  const auth = authFixture({ authenticated: true }); fixtures.push(auth); await auth.store.bootstrap();
  const records = new Map([makeRow(), makeRow(2, 'INTERVIEW')].map(row => [row.id, row]));
  const events = new Map<string, ApplicationStatusHistory[]>();
  const trace: string[] = [];
  const list = vi.fn(async (url: string): Promise<Response> => {
    const query = new URL(url, 'http://127.0.0.1').searchParams;
    const items = [...records.values()].filter(row => (row.archivedAt !== null) === (query.get('view') === 'archived')
      && (!query.has('status') || row.status === query.get('status'))
      && (!query.get('q') || `${row.company}\n${row.jobTitle}`.toLowerCase().includes(query.get('q')!.toLowerCase())));
    return json({ items, nextCursor: null });
  });
  const history = vi.fn(async (id: string): Promise<Response> => json({ items: [...(events.get(id) ?? [])].reverse(), nextCursor: null }));
  const write = vi.fn(async (id: string, init: RequestInit): Promise<Response> => {
    const previous = records.get(id)!, input = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(input.expectedVersion).toBe(previous.version); delete input.expectedVersion;
    const row = { ...previous, ...input, version: previous.version + 1 } as Application; records.set(id, row);
    if (row.status !== previous.status) events.set(id, [...(events.get(id) ?? []), {
      id: makeRow(100 + row.version).id, fromStatus: previous.status, toStatus: row.status, applicationVersion: row.version, changedAt: row.updatedAt
    }]);
    return json({ application: row });
  });
  let concurrent = 0, maximum = 0;
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url), parsed = new URL(target, 'http://127.0.0.1'), id = parsed.pathname.split('/')[3]!;
    concurrent++; maximum = Math.max(maximum, concurrent);
    try {
      if (init?.method === 'PUT') { trace.push('PUT'); return await write(id, init); }
      if (parsed.pathname.endsWith('/history')) { trace.push('history'); return await history(id); }
      if (parsed.pathname.endsWith('/archive') || parsed.pathname.endsWith('/restore')) {
        const row = records.get(id)!; expect(JSON.parse(String(init?.body))).toEqual({ expectedVersion: row.version });
        const updated = { ...row, version: row.version + 1, archivedAt: parsed.pathname.endsWith('/archive') ? row.updatedAt : null };
        records.set(id, updated); return json({ application: updated });
      }
      if (init?.method === 'DELETE') {
        expect(JSON.parse(String(init.body))).toEqual({ expectedVersion: records.get(id)!.version, confirmPermanentDeletion: true });
        records.delete(id); events.delete(id); return json({ deletedApplicationId: id });
      }
      if (init?.method === 'POST') {
        const row = { ...makeRow(3), ...JSON.parse(String(init.body)) } as Application; records.set(row.id, row); return json({ application: row }, 201);
      }
      if (id) { trace.push('detail'); return records.has(id) ? json({ application: records.get(id) }) : json({ code: 'NOT_FOUND', message: 'Missing' }, 404); }
      trace.push(`list:${parsed.searchParams.get('status') ?? 'all'}`); return await list(target);
    } finally { concurrent--; }
  });
  vi.stubGlobal('fetch', fetcher);
  if (renderUI) {
    render(<StrictMode><MemoryRouter initialEntries={['/app']}><App authStore={auth.store} /></MemoryRouter></StrictMode>);
    await screen.findByRole('button', { name: 'Edit application: Engineer at Acme' });
  }
  const board = async () => {
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Board' })));
    await screen.findByRole('heading', { name: 'Application board' });
  };
  const open = async (company = 'Acme') => {
    await act(async () => fireEvent.click(screen.getByRole('button', { name: `Edit application: Engineer at ${company}` })));
    await screen.findByRole('button', { name: 'Save changes' });
  };
  return { auth, records, events, fetcher, list, history, write, trace, board, open, maximum: () => maximum,
    statuses: () => list.mock.calls.map(([url]) => new URL(url, 'http://127.0.0.1').searchParams.get('status')) };
}

describe('real-store workspace Kanban integration', () => {
  it('defaults to List, loads all columns once, preserves mode across Archived and never pushes search/presentation history', async () => {
    const f = await setup(), push = vi.spyOn(window.history, 'pushState');
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true');
    await f.board(); expect(f.statuses()).toEqual([null, ...boardStatuses]); expect(f.maximum()).toBe(1);
    expect(screen.getAllByRole('heading', { level: 3 }).map(element => element.textContent)).toEqual(boardStatuses.map(statusLabel));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Archived' })));
    await screen.findByRole('heading', { name: 'Archived applications' }); expect(screen.queryByRole('button', { name: 'Board' })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Active' })));
    await screen.findByRole('heading', { name: 'Application board' }); expect(f.statuses().slice(-7)).toEqual(boardStatuses);
    expect(push).not.toHaveBeenCalled();
  });
  it('shares submitted Active filters, retains drafts, and keeps Archived criteria separate', async () => {
    const f = await setup();
    fireEvent.change(screen.getByLabelText('Search company or job title'), { target: { value: 'Acme' } });
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'SAVED' } });
    await act(async () => fireEvent.submit(screen.getByRole('search')));
    await f.board(); expect(screen.getAllByText('Not included by the current status filter.')).toHaveLength(6);
    expect(f.statuses().slice(-1)).toEqual(['SAVED']);
    fireEvent.change(screen.getByLabelText('Search company or job title'), { target: { value: 'Unsubmitted' } });
    const count = f.list.mock.calls.length;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'List' })));
    expect((await screen.findByLabelText('Search company or job title') as HTMLInputElement).value).toBe('Unsubmitted');
    expect(new URL(f.list.mock.calls.at(-1)![0], 'http://127.0.0.1').searchParams.get('q')).toBe('Acme');
    expect(f.list.mock.calls.length).toBe(count + 1);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Archived' })));
    expect((await screen.findByLabelText('Search company or job title') as HTMLInputElement).value).toBe('');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Active' })));
    await f.board(); expect((screen.getByLabelText('Search company or job title') as HTMLInputElement).value).toBe('Unsubmitted');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Clear filters' })));
    expect(screen.queryByText('Not included by the current status filter.')).toBeNull();
  });
  it('preserves dirty drafts/history across presentations, retains selection consent and restores card focus on Cancel', async () => {
    const f = await setup(); await f.board(); await f.open();
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Unsaved draft' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false), histories = f.history.mock.calls.length;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'List' })));
    await f.board(); expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Unsaved draft');
    expect(f.history).toHaveBeenCalledTimes(histories); expect(confirm).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Edit application: Engineer at Other' })); expect(confirm).toHaveBeenCalledOnce();
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Unsaved draft');
    await act(async () => fireEvent.click(screen.getByRole('link', { name: 'Skip to content' })));
    expect(document.activeElement?.id).toBe('main'); expect(confirm).toHaveBeenCalledOnce();
    confirm.mockReturnValue(true); await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })));
    expect(screen.queryByRole('form', { name: 'Edit application' })).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit application: Engineer at Acme' }));
  });
  it('refreshes old/destination columns only after status history settles, retaining the editor', async () => {
    const f = await setup(); await f.board(); await f.open(); const before = f.list.mock.calls.length;
    const gate = deferred<Response>(); f.history.mockReturnValueOnce(gate.promise);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'APPLIED' } });
    fireEvent.change(screen.getByLabelText('Application date'), { target: { value: '2026-10-20' } });
    act(() => fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })));
    await waitFor(() => expect(f.trace.at(-1)).toBe('history')); expect(f.list).toHaveBeenCalledTimes(before);
    await act(async () => gate.resolve(json({ items: [...f.events.get(makeRow().id)!].reverse(), nextCursor: null })));
    await screen.findByText('Changes saved.');
    expect(f.statuses().slice(before).sort()).toEqual(['APPLIED', 'SAVED']); expect(f.write).toHaveBeenCalledOnce();
    expect(screen.getByRole('form', { name: 'Edit application' })).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Applied' })).getByRole('button', { name: /Acme/ })).toBeTruthy();
    expect(screen.getByText('Saved → Applied')).toBeTruthy(); expect(f.maximum()).toBe(1);
  });
  it('refreshes company membership but treats failed follow-up reads separately from confirmed saves', async () => {
    const f = await setup(); await f.board(); await f.open();
    f.list.mockImplementation(async () => json({ code: 'SERVICE_UNAVAILABLE', message: 'Unavailable' }, 503));
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Renamed' } });
    await act(async () => fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })));
    expect(await screen.findByText('Changes saved.')).toBeTruthy(); expect(screen.getByText(/This column could not be loaded/)).toBeTruthy();
    expect(f.write).toHaveBeenCalledOnce(); expect(f.statuses().at(-1)).toBe('SAVED');
    expect(screen.queryByText(/could not confirm whether your changes/)).toBeNull();
  });
  it('updates notes without resetting the column cursor or querying the board again', async () => {
    const f = await setup();
    const original = f.list.getMockImplementation()!;
    f.list.mockImplementation(async url => {
      const query = new URL(url, 'http://127.0.0.1').searchParams;
      return query.get('status') === 'SAVED' ? json({ items: [f.records.get(makeRow().id)], nextCursor: 'saved_next' }) : original(url);
    });
    await f.board(); await f.open(); const count = f.list.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Confirmed notes' } });
    await act(async () => fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })));
    await screen.findByText('Changes saved.'); expect(f.list).toHaveBeenCalledTimes(count);
    expect(screen.getByRole('button', { name: 'Load more Saved applications' })).toBeTruthy();
    expect(f.records.get(makeRow().id)?.notes).toBe('Confirmed notes');
  });
  it('loads independent extra pages, retries only the failed page and fully refreshes on request', async () => {
    const f = await setup(), original = f.list.getMockImplementation()!;
    let rejectApplied = true;
    f.list.mockImplementation(async url => {
      const query = new URL(url, 'http://127.0.0.1').searchParams, status = query.get('status'), cursor = query.get('cursor');
      if (status === 'SAVED') return json({ items: [makeRow(cursor ? 4 : 1)], nextCursor: cursor ? null : 'saved_next' });
      if (status === 'APPLIED') {
        if (cursor && rejectApplied) return json({ code: 'SERVICE_UNAVAILABLE', message: 'Unavailable' }, 503);
        return json({ items: [makeRow(cursor ? 5 : 3, 'APPLIED')], nextCursor: cursor ? null : 'applied_next' });
      }
      return original(url);
    });
    await f.board(); const before = f.list.mock.calls.length;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Load more Saved applications' })));
    expect(within(screen.getByRole('region', { name: 'Saved' })).getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByRole('button', { name: 'Load more Applied applications' })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Load more Applied applications' })));
    expect(screen.getByRole('button', { name: 'Retry Applied' })).toBeTruthy();
    expect(f.list).toHaveBeenCalledTimes(before + 2); rejectApplied = false;
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Retry Applied' })));
    expect(new URL(f.list.mock.calls.at(-1)![0], 'http://127.0.0.1').searchParams.get('cursor')).toBe('applied_next');
    expect(within(screen.getByRole('region', { name: 'Applied' })).getAllByRole('listitem')).toHaveLength(2);
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Refresh board' })));
    expect(f.list).toHaveBeenCalledTimes(before + 10); expect(f.statuses().slice(-7)).toEqual(boardStatuses);
    expect(within(screen.getByRole('region', { name: 'Saved' })).getAllByRole('listitem')).toHaveLength(1);
  });
  it('restores focus to the board heading when a saved status no longer matches the selected column', async () => {
    const f = await setup();
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'SAVED' } });
    await act(async () => fireEvent.submit(screen.getByRole('search')));
    await f.board(); await f.open();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'APPLIED' } });
    fireEvent.change(screen.getByLabelText('Application date'), { target: { value: '2026-10-20' } });
    await act(async () => fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })));
    expect(await screen.findByText('Changes saved.')).toBeTruthy(); expect(screen.getByText(/selected application is not in/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Cancel' })));
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Application board' }));
  });
  it('preserves dirty drafts and stale conflict reasons without automatically replaying PUT', async () => {
    const f = await setup(); await f.board(); await f.open();
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Retain draft' } });
    f.write.mockResolvedValueOnce(json({ code: 'APPLICATION_CONFLICT', conflictReason: 'STALE_VERSION', message: 'Changed' }, 409));
    await act(async () => fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })));
    expect(await screen.findByRole('button', { name: 'Review saved application' })).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Review saved application' })));
    expect((await screen.findByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Retain draft');
    expect(f.write).toHaveBeenCalledOnce(); expect(screen.getByText(/Read-only review/)).toBeTruthy();
  });
  it('retains an uncertain draft through read-only review without replaying mutation', async () => {
    const f = await setup(); await f.board(); await f.open();
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Uncertain draft' } });
    f.write.mockRejectedValueOnce(new Error('Transport lost'));
    await act(async () => fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })));
    expect(await screen.findByText(/this save will not be replayed/)).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Review saved application' })));
    expect(f.write).toHaveBeenCalledOnce(); expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Uncertain draft');
  });
  it('wires creation and archive/restore/delete without changing unrelated applications', async () => {
    const f = await setup(); await f.board(); const count = f.list.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Disposable' } }); fireEvent.change(screen.getByLabelText('Job title'), { target: { value: 'Engineer' } });
    await act(async () => fireEvent.submit(screen.getByRole('form', { name: 'Add application' })));
    expect(await screen.findByRole('button', { name: 'Edit application: Engineer at Disposable' })).toBeTruthy();
    expect(f.statuses().slice(count)).toEqual(['SAVED']); await f.open('Disposable');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Archive application' })));
    expect(screen.queryByRole('button', { name: /Edit application:.*Disposable/ })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Archived' })));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'View archived application: Engineer at Disposable' })));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'Restore application' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Active' })));
    await screen.findByRole('heading', { name: 'Application board' }); await f.open('Disposable');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Archive application' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Archived' })));
    await act(async () => fireEvent.click(await screen.findByRole('button', { name: 'View archived application: Engineer at Disposable' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Permanently delete' })));
    expect(document.activeElement?.textContent).toBe('Cancel deletion');
    await userEvent.keyboard('{Escape}'); expect(screen.queryByRole('button', { name: 'Cancel deletion' })).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Permanently delete' })));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Permanently delete application' })));
    expect(f.records.has(makeRow(3).id)).toBe(false); expect(f.records.has(makeRow().id)).toBe(true); expect(f.records.has(makeRow(2).id)).toBe(true);
  });
  it('pauses for explicit Retry-After and exposes an honest failed column without a retry loop', async () => {
    const f = await setup();
    f.list.mockResolvedValueOnce(json({ code: 'RATE_LIMITED', message: 'Wait' }, 429, { 'Retry-After': '60' }));
    await f.board(); expect(screen.getByText('Too many requests. Wait before retrying.')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Retry Saved' }) as HTMLButtonElement).disabled).toBe(true);
    expect(f.statuses()).toEqual([null, 'SAVED']); expect(screen.getAllByText('Not loaded yet.')).toHaveLength(6);
  });
  it('clears board presentation and private data on confirmed account replacement', async () => {
    const f = await setup(); await f.board(); await f.open();
    f.auth.api.me.mockResolvedValue({ user: { ...user, id: makeRow(99).id } }); f.records.clear();
    await act(async () => { await f.auth.store.revalidate(); });
    expect(await screen.findByRole('button', { name: 'List' })).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Edit application' })).toBeNull(); expect(screen.queryByText('Acme')).toBeNull();
    expect(screen.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')).toBe('true');
  });
  it('restores focus lost to verified-content remounts without stealing intentionally cleared focus', async () => {
    const f = await setup(); await f.board(); await f.open();
    const notes = screen.getByLabelText('Notes (optional)'); notes.focus();
    await act(async () => { await f.auth.store.revalidate(); });
    expect(document.activeElement).toBe(await screen.findByLabelText('Notes (optional)'));
    (document.activeElement as HTMLElement).blur(); expect(document.activeElement).toBe(document.body);
    await act(async () => { await f.auth.store.revalidate(); });
    expect(document.activeElement).toBe(document.body);
  });
});

describe('pending-read workspace handoff through actual admission', () => {
  it('settles coalesced presentation intents without leaving List disabled or starting discarded Board work', async () => {
    const f = await setup(false), api = createApplicationsApi(f.auth.store);
    const hook = renderHook(() => useApplicationWorkspace(f.auth.store, api)); await act(async () => hook.result.current.enter());
    await act(async () => { hook.result.current.selectPresentation('board'); hook.result.current.selectPresentation('list'); });
    expect(hook.result.current.isBoard).toBe(false); expect(f.statuses().every(status => status === null)).toBe(true);
    const count = f.list.mock.calls.length;
    await act(async () => hook.result.current.applications.refresh()); expect(f.list).toHaveBeenCalledTimes(count + 1);
    hook.unmount();
  });
  it('waits for ignored cancellation, opens editor/history, then resumes every pending board column', async () => {
    const f = await setup(false), gate = deferred<Response>(), api = createApplicationsApi(f.auth.store);
    const hook = renderHook(() => useApplicationWorkspace(f.auth.store, api));
    await act(async () => hook.result.current.enter());
    f.list.mockReturnValueOnce(gate.promise);
    act(() => hook.result.current.selectPresentation('board'));
    await waitFor(() => expect(f.statuses()).toEqual([null, 'SAVED']));
    act(() => hook.result.current.editor.open(makeRow(2).id));
    expect(f.fetcher.mock.calls.at(-1)![1]?.signal?.aborted).toBe(true); expect(f.trace).not.toContain('detail');
    await act(async () => gate.resolve(json({ items: [makeRow()], nextCursor: null })));
    await waitFor(() => expect(hook.result.current.editor.historyLoading).toBe(false));
    await waitFor(() => expect(f.statuses().slice(-7)).toEqual(boardStatuses));
    expect(hook.result.current.editor.selectedId).toBe(makeRow(2).id); expect(hook.result.current.editor.application?.company).toBe('Other');
    expect(f.maximum()).toBe(1); expect(f.trace.indexOf('history')).toBeLessThan(f.trace.lastIndexOf('list:SAVED')); hook.unmount();
  });
  it('drops queued editor intent and old data when a pending read discovers account replacement', async () => {
    const f = await setup(false), gate = deferred<{ user: typeof user }>(), api = createApplicationsApi(f.auth.store);
    const hook = renderHook(() => useApplicationWorkspace(f.auth.store, api)); await act(async () => hook.result.current.enter());
    f.auth.api.me.mockReturnValueOnce(gate.promise);
    act(() => hook.result.current.selectPresentation('board'));
    await waitFor(() => expect(f.auth.store.getSnapshot().busy).toBe(true));
    act(() => hook.result.current.editor.open(makeRow().id));
    await act(async () => gate.resolve({ user: { ...user, id: makeRow(99).id } }));
    expect(hook.result.current.presentation).toBe('list'); expect(hook.result.current.editor.selectedId).toBeNull();
    expect(f.trace).not.toContain('detail'); expect(hook.result.current.board.columns.SAVED.items).toEqual([]); hook.unmount();
  });
  it('preserves filters and board pages through same-account verification without extra collection reads', async () => {
    const f = await setup(); await f.board(); const count = f.list.mock.calls.length;
    fireEvent.change(screen.getByLabelText('Search company or job title'), { target: { value: 'Draft criteria' } });
    await act(async () => { await f.auth.store.revalidate(); });
    expect((await screen.findByLabelText('Search company or job title') as HTMLInputElement).value).toBe('Draft criteria');
    expect(f.list).toHaveBeenCalledTimes(count); expect(screen.getByRole('button', { name: 'Edit application: Engineer at Acme' })).toBeTruthy();
  });
  it('clears private state after confirmed logout rather than replaying any application operation', async () => {
    const f = await setup(); await f.board();
    f.auth.api.me.mockRejectedValue(new AuthFailure('http', 401, 'UNAUTHENTICATED'));
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Sign out' })));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Application board' })).toBeNull(); expect(f.write).not.toHaveBeenCalled();
  });
});
