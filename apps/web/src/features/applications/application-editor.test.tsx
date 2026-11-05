import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter, MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Application } from '@applyflow/contracts';
import { App } from '../../App';
import { authFixture, deferred, user } from '../../test/auth-fixtures';
import { AuthFailure } from '../../lib/auth/api';

const row: Application = { id: 'c4974360-a70c-4a29-8b41-df95d15d7270', version: 1, archivedAt: null, company: 'Acme', jobTitle: 'Engineer', status: 'SAVED',
  applicationDate: null, location: 'Manila', jobUrl: 'https://example.invalid/job', notes: 'First\n  Second',
  createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z' };
const event = { id: user.id, fromStatus: 'SAVED', toStatus: 'APPLIED', applicationVersion: 2, changedAt: row.createdAt };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const fixtures: ReturnType<typeof authFixture>[] = [];
afterEach(() => { fixtures.splice(0).forEach(f => f.store.dispose()); });
async function start(options: { listed?: Application[]; detail?: Application; browser?: boolean;
  unknownEntry?: 'back' | 'forward'; historyIndex?: number | undefined } = {}) {
  const auth = authFixture({ authenticated: true }); fixtures.push(auth);
  let saved = options.detail ?? row;
  const put = vi.fn(async (body: Record<string, unknown>) => {
    const editable = { ...body }; delete editable.expectedVersion;
    const changed = Object.entries(editable).some(([key, value]) => saved[key as keyof Application] !== value);
    saved = { ...saved, ...editable, version: saved.version + (changed ? 1 : 0) } as Application;
    return json({ application: saved });
  });
  const history = vi.fn<(url: string) => Promise<Response>>().mockResolvedValue(json({ items: [], nextCursor: null }));
  const detail = vi.fn<(id: string) => Promise<Response>>().mockImplementation(async id => json({ application: { ...saved, id } }));
  const list = vi.fn<(url: string) => Promise<Response>>().mockImplementation(async () => json({
    items: auth.store.getSnapshot().user?.id === user.id ? (options.listed ?? [row]).map(item => put.mock.calls.length && item.id === saved.id ? saved : item) : [], nextCursor: null
  }));
  const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    const target = String(url);
    // A configured response models repeated HTTP responses, each with its own body.
    if (init?.method === 'PUT') return (await put(JSON.parse(init.body as string))).clone();
    if (target.includes('/history?')) return (await history(target)).clone();
    if (target.startsWith('/api/applications/')) return (await detail(target.split('/').at(-1)!)).clone();
    return (await list(target)).clone();
  });
  vi.stubGlobal('fetch', fetcher);
  if (options.browser) {
    const state = { idx: options.historyIndex, key: 'start' };
    window.history.replaceState(state, '', options.unknownEntry === 'back' ? '/older-unknown' : '/app');
    if (options.unknownEntry === 'back') window.history.pushState(state, '', '/app');
    if (options.unknownEntry === 'forward') {
      window.history.pushState(state, '', '/newer-unknown');
      await new Promise<void>(resolve => {
        window.addEventListener('popstate', () => resolve(), { once: true });
        window.history.back();
      });
    }
  }
  const view = render(<StrictMode>{options.browser
    ? <BrowserRouter><App authStore={auth.store} /></BrowserRouter>
    : <MemoryRouter initialEntries={['/app']}><App authStore={auth.store} /></MemoryRouter>}</StrictMode>);
  await screen.findByRole('button', { name: /Edit application:/ });
  const open = async () => {
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: /Edit application:/ })[0]!); });
    return screen.findByRole('form', { name: 'Edit application' });
  };
  return { auth, fetcher, put, detail, history, list, open, ...view };
}
describe('accessible workspace editor through the real authenticated gateway', () => {
  it('prefills seven fresh fields and keeps the detail panel before the list with shared accessible controls', async () => {
    const f = await start({ detail: { ...row, company: 'Fresh company', version: 4 } }); await f.open();
    expect((screen.getByLabelText('Company') as HTMLInputElement).value).toBe('Fresh company');
    expect((screen.getByLabelText('Job title') as HTMLInputElement).value).toBe('Engineer');
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('SAVED');
    expect((screen.getByLabelText('Application date') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('Location (optional)') as HTMLInputElement).value).toBe('Manila');
    expect((screen.getByLabelText('Job URL (optional)') as HTMLInputElement).value).toBe(row.jobUrl);
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe(row.notes);
    const heading = screen.getByRole('heading', { name: 'Edit application' }); expect(document.activeElement).toBe(heading);
    await userEvent.setup().tab(); expect(document.activeElement).toBe(screen.getByLabelText('Company'));
    expect(document.getElementById('application-detail-panel')!.compareDocumentPosition(document.getElementById('applications-heading')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText(/No status changes recorded yet/)).toBeTruthy(); expect(f.detail).toHaveBeenCalledOnce();
  });
  it('focuses local validation errors and does not send an incomplete edit', async () => {
    const f = await start(); await f.open();
    fireEvent.change(screen.getByLabelText('Job title'), { target: { value: '' } });
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })); });
    expect(document.activeElement).toBe(screen.getByRole('alert'));
    const field = screen.getByLabelText('Job title'); expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(field.getAttribute('aria-describedby')!)?.textContent).toContain('Review');
    expect(f.put).not.toHaveBeenCalled();
  });
  it('uses explicit retry after a detail failure without initializing from stale list data', async () => {
    const f = await start(); f.detail.mockResolvedValueOnce(json({ code: 'SERVICE_UNAVAILABLE', message: 'Unavailable.' }, 503));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Edit application:/ })); });
    expect(await screen.findByText(/Application details could not be loaded/)).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Edit application' })).toBeNull(); expect(f.detail).toHaveBeenCalledOnce(); expect(f.history).not.toHaveBeenCalled();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry application details' })); });
    expect(await screen.findByRole('form', { name: 'Edit application' })).toBeTruthy(); expect(f.detail).toHaveBeenCalledTimes(2);
  });
  it('focuses sanitized server field errors and preserves the rejected draft', async () => {
    const f = await start(); await f.open(); fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Draft' } });
    f.put.mockResolvedValue(json({ code: 'INVALID_REQUEST', message: 'PRIVATE', fieldErrors: { company: ['PRIVATE'] } }, 400));
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })); });
    expect(await screen.findByText(/Changes were not accepted/)).toBeTruthy(); expect(document.activeElement).toBe(screen.getByRole('alert'));
    expect(screen.getByLabelText('Company').getAttribute('aria-invalid')).toBe('true');
    expect((screen.getByLabelText('Company') as HTMLInputElement).value).toBe('Draft'); expect(screen.queryByText(/PRIVATE/)).toBeNull();
  });
  it('keeps an unfinished creation draft when opening and closing an editor', async () => {
    const f = await start(); fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Unfinished new role' } });
    await f.open(); expect((screen.getByLabelText('Company') as HTMLInputElement).value).toBe(row.company);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect((screen.getByLabelText('Company') as HTMLInputElement).value).toBe('Unfinished new role');
  });
  it('extracts autofill values, sends all eight keys and updates the matching list entry', async () => {
    const f = await start(); await f.open();
    (screen.getByLabelText('Company') as HTMLInputElement).value = ' Edited company ';
    (screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value = 'Keep\n  formatting';
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })); });
    await screen.findByText('Changes saved.');
    expect(f.put.mock.calls[0]![0]).toEqual({ company: 'Edited company', jobTitle: row.jobTitle, status: 'SAVED', applicationDate: null,
      location: row.location, jobUrl: row.jobUrl, notes: 'Keep\n  formatting', expectedVersion: 1 });
    expect(within(screen.getByRole('region', { name: 'Your applications' })).getByText('Edited company')).toBeTruthy();
    expect(f.list).toHaveBeenCalledTimes(2); expect(f.history).toHaveBeenCalledOnce(); expect(f.put).toHaveBeenCalledOnce();
  });
  it('reports a no-op honestly and preserves its revision', async () => {
    const f = await start(); await f.open();
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })); });
    expect(await screen.findByText(/No changes needed/)).toBeTruthy(); expect(screen.getByText('Revision 1')).toBeTruthy();
    expect(f.put).toHaveBeenCalledOnce(); expect(f.history).toHaveBeenCalledOnce();
  });
  it('confirms dirty cancellation and restores focus to the current Edit action', async () => {
    const f = await start(); await f.open(); fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Draft' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(screen.getByRole('form', { name: 'Edit application' })).toBeTruthy();
    confirm.mockReturnValue(true); await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); });
    expect(screen.getByRole('form', { name: 'Add application' })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Edit application:/ })); expect(f.put).not.toHaveBeenCalled();
  });
  it('preserves a dirty editor across temporary protected-content unmounts for the same account', async () => {
    const f = await start(); await f.open(); fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Private draft' } });
    const gate = deferred<{ user: typeof user }>(); f.auth.api.me.mockReturnValueOnce(gate.promise);
    let verify!: Promise<unknown>;
    act(() => { verify = f.auth.store.revalidate(); }); expect(screen.queryByRole('form', { name: 'Edit application' })).toBeNull();
    await act(async () => { gate.resolve({ user }); await verify; });
    expect((await screen.findByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Private draft');
    expect(f.detail).toHaveBeenCalledOnce(); expect(f.put).not.toHaveBeenCalled();
  });
  it('keeps drafts after conflict, reviews without replacing them, and reloads only after consent', async () => {
    const f = await start(); await f.open(); fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'My draft' } });
    f.put.mockResolvedValue(json({ code: 'APPLICATION_CONFLICT', message: 'Rejected.' }, 409));
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })); });
    expect(await screen.findByText(/This application changed elsewhere/)).toBeTruthy();
    expect((screen.getByLabelText('Company') as HTMLInputElement).value).toBe('My draft');
    expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
    f.detail.mockResolvedValue(json({ application: { ...row, company: 'Stored company', version: 3 } }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Review saved application' })); });
    expect(await screen.findByRole('heading', { name: /Saved version · Revision 3/ })).toBeTruthy();
    expect((screen.getByLabelText('Company') as HTMLInputElement).value).toBe('My draft');
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Reload and discard draft' })); expect(f.detail).toHaveBeenCalledTimes(2);
    confirm.mockReturnValue(true); await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reload and discard draft' })); });
    expect((await screen.findByLabelText('Company') as HTMLInputElement).value).toBe('Stored company'); expect(f.put).toHaveBeenCalledOnce();
  });
  it('requires read-only review after an uncertain PUT and never silently resends it', async () => {
    const f = await start(); await f.open(); fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Draft' } });
    f.put.mockRejectedValue(new Error('PRIVATE transport data'));
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })); });
    expect(await screen.findByText(/We could not confirm whether your changes were saved/)).toBeTruthy();
    await act(async () => { await f.auth.store.revalidate(); fireEvent.click(screen.getByRole('button', { name: 'Review saved application' })); });
    expect((await screen.findByLabelText('Company') as HTMLInputElement).value).toBe('Draft'); expect(f.put).toHaveBeenCalledOnce();
    expect(screen.queryByText(/PRIVATE/)).toBeNull(); expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('disables duplicate mutations and conflicting actions throughout pending saves', async () => {
    const f = await start(); await f.open(); const gate = deferred<Response>(); f.put.mockReturnValueOnce(gate.promise);
    const form = screen.getByRole('form', { name: 'Edit application' });
    act(() => { fireEvent.submit(form); fireEvent.submit(form); });
    await waitFor(() => expect(f.put).toHaveBeenCalledOnce());
    expect(screen.queryByRole('form', { name: 'Edit application' })).toBeNull(); expect(screen.getByRole('heading', { name: 'Saving your application' })).toBeTruthy();
    await act(async () => { gate.resolve(json({ application: row })); }); expect(await screen.findByText(/No changes needed/)).toBeTruthy();
  });
  it('keeps status saves successful when history fails and offers an independent read retry', async () => {
    const f = await start(); await f.open();
    fireEvent.change(screen.getByLabelText('Status'), { target: { value: 'APPLIED' } });
    fireEvent.change(screen.getByLabelText('Application date'), { target: { value: '2024-02-29' } });
    f.history.mockResolvedValueOnce(json({ code: 'SERVICE_UNAVAILABLE', message: 'Unavailable.' }, 503));
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Edit application' })); });
    expect(await screen.findByText('Changes saved.')).toBeTruthy(); expect(screen.getByText(/Status history could not be loaded/)).toBeTruthy();
    f.history.mockResolvedValue(json({ items: [event], nextCursor: null }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Retry status history' })); });
    expect(await screen.findByText('Saved → Applied')).toBeTruthy(); expect(f.put).toHaveBeenCalledOnce();
  });
  it('renders descending history with readable timestamps and loads strictly older revisions', async () => {
    const f = await start(); f.history.mockResolvedValueOnce(json({ items: [{ ...event, applicationVersion: 4 }], nextCursor: '4' })); await f.open();
    f.history.mockResolvedValue(json({ items: [{ ...event, id: row.id }], nextCursor: null }));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Load older changes' })); });
    const region = screen.getByRole('region', { name: 'Status history' });
    expect(within(region).getAllByRole('listitem').map(item => item.textContent)).toEqual([expect.stringContaining('Revision 4'), expect.stringContaining('Revision 2')]);
    expect(region.querySelector('time')?.getAttribute('datetime')).toBe(row.createdAt);
    expect(region.querySelector('time')?.textContent).toMatch(/2026/); expect(f.history.mock.calls[1]![0]).toContain('cursor=4');
    expect(screen.queryByRole('button', { name: 'Load older changes' })).toBeNull();
  });
  it('clears private drafts and history on account replacement', async () => {
    const f = await start(); await f.open(); fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'A private draft' } });
    f.auth.api.me.mockResolvedValue({ user: { ...user, id: row.id, email: 'other@example.invalid' } });
    await act(async () => { await f.auth.store.revalidate(); });
    expect(await screen.findByRole('form', { name: 'Add application' })).toBeTruthy();
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByRole('region', { name: 'Status history' })).toBeNull(); expect(screen.queryByText('A private draft')).toBeNull();
  });
  it('confirms a dirty logout and removes protected editor data on confirmed logout', async () => {
    const f = await start(); await f.open(); fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Private draft' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' })); expect(f.auth.api.logout).not.toHaveBeenCalled();
    f.auth.api.logout.mockImplementation(async () => { f.auth.api.me.mockRejectedValue(new AuthFailure('http', 401, 'UNAUTHENTICATED')); });
    confirm.mockReturnValue(true); await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign out' })); });
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeTruthy(); expect(screen.queryByText('Private draft')).toBeNull();
    expect(screen.queryByRole('form', { name: 'Edit application' })).toBeNull();
  });
  it('keeps the controller, selection, draft and history through skip-link fragments and real jsdom Back/Forward', async () => {
    const f = await start({ browser: true });
    f.history.mockResolvedValue(json({ items: [event], nextCursor: null })); await f.open();
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Keep this draft' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'Skip to content' })); });
    expect(window.location.hash).toBe('#main'); expect(document.activeElement).toBe(document.getElementById('main'));
    const check = async (hash: string) => {
      await waitFor(() => expect(window.location.hash).toBe(hash));
      expect((await screen.findByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Keep this draft');
      expect(screen.getByText(/Revision 1 · Unsaved changes/)).toBeTruthy(); expect(screen.getByText(/Saved → Applied/)).toBeTruthy();
      expect(f.detail).toHaveBeenCalledOnce(); expect(f.history).toHaveBeenCalledOnce();
    };
    await check('#main');
    await act(async () => { window.history.back(); }); await check('');
    await act(async () => { window.history.forward(); }); await check('#main');
    expect(confirm).not.toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled();
  });
  it.each([undefined, 0, 999])('retains a dirty draft through fragment traversal with router idx %s', async idx => {
    const f = await start({ browser: true }); await f.open();
    fireEvent.change(screen.getByLabelText('Company'), { target: { value: 'Draft company' } });
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'Skip to content' })); });
    window.history.replaceState({ ...window.history.state, idx }, '', window.location.href);
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(window.location.hash).toBe(''));
    expect((await screen.findByLabelText('Company') as HTMLInputElement).value).toBe('Draft company');
    await act(async () => { window.history.forward(); });
    await waitFor(() => expect(window.location.hash).toBe('#main'));
    expect((await screen.findByLabelText('Company') as HTMLInputElement).value).toBe('Draft company');
    expect(f.detail).toHaveBeenCalledOnce(); expect(f.put).not.toHaveBeenCalled();
  });
  it('keeps the draft through native fragment entries without router history metadata', async () => {
    const f = await start({ browser: true }); await f.open();
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Native fragment draft' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const originalEntry = window.history.state.__applyflowWorkspaceEntry.id;
    await act(async () => { window.location.hash = '#native'; });
    await waitFor(() => expect(window.history.state?.__applyflowWorkspaceEntry?.id).not.toBe(originalEntry));
    expect(window.history.state.__applyflowWorkspaceEntry.position).toBeNull();
    expect((await screen.findByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Native fragment draft');
    await act(async () => { window.history.back(); }); await waitFor(() => expect(window.location.hash).toBe(''));
    expect((await screen.findByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Native fragment draft');
    await act(async () => { window.history.forward(); }); await waitFor(() => expect(window.location.hash).toBe('#native'));
    expect((await screen.findByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Native fragment draft');
    expect(confirm).not.toHaveBeenCalled(); expect(f.detail).toHaveBeenCalledOnce(); expect(f.put).not.toHaveBeenCalled();
  });
  it.each([
    ['back', undefined], ['back', 0], ['back', 999],
    ['forward', undefined], ['forward', 0], ['forward', 999]
  ] as const)('keeps an older/newer unknown entry untrusted after clean %s and dirty cancellation (idx %s)', async (direction, historyIndex) => {
    const go = vi.spyOn(window.history, 'go');
    const f = await start({ browser: true, unknownEntry: direction, historyIndex });
    const original = window.history.state.__applyflowWorkspaceEntry;
    const unknownPath = direction === 'back' ? '/older-unknown' : '/newer-unknown';
    const arrive = () => direction === 'back' ? window.history.back() : window.history.forward();
    const returnToWorkspace = () => direction === 'back' ? window.history.forward() : window.history.back();
    // Exact audited sequence: clean admission of unknown B, return to trusted A,
    // open a dirty editor, then revisit B and reject departure.
    await act(async () => { arrive(); });
    await waitFor(() => expect(window.location.pathname).toBe(unknownPath));
    await screen.findByRole('heading', { name: 'Page not found' });
    expect(window.history.state.__applyflowWorkspaceEntry.position).toBeNull();
    const unknownId = window.history.state.__applyflowWorkspaceEntry.id;
    await act(async () => { returnToWorkspace(); });
    await screen.findByRole('button', { name: /Edit application:/ });
    expect(window.history.state.__applyflowWorkspaceEntry).toEqual(original);
    f.history.mockResolvedValue(json({ items: [event], nextCursor: null })); await f.open();
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Keep unknown-entry draft' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => { arrive(); });
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    expect(window.location.pathname).toBe('/app'); expect(go).not.toHaveBeenCalled();
    expect(window.history.state.__applyflowWorkspaceEntry.position).toBeNull();
    expect(window.history.state.__applyflowWorkspaceEntry.id).not.toBe(unknownId);
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Keep unknown-entry draft');
    expect(screen.getByText(/Saved → Applied/)).toBeTruthy();
    // Returning to the original A after fallback retains both draft and A's
    // established position. No extra detail fetch or mutation is issued.
    await act(async () => { returnToWorkspace(); });
    await waitFor(() => expect(window.history.state.__applyflowWorkspaceEntry.id).toBe(original.id));
    expect((await screen.findByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Keep unknown-entry draft');
    expect(window.history.state.__applyflowWorkspaceEntry.position).toEqual(original.position);
    expect(confirm).toHaveBeenCalledOnce(); expect(go).not.toHaveBeenCalled();
    expect(f.detail).toHaveBeenCalledOnce(); expect(f.put).not.toHaveBeenCalled();
  });
  it('retains the draft through repeated real unknown Back cancellations and forward recovery to a known entry', async () => {
    window.history.replaceState({}, '', '/oldest-unknown');
    window.history.pushState({}, '', '/placeholder');
    const go = vi.spyOn(window.history, 'go');
    const f = await start({ browser: true, unknownEntry: 'back' });
    const original = window.history.state.__applyflowWorkspaceEntry;
    await f.open(); fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Repeated cancellation draft' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => { window.history.back(); }); await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    const firstFallback = window.history.state.__applyflowWorkspaceEntry;
    expect(firstFallback.position).toBeNull();
    await act(async () => { window.history.back(); }); await waitFor(() => expect(confirm).toHaveBeenCalledTimes(2));
    expect(window.location.pathname).toBe('/app'); expect(window.history.state.__applyflowWorkspaceEntry.position).toBeNull();
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Repeated cancellation draft');
    await act(async () => { window.history.forward(); });
    await waitFor(() => expect(window.history.state.__applyflowWorkspaceEntry.id).toBe(firstFallback.id));
    await act(async () => { window.history.forward(); });
    await waitFor(() => expect(window.history.state.__applyflowWorkspaceEntry.id).toBe(original.id));
    expect(window.history.state.__applyflowWorkspaceEntry.position).toEqual(original.position);
    expect((await screen.findByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Repeated cancellation draft');
    expect(confirm).toHaveBeenCalledTimes(2); expect(go).not.toHaveBeenCalled();
    expect(f.detail).toHaveBeenCalledOnce(); expect(f.put).not.toHaveBeenCalled();
  });
  it('blocks a dirty router-link departure before commit and departs only after consent', async () => {
    const f = await start({ browser: true }); await f.open();
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Private draft' } });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'ApplyFlow' })); });
    expect(window.location.pathname).toBe('/app'); expect(confirm).toHaveBeenCalledOnce();
    expect((screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Private draft');
    confirm.mockReturnValue(true);
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'ApplyFlow' })); });
    expect(window.location.pathname).toBe('/'); expect(screen.queryByRole('form', { name: 'Edit application' })).toBeNull();
    expect(confirm).toHaveBeenCalledTimes(2); expect(f.put).not.toHaveBeenCalled();
  });
  it('cancels and restores a known Back departure, then permits Back and Forward after explicit consent', async () => {
    const f = await start({ browser: true });
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'ApplyFlow' })); });
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'Sign in' })); });
    await screen.findByRole('button', { name: /Edit application:/ }); await f.open();
    fireEvent.change(screen.getByLabelText('Notes (optional)'), { target: { value: 'Keep me' } });
    // Corrupt only the router's public index; our entry identities remain intact.
    window.history.replaceState({ ...window.history.state, idx: undefined }, '', window.location.href);
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(confirm).toHaveBeenCalledOnce());
    await waitFor(() => expect(window.location.pathname).toBe('/app'));
    expect((await screen.findByLabelText('Notes (optional)') as HTMLTextAreaElement).value).toBe('Keep me');
    confirm.mockReturnValue(true);
    await act(async () => { window.history.back(); });
    await waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(confirm).toHaveBeenCalledTimes(2); expect(screen.queryByRole('form', { name: 'Edit application' })).toBeNull();
    await act(async () => { window.history.forward(); });
    expect(await screen.findByRole('form', { name: 'Add application' })).toBeTruthy();
    expect(confirm).toHaveBeenCalledTimes(2); expect(f.put).not.toHaveBeenCalled();
  });
  it('leaves with a clean editor without a confirmation', async () => {
    const f = await start({ browser: true }); await f.open();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'ApplyFlow' })); });
    expect(window.location.pathname).toBe('/'); expect(confirm).not.toHaveBeenCalled(); expect(f.put).not.toHaveBeenCalled();
  });
});
