import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Application } from '@applyflow/contracts';
import { App } from '../../App';
import { authFixture, deferred, user } from '../../test/auth-fixtures';

const row: Application = { id: 'c4974360-a70c-4a29-8b41-df95d15d7270', version: 4, company: 'Acme', jobTitle: 'Engineer',
  status: 'INTERVIEW', applicationDate: '2024-02-29', location: 'Manila', jobUrl: 'https://example.invalid/job', notes: 'Saved notes',
  createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z', archivedAt: null };
const archived: Application = { ...row, id: 'a4974360-a70c-4a29-8b41-df95d15d7270', company: 'Kept company', archivedAt: row.createdAt };
const sibling: Application = { ...row, id: 'b4974360-a70c-4a29-8b41-df95d15d7270', company: 'Other company' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fixtures: ReturnType<typeof authFixture>[] = [];
afterEach(() => { fixtures.splice(0).forEach(f => f.store.dispose()); });

// Component-level HTTP double only; no server, browser or database is started.
async function start() {
  const auth = authFixture({ authenticated: true }); fixtures.push(auth);
  const records = new Map([row, sibling, archived].map(value => [value.id, { ...value }]));
  const writes = vi.fn(async (url: string, init: RequestInit) => {
    const id = url.split('/')[3]!, value = records.get(id)!;
    const body = JSON.parse(String(init.body)) as { expectedVersion: number };
    expect(body.expectedVersion).toBe(value.version);
    if (init.method === 'DELETE') { records.delete(id); return json({ deletedApplicationId: id }); }
    const updated = { ...value, version: value.version + 1, archivedAt: url.endsWith('/archive') ? row.createdAt : null };
    records.set(id, updated); return json({ application: updated });
  });
  const detail = vi.fn(async (id: string) => records.has(id) ? json({ application: records.get(id) }) : json({ code: 'NOT_FOUND', message: 'Unavailable.' }, 404));
  const history = vi.fn(async (url: string) => json({ items: [url.includes('cursor=')
    ? { id: row.id, fromStatus: 'SAVED', toStatus: 'APPLIED', applicationVersion: 2, changedAt: row.createdAt }
    : { id: user.id, fromStatus: 'APPLIED', toStatus: 'INTERVIEW', applicationVersion: 3, changedAt: row.createdAt }], nextCursor: url.includes('cursor=') ? null : '3' }));
  const list = vi.fn(async (url: string) => {
    const params = new URL(url, 'http://127.0.0.1').searchParams, view = params.get('view') ?? 'active';
    return json({ items: auth.store.getSnapshot().user?.id === user.id ? [...records.values()].filter(value => (value.archivedAt === null) === (view === 'active')) : [],
      nextCursor: params.has('cursor') ? null : `${view}-cursor` });
  });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (init?.method !== 'GET') return (await writes(target, init!)).clone();
    if (target.includes('/history?')) return (await history(target)).clone();
    if (target.startsWith('/api/applications/')) return (await detail(target.split('/')[3]!)).clone();
    return (await list(target)).clone();
  });
  vi.stubGlobal('fetch', fetcher);
  const view = render(<StrictMode><MemoryRouter initialEntries={['/app']}><App authStore={auth.store} /></MemoryRouter></StrictMode>);
  await screen.findByRole('button', { name: 'Edit application: Engineer at Acme' });
  async function openActive() {
    fireEvent.click(screen.getByRole('button', { name: 'Edit application: Engineer at Acme' })); await screen.findByRole('form', { name: 'Edit application' });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Archive application' }) as HTMLButtonElement).disabled).toBe(false));
  }
  async function openArchived() {
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    fireEvent.click(await screen.findByRole('button', { name: 'View archived application: Engineer at Kept company' }));
    await screen.findByRole('heading', { name: 'Archived application' });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Restore application' }) as HTMLButtonElement).disabled).toBe(false));
  }
  return { ...view, auth, records, writes, detail, history, list, fetcher, openActive, openArchived };
}

