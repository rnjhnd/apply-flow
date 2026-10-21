import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { AuthFailure, type AuthApi } from '../../lib/auth/api';
import { authFixture, credentials, deferred, proof, rotated, user } from '../../test/auth-fixtures';
import { AuthProvider } from './auth-provider';
import { AuthRoute } from './auth-route';
import { useAuthAdmission } from './auth-admission';

const fixtures: ReturnType<typeof authFixture>[] = [];
function fixture(options: Parameters<typeof authFixture>[0] = {}) {
  const setup = authFixture(options); fixtures.push(setup); return setup;
}
function Navigation() {
  const navigate = useNavigate();
  return <><button onClick={() => navigate('/missing')}>Leave page</button>
    <button onClick={() => navigate('/login')}>Visit login</button>
    <output aria-label="Current path">{useLocation().pathname}</output></>;
}
function start(path = '/login', setup = fixture()) {
  const view = render(<StrictMode><MemoryRouter initialEntries={[path]}><Navigation /><App authStore={setup.store} /></MemoryRouter></StrictMode>);
  return { ...setup, ...view };
}
async function fields(mode: 'login' | 'register' = 'login') {
  const form = await screen.findByRole('form', { name: mode === 'login' ? 'Sign in' : 'Create an account' });
  return { form, email: screen.getByLabelText('Email') as HTMLInputElement, password: screen.getByLabelText('Password', { exact: true }) as HTMLInputElement };
}
function fill(email = credentials.email, password = credentials.password) {
  // Assign native values without React change events, as password managers may do.
  (screen.getByLabelText('Email') as HTMLInputElement).value = email;
  (screen.getByLabelText('Password', { exact: true }) as HTMLInputElement).value = password;
}
function authenticated(setup: ReturnType<typeof fixture>, replacement = user) {
  setup.api.me.mockResolvedValue({ user: replacement });
  setup.api.csrf.mockResolvedValue({ csrfToken: rotated, registrationEnabled: true });
}
function anonymous(setup: ReturnType<typeof fixture>) {
  setup.api.me.mockRejectedValue(new AuthFailure('http', 401, 'UNAUTHENTICATED'));
  setup.api.csrf.mockResolvedValue({ csrfToken: rotated, registrationEnabled: true });
}
beforeEach(() => { vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible'); });
afterEach(() => { for (const setup of fixtures) setup.store.dispose(); fixtures.length = 0; });

describe('native authentication forms and credential lifetime', () => {
  it('uses persistent labels, password-manager metadata, POST fallback and shared validation', async () => {
    start(); const { form, email, password } = await fields();
    expect(form.getAttribute('method')).toBe('post'); expect(form.hasAttribute('novalidate')).toBe(true);
    expect(email.autocomplete).toBe('username'); expect(email.type).toBe('email');
    expect(email.getAttribute('autocapitalize')).toBe('none'); expect(email.getAttribute('inputmode')).toBe('email');
    expect(password.autocomplete).toBe('current-password'); expect(password.type).toBe('password');
    expect(password.hasAttribute('maxlength')).toBe(false); expect(password.hasAttribute('minlength')).toBe(false);
  });
  it('keeps the password after local validation and links errors with a focused summary', async () => {
    const setup = start(); const { form, email, password } = await fields();
    fill('invalid', '  Keep e\u0301 and spaces  '); fireEvent.submit(form);
    const alert = await screen.findByRole('alert'); await waitFor(() => expect(document.activeElement).toBe(alert));
    expect(email.getAttribute('aria-invalid')).toBe('true'); expect(email.getAttribute('aria-describedby')).toBe('email-error');
    expect(screen.getByText('Enter a valid email address.').id).toBe('email-error');
    expect(password.value).toBe('  Keep e\u0301 and spaces  '); expect(setup.api.login).not.toHaveBeenCalled();
  });
  it('reports registration password errors without clearing and uses new-password autocomplete', async () => {
    const setup = start('/register', fixture({ registration: true })); const { form, password } = await fields('register');
    fill(user.email, 'too short'); fireEvent.submit(form);
    expect(password.value).toBe('too short'); expect(password.autocomplete).toBe('new-password');
    expect(password.getAttribute('aria-invalid')).toBe('true'); expect(password.getAttribute('aria-describedby')).toBe('password-hint password-error');
    expect(screen.getByText('Use 15–128 characters for your password.')).toBeTruthy(); expect(setup.api.register).not.toHaveBeenCalled();
  });
  it('reads autofill values at submission and preserves password spaces, Unicode and combining sequences', async () => {
    const setup = start(); const { form, password, email } = await fields();
    const value = '  e\u0301🧭密碼  ';
    const gate = deferred<Awaited<ReturnType<AuthApi['login']>>>(); setup.api.login.mockReturnValue(gate.promise);
    fill('  FIXTURE@EXAMPLE.INVALID  ', value); fireEvent.submit(form);
    expect(password.value).toBe(''); expect(email.value).toBe('FIXTURE@EXAMPLE.INVALID'); // Native email controls strip outer ASCII whitespace.
    await waitFor(() => expect(setup.api.login).toHaveBeenCalledWith({ email: user.email, password: value }, proof));
    await act(async () => { gate.reject(new AuthFailure('http', 401, 'INVALID_CREDENTIALS')); });
    expect(await screen.findByRole('alert')).toBeTruthy(); expect(password.value).toBe('');
  });
  it('uses Unicode code point validation rather than native UTF-16 maxlength', async () => {
    const setup = start('/register', fixture({ registration: true })); const { form, password } = await fields('register');
    const value = '🧭'.repeat(100); fill(user.email, value);
    setup.api.register.mockRejectedValue(new AuthFailure('http', 409, 'ACCOUNT_UNAVAILABLE'));
    fireEvent.submit(form); expect(password.value).toBe('');
    await waitFor(() => expect(setup.api.register).toHaveBeenCalledWith({ email: user.email, password: value }, proof));
  });
  it('retains credentials if the coordinator rejects before accepting ownership', async () => {
    const setup = start(); const { form, password } = await fields();
    vi.spyOn(setup.store, 'login').mockRejectedValue(new AuthFailure('stale'));
    fill(); fireEvent.submit(form);
    expect(password.value).toBe(credentials.password);
    await screen.findByRole('alert'); expect(setup.api.login).not.toHaveBeenCalled();
    expect(setup.api.csrf).toHaveBeenCalledOnce();
  });
  it('clears at accepted coordinator handoff even if its preflight later rejects before a POST', async () => {
    const setup = start(); const { form, password } = await fields();
    setup.api.me.mockRejectedValueOnce(new AuthFailure('http', 503)); fill(); fireEvent.submit(form);
    expect(password.value).toBe(''); await screen.findByRole('button', { name: 'Check session' });
    expect(setup.api.login).not.toHaveBeenCalled(); expect(setup.api.csrf).toHaveBeenCalledTimes(2);
  });
  it('links only trusted server field names to locally authored feedback', async () => {
    const setup = start(); const { form, email, password } = await fields();
    setup.api.login.mockRejectedValueOnce(new AuthFailure('http', 400, 'INVALID_REQUEST', null, ['email', 'password']));
    fill(); fireEvent.submit(form); await screen.findByRole('alert');
    await waitFor(() => expect(setup.store.getSnapshot().busy).toBe(false));
    expect(email.getAttribute('aria-describedby')).toBe('email-error'); expect(password.getAttribute('aria-describedby')).toBe('password-error');
    expect(screen.getByText('Review your email address.')).toBeTruthy(); expect(screen.getByText('Review your password.')).toBeTruthy();
  });
  it('clears the detached password control when the form is left', async () => {
    start(); const { password } = await fields(); fill();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Leave page' }));
    expect(password.value).toBe(''); expect(password.isConnected).toBe(false);
  });
  it('prevents duplicate submits while an accepted request is pending', async () => {
    const setup = start(); const { form, password } = await fields();
    const gate = deferred<Awaited<ReturnType<AuthApi['login']>>>(); setup.api.login.mockReturnValue(gate.promise);
    fill(); fireEvent.submit(form); fill(); fireEvent.submit(form);
    await waitFor(() => expect(setup.api.login).toHaveBeenCalledOnce());
    expect(password.closest('fieldset')?.disabled).toBe(true);
    expect(password.closest('fieldset')?.hasAttribute('inert')).toBe(true); expect(setup.held()).toBe(1);
    await act(async () => { gate.reject(new AuthFailure('http', 400, 'INVALID_REQUEST')); });
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy(); expect(setup.api.login).toHaveBeenCalledOnce();
  });
  it('keeps native password visibility keyboard-operable without submitting or transforming the value', async () => {
    const setup = start(); const { password } = await fields(); const keyboard = userEvent.setup();
    fill(user.email, ' e\u0301🧭 '); const toggle = screen.getByRole('button', { name: 'Show password' });
    password.focus(); await keyboard.tab(); expect(document.activeElement).toBe(toggle);
    await keyboard.keyboard('{Enter}'); expect(password.type).toBe('text'); expect(password.value).toBe(' e\u0301🧭 ');
    expect(toggle.getAttribute('aria-pressed')).toBe('true'); expect(toggle.getAttribute('aria-controls')).toBe('password');
    await keyboard.keyboard(' '); expect(password.type).toBe('password'); expect(setup.api.login).not.toHaveBeenCalled();
  });
  it('documents the existing native-field CR/LF limitation without transforming other characters', async () => {
    start(); const { password } = await fields();
    password.value = ' a\r\nb\nc e\u0301 ';
    expect(password.value).toBe(' abc e\u0301 ');
  });
});

describe('live admission, uncertainty and operation ownership', () => {
  it('rejects stale admission callbacks after invalidation, newer proof, capability revocation and unmount', async () => {
    const setup = fixture({ registration: true }); let admission!: ReturnType<typeof useAuthAdmission>;
    function Probe() {
      const current = useAuthAdmission(); useEffect(() => { admission = current; }, [current]);
      return <h1>Admission probe</h1>;
    }
    const view = render(<StrictMode><MemoryRouter><AuthProvider store={setup.store}><AuthRoute kind="registration"><Probe /></AuthRoute></AuthProvider></MemoryRouter></StrictMode>);
    await screen.findByRole('heading', { name: 'Admission probe' }); const first = admission.canSubmit; expect(first()).toBe(true);
    setup.api.csrf.mockRejectedValueOnce(new AuthFailure('http', 503));
    await act(async () => { setup.notify('invalidate'); }); expect(first()).toBe(false);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check session' }));
    await screen.findByRole('heading', { name: 'Admission probe' }); expect(admission.canSubmit()).toBe(true); expect(first()).toBe(false);
    const latest = admission.canSubmit;
    setup.api.csrf.mockResolvedValue({ csrfToken: proof, registrationEnabled: false });
    await act(async () => { setup.notify('invalidate'); }); expect(latest()).toBe(false);
    await screen.findByRole('heading', { name: 'Account creation is unavailable' }); view.unmount(); expect(latest()).toBe(false);
    expect(setup.api.register).not.toHaveBeenCalled();
  });
  it('completes explicit registration through the coordinator, then verifies before workspace admission', async () => {
    const setup = start('/register', fixture({ registration: true })); const { form } = await fields('register');
    setup.api.register.mockImplementation(async () => { authenticated(setup); return { user, csrfToken: rotated }; });
    fill(); fireEvent.submit(form);
    expect(await screen.findByRole('heading', { name: 'Your workspace' })).toBeTruthy();
    expect(setup.api.register).toHaveBeenCalledOnce(); expect(setup.api.csrf).toHaveBeenCalledTimes(4);
    expect(screen.getByLabelText('Current path').textContent).toBe('/app');
  });
  it('preserves the same draft and focus during background verification and blocks synthetic submits', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const setup = start(); const { form, email, password } = await fields(); fill(); password.focus();
    const gate = deferred<Awaited<ReturnType<AuthApi['csrf']>>>(); setup.api.csrf.mockReturnValueOnce(gate.promise);
    now += 30_000; fireEvent.focus(window);
    await waitFor(() => expect(setup.api.csrf).toHaveBeenCalledTimes(2));
    fireEvent.submit(form); expect(setup.api.login).not.toHaveBeenCalled(); expect(password.value).toBe(credentials.password);
    expect(email.closest('fieldset')?.disabled).toBe(true);
    await act(async () => { gate.resolve({ csrfToken: proof, registrationEnabled: false }); });
    expect(screen.getByLabelText('Email')).toBe(email); expect(screen.getByLabelText('Password', { exact: true })).toBe(password);
    expect(password.value).toBe(credentials.password); expect(document.activeElement).toBe(password);
  });
  it('removes registration and clears credentials after live capability revocation', async () => {
    const setup = start('/register', fixture({ registration: true })); const { password } = await fields('register'); fill();
    setup.api.csrf.mockResolvedValue({ csrfToken: proof, registrationEnabled: false });
    await act(async () => { setup.notify('invalidate'); });
    await screen.findByRole('heading', { name: 'Account creation is unavailable' });
    expect(password.isConnected).toBe(false); expect(password.value).toBe(''); expect(setup.api.register).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
  });
  it('blocks registration after ambiguous account creation, preserves uncertainty across reads and allows explicit login recovery', async () => {
    const setup = start('/register', fixture({ registration: true })); let controls = await fields('register');
    setup.api.register.mockRejectedValueOnce(new AuthFailure('network')); fill(); fireEvent.submit(controls.form);
    await screen.findByRole('alert');
    await waitFor(() => expect(setup.store.getSnapshot().busy).toBe(false));
    expect(setup.store.getSnapshot()).toMatchObject({ status: 'anonymous', outcomeUncertain: true });
    expect((screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement).disabled).toBe(true);
    fill(); fireEvent.submit(controls.form); expect(setup.api.register).toHaveBeenCalledOnce();
    expect(setup.api.csrf).toHaveBeenCalledTimes(3); // Initial, preflight, bounded coordinator reconciliation: no redundant UI read.
    await act(async () => { await setup.store.revalidate(); });
    expect(setup.store.getSnapshot().outcomeUncertain).toBe(true);
    await userEvent.setup().click(screen.getByRole('link', { name: 'Sign in' })); controls = await fields();
    setup.api.login.mockImplementation(async () => { authenticated(setup); return { user, csrfToken: rotated }; });
    fill(); fireEvent.submit(controls.form);
    expect(await screen.findByRole('heading', { name: 'Your workspace' })).toBeTruthy();
    expect(setup.store.getSnapshot().outcomeUncertain).toBe(false); expect(setup.api.register).toHaveBeenCalledOnce();
  });
  it('keeps verified workspace access with unrelated earlier registration uncertainty', async () => {
    const setup = fixture({ registration: true }); await setup.store.bootstrap();
    setup.api.register.mockImplementation(async () => { authenticated(setup); throw new AuthFailure('network'); });
    await setup.store.register(credentials).catch(() => {}); start('/app', setup);
    expect(await screen.findByRole('heading', { name: 'Your workspace' })).toBeTruthy();
    expect(screen.getByText(/outcome of an earlier request may differ/)).toBeTruthy(); expect(setup.store.getSnapshot().outcomeUncertain).toBe(true);
  });
  it('uses a real session receipt after ambiguous login without replay or an extra UI reconciliation', async () => {
    const setup = start(); const { form } = await fields();
    setup.api.login.mockImplementation(async () => { authenticated(setup); throw new AuthFailure('network'); });
    fill(); fireEvent.submit(form); await screen.findByRole('heading', { name: 'Your workspace' });
    expect(setup.store.getSnapshot()).toMatchObject({ status: 'authenticated', outcomeUncertain: true });
    expect(setup.api.login).toHaveBeenCalledOnce(); expect(setup.api.csrf).toHaveBeenCalledTimes(4);
    // Initial, preflight, coordinator reconciliation, mandatory new workspace entry.
  });
  it('does not redirect from stale login success when invalidation and authoritative reconciliation find an anonymous session', async () => {
    const setup = start(); const { form } = await fields();
    const gate = deferred<Awaited<ReturnType<AuthApi['login']>>>(); setup.api.login.mockReturnValue(gate.promise);
    fill(); fireEvent.submit(form); await waitFor(() => expect(setup.api.login).toHaveBeenCalledOnce());
    act(() => setup.notify('invalidate'));
    await act(async () => { gate.resolve({ user, csrfToken: rotated }); });
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByLabelText('Current path').textContent).toBe('/login');
    expect(screen.queryByRole('heading', { name: 'Your workspace' })).toBeNull(); expect(setup.api.csrf).toHaveBeenCalledTimes(3);
  });
  it('does not expose workspace from a definitive login response before authoritative verification finishes', async () => {
    const setup = start(); const { form } = await fields();
    const gate = deferred<Awaited<ReturnType<AuthApi['me']>>>();
    setup.api.login.mockImplementation(async () => { authenticated(setup); setup.api.me.mockReturnValueOnce(gate.promise); return { user, csrfToken: rotated }; });
    fill(); fireEvent.submit(form);
    await waitFor(() => expect(setup.api.me).toHaveBeenCalledTimes(3));
    expect(screen.queryByText(user.email)).toBeNull(); expect(screen.queryByRole('heading', { name: 'Your workspace' })).toBeNull();
    await act(async () => { gate.resolve({ user }); });
    expect(await screen.findByRole('heading', { name: 'Your workspace' })).toBeTruthy();
  });
  it('ignores a successful old operation after leaving, without disposing or releasing its lock early', async () => {
    const setup = start(); const { form, password } = await fields(); const dispose = vi.spyOn(setup.store, 'dispose');
    const gate = deferred<Awaited<ReturnType<AuthApi['login']>>>(); setup.api.login.mockReturnValue(gate.promise);
    fill(); fireEvent.submit(form); await waitFor(() => expect(setup.api.login).toHaveBeenCalledOnce());
    await userEvent.setup().click(screen.getByRole('button', { name: 'Leave page' }));
    expect(password.value).toBe(''); expect(setup.held()).toBe(1); expect(setup.subscriptions()).toBe(0);
    authenticated(setup); await act(async () => { gate.resolve({ user, csrfToken: rotated }); });
    expect(screen.getByLabelText('Current path').textContent).toBe('/missing');
    expect(setup.api.csrf).toHaveBeenCalledTimes(2); expect(setup.held()).toBe(0); expect(dispose).not.toHaveBeenCalled();
  });
  it('owns operations per history entry, including navigation back to the same pathname while a login is pending', async () => {
    const setup = start(); const { form } = await fields();
    const gate = deferred<Awaited<ReturnType<AuthApi['login']>>>(); setup.api.login.mockReturnValue(gate.promise);
    fill(); fireEvent.submit(form); await waitFor(() => expect(setup.api.login).toHaveBeenCalledOnce());
    await userEvent.setup().click(screen.getByRole('button', { name: 'Visit login' }));
    expect(screen.getByRole('heading', { name: 'Checking your session' })).toBeTruthy();
    await act(async () => { gate.reject(new AuthFailure('http', 400, 'INVALID_REQUEST')); });
    await fields(); expect(screen.queryByRole('alert')).toBeNull(); expect(setup.api.csrf).toHaveBeenCalledTimes(3);
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now); now += 30_000;
    const verification = deferred<Awaited<ReturnType<AuthApi['csrf']>>>(); setup.api.csrf.mockReturnValueOnce(verification.promise);
    fireEvent.focus(window); await waitFor(() => expect(setup.api.csrf).toHaveBeenCalledTimes(4));
    expect(screen.getByText('Checking your session…')).toBeTruthy(); expect(screen.queryByText('Signing in')).toBeNull();
    await act(async () => { verification.resolve({ csrfToken: proof, registrationEnabled: false }); });
    expect(setup.api.login).toHaveBeenCalledOnce();
  });
  it('does not infer authentication when login succeeded but its authoritative verification fails', async () => {
    const setup = start(); const { form } = await fields();
    setup.api.login.mockImplementation(async () => { setup.api.me.mockRejectedValue(new AuthFailure('http', 503)); return { user, csrfToken: rotated }; });
    fill(); fireEvent.submit(form);
    const recover = await screen.findByRole('button', { name: 'Check session' });
    expect(screen.getByLabelText('Current path').textContent).toBe('/login'); expect(screen.queryByRole('heading', { name: 'Your workspace' })).toBeNull();
    expect(setup.api.login).toHaveBeenCalledOnce(); authenticated(setup);
    await userEvent.setup().click(recover); await screen.findByRole('heading', { name: 'Your workspace' });
    expect(setup.api.login).toHaveBeenCalledOnce();
  });
  it('keeps secrets out of rendered feedback, browser storage, history state and URLs', async () => {
    const setup = start(); const { form } = await fields();
    setup.api.login.mockRejectedValue(new AuthFailure('network')); fill(); fireEvent.submit(form);
    await screen.findByRole('alert'); await waitFor(() => expect(setup.store.getSnapshot().busy).toBe(false));
    const publicValues = [document.body.textContent, JSON.stringify(window.history.state), window.location.href,
      JSON.stringify({ ...window.localStorage }), JSON.stringify({ ...window.sessionStorage })].join(' ');
    for (const secret of [credentials.password, proof, rotated]) expect(publicValues).not.toContain(secret);
    expect(window.localStorage.length).toBe(0); expect(window.sessionStorage.length).toBe(0);
    expect(setup.api.login).toHaveBeenCalledOnce();
  });
  it('respects 429 cooldown without replay or automatic deadline requests, then offers explicit recovery', async () => {
    vi.useFakeTimers(); const setup = start(); await act(async () => {});
    const deadline = Date.now() + 5000;
    setup.api.login.mockRejectedValueOnce(new AuthFailure('http', 429, 'RATE_LIMITED', deadline));
    fill(); await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Sign in' })); });
    expect(screen.getByRole('alert').textContent).toContain('Too many attempts');
    const recover = screen.getByRole('button', { name: 'Check session' }) as HTMLButtonElement;
    expect(recover.disabled).toBe(true); expect(setup.api.csrf).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(recover.disabled).toBe(false); expect(setup.api.csrf).toHaveBeenCalledTimes(2); expect(setup.api.login).toHaveBeenCalledOnce();
    await act(async () => { fireEvent.click(recover); });
    expect(screen.getByRole('form', { name: 'Sign in' })).toBeTruthy(); expect(setup.api.csrf).toHaveBeenCalledTimes(3);
  });
  it('keeps the eight-second indicator informational throughout a slow login', async () => {
    vi.useFakeTimers(); const setup = start(); await act(async () => {});
    const gate = deferred<Awaited<ReturnType<AuthApi['login']>>>(); setup.api.login.mockReturnValue(gate.promise);
    fill(); await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Sign in' })); await vi.advanceTimersByTimeAsync(8000); });
    expect(screen.getByText(/longer than expected/)).toBeTruthy(); expect(setup.held()).toBe(1); expect(setup.api.login).toHaveBeenCalledOnce();
    await act(async () => { gate.reject(new AuthFailure('http', 401, 'INVALID_CREDENTIALS')); });
  });
  it.each([400, 401, 403, 409, 503])('shows trusted feedback for HTTP %i without replaying the POST', async (status) => {
    const setup = start(); const { form, password } = await fields();
    setup.api.login.mockRejectedValueOnce(new AuthFailure('http', status, status === 401 ? 'INVALID_CREDENTIALS' : 'REQUEST_REJECTED'));
    fill(); fireEvent.submit(form); const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toContain('fixture@example.invalid'); expect(password.value).toBe('');
    await waitFor(() => expect(setup.store.getSnapshot().busy).toBe(false)); expect(setup.api.login).toHaveBeenCalledOnce();
    expect(screen.queryByRole('heading', { name: 'Your workspace' })).toBeNull();
  });
  it('does not describe malformed protocol responses as definite rejection even when their status is 400', async () => {
    const setup = start('/register', fixture({ registration: true })); const { form } = await fields('register');
    setup.api.register.mockRejectedValueOnce(new AuthFailure('protocol', 400)); fill(); fireEvent.submit(form);
    const alert = await screen.findByRole('alert'); expect(alert.textContent).toContain('could not confirm');
    await waitFor(() => expect(setup.store.getSnapshot().busy).toBe(false)); expect(setup.store.getSnapshot().outcomeUncertain).toBe(true);
    expect((screen.getByRole('button', { name: 'Create account' }) as HTMLButtonElement).disabled).toBe(true);
    expect(setup.api.register).toHaveBeenCalledOnce(); expect(setup.api.csrf).toHaveBeenCalledTimes(3);
  });
});

