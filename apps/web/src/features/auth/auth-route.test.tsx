import { StrictMode, useEffect } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation, useNavigate } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { AuthFailure, type AuthApi } from '../../lib/auth/api';
import * as authStoreModule from '../../lib/auth/store';
import { AuthProvider } from './auth-provider';
import { AuthRoute } from './auth-route';
import { authFixture, credentials, deferred, proof, rotated, user } from '../../test/auth-fixtures';

const fixtures: ReturnType<typeof authFixture>[] = [];
function fixture(options: Parameters<typeof authFixture>[0] = {}) {
  const result = authFixture(options); fixtures.push(result); return result;
}
function Navigation() {
  const navigate = useNavigate(); const location = useLocation();
  return <nav aria-label="Test navigation">
    <button onClick={() => navigate('/')}>Go home</button>
    <button onClick={() => navigate('/login')}>Go login</button>
    <button onClick={() => navigate('/register')}>Go register</button>
    <button onClick={() => navigate('/app')}>Go app</button>
    <button onClick={() => navigate(-1)}>Back</button>
    <output aria-label="Current path">{location.pathname}</output>
  </nav>;
}
function start(path: string, setup = fixture()) {
  const view = render(<StrictMode><MemoryRouter initialEntries={[path]}>
    <Navigation /><App authStore={setup.store} />
  </MemoryRouter></StrictMode>);
  return { ...setup, ...view };
}
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ status: 'ok', service: 'applyflow-api' }),
    { headers: { 'Content-Type': 'application/json' } })));
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => { for (const setup of fixtures) setup.store.dispose(); fixtures.length = 0; });

