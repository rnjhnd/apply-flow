import { StrictMode, useEffect, type ReactNode } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthFailure, type AuthApi } from '../../lib/auth/api';
import { authFixture, credentials, deferred, proof, rotated, user } from '../../test/auth-fixtures';
import { AuthProvider } from './auth-provider';
import { AuthRoute } from './auth-route';
import { useAuth } from './use-auth';
import { App } from '../../App';

const fixtures: ReturnType<typeof authFixture>[] = [];
function fixture(options: Parameters<typeof authFixture>[0] = {}) {
  const setup = authFixture(options); fixtures.push(setup); return setup;
}
const flush = async () => { await act(async () => {}); };
afterEach(() => { for (const setup of fixtures) setup.store.dispose(); fixtures.length = 0; });
function mount(setup: ReturnType<typeof fixture>, kind: 'guest' | 'protected' | 'registration' = 'guest', children: ReactNode = <h1>Admitted content</h1>) {
  return render(<StrictMode><MemoryRouter><AuthProvider store={setup.store}>
    <AuthRoute kind={kind}>{children}</AuthRoute>
  </AuthProvider></MemoryRouter></StrictMode>);
}
async function pendingMutation(kind: 'login' | 'logout') {
  const setup = fixture({ authenticated: kind === 'logout' }); await setup.store.bootstrap();
  const gate = deferred<void>();
  setup.api.login.mockImplementation(async () => { await gate.promise; return { user, csrfToken: rotated }; });
  setup.api.logout.mockReturnValue(gate.promise);
  const operation = kind === 'logout' ? setup.store.logout() : setup.store.login(credentials);
  await waitFor(() => expect(setup.api[kind]).toHaveBeenCalledOnce());
  return { setup, gate, operation };
}

