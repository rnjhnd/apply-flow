import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Application } from '@applyflow/contracts';
import { App } from '../../App';
import { authFixture, deferred, user } from '../../test/auth-fixtures';

const row: Application = { id: 'c4974360-a70c-4a29-8b41-df95d15d7270', version: 4, company: 'Acme', jobTitle: 'Engineer',
  status: 'INTERVIEW', applicationDate: '2024-02-29', location: null, jobUrl: null, notes: 'Saved notes', archivedAt: null,
  createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z' };
const sibling = { ...row, id: user.id, company: 'Other' };
const event = { id: user.id, fromStatus: 'APPLIED', toStatus: 'INTERVIEW', applicationVersion: 3, changedAt: row.createdAt };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fixtures: ReturnType<typeof authFixture>[] = [];
afterEach(() => { fixtures.splice(0).forEach(f => f.store.dispose()); });

// Controlled HTTP responses exercise the real frontend auth/transport composition.
// This is jsdom, not a server/browser session or evidence of SQL matching.
async function start() {
  const auth = authFixture({ authenticated: true }); fixtures.push(auth);
  let saved = { ...row };
  const trace: string[] = [];
  const list = vi.fn<(url: string) => Promise<Response>>().mockImplementation(async () => json({ items: [saved, sibling], nextCursor: 'older' }));
  const history = vi.fn<() => Promise<Response>>().mockImplementation(async () => json({ items: [event], nextCursor: null }));
  const write = vi.fn(async (_url: string, init: RequestInit) => {
    const fields = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(fields.expectedVersion).toBe(saved.version);
    delete fields.expectedVersion;
    saved = { ...saved, ...fields, version: saved.version + 1 } as Application;
    return json({ application: saved });
  });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    const target = String(url);
    if (init?.method === 'PUT') { trace.push('write'); return (await write(target, init)).clone(); }
    if (target.includes('/history?')) { trace.push('history'); return (await history()).clone(); }
    if (target.startsWith('/api/applications/')) return json({ application: saved });
    trace.push('list'); return (await list(target)).clone();
  });
  vi.stubGlobal('fetch', fetcher);
  render(<StrictMode><MemoryRouter initialEntries={['/app']}><App authStore={auth.store} /></MemoryRouter></StrictMode>);
  await screen.findByRole('button', { name: 'Edit application: Engineer at Acme' });
  const open = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Edit application: Engineer at Acme' }));
    await screen.findByLabelText('Notes (optional)');
    await waitFor(() => expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(false));
  };
  const search = async (q: string, status = '') => {
    fireEvent.change(screen.getByLabelText('Search company or job title'), { target: { value: q } });
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: status } });
    await act(async () => { fireEvent.submit(screen.getByRole('search', { name: 'Search applications' })); });
    await screen.findByRole('search', { name: 'Search applications' });
  };
  return { auth, list, history, write, trace, open, search };
}

