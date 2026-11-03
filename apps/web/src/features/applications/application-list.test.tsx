import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApplicationList } from './application-list';
import type { ApplicationsController } from './use-applications';

function controller(overrides: Partial<ApplicationsController> = {}): ApplicationsController {
  return { draft: { company: '', jobTitle: '', status: 'SAVED', applicationDate: '', location: '', jobUrl: '', notes: '' },
    setDraft: vi.fn(), items: [], nextCursor: null, loading: false, saving: false, listError: false, failure: null,
    view: 'active', switchView: vi.fn(), removeItem: vi.fn(),
    message: null, enter: vi.fn(), save: vi.fn(), cooldown: 0, refresh: vi.fn(), loadMore: vi.fn(), replaceItem: vi.fn(), ...overrides };
}
describe('application list presentation', () => {
  it('shows a useful empty state without unfinished controls', () => {
    render(<ApplicationList controller={controller()} onEdit={vi.fn()} />); expect(screen.getByText(/No applications saved yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /edit|delete|archive/i })).toBeNull();
  });
  it('announces loading and errors, provides explicit retry, and prevents concurrent pagination', () => {
    const state = controller({ loading: true, nextCursor: 'cursor' }); const view = render(<ApplicationList controller={state} onEdit={vi.fn()} />);
    expect(screen.getByRole('status').textContent).toContain('Loading'); expect((screen.getByRole('button', { name: 'Load more applications' }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<ApplicationList controller={{ ...state, loading: false, listError: true }} onEdit={vi.fn()} />);
    expect(screen.getByRole('alert').textContent).toContain('could not be loaded'); fireEvent.click(screen.getByRole('button', { name: 'Refresh applications' })); expect(state.refresh).toHaveBeenCalledOnce();
  });
  it('renders safe text, date-only values, and protected external links', () => {
    const state = controller({ items: [{ id: 'c4974360-a70c-4a29-8b41-df95d15d7270', version: 1, archivedAt: null, company: '<script>Company</script>', jobTitle: 'Engineer', status: 'APPLIED',
      applicationDate: '2026-10-22', location: 'Manila', jobUrl: 'https://example.invalid/job', notes: 'First\n  Second',
      createdAt: '2026-10-22T00:00:00.000Z', updatedAt: '2026-10-22T00:00:00.000Z' }], nextCursor: 'cursor' });
    const edit = vi.fn(); render(<ApplicationList controller={state} onEdit={edit} />);
    expect(screen.getByText('<script>Company</script>')).toBeTruthy(); expect(document.querySelector('script')).toBeNull();
    expect(document.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-22');
    const link = screen.getByRole('link'); expect(link.getAttribute('rel')).toBe('noopener noreferrer'); expect(link.getAttribute('target')).toBe('_blank');
    fireEvent.click(screen.getByRole('button', { name: 'Load more applications' })); expect(state.loadMore).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /Edit application:/ })); expect(edit).toHaveBeenCalledWith(state.items[0]!.id);
  });
});