describe('minimal workspace and conservative logout', () => {
  it('ignores abandoned logout callbacks without cancelling requests or adding a verification read', async () => {
    const setup = start('/app', fixture({ authenticated: true })); const button = await screen.findByRole('button', { name: 'Sign out' });
    const gate = deferred<void>(); setup.api.logout.mockReturnValue(gate.promise); fireEvent.click(button);
    await waitFor(() => expect(setup.api.logout).toHaveBeenCalledOnce());
    await userEvent.setup().click(screen.getByRole('button', { name: 'Leave page' }));
    expect(setup.subscriptions()).toBe(0); expect(setup.held()).toBe(1); anonymous(setup);
    await act(async () => { gate.resolve(); });
    expect(screen.getByLabelText('Current path').textContent).toBe('/missing'); expect(setup.api.csrf).toHaveBeenCalledTimes(2);
    expect(setup.held()).toBe(0); expect(setup.subscriptions()).toBe(0);
  });
  it('shows only safe verified user information and honest future-work messaging', async () => {
    start('/app', fixture({ authenticated: true }));
    expect(await screen.findByRole('heading', { name: 'Your workspace' })).toBeTruthy();
    expect(screen.getByText(user.email)).toBeTruthy(); expect(document.body.textContent).not.toContain(user.id);
    expect(document.body.textContent).not.toContain(proof); expect(document.body.textContent).not.toContain(rotated);
    expect(screen.getByText(/Application tracking will arrive in a later milestone/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy();
  });
  it('gates workspace while logout and anonymous confirmation are pending, prevents duplicates and redirects only on proof', async () => {
    const setup = start('/app', fixture({ authenticated: true })); const button = await screen.findByRole('button', { name: 'Sign out' });
    const logout = deferred<void>(); const confirmation = deferred<Awaited<ReturnType<AuthApi['me']>>>();
    setup.api.logout.mockReturnValue(logout.promise); fireEvent.click(button); fireEvent.click(button);
    await waitFor(() => expect(setup.api.logout).toHaveBeenCalledOnce());
    expect(screen.queryByText(user.email)).toBeNull(); expect(screen.getByLabelText('Current path').textContent).toBe('/app');
    anonymous(setup); setup.api.me.mockReturnValueOnce(confirmation.promise);
    await act(async () => { logout.resolve(); });
    expect(screen.getByLabelText('Current path').textContent).toBe('/app'); expect(screen.queryByRole('form')).toBeNull();
    await act(async () => { confirmation.reject(new AuthFailure('http', 401, 'UNAUTHENTICATED')); });
    expect(await screen.findByRole('form', { name: 'Sign in' })).toBeTruthy(); expect(setup.api.logout).toHaveBeenCalledOnce();
  });
  it('does not claim logout when a replacement authenticated session is discovered', async () => {
    const setup = start('/app', fixture({ authenticated: true })); const button = await screen.findByRole('button', { name: 'Sign out' });
    const replacement = { ...user, id: 'bb08d55f-7869-46d3-a2af-f4676ac7019d', email: 'replacement@example.invalid' };
    setup.api.logout.mockImplementation(async () => { authenticated(setup, replacement); }); fireEvent.click(button);
    expect(await screen.findByText(/current session is still signed in/)).toBeTruthy();
    expect(await screen.findByText(replacement.email)).toBeTruthy(); expect(screen.getByLabelText('Current path').textContent).toBe('/app');
    expect(document.body.textContent).not.toContain('You have been signed out'); expect(setup.api.logout).toHaveBeenCalledOnce();
  });
  it('retains logout feedback above unmounted protected children and exposes explicit failed-reconciliation recovery', async () => {
    const setup = start('/app', fixture({ authenticated: true })); const button = await screen.findByRole('button', { name: 'Sign out' });
    setup.api.logout.mockImplementation(async () => { setup.api.me.mockRejectedValue(new AuthFailure('http', 503)); throw new AuthFailure('network'); });
    fireEvent.click(button); expect(await screen.findByRole('alert')).toBeTruthy();
    const recover = await screen.findByRole('button', { name: 'Check session' });
    expect(screen.queryByText(user.email)).toBeNull(); expect(screen.getByLabelText('Current path').textContent).toBe('/app');
    expect(setup.api.csrf).toHaveBeenCalledTimes(3); authenticated(setup);
    await userEvent.setup().click(recover);
    expect(await screen.findByRole('heading', { name: 'Your workspace' })).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('could not confirm'); expect(setup.store.getSnapshot().outcomeUncertain).toBe(true);
    expect(setup.api.logout).toHaveBeenCalledOnce();
  });
  it('handles an ambiguous logout with a verified anonymous session without claiming confirmed mutation success', async () => {
    const setup = start('/app', fixture({ authenticated: true })); const button = await screen.findByRole('button', { name: 'Sign out' });
    setup.api.logout.mockImplementation(async () => { anonymous(setup); throw new AuthFailure('network'); }); fireEvent.click(button);
    await fields(); expect(setup.store.getSnapshot()).toMatchObject({ status: 'anonymous', outcomeUncertain: true });
    expect(document.body.textContent).not.toContain('You have been signed out');
    expect(screen.getByText(/outcome of an earlier request may differ/)).toBeTruthy(); expect(setup.api.logout).toHaveBeenCalledOnce();
  });
  it('does not claim logout after a confirmed response when the confirmation read fails', async () => {
    const setup = start('/app', fixture({ authenticated: true })); const button = await screen.findByRole('button', { name: 'Sign out' });
    setup.api.logout.mockImplementation(async () => { setup.api.me.mockRejectedValue(new AuthFailure('http', 503)); }); fireEvent.click(button);
    const recover = await screen.findByRole('button', { name: 'Check session' });
    expect(screen.getByLabelText('Current path').textContent).toBe('/app'); expect(screen.queryByRole('form')).toBeNull();
    expect(document.body.textContent).not.toContain('You have been signed out');
    anonymous(setup); await userEvent.setup().click(recover); await fields(); expect(setup.api.logout).toHaveBeenCalledOnce();
  });
  it('reuses authoritative logout reconciliation without another recovery request', async () => {
    const setup = start('/app', fixture({ authenticated: true })); const button = await screen.findByRole('button', { name: 'Sign out' });
    setup.api.logout.mockRejectedValueOnce(new AuthFailure('http', 403, 'REQUEST_REJECTED')); fireEvent.click(button);
    await screen.findByRole('alert'); await screen.findByRole('button', { name: 'Sign out' });
    expect(setup.api.csrf).toHaveBeenCalledTimes(3); expect(setup.api.me).toHaveBeenCalledTimes(3);
    expect(setup.store.getSnapshot().verifiedReadId).not.toBeNull(); expect(setup.api.logout).toHaveBeenCalledOnce();
  });
});