describe('accessible workspace search/filter interactions', () => {
  it('labels native controls, waits for Enter/Search, reflects unapplied input and never pushes browser history', async () => {
    const f = await start(), ui = userEvent.setup(), push = vi.spyOn(window.history, 'pushState'), replace = vi.spyOn(window.history, 'replaceState');
    expect(screen.getByRole('search', { name: 'Search applications' })).toBeTruthy();
    expect(within(screen.getByLabelText('Filter by status')).getAllByRole('option')).toHaveLength(8);
    await ui.type(screen.getByLabelText('Search company or job title'), ' Acme ');
    await ui.selectOptions(screen.getByLabelText('Filter by status'), 'INTERVIEW');
    expect(f.list).toHaveBeenCalledOnce(); expect(screen.getByText(/Filter changes have not been applied/)).toBeTruthy();
    await ui.click(screen.getByLabelText('Search company or job title')); await ui.keyboard('{Enter}');
    await waitFor(() => expect(f.list).toHaveBeenCalledTimes(2));
    expect(new URL(f.list.mock.calls[1]![0], 'https://example.invalid').searchParams.get('q')).toBe('Acme');
    await screen.findByLabelText('Search company or job title');
    expect((screen.getByLabelText('Search company or job title') as HTMLInputElement).value).toBe('Acme');
    expect(screen.queryByText(/Filter changes have not been applied/)).toBeNull();
    expect(document.activeElement).toBe(screen.getByLabelText('Search company or job title'));
    expect(push).not.toHaveBeenCalled(); expect(replace).not.toHaveBeenCalled();
  });
  it('preserves dirty editor and history on Search/Clear, including when its row is outside complete results', async () => {
    const f = await start(); await f.open();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Private unsaved draft' } });
    f.list.mockResolvedValueOnce(json({ items: [], nextCursor: null }));
    await f.search('No matching result');
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Private unsaved draft');
    expect(screen.getByText(/selected application is not in the current results/)).toBeTruthy();
    expect(screen.getByText(/Applied.*Interview/)).toBeTruthy();
    expect(f.history).toHaveBeenCalledOnce(); expect(confirm).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear filters' })); });
    await screen.findByLabelText('Notes (optional)'); expect(f.list.mock.calls.at(-1)![0]).toBe('/api/applications?limit=20');
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Private unsaved draft');
    expect(confirm).not.toHaveBeenCalled(); expect(f.write).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Edit application: Engineer at Other/ })); expect(confirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Archived' })); expect(confirm).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' })); expect(confirm).toHaveBeenCalledTimes(3);
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Private unsaved draft');
  });
  it('does not claim a selected row fails filters when an unloaded page may contain it', async () => {
    const f = await start(); await f.open();
    f.list.mockResolvedValueOnce(json({ items: [sibling], nextCursor: 'more' }));
    await f.search('Some search');
    expect(screen.queryByText(/selected application is not in the current results/)).toBeNull();
    expect(screen.getByRole('form', { name: 'Edit application' })).toBeTruthy();
  });
  it('preserves both filter drafts and applied values through real same-account reconciliation', async () => {
    const f = await start(); await f.search('Active phrase', 'INTERVIEW');
    fireEvent.change(screen.getByLabelText('Search company or job title'), { target: { value: 'Active draft' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Archived' })); });
    await screen.findByLabelText('Search company or job title'); await f.search('Archived phrase', 'OFFER');
    fireEvent.change(screen.getByLabelText('Search company or job title'), { target: { value: 'Archived draft' } });
    await act(async () => { await f.auth.store.revalidate(); });
    expect((await screen.findByLabelText('Search company or job title') as HTMLInputElement).value).toBe('Archived draft');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Active' })); });
    expect((await screen.findByLabelText('Search company or job title') as HTMLInputElement).value).toBe('Active draft');
    const params = new URL(f.list.mock.calls.at(-1)![0], 'https://example.invalid').searchParams;
    expect(params.get('q')).toBe('Active phrase'); expect(params.get('status')).toBe('INTERVIEW'); expect(params.has('cursor')).toBe(false);
  });
  it('announces filtered versus unfiltered empty results and focuses invalid input without dispatch', async () => {
    const f = await start(); f.list.mockResolvedValue(json({ items: [], nextCursor: null }));
    await f.search('No matches'); expect(screen.getByRole('heading', { name: 'No matching applications' })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Clear filters' })); });
    await screen.findByText(/No applications saved yet/);
    const count = f.list.mock.calls.length;
    await f.search('x'.repeat(201));
    expect(f.list).toHaveBeenCalledTimes(count); expect(screen.getByRole('alert').textContent).toContain('200');
    expect(screen.getByLabelText('Search company or job title').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('Search company or job title'));
  });
  it('refreshes company/title membership only after a confirmed save and keeps success on a failed read', async () => {
    const f = await start(); await f.search('Acme', 'INTERVIEW'); await f.open();
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'New company' } });
    f.list.mockResolvedValueOnce(json({ code: 'SERVICE_UNAVAILABLE', message: 'Unavailable.' }, 503));
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })); });
    await screen.findByText('Changes saved.'); await screen.findByText(/Applications could not be loaded/);
    expect(f.list.mock.calls.at(-1)![0]).toContain('q=Acme'); expect(f.write).toHaveBeenCalledOnce();
    expect((screen.getByLabelText('Company') as HTMLInputElement).value).toBe('New company');
    expect(screen.queryByText(/could not confirm whether your changes/)).toBeNull();
  });
  it('preserves pages after notes-only edits and orders status history before the list reconciliation', async () => {
    const f = await start(); await f.open();
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Notes edit' } });
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })); });
    await screen.findByText('Changes saved.'); expect(f.list).toHaveBeenCalledOnce();
    expect(screen.getByRole('button', { name: 'Load more applications' })).toBeTruthy();
    const gate = deferred<Response>(); f.history.mockReturnValueOnce(gate.promise);
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'OFFER' } });
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })); });
    await waitFor(() => expect(f.history).toHaveBeenCalledTimes(2)); expect(f.list).toHaveBeenCalledOnce();
    await act(async () => { gate.resolve(json({ items: [{ ...event, fromStatus: 'INTERVIEW', toStatus: 'OFFER', applicationVersion: 6 }], nextCursor: null })); });
    await waitFor(() => expect(f.list).toHaveBeenCalledTimes(2));
    expect(f.trace.slice(-3)).toEqual(['write', 'history', 'list']);
    expect(screen.getByRole('form', { name: 'Edit application' })).toBeTruthy();
  });
  it('keeps an uncertain save draft and recovery controls through Search without replaying PUT', async () => {
    const f = await start(); await f.open(); f.write.mockRejectedValueOnce(new Error('Disconnected'));
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Uncertain draft' } });
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })); });
    await screen.findByText(/could not confirm whether your changes were saved/);
    f.list.mockResolvedValueOnce(json({ items: [], nextCursor: null })); await f.search('Another query');
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Uncertain draft');
    expect(screen.getByRole('button', { name: 'Review saved application' })).toBeTruthy();
    expect(f.write).toHaveBeenCalledOnce(); expect(f.history).toHaveBeenCalledOnce();
  });
  it('treats a successful edit missing from refreshed results as saved and retains its editor', async () => {
    const f = await start(); await f.search('Acme'); await f.open();
    f.list.mockResolvedValueOnce(json({ items: [], nextCursor: null }));
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Outside search' } });
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })); });
    await screen.findByText('Changes saved.'); await screen.findByRole('heading', { name: 'No matching applications' });
    expect((screen.getByLabelText('Company') as HTMLInputElement).value).toBe('Outside search');
    expect(screen.getByText(/selected application is not in the current results/)).toBeTruthy(); expect(f.write).toHaveBeenCalledOnce();
  });
  it('keeps editor focus on ordinary rerenders and provides responsive native controls', async () => {
    const f = await start(); await f.open(); await f.search('Acme');
    const notes = screen.getByLabelText('Notes (optional)'); notes.focus();
    await act(async () => { await Promise.resolve(); }); expect(document.activeElement).toBe(notes);
    expect(screen.getByRole('search').className).toContain('space-y-4');
    expect(screen.getByLabelText('Search company or job title').className).toContain('min-w-0');
  });
});
