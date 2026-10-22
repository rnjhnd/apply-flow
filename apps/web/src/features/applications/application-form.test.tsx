import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authFixture } from '../../test/auth-fixtures';
import { AuthAdmissionContext } from '../auth/auth-admission';
import { ApplicationForm } from './application-form';
import { useApplications } from './use-applications';
import type { ApplicationsApi } from '../../lib/applications/api';

const stores: ReturnType<typeof authFixture>[] = [];
afterEach(() => { stores.forEach(f => f.store.dispose()); stores.length = 0; });
async function start(allowed = true) {
  const auth = authFixture({ authenticated: true }); stores.push(auth); await auth.store.bootstrap();
  const api = { create: vi.fn<ApplicationsApi['create']>().mockRejectedValue(new Error()), list: vi.fn<ApplicationsApi['list']>().mockResolvedValue({ items: [], nextCursor: null }) };
  const canSubmit = vi.fn(() => allowed);
  function Form() { const controller = useApplications(auth.store, api); return <AuthAdmissionContext value={{ allowed: true, canSubmit }}><ApplicationForm controller={controller} /></AuthAdmissionContext>; }
  render(<Form />);return { api, canSubmit };
}
describe('accessible application form', () => {
  it('has persistent labels, Saved default, native fields and conditional date requirement', async () => {
    await start(); const date = screen.getByLabelText('Application date') as HTMLInputElement;
    expect((screen.getByLabelText('Status') as HTMLSelectElement).value).toBe('SAVED'); expect(date.type).toBe('date'); expect(date.required).toBe(false);
    expect(screen.getByLabelText('Notes (optional)').tagName).toBe('TEXTAREA');
    expect((screen.getByLabelText('Job URL (optional)') as HTMLInputElement).type).toBe('url');
    await userEvent.setup().selectOptions(screen.getByLabelText('Status'), 'APPLIED'); expect(date.required).toBe(true);
  });
  it('announces local errors, focuses the summary and preserves drafts without a request', async () => {
    const f = await start(); await userEvent.setup().type(screen.getByLabelText('Company'), 'Acme');
    fireEvent.submit(screen.getByRole('form', { name: 'Add application' })); await act(async () => {});
    const alert = screen.getByRole('alert'); expect(document.activeElement).toBe(alert);
    const title = screen.getByLabelText('Job title'); expect(title.getAttribute('aria-invalid')).toBe('true');
    expect(document.getElementById(title.getAttribute('aria-describedby')!)?.textContent).toContain('Review');
    expect((screen.getByLabelText('Company') as HTMLInputElement).value).toBe('Acme'); expect(f.api.create).not.toHaveBeenCalled();
  });
  it('extracts native autofill values with FormData and preserves meaningful notes formatting', async () => {
    const f = await start(); (screen.getByLabelText('Company') as HTMLInputElement).value = ' Acme ';
    (screen.getByLabelText('Job title') as HTMLInputElement).value = ' Engineer ';
    (screen.getByLabelText('Notes (optional)') as HTMLTextAreaElement).value = 'First line\n\n  Second line';
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Add application' })); });
    expect(f.api.create).toHaveBeenCalledWith({ company: 'Acme', jobTitle: 'Engineer', status: 'SAVED', applicationDate: null, location: null, jobUrl: null, notes: 'First line\n\n  Second line' });
  });
  it('checks live admission even when DOM controls are enabled', async () => {
    const f = await start(false); (screen.getByLabelText('Company') as HTMLInputElement).value = 'Acme';
    (screen.getByLabelText('Job title') as HTMLInputElement).value = 'Engineer';
    fireEvent.submit(screen.getByRole('form', { name: 'Add application' })); expect(f.canSubmit).toHaveBeenCalled(); expect(f.api.create).not.toHaveBeenCalled();
  });
  it('uses keyboard-operable native submission controls', async () => {
    await start(); const keyboard = userEvent.setup(); await keyboard.tab(); expect(document.activeElement).toBe(screen.getByLabelText('Company'));
    await keyboard.tab(); expect(document.activeElement).toBe(screen.getByLabelText('Job title'));
    expect(screen.getByRole('button', { name: 'Save application' }).getAttribute('type')).toBe('submit');
  });
});