describe('verification consumer ownership', () => {
  it.each(['login', 'logout'] as const)('removes abandoned subscriptions and requests across repeated mounts during pending %s', async (kind) => {
    const { setup, gate, operation } = await pendingMutation(kind);
    const dispose = vi.spyOn(setup.store, 'dispose');
    for (let i = 0; i < 3; i++) {
      const view = mount(setup); await flush();
      expect(setup.subscriptions()).toBe(2); // One React observer and one shared, unstarted verification waiter.
      view.unmount(); expect(setup.subscriptions()).toBe(0);
      expect(setup.api.csrf).toHaveBeenCalledTimes(2); expect(setup.held()).toBe(1);
    }
    await act(async () => { gate.resolve(); await operation; });
    expect(setup.api.csrf).toHaveBeenCalledTimes(2); expect(setup.api.me).toHaveBeenCalledTimes(2);
    expect(setup.api[kind]).toHaveBeenCalledOnce(); expect(setup.subscriptions()).toBe(0);
    expect(setup.held()).toBe(0); expect(dispose).not.toHaveBeenCalled();
  });
  it.each(['login', 'logout'] as const)('shares one fresh verification with a surviving consumer after abandoned pending-%s visits', async (kind) => {
    const { setup, gate, operation } = await pendingMutation(kind);
    for (let i = 0; i < 3; i++) { const view = mount(setup); await flush(); view.unmount(); expect(setup.subscriptions()).toBe(0); }
    const active = mount(setup, kind === 'login' ? 'protected' : 'guest'); await flush();
    expect(setup.subscriptions()).toBe(2); expect(setup.held()).toBe(1);
    expect(screen.queryByRole('heading', { name: 'Admitted content' })).toBeNull();
    if (kind === 'login') setup.api.me.mockResolvedValue({ user });
    else setup.api.me.mockRejectedValue(new AuthFailure('http', 401, 'UNAUTHENTICATED'));
    setup.api.csrf.mockResolvedValue({ csrfToken: rotated, registrationEnabled: false });
    await act(async () => { gate.resolve(); await operation; });
    expect(await screen.findByRole('heading', { name: 'Admitted content' })).toBeTruthy();
    expect(setup.api.csrf).toHaveBeenCalledTimes(3); expect(setup.api.me).toHaveBeenCalledTimes(3);
    expect(setup.api[kind]).toHaveBeenCalledOnce(); expect(setup.subscriptions()).toBe(1);
    expect(setup.store.getSnapshot().verifiedReadId).toBe(2);
    active.unmount(); expect(setup.subscriptions()).toBe(0); expect(setup.held()).toBe(0);
  });
  it('keeps a dispatched read locked and shares it with a remounted StrictMode consumer', async () => {
    const setup = fixture({ authenticated: true }); const gate = deferred<Awaited<ReturnType<AuthApi['me']>>>();
    setup.api.me.mockReturnValue(gate.promise);
    const first = mount(setup, 'protected'); await waitFor(() => expect(setup.api.me).toHaveBeenCalledOnce());
    first.unmount(); expect(setup.subscriptions()).toBe(0); expect(setup.held()).toBe(1);
    const next = mount(setup, 'protected'); await flush(); expect(setup.api.csrf).toHaveBeenCalledOnce();
    await act(async () => { gate.resolve({ user }); });
    expect(await screen.findByRole('heading', { name: 'Admitted content' })).toBeTruthy();
    expect(setup.api.csrf).toHaveBeenCalledOnce(); expect(setup.held()).toBe(0);
    next.unmount(); expect(setup.subscriptions()).toBe(0);
  });
  it('does not start a request for a consumer abandoned before the scheduled verification starts', async () => {
    const setup = fixture(); const view = mount(setup); view.unmount(); await flush();
    expect(setup.api.csrf).not.toHaveBeenCalled(); expect(setup.subscriptions()).toBe(0);
  });
  it('retains one shared waiter while another active consumer still needs verification', async () => {
    const { setup, gate, operation } = await pendingMutation('login');
    const first = mount(setup, 'protected'); await flush();
    const second = mount(setup, 'protected'); await flush(); expect(setup.subscriptions()).toBe(3);
    first.unmount(); expect(setup.subscriptions()).toBe(2); expect(setup.api.csrf).toHaveBeenCalledTimes(2);
    setup.api.me.mockResolvedValue({ user }); setup.api.csrf.mockResolvedValue({ csrfToken: rotated, registrationEnabled: false });
    await act(async () => { gate.resolve(); await operation; });
    expect(await screen.findByRole('heading', { name: 'Admitted content' })).toBeTruthy();
    expect(setup.api.csrf).toHaveBeenCalledTimes(3); expect(setup.subscriptions()).toBe(1);
    second.unmount(); expect(setup.subscriptions()).toBe(0);
  });
  it.each(['login', 'logout'] as const)('uses a real reconciliation receipt from pending %s without repeating its completed read', async (kind) => {
    const { setup, gate, operation } = await pendingMutation(kind);
    const view = mount(setup, kind === 'login' ? 'protected' : 'guest'); await flush();
    act(() => setup.notify('invalidate'));
    expect(screen.queryByRole('heading', { name: 'Admitted content' })).toBeNull();
    if (kind === 'login') setup.api.me.mockResolvedValue({ user });
    else setup.api.me.mockRejectedValue(new AuthFailure('http', 401, 'UNAUTHENTICATED'));
    setup.api.csrf.mockResolvedValue({ csrfToken: rotated, registrationEnabled: false });
    await act(async () => { gate.resolve(); await operation; });
    expect(await screen.findByRole('heading', { name: 'Admitted content' })).toBeTruthy();
    expect(setup.store.getSnapshot().verifiedReadId).toBe(2);
    expect(setup.api.csrf).toHaveBeenCalledTimes(3); expect(setup.api.me).toHaveBeenCalledTimes(3);
    expect(setup.api[kind]).toHaveBeenCalledOnce(); expect(setup.subscriptions()).toBe(1);
    view.unmount(); expect(setup.subscriptions()).toBe(0);
  });
});