describe('workspace lifecycle interactions', () => {
  it('switches accessible views with fresh pagination and shows creation only in Active', async () => {
    const f = await start();
    expect(screen.getByRole('button', { name: 'Active' }).getAttribute('aria-pressed')).toBe('true');
    const pushes = vi.spyOn(window.history, 'pushState');
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    await screen.findByRole('heading', { name: 'Archived applications' });
    expect(screen.queryByRole('form')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load more applications' }));
    await waitFor(() => expect(f.list.mock.calls.some(([url]) => url.includes('view=archived') && url.includes('cursor=archived-cursor'))).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Active' }));
    await screen.findByRole('button', { name: 'Edit application: Engineer at Acme' });
    expect(f.list.mock.calls.at(-1)![0]).not.toContain('cursor='); expect(pushes).not.toHaveBeenCalled();
  });
  it('keeps a dirty draft until archive succeeds and preserves sibling entries and Load more', async () => {
    const f = await start(); await f.openActive();
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Unsaved note' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Archive application' })); expect(f.writes).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Unsaved note');
    confirm.mockReturnValue(true); const gate = deferred<Response>(); f.writes.mockReturnValueOnce(gate.promise);
    fireEvent.click(screen.getByRole('button', { name: 'Archive application' }));
    await waitFor(() => expect(f.writes).toHaveBeenCalledOnce());
    await act(async () => { gate.resolve(json({ application: { ...row, version: 5, archivedAt: row.createdAt } })); });
    await screen.findByText(/Application archived. Its details and history are preserved/);
    expect(screen.queryByRole('button', { name: 'Edit application: Engineer at Acme' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Edit application: Engineer at Other company' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load more applications' })).toBeTruthy(); expect(f.list).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Your applications' }));
  });
  it('renders archived fields/history without edit controls and loads older changes', async () => {
    const f = await start(); await f.openArchived(); const panel = document.getElementById('application-detail-panel')!;
    expect(within(panel).getByText('Saved notes')).toBeTruthy(); expect(within(panel).getByText('Interview')).toBeTruthy();
    expect(within(panel).getByText('2024-02-29')).toBeTruthy(); expect(within(panel).queryByRole('form')).toBeNull();
    expect(within(panel).queryByRole('textbox')).toBeNull(); expect(within(panel).queryByRole('button', { name: 'Save changes' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load older changes' }));
    await waitFor(() => expect(f.history.mock.calls.at(-1)![0]).toContain('cursor=3'));
    await screen.findByText(/Revision 2/); expect(screen.queryByText(/Status history could not be loaded/)).toBeNull();
  });
  it('restores without switching view and preserves unrelated archived records and cursor', async () => {
    const f = await start(); f.records.set(sibling.id, { ...sibling, archivedAt: row.createdAt }); await f.openArchived();
    fireEvent.click(screen.getByRole('button', { name: 'Restore application' }));
    await screen.findByText(/Application restored. Refresh Active applications/);
    expect(screen.getByRole('button', { name: 'Archived' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'View archived application: Engineer at Other company' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load more applications' })).toBeTruthy();
    expect(f.writes.mock.calls[0]![0]).toBe(`/api/applications/${archived.id}/restore`);
  });
  it('uses fresh archived detail for a stale Active entry and announces restore in the current view', async () => {
    const f = await start(); f.records.set(row.id, { ...row, archivedAt: row.createdAt });
    fireEvent.click(screen.getByRole('button', { name: 'Edit application: Engineer at Acme' }));
    await screen.findByRole('heading', { name: 'Archived application' });
    await waitFor(() => expect((screen.getByRole('button', { name: 'Restore application' }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: 'Restore application' }));
    await screen.findByText('Application restored. Its original creation order is preserved.');
    expect(screen.getByRole('button', { name: 'Active' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Edit application: Engineer at Acme' })).toBeTruthy();
  });
  it('requires explicit inline deletion confirmation, focuses Cancel, and restores focus on Escape/cancellation', async () => {
    const f = await start(); await f.openArchived(); const keyboard = userEvent.setup();
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete' }));
    expect(screen.getByRole('heading', { name: 'Permanently delete Engineer at Kept company?' })).toBeTruthy();
    expect(screen.getByText(/permanently removes the application and all its status history/)).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel deletion' })); expect(f.writes).not.toHaveBeenCalled();
    await keyboard.keyboard('{Escape}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Permanently delete' }));
    fireEvent.click(document.activeElement!); fireEvent.click(screen.getByRole('button', { name: 'Cancel deletion' }));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Permanently delete' })); expect(f.writes).not.toHaveBeenCalled();
    fireEvent.click(document.activeElement!); fireEvent.click(screen.getByRole('button', { name: 'Permanently delete application' }));
    await screen.findByText('Application permanently deleted.');
    expect(JSON.parse(String(f.writes.mock.calls[0]![1].body))).toEqual({ expectedVersion: 4, confirmPermanentDeletion: true });
    expect(f.writes.mock.calls[0]![1].method).toBe('DELETE'); expect(screen.queryByRole('heading', { name: 'Archived application' })).toBeNull();
  });
  it('protects dirty drafts on view switching and keeps Skip to content functional', async () => {
    const f = await start(); await f.openActive(); fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Keep draft' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Keep draft'); expect(f.list).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('link', { name: 'Skip to content' })); expect(confirm).toHaveBeenCalledOnce();
    expect((await screen.findByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Keep draft');
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: 'Archived' }));
    await screen.findByRole('heading', { name: 'Archived applications' }); expect(screen.queryByLabelText('Notes (optional)')).toBeNull();
  });
  it.each(['STALE_VERSION', 'APPLICATION_ARCHIVED', 'APPLICATION_NOT_ARCHIVED'] as const)('explains %s while retaining explicit recovery', async conflictReason => {
    const f = await start(); await f.openActive();
    f.writes.mockResolvedValueOnce(json({ code: 'APPLICATION_CONFLICT', conflictReason, message: 'Do not display this' }, 409));
    fireEvent.click(screen.getByRole('button', { name: 'Archive application' }));
    await screen.findByRole('button', { name: 'Review saved application' });
    const expected = conflictReason === 'APPLICATION_ARCHIVED' ? /is archived and cannot be edited/ : conflictReason === 'APPLICATION_NOT_ARCHIVED' ? /is active and cannot be permanently deleted/ : /changed elsewhere/;
    expect(screen.getByText(expected)).toBeTruthy(); expect(screen.queryByText('Do not display this')).toBeNull();
    expect(screen.getByRole('button', { name: 'Reload and discard draft' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review saved application' })); await screen.findByRole('heading', { name: /Saved version/ });
    expect(f.writes).toHaveBeenCalledOnce();
  });
  it('does not attribute an uncertain deletion to a later unavailable record or replay it', async () => {
    const f = await start(); await f.openArchived(); f.writes.mockRejectedValueOnce(new Error('private'));
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Permanently delete application' }));
    await screen.findByText(/could not confirm the permanent deletion/);
    f.records.delete(archived.id); fireEvent.click(screen.getByRole('button', { name: 'Review saved application' }));
    await screen.findByText(/cannot determine which request removed it/);
    expect(f.writes).toHaveBeenCalledOnce(); expect(screen.queryByText('Application permanently deleted.')).toBeNull();
  });
  it('reviews the current archive state without replacing the draft and requires consent before reload', async () => {
    const f = await start(); await f.openActive();
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Retained draft' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    f.writes.mockRejectedValueOnce(new Error('Uncertain network result'));
    fireEvent.click(screen.getByRole('button', { name: 'Archive application' }));
    await screen.findByRole('button', { name: 'Review saved application' });
    f.records.set(row.id, { ...row, version: 5, archivedAt: row.createdAt });
    fireEvent.click(screen.getByRole('button', { name: 'Review saved application' }));
    await screen.findByText('This application is archived.');
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Retained draft');
    confirm.mockReturnValue(false); fireEvent.click(screen.getByRole('button', { name: 'Reload and discard draft' }));
    expect(screen.getByLabelText('Notes (optional)')).toBeTruthy();
    confirm.mockReturnValue(true); fireEvent.click(screen.getByRole('button', { name: 'Reload and discard draft' }));
    await screen.findByRole('heading', { name: 'Archived application' });
    expect(screen.queryByRole('form', { name: 'Edit application' })).toBeNull(); expect(f.writes).toHaveBeenCalledOnce();
  });
});
