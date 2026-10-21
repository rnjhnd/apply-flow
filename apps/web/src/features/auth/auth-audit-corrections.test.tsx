import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { AuthFailure, type AuthApi } from '../../lib/auth/api';
import { authFixture, credentials, deferred, proof, rotated, user } from '../../test/auth-fixtures';

const fixtures: ReturnType<typeof authFixture>[] = [];
function fixture() { const setup = authFixture({ registration: true }); fixtures.push(setup); return setup; }
function start(setup: ReturnType<typeof fixture>, path = '/register') {
  return render(<StrictMode><MemoryRouter initialEntries={[path]}><App authStore={setup.store} /></MemoryRouter></StrictMode>);
}
function fill() {
  (screen.getByLabelText('Email') as HTMLInputElement).value = credentials.email;
  (screen.getByLabelText('Password', { exact: true }) as HTMLInputElement).value = credentials.password;
}
afterEach(() => { for (const setup of fixtures) setup.store.dispose(); fixtures.length = 0; });

describe('registration recovery without invented mutation uncertainty', () => {
  it.each(['csrf', 'me'] as const)('restores registration after an initial failed %s read and explicit anonymous recovery', async (endpoint) => {
    const setup = fixture(); setup.api[endpoint].mockRejectedValueOnce(new AuthFailure('network')); start(setup);
    const recovery = await screen.findByRole('button', { name: 'Check session' });
    expect(screen.queryByRole('form')).toBeNull();
    expect(setup.store.getSnapshot()).toMatchObject({ status: 'uncertain', outcomeUncertain: false, verifiedReadId: null });
    expect(screen.getByText('Your session could not be verified. Check your session before continuing.')).toBeTruthy();
    expect(screen.queryByText(/earlier account creation succeeded/)).toBeNull();
    await userEvent.setup().click(recovery);
    const form = await screen.findByRole('form', { name: 'Create an account' });
    expect(setup.store.getSnapshot()).toMatchObject({ status: 'anonymous', registrationEnabled: true, outcomeUncertain: false, verifiedReadId: 1 });
    expect((screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement).disabled).toBe(false);
    expect(setup.api.csrf).toHaveBeenCalledTimes(2); expect(setup.api.register).not.toHaveBeenCalled();
    // A deliberate attempt is admitted, using the existing coordinator, never replayed.
    setup.api.register.mockRejectedValueOnce(new AuthFailure('http', 409, 'ACCOUNT_UNAVAILABLE'));
    fill(); fireEvent.submit(form); await screen.findByRole('alert');
    await waitFor(() => expect(setup.store.getSnapshot().busy).toBe(false)); expect(setup.api.register).toHaveBeenCalledOnce();
  });
  it.each(['csrf', 'me'] as const)('keeps registration blocked after ambiguous registration, failed %s read, and successful anonymous verification', async (endpoint) => {
    const setup = fixture(); start(setup);
    const form = await screen.findByRole('form', { name: 'Create an account' });
    setup.api.register.mockRejectedValueOnce(new AuthFailure('network')); fill(); fireEvent.submit(form);
    await screen.findByRole('alert'); await waitFor(() => expect(setup.store.getSnapshot().busy).toBe(false));
    expect(setup.store.getSnapshot()).toMatchObject({ status: 'anonymous', outcomeUncertain: true, verifiedReadId: 2 });
    expect(setup.api.csrf).toHaveBeenCalledTimes(3);
    setup.api[endpoint].mockRejectedValueOnce(new AuthFailure('network'));
    await act(async () => { await setup.store.revalidate().catch(() => {}); });
    expect(setup.store.getSnapshot()).toMatchObject({ status: 'uncertain', outcomeUncertain: true, verifiedReadId: null });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check session' }));
    await screen.findByRole('form', { name: 'Create an account' });
    expect(setup.store.getSnapshot()).toMatchObject({ status: 'anonymous', outcomeUncertain: true, verifiedReadId: 3 });
    expect((screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement).disabled).toBe(true);
    fill(); fireEvent.submit(form); expect(setup.api.register).toHaveBeenCalledOnce();
    await userEvent.setup().click(screen.getByRole('link', { name: 'Sign in' }));
    await screen.findByRole('form', { name: 'Sign in' });
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(false);
    expect(setup.store.getSnapshot().outcomeUncertain).toBe(true); expect(setup.api.login).not.toHaveBeenCalled();
  });
  it.each(['failed', 'stale'] as const)('never admits registration after %s recovery without a current receipt', async (kind) => {
    const setup = fixture(); setup.api.csrf.mockRejectedValueOnce(new AuthFailure('network')); start(setup);
    await screen.findByRole('button', { name: 'Check session' });
    if (kind === 'failed') setup.api.me.mockRejectedValueOnce(new AuthFailure('network'));
    else setup.api.csrf.mockImplementation(async () => {
      setup.notify('invalidate'); return { csrfToken: proof, registrationEnabled: true };
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check session' }));
    await waitFor(() => expect(setup.store.getSnapshot().busy).toBe(false));
    expect(setup.store.getSnapshot()).toMatchObject({ verifiedReadId: null, registrationEnabled: null, outcomeUncertain: false });
    expect(screen.queryByRole('form')).toBeNull(); expect(screen.queryByRole('button', { name: 'Create account' })).toBeNull();
    expect(setup.api.register).not.toHaveBeenCalled(); expect(setup.api.csrf).toHaveBeenCalledTimes(kind === 'stale' ? 3 : 2);
    setup.api.csrf.mockResolvedValue({ csrfToken: proof, registrationEnabled: true });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check session' }));
    await screen.findByRole('form', { name: 'Create an account' });
    expect(setup.store.getSnapshot()).toMatchObject({ verifiedReadId: 1, status: 'anonymous', outcomeUncertain: false });
  });
});

describe('synchronous invocation ownership', () => {
  it('sanitizes a synchronous throw, retains a pre-handoff password and allows a later explicit attempt', async () => {
    const setup = fixture(); start(setup, '/login');
    const form = await screen.findByRole('form', { name: 'Sign in' });
    const password = screen.getByLabelText('Password', { exact: true }) as HTMLInputElement;
    const logging = vi.spyOn(console, 'error');
    vi.spyOn(setup.store, 'login').mockImplementationOnce(() => { throw new Error(credentials.password); });
    fill(); fireEvent.submit(form);
    expect(password.value).toBe(credentials.password);
    const alert = await screen.findByRole('alert'); expect(alert.textContent).toContain('could not confirm');
    expect(alert.textContent).not.toContain(credentials.password); expect(logging).not.toHaveBeenCalled();
    expect(setup.api.login).not.toHaveBeenCalled(); expect(setup.api.csrf).toHaveBeenCalledOnce();
    setup.api.login.mockRejectedValueOnce(new AuthFailure('http', 401, 'INVALID_CREDENTIALS'));
    fireEvent.submit(form); expect(password.value).toBe('');
    await waitFor(() => expect(setup.api.login).toHaveBeenCalledOnce());
    await screen.findByText(/email or password was not recognized/);
  });
  it('does not release or duplicate real accepted work when a dependency throws after handing off', async () => {
    const setup = fixture(); start(setup, '/login'); const form = await screen.findByRole('form', { name: 'Sign in' });
    const gate = deferred<Awaited<ReturnType<AuthApi['login']>>>(); setup.api.login.mockReturnValueOnce(gate.promise);
    const original = setup.store.login; let dispatched!: ReturnType<typeof original>;
    vi.spyOn(setup.store, 'login').mockImplementationOnce((input) => {
      dispatched = original(input); void dispatched.catch(() => {});
      throw new Error('Synthetic dependency exception after accepted handoff');
    });
    fill(); fireEvent.submit(form);
    expect((screen.getByLabelText('Password', { exact: true }) as HTMLInputElement).value).toBe('');
    await screen.findByRole('alert'); await waitFor(() => expect(setup.api.login).toHaveBeenCalledOnce());
    expect(setup.store.getSnapshot().busy).toBe(true); expect(setup.held()).toBe(1);
    fireEvent.submit(form); expect(setup.api.login).toHaveBeenCalledOnce();
    expect(setup.api.csrf).toHaveBeenCalledTimes(2);
    await act(async () => { gate.resolve({ user, csrfToken: rotated }); await dispatched; });
    await screen.findByRole('button', { name: 'Check session' });
    expect(setup.held()).toBe(0); expect(setup.store.getSnapshot().verifiedReadId).toBeNull();
    expect(setup.api.csrf).toHaveBeenCalledTimes(2); expect(setup.api.login).toHaveBeenCalledOnce();
    expect(screen.queryByRole('heading', { name: 'Your workspace' })).toBeNull();
  });
});

describe('announcements outside busy content', () => {
  it.each(['bootstrap', 'background', 'mutation'] as const)('keeps the eight-second %s announcement outside busy content without releasing work', async (phase) => {
    vi.useFakeTimers(); const setup = fixture();
    const gate = deferred<Awaited<ReturnType<AuthApi['csrf']>>>();
    const login = deferred<Awaited<ReturnType<AuthApi['login']>>>();
    if (phase === 'bootstrap') setup.api.csrf.mockReturnValueOnce(gate.promise);
    start(setup, '/login'); await act(async () => {});
    let operation: Promise<unknown> | undefined;
    const password = phase === 'bootstrap' ? null : screen.getByLabelText('Password', { exact: true });
    if (phase === 'background') {
      password?.focus(); setup.api.csrf.mockReturnValueOnce(gate.promise);
      await act(async () => { operation = setup.store.revalidate(); });
    } else if (phase === 'mutation') {
      setup.api.login.mockReturnValueOnce(login.promise); fill();
      await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Sign in' })); });
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    const progress = screen.getByText(/longer than expected/);
    expect(progress.getAttribute('role')).toBe('status'); expect(progress.closest('[aria-busy="true"]')).toBeNull();
    expect(document.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(setup.store.getSnapshot().busy).toBe(true); expect(setup.held()).toBe(1);
    if (phase === 'background') {
      expect(password?.closest('fieldset')?.disabled).toBe(true);
      expect(password?.closest('fieldset')?.hasAttribute('inert')).toBe(true); expect(document.activeElement).toBe(password);
    }
    await act(async () => {
      if (phase === 'mutation') login.reject(new AuthFailure('http', 401, 'INVALID_CREDENTIALS'));
      else gate.resolve({ csrfToken: proof, registrationEnabled: true });
      await operation;
    });
    expect(setup.store.getSnapshot().busy).toBe(false); expect(setup.held()).toBe(0);
    expect(setup.api.login).toHaveBeenCalledTimes(phase === 'mutation' ? 1 : 0);
  });
});