describe('freshness-driven external recovery', () => {
  it.each(['anonymous', 'authenticated'] as const)('recovers a failed entry from a newer external %s receipt without a redundant read', async (status) => {
    const setup = fixture({ authenticated: status === 'authenticated' });
    setup.api.csrf.mockRejectedValueOnce(new AuthFailure('http', 503));
    mount(setup, status === 'authenticated' ? 'protected' : 'guest');
    await screen.findByRole('button', { name: 'Check session' });
    const gate = deferred<Awaited<ReturnType<AuthApi['csrf']>>>(); setup.api.csrf.mockReturnValueOnce(gate.promise);
    act(() => setup.notify('invalidate'));
    expect(setup.store.getSnapshot().verifiedReadId).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Admitted content' })).toBeNull();
    await act(async () => { gate.resolve({ csrfToken: proof, registrationEnabled: false }); });
    expect(await screen.findByRole('heading', { name: 'Admitted content' })).toBeTruthy();
    expect(setup.store.getSnapshot()).toMatchObject({ verifiedReadId: 1, busy: false, status });
    expect(setup.api.csrf).toHaveBeenCalledTimes(2); expect(setup.api.me).toHaveBeenCalledOnce();
    expect(setup.api.login).not.toHaveBeenCalled(); expect(setup.api.logout).not.toHaveBeenCalled();
  });
  it('keeps failed external recovery gated and explicitly recoverable', async () => {
    const setup = fixture({ authenticated: true }); setup.api.csrf.mockRejectedValueOnce(new AuthFailure('http', 503));
    mount(setup, 'protected'); await screen.findByRole('button', { name: 'Check session' });
    setup.api.me.mockRejectedValueOnce(new AuthFailure('http', 503));
    await act(async () => { setup.notify('invalidate'); });
    expect(setup.store.getSnapshot()).toMatchObject({ status: 'unavailable', verifiedReadId: null, busy: false });
    expect(screen.queryByRole('heading', { name: 'Admitted content' })).toBeNull();
    expect(setup.api.csrf).toHaveBeenCalledTimes(2);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check session' }));
    expect(await screen.findByRole('heading', { name: 'Admitted content' })).toBeTruthy();
    expect(setup.api.csrf).toHaveBeenCalledTimes(3);
  });
  it('rejects stale external verification without flashing protected content', async () => {
    const setup = fixture({ authenticated: true }); setup.api.csrf.mockRejectedValueOnce(new AuthFailure('http', 503));
    const admitted = vi.fn(); function Content() { useEffect(() => { admitted(); }, []); return <h1>Admitted content</h1>; }
    mount(setup, 'protected', <Content />); await screen.findByRole('button', { name: 'Check session' });
    const gate = deferred<Awaited<ReturnType<AuthApi['me']>>>();
    setup.api.me.mockReturnValueOnce(gate.promise).mockRejectedValueOnce(new AuthFailure('http', 503));
    act(() => setup.notify('invalidate')); await waitFor(() => expect(setup.api.me).toHaveBeenCalledOnce());
    act(() => setup.notify('invalidate'));
    await act(async () => { gate.resolve({ user }); });
    expect(setup.store.getSnapshot()).toMatchObject({ verifiedReadId: null, busy: false, status: 'unavailable' });
    expect(admitted).not.toHaveBeenCalled(); expect(setup.api.csrf).toHaveBeenCalledTimes(3);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check session' }));
    expect(await screen.findByRole('heading', { name: 'Admitted content' })).toBeTruthy();
    expect(setup.api.csrf).toHaveBeenCalledTimes(4);
  });
  it('does not accept a cached pre-entry receipt when new entry verification fails', async () => {
    const setup = fixture({ authenticated: true }); await setup.store.bootstrap();
    expect(setup.store.getSnapshot().verifiedReadId).toBe(1);
    setup.api.csrf.mockRejectedValueOnce(new AuthFailure('http', 503)); mount(setup, 'protected');
    expect(screen.queryByRole('heading', { name: 'Admitted content' })).toBeNull();
    await screen.findByRole('button', { name: 'Check session' });
    expect(setup.store.getSnapshot().verifiedReadId).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Admitted content' })).toBeNull();
    await act(async () => { setup.notify('invalidate'); });
    expect(await screen.findByRole('heading', { name: 'Admitted content' })).toBeTruthy();
    expect(setup.store.getSnapshot().verifiedReadId).toBe(2); expect(setup.api.csrf).toHaveBeenCalledTimes(3);
  });
  it('requires a fresh read after mutation success and cached bootstrap before redirecting to protected content', async () => {
    const setup = fixture();
    function Location() { return <output aria-label="Current path">{useLocation().pathname}</output>; }
    render(<StrictMode><MemoryRouter initialEntries={['/login']}><Location /><App authStore={setup.store} /></MemoryRouter></StrictMode>);
    await screen.findByRole('heading', { name: 'Sign in' });
    setup.api.login.mockImplementation(async () => {
      setup.api.me.mockResolvedValue({ user }); setup.api.csrf.mockResolvedValue({ csrfToken: rotated, registrationEnabled: false });
      return { user, csrfToken: rotated };
    });
    await act(async () => { await setup.store.login(credentials); });
    expect(setup.store.getSnapshot()).toMatchObject({ status: 'authenticated', verifiedReadId: null, busy: false });
    expect(screen.getByLabelText('Current path').textContent).toBe('/login');
    expect(screen.queryByRole('heading', { name: 'Workspace route verified' })).toBeNull();
    await act(async () => { await setup.store.bootstrap(); });
    expect(setup.api.csrf).toHaveBeenCalledTimes(2); expect(screen.getByLabelText('Current path').textContent).toBe('/login');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check session' }));
    expect(await screen.findByRole('heading', { name: 'Workspace route verified' })).toBeTruthy();
    expect(setup.api.csrf).toHaveBeenCalledTimes(4); expect(setup.api.login).toHaveBeenCalledOnce();
  });
});