describe('authentication route integration', () => {
  it('creates the production singleton integration only when leaving welcome for an auth route', async () => {
    const setup = fixture(); const factory = vi.spyOn(authStoreModule, 'getAuthStore').mockReturnValue(setup.store);
    render(<StrictMode><MemoryRouter><App /></MemoryRouter></StrictMode>);
    await screen.findByText('API available'); expect(factory).not.toHaveBeenCalled();
    await userEvent.setup().click(screen.getByRole('link', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(factory).toHaveBeenCalled(); expect(setup.api.csrf).toHaveBeenCalledOnce();
  });
  it('provides keyboard-activated explicit recovery', async () => {
    const setup = fixture(); setup.api.csrf.mockRejectedValueOnce(new AuthFailure('http', 503));
    start('/login', setup); const button = await screen.findByRole('button', { name: 'Check session' });
    button.focus(); expect(document.activeElement).toBe(button);
    await userEvent.setup().keyboard('{Enter}');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(setup.api.csrf).toHaveBeenCalledTimes(2); expect(document.querySelector('form')).toBeNull();
  });
  it('exposes explicit recovery for the accepted invalidation-then-400 regression without replay', async () => {
    const setup = start('/login'); await screen.findByRole('heading', { name: 'Sign in' });
    const gate = deferred<Awaited<ReturnType<AuthApi['login']>>>(); setup.api.login.mockReturnValue(gate.promise);
    let operation!: ReturnType<typeof setup.store.login>;
    await act(async () => { operation = setup.store.login(credentials); void operation.catch(() => {}); });
    await waitFor(() => expect(setup.api.login).toHaveBeenCalledOnce());
    act(() => setup.notify('invalidate'));
    await act(async () => { gate.reject(new AuthFailure('http', 400, 'INVALID_REQUEST')); await operation.catch(() => {}); });
    const button = await screen.findByRole('button', { name: 'Check session' });
    expect(setup.store.getSnapshot()).toMatchObject({ status: 'unavailable', busy: false });
    expect(setup.api.csrf).toHaveBeenCalledTimes(2);
    await userEvent.setup().click(button);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy(); expect(setup.api.login).toHaveBeenCalledOnce();
  });
  it('preserves cooldown after mutation invalidation, suppresses foreground checks, and requires explicit recovery', async () => {
    vi.useFakeTimers(); const setup = fixture(); const deadline = Date.now() + 45_000;
    start('/login', setup); await act(async () => {});
    setup.api.login.mockRejectedValueOnce(new AuthFailure('http', 429, 'RATE_LIMITED', deadline));
    await act(async () => { await setup.store.login(credentials).catch(() => {}); setup.notify('invalidate'); });
    const button = screen.getByRole('button', { name: 'Check session' }); expect(button.hasAttribute('disabled')).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); fireEvent.focus(window); fireEvent(document, new Event('visibilitychange')); });
    expect(setup.api.csrf).toHaveBeenCalledTimes(2); expect(setup.api.login).toHaveBeenCalledOnce();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(button.hasAttribute('disabled')).toBe(false); expect(setup.api.csrf).toHaveBeenCalledTimes(2);
    await act(async () => { fireEvent.click(button); });
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy(); expect(setup.api.login).toHaveBeenCalledOnce();
  });
  it('does not expose cached workspace content when fresh validation reports session expiry', async () => {
    const setup = fixture({ authenticated: true }); await setup.store.bootstrap();
    setup.api.me.mockRejectedValue(new AuthFailure('http', 401, 'UNAUTHENTICATED'));
    start('/app', setup);
    expect(screen.queryByRole('heading', { name: 'Workspace route verified' })).toBeNull();
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByLabelText('Current path').textContent).toBe('/login');
  });
  it('preserves public welcome/health and performs no authentication bootstrap', async () => {
    const setup = start('/');
    expect(screen.getByRole('heading', { name: /Your next chapter/ })).toBeTruthy();
    expect(await screen.findByText('API available')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
    expect(setup.api.csrf).not.toHaveBeenCalled(); expect(setup.api.me).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.every(([url]) => url === '/api/v1/health/live')).toBe(true);
  });
  it('single-flights actual StrictMode initialization and never disposes on React cleanup', async () => {
    const setup = fixture(); const dispose = vi.spyOn(setup.store, 'dispose');
    const subscribe = vi.spyOn(setup.store, 'subscribe');
    const view = start('/login', setup);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(setup.api.csrf).toHaveBeenCalledOnce(); expect(setup.api.me).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalled(); view.unmount(); expect(dispose).not.toHaveBeenCalled();
  });
  it('gates even cached authenticated state until the new entry is verified', async () => {
    const setup = fixture({ authenticated: true }); await setup.store.bootstrap();
    const gate = deferred<Awaited<ReturnType<AuthApi['me']>>>(); setup.api.me.mockReturnValueOnce(gate.promise);
    start('/app', setup);
    expect(screen.queryByRole('heading', { name: 'Workspace route verified' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Checking your session' })).toBeTruthy();
    await act(async () => { gate.resolve({ user }); });
    expect(await screen.findByRole('heading', { name: 'Workspace route verified' })).toBeTruthy();
    expect(setup.api.csrf).toHaveBeenCalledTimes(2);
    expect(document.body.textContent).not.toContain(user.email);
    expect(document.body.textContent).not.toContain(proof);
  });
  it('redirects a verified anonymous protected visit to login', async () => {
    start('/app');
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByLabelText('Current path').textContent).toBe('/login');
    expect(screen.queryByRole('heading', { name: 'Workspace route verified' })).toBeNull();
  });
  it.each(['/login', '/register'])('redirects authenticated %s to the protected boundary', async (path) => {
    const setup = start(path, fixture({ authenticated: true }));
    expect(await screen.findByRole('heading', { name: 'Workspace route verified' })).toBeTruthy();
    expect(screen.getByLabelText('Current path').textContent).toBe('/app');
    expect(setup.api.login).not.toHaveBeenCalled(); expect(setup.api.register).not.toHaveBeenCalled();
  });
  it('renders registration placeholder only after explicit server permission', async () => {
    start('/register', fixture({ registration: true }));
    expect(await screen.findByRole('heading', { name: 'Create an account' })).toBeTruthy();
    expect(document.querySelector('form')).toBeNull();
  });
  it('explains disabled direct registration and provides a working Sign in link', async () => {
    start('/register');
    expect(await screen.findByRole('heading', { name: 'Account creation is unavailable' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Create an account' })).toBeNull();
    await userEvent.setup().click(screen.getByRole('link', { name: 'Sign in' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });
  it('does not infer disabled registration while capability is unknown', async () => {
    const setup = fixture(); const gate = deferred<Awaited<ReturnType<AuthApi['csrf']>>>();
    setup.api.csrf.mockReturnValue(gate.promise); start('/register', setup);
    expect(screen.queryByRole('heading', { name: 'Account creation is unavailable' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Create an account' })).toBeNull();
    await act(async () => { gate.resolve({ csrfToken: proof, registrationEnabled: true }); });
    expect(await screen.findByRole('heading', { name: 'Create an account' })).toBeTruthy();
  });
  it.each(['http', 'network'] as const)('offers explicit %s recovery without assuming logout or replaying mutations', async (kind) => {
    const setup = fixture({ authenticated: true });
    setup.api.csrf.mockRejectedValueOnce(new AuthFailure(kind, kind === 'http' ? 503 : 0));
    start('/app', setup);
    const button = await screen.findByRole('button', { name: 'Check session' });
    expect(setup.store.getSnapshot().status).toBe(kind === 'http' ? 'unavailable' : 'uncertain');
    expect(screen.getByLabelText('Current path').textContent).toBe('/app');
    expect(screen.getByText(/does not mean you have been signed out/)).toBeTruthy();
    await userEvent.setup().click(button);
    expect(await screen.findByRole('heading', { name: 'Workspace route verified' })).toBeTruthy();
    expect(setup.api.csrf).toHaveBeenCalledTimes(2);
    expect(setup.api.login).not.toHaveBeenCalled(); expect(setup.api.logout).not.toHaveBeenCalled();
  });
  it('distinguishes unavailable coordination and sends no fallback requests', async () => {
    const setup = start('/login', fixture({ unsupported: true }));
    expect(await screen.findByRole('heading', { name: 'Browser coordination unavailable' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Check session' })).toBeNull();
    expect(setup.api.csrf).not.toHaveBeenCalled();
  });
  it('allows an authenticated snapshot with an unresolved earlier outcome and a notice', async () => {
    const setup = fixture({ registration: true }); await setup.store.bootstrap();
    setup.api.register.mockImplementation(async () => { setup.api.me.mockResolvedValue({ user }); throw new AuthFailure('network'); });
    await expect(setup.store.register(credentials)).rejects.toMatchObject({ kind: 'network' });
    start('/app', setup);
    expect(await screen.findByRole('heading', { name: 'Workspace route verified' })).toBeTruthy();
    expect(screen.getByText(/outcome of an earlier request may differ/)).toBeTruthy();
    expect(setup.store.getSnapshot().outcomeUncertain).toBe(true); expect(setup.api.register).toHaveBeenCalledOnce();
  });
  it('waits for pending authentication, then verifies the actual session before redirecting', async () => {
    const setup = fixture({ registration: true }); await setup.store.bootstrap();
    const gate = deferred<Awaited<ReturnType<AuthApi['login']>>>(); setup.api.login.mockReturnValue(gate.promise);
    const operation = setup.store.login(credentials); await waitFor(() => expect(setup.api.login).toHaveBeenCalledOnce());
    start('/register', setup); await act(async () => {});
    expect(setup.api.csrf).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('heading', { name: 'Checking your session' })).toBeTruthy();
    setup.api.csrf.mockResolvedValue({ csrfToken: rotated, registrationEnabled: true }); setup.api.me.mockResolvedValue({ user });
    await act(async () => { gate.resolve({ user, csrfToken: rotated }); await operation; });
    expect(await screen.findByRole('heading', { name: 'Workspace route verified' })).toBeTruthy();
    expect(setup.api.login).toHaveBeenCalledOnce();
  });
  it('obtains fresh proof after joining a pending logout instead of assuming anonymous is form-ready', async () => {
    const setup = fixture({ authenticated: true }); await setup.store.bootstrap();
    const gate = deferred<void>(); setup.api.logout.mockReturnValue(gate.promise);
    const operation = setup.store.logout(); await waitFor(() => expect(setup.api.logout).toHaveBeenCalledOnce());
    start('/login', setup); await act(async () => {}); expect(setup.api.csrf).toHaveBeenCalledTimes(2);
    setup.api.csrf.mockResolvedValue({ csrfToken: rotated, registrationEnabled: false });
    setup.api.me.mockRejectedValue(new AuthFailure('http', 401, 'UNAUTHENTICATED'));
    await act(async () => { gate.resolve(); await operation; });
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(setup.api.csrf).toHaveBeenCalledTimes(3); expect(setup.api.logout).toHaveBeenCalledOnce();
  });
  it('ignores obsolete route completion after leaving for the public welcome', async () => {
    const setup = fixture({ authenticated: true }); const gate = deferred<Awaited<ReturnType<AuthApi['csrf']>>>();
    setup.api.csrf.mockReturnValue(gate.promise); const dispose = vi.spyOn(setup.store, 'dispose'); start('/login', setup);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Go home' }));
    await act(async () => { gate.resolve({ csrfToken: proof, registrationEnabled: false }); });
    expect(screen.getByLabelText('Current path').textContent).toBe('/');
    expect(screen.getByRole('heading', { name: /Your next chapter/ })).toBeTruthy(); expect(dispose).not.toHaveBeenCalled();
  });
  it('replaces auth redirects in browser history rather than leaving a redirect loop', async () => {
    start('/'); const keyboard = userEvent.setup();
    await keyboard.click(screen.getByRole('button', { name: 'Go app' }));
    await screen.findByRole('heading', { name: 'Sign in' });
    await keyboard.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByRole('heading', { name: /Your next chapter/ })).toBeTruthy();
  });
  it('provides accessible unknown-route navigation and route title', async () => {
    const setup = start('/missing');
    expect(screen.getByRole('heading', { name: 'Page not found' })).toBeTruthy();
    expect(document.title).toBe('Page not found — ApplyFlow'); expect(document.activeElement?.id).toBe('main');
    await userEvent.setup().click(screen.getByRole('link', { name: 'Return home' }));
    expect(await screen.findByRole('heading', { name: /Your next chapter/ })).toBeTruthy(); expect(setup.api.csrf).not.toHaveBeenCalled();
  });
  it('shows the eight-second waiting indicator without releasing pending verification', async () => {
    vi.useFakeTimers(); const setup = fixture(); const gate = deferred<Awaited<ReturnType<AuthApi['csrf']>>>();
    setup.api.csrf.mockReturnValue(gate.promise); start('/login', setup);
    await act(async () => { await vi.advanceTimersByTimeAsync(8000); });
    expect(screen.getByText(/operation is still running/)).toBeTruthy(); expect(setup.store.getSnapshot().busy).toBe(true);
    expect(setup.api.csrf).toHaveBeenCalledOnce();
    await act(async () => { gate.resolve({ csrfToken: proof, registrationEnabled: false }); });
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
  });
  it('honors cooldown boundaries without scheduling requests and enables explicit recovery', async () => {
    vi.useFakeTimers(); const now = Date.now(); const setup = fixture();
    setup.api.csrf.mockRejectedValueOnce(new AuthFailure('http', 429, 'RATE_LIMITED', now + 2000));
    start('/login', setup); await act(async () => {});
    const button = screen.getByRole('button', { name: 'Check session' }); expect(button.hasAttribute('disabled')).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1999); }); expect(button.hasAttribute('disabled')).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); }); expect(button.hasAttribute('disabled')).toBe(false);
    expect(setup.api.csrf).toHaveBeenCalledOnce();
    await act(async () => { fireEvent.click(button); });
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy(); expect(setup.api.csrf).toHaveBeenCalledTimes(2);
  });
});

describe('foreground verification and guest DOM retention', () => {
  function sentinel(setup: ReturnType<typeof fixture>, mounted = vi.fn()) {
    function Draft() {
      useEffect(() => { mounted(); }, []);
      return <label>Draft note<input aria-label="Draft note" defaultValue="" /></label>;
    }
    render(<StrictMode><MemoryRouter initialEntries={['/login']}><AuthProvider store={setup.store}>
      <AuthRoute kind="guest"><Draft /></AuthRoute>
    </AuthProvider></MemoryRouter></StrictMode>);
    return mounted;
  }
  it('coalesces focus/visibility but preserves the same guest field through pending verification, outage, and recovery', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const setup = fixture(); const mounted = sentinel(setup); const keyboard = userEvent.setup();
    const input = await screen.findByRole('textbox', { name: 'Draft note' }); await keyboard.type(input, 'Keep this draft');
    const mountCount = mounted.mock.calls.length;
    fireEvent.focus(window); fireEvent(document, new Event('visibilitychange'));
    expect(setup.api.csrf).toHaveBeenCalledOnce();
    const gate = deferred<Awaited<ReturnType<AuthApi['csrf']>>>(); setup.api.csrf.mockReturnValueOnce(gate.promise);
    setup.api.me.mockRejectedValueOnce(new AuthFailure('http', 503, 'SERVICE_UNAVAILABLE'));
    now += 30_000; fireEvent.focus(window); fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(setup.api.csrf).toHaveBeenCalledTimes(2));
    expect(screen.getByRole('textbox', { name: 'Draft note' })).toBe(input);
    expect((input as HTMLInputElement).value).toBe('Keep this draft');
    await act(async () => { gate.resolve({ csrfToken: proof, registrationEnabled: false }); });
    const recover = await screen.findByRole('button', { name: 'Check session' });
    expect(input.isConnected).toBe(true); expect(screen.queryByRole('textbox', { name: 'Draft note' })).toBeNull();
    // Explicit recovery occurs within 30 seconds of focus and must not be throttled.
    await keyboard.click(recover);
    expect(await screen.findByRole('textbox', { name: 'Draft note' })).toBe(input);
    expect((input as HTMLInputElement).value).toBe('Keep this draft'); expect(mounted).toHaveBeenCalledTimes(mountCount);
    expect(setup.api.csrf).toHaveBeenCalledTimes(3);
  });
  it('skips foreground revalidation in a hidden document', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    const setup = fixture(); sentinel(setup); await screen.findByRole('textbox', { name: 'Draft note' });
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden'); now += 30_000;
    fireEvent.focus(window); fireEvent(document, new Event('visibilitychange')); await act(async () => {});
    expect(setup.api.csrf).toHaveBeenCalledOnce();
  });
  it('reacts to cross-tab invalidation without presenting stale guest state as authenticated', async () => {
    const setup = fixture(); sentinel(setup); const input = await screen.findByRole('textbox', { name: 'Draft note' });
    const gate = deferred<Awaited<ReturnType<AuthApi['csrf']>>>(); setup.api.csrf.mockReturnValueOnce(gate.promise);
    act(() => setup.notify('invalidate'));
    expect(screen.queryByRole('textbox', { name: 'Draft note' })).toBeNull(); expect(input.isConnected).toBe(true);
    await act(async () => { gate.resolve({ csrfToken: proof, registrationEnabled: false }); });
    expect(await screen.findByRole('textbox', { name: 'Draft note' })).toBe(input);
  });
});
