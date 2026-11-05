import { act, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Application } from '@applyflow/contracts';
import { authFixture } from '../../test/auth-fixtures';
import { ApplicationFailure, type ApplicationsApi } from '../../lib/applications/api';
import { useApplicationBoard, boardStatuses } from './use-application-board';
import { useApplications } from './use-applications';
import { ApplicationBoard } from './application-board';
import { statusLabel } from './application-field-policy';

const row: Application = { id: 'c4974360-a70c-4a29-8b41-df95d15d7270', version: 1, archivedAt: null, company: 'Acme', jobTitle: 'Engineer',
  status: 'SAVED', applicationDate: null, location: 'Remote', jobUrl: null, notes: null, createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z' };
const fixtures: ReturnType<typeof authFixture>[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.store.dispose()));
async function fixture() {
  const auth = authFixture({ authenticated: true }); fixtures.push(auth); await auth.store.bootstrap();
  const api = { create: vi.fn<ApplicationsApi['create']>(), list: vi.fn<ApplicationsApi['list']>().mockResolvedValue({ items: [], nextCursor: null }) };
  const hook = renderHook(() => ({ board: useApplicationBoard(auth.store, api), applications: useApplications(auth.store, api) }));
  await act(async () => { hook.result.current.board.configure({ enabled: true, filters: {} }); hook.result.current.board.resume(); });
  return hook.result.current;
}

describe('semantic Kanban presentation', () => {
  it('renders seven ordered sections, labelled native filters and a keyboard-scrollable responsive region', async () => {
    const f = await fixture(); render(<ApplicationBoard controller={f.board} applications={f.applications} onEdit={vi.fn()} selectedId={null} disabled={false} />);
    expect(screen.getAllByRole('heading', { level: 3 }).map(element => element.textContent)).toEqual(boardStatuses.map(statusLabel));
    const region = screen.getByRole('region', { name: 'Application status columns' });
    expect(region.tabIndex).toBe(0); expect(region.className).toContain('lg:overflow-x-auto'); expect(region.className).toContain('grid');
    expect(screen.getByRole('region', { name: 'Saved' }).className).toContain('lg:w-72');
    expect(screen.getByLabelText('Search company or job title')).toBeTruthy(); expect(screen.getByLabelText('Filter by status')).toBeTruthy();
    expect(screen.getAllByText('No active applications in this status.')).toHaveLength(7);
    expect(screen.queryByText(/total/i)).toBeTruthy(); // The hint explicitly rejects a total-count claim.
  });
  it('distinguishes unloaded/loading/error/excluded/filtered-empty and invokes status-specific Retry', async () => {
    const f = await fixture(), retry = vi.fn();
    const board = { ...f.board, retry, columns: { ...f.board.columns,
      SAVED: { ...f.board.columns.SAVED, phase: 'unloaded' as const },
      APPLIED: { ...f.board.columns.APPLIED, phase: 'loading' as const },
      INTERVIEW: { ...f.board.columns.INTERVIEW, phase: 'error' as const, error: new ApplicationFailure('stale') },
      OFFER: { ...f.board.columns.OFFER, phase: 'excluded' as const } } };
    render(<ApplicationBoard controller={board} applications={{ ...f.applications, hasFilters: true }} onEdit={vi.fn()} selectedId={null} disabled={false} />);
    expect(within(screen.getByRole('region', { name: 'Saved' })).getByText('Not loaded yet.')).toBeTruthy();
    expect(screen.getByText('Loading Applied applications…')).toBeTruthy();
    expect(screen.getByText('Not included by the current status filter.')).toBeTruthy();
    expect(screen.getAllByText('No matching applications in this column.')).toHaveLength(3);
    await userEvent.click(screen.getByRole('button', { name: 'Retry Interview' })); expect(retry).toHaveBeenCalledExactlyOnceWith('INTERVIEW');
  });
  it('uses native keyboard card buttons with metadata, selected state and independent page controls', async () => {
    const f = await fixture(), onEdit = vi.fn(), loadMore = vi.fn(), refresh = vi.fn();
    const board = { ...f.board, loadMore, refresh, columns: { ...f.board.columns,
      SAVED: { ...f.board.columns.SAVED, items: [row], nextCursor: 'next' },
      APPLIED: { ...f.board.columns.APPLIED, items: [{ ...row, id: '7bf22ee7-a3be-40de-957e-89fca7bac5ad', status: 'APPLIED' as const, applicationDate: '2026-10-20' }], nextCursor: 'other' } } };
    render(<ApplicationBoard controller={board} applications={f.applications} onEdit={onEdit} selectedId={row.id} disabled={false} />);
    const cards = screen.getAllByRole('button', { name: 'Edit application: Engineer at Acme' });
    expect(cards[0]?.getAttribute('aria-expanded')).toBe('true'); expect(cards[0]?.getAttribute('aria-controls')).toBe('application-detail-panel');
    cards[0]!.focus(); const keyboard = userEvent.setup(); await keyboard.keyboard('{Enter} ');
    expect(onEdit).toHaveBeenCalledTimes(2); expect(onEdit).toHaveBeenLastCalledWith(row.id);
    expect(screen.getAllByText('Remote')).toHaveLength(2); expect(screen.getByText('2026-10-20').getAttribute('datetime')).toBe('2026-10-20');
    await keyboard.click(screen.getByRole('button', { name: 'Load more Saved applications' })); expect(loadMore).toHaveBeenCalledExactlyOnceWith('SAVED');
    await keyboard.click(screen.getByRole('button', { name: 'Refresh board' })); expect(refresh).toHaveBeenCalledOnce();
    expect(screen.getAllByText('1 shown; more available.')).toHaveLength(2);
  });
  it('does not claim a selected card is absent while any included column has unloaded pages', async () => {
    const f = await fixture(), controller = { ...f.board, columns: { ...f.board.columns, SAVED: { ...f.board.columns.SAVED, nextCursor: 'more' } } };
    const view = render(<ApplicationBoard controller={controller} applications={f.applications} onEdit={vi.fn()} selectedId={row.id} disabled={false} />);
    expect(screen.queryByText(/selected application is not in/)).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Saved' })).queryByText('No active applications in this status.')).toBeNull();
    expect(screen.getByText('No applications currently shown. Load more to continue this column.')).toBeTruthy();
    view.rerender(<ApplicationBoard controller={f.board} applications={f.applications} onEdit={vi.fn()} selectedId={row.id} disabled={false} />);
    expect(screen.getByText(/selected application is not in/)).toBeTruthy();
  });
});