describe('guest interaction admission (test-only forms)', () => {
  function Form({ kind = 'login', attempted = vi.fn(), rejected = vi.fn() }: {
    kind?: 'login' | 'register'; attempted?: () => void; rejected?: (error: unknown) => void;
  }) {
    const { integration } = useAuth();
    return <form aria-label="Test guest form" onSubmit={(event) => {
      event.preventDefault(); attempted();
      // Deliberately consult the live service, not the render snapshot or disabled attribute.
      void integration.store[kind](credentials).catch(rejected);
    }}><label>Test field<input name="draft" /></label><button type="submit">Submit test</button></form>;
  }
  it('excludes unknown and invalidated guest controls from normal keyboard navigation', async () => {
    const setup = fixture(); const gate = deferred<Awaited<ReturnType<AuthApi['csrf']>>>();
    setup.api.csrf.mockReturnValueOnce(gate.promise);
    const attempted = vi.fn(); const rejected = vi.fn(); const keyboard = userEvent.setup();
    render(<StrictMode><MemoryRouter><button>Outside before</button><AuthProvider store={setup.store}>
      <AuthRoute kind="guest"><Form attempted={attempted} rejected={rejected} /></AuthRoute>
    </AuthProvider><button>Outside after</button></MemoryRouter></StrictMode>);
    const before = screen.getByRole('button', { name: 'Outside before' });
    const after = screen.getByRole('button', { name: 'Outside after' });
    before.focus(); await keyboard.tab(); expect(document.activeElement).toBe(after);
    await act(async () => { gate.resolve({ csrfToken: proof, registrationEnabled: false }); });
    const input = await screen.findByRole('textbox', { name: 'Test field' });
    before.focus(); await keyboard.tab(); expect(document.activeElement).toBe(input);
    setup.api.csrf.mockRejectedValueOnce(new AuthFailure('http', 503));
    await act(async () => { setup.notify('invalidate'); });
    expect(input.isConnected).toBe(true); expect(input.closest('fieldset')?.hasAttribute('inert')).toBe(true);
    before.focus(); await keyboard.tab(); expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Check session' }));
    await keyboard.tab(); expect(document.activeElement).toBe(after);
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Test guest form', hidden: true })); });
    expect(attempted).toHaveBeenCalledOnce(); expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stale' }));
    expect(setup.api.login).not.toHaveBeenCalled();
  });
  it('blocks pending submission both in normal interaction and after programmatic DOM bypass', async () => {
    let now = Date.now(); vi.spyOn(Date, 'now').mockImplementation(() => now);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const setup = fixture(); const attempted = vi.fn(); const rejected = vi.fn();
    mount(setup, 'guest', <Form attempted={attempted} rejected={rejected} />);
    const submit = await screen.findByRole('button', { name: 'Submit test' });
    const gate = deferred<Awaited<ReturnType<AuthApi['csrf']>>>(); setup.api.csrf.mockReturnValueOnce(gate.promise);
    now += 30_000; fireEvent.focus(window); await waitFor(() => expect(setup.api.csrf).toHaveBeenCalledTimes(2));
    expect(submit.closest('fieldset')?.disabled).toBe(true); expect(submit.closest('fieldset')?.hasAttribute('inert')).toBe(true);
    await userEvent.setup().click(submit); expect(attempted).not.toHaveBeenCalled();
    await act(async () => { fireEvent.submit(screen.getByRole('form', { name: 'Test guest form' })); });
    expect(attempted).toHaveBeenCalledOnce(); expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ kind: 'busy' }));
    expect(setup.api.login).not.toHaveBeenCalled();
    await act(async () => { gate.resolve({ csrfToken: proof, registrationEnabled: false }); });
  });
  it('removes registration interaction on capability revocation and rejects live submission admission', async () => {
    const setup = fixture({ registration: true }); const attempted = vi.fn(); const rejected = vi.fn();
    mount(setup, 'registration', <Form kind="register" attempted={attempted} rejected={rejected} />);
    const submit = await screen.findByRole('button', { name: 'Submit test' }); const form = submit.closest('form')!;
    setup.api.csrf.mockResolvedValue({ csrfToken: proof, registrationEnabled: false });
    await act(async () => { setup.notify('invalidate'); });
    expect(await screen.findByRole('heading', { name: 'Account creation is unavailable' })).toBeTruthy();
    expect(form.isConnected).toBe(false); expect(screen.queryByRole('button', { name: 'Submit test' })).toBeNull();
    submit.focus(); expect(document.activeElement).not.toBe(submit);
    // An obsolete handler cannot bypass live capability validation even without any DOM control.
    await act(async () => { await setup.store.register(credentials).catch(rejected); });
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ kind: 'validation', status: 404 }));
    expect(setup.api.register).not.toHaveBeenCalled(); expect(attempted).not.toHaveBeenCalled();
  });
});
