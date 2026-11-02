import { act, fireEvent, render, screen } from '@testing-library/react';
import { BrowserRouter, Route, Routes, useNavigate } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceNavigation } from './workspace-navigation';
import { WorkspaceNavigationProvider } from './workspace-navigation-provider';
import { WorkspaceNavigationContext } from './workspace-navigation-context';
import { useContext, useLayoutEffect } from 'react';

const releases: (() => void)[] = [];
afterEach(() => { releases.splice(0).reverse().forEach(release => release()); });

// Controlled POPs cover races jsdom cannot schedule. Component tests separately
// exercise BrowserRouter with jsdom's asynchronous history.back()/forward().
function historyFixture() {
  const rawReplace = window.history.replaceState.bind(window.history);
  rawReplace({ idx: 0 }, '', '/outside');
  const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
  const navigation = createWorkspaceNavigation(window); releases.push(navigation.install());
  const snapshot = () => ({ state: window.history.state as unknown, href: window.location.href });
  const outside = snapshot();
  window.history.pushState({ idx: 1 }, '', '/app'); const workspace = snapshot();
  const confirm = vi.fn(() => false);
  releases.push(navigation.register({ dirty: true, confirm }));
  const observed = vi.fn(); window.addEventListener('popstate', observed);
  releases.push(() => window.removeEventListener('popstate', observed));
  function pop(entry: ReturnType<typeof snapshot>) {
    rawReplace(entry.state, '', entry.href);
    window.dispatchEvent(new PopStateEvent('popstate', { state: entry.state }));
  }
  return { navigation, outside, workspace, snapshot, confirm, go, observed, pop };
}

describe('workspace departure restoration identities', () => {
  it.each([undefined, 1, -500, 'unexpected'])('does not trust router idx %s to cancel a POP', idx => {
    const f = historyFixture();
    f.pop({ ...f.outside, state: { ...(f.outside.state as object), idx } });
    expect(f.confirm).toHaveBeenCalledOnce(); expect(f.go).toHaveBeenCalledExactlyOnceWith(1);
    expect(f.observed).not.toHaveBeenCalled();
    f.pop(f.workspace); expect(f.observed).not.toHaveBeenCalled();
    f.confirm.mockReturnValue(true); f.pop(f.outside);
    expect(f.confirm).toHaveBeenCalledTimes(2); expect(f.observed).toHaveBeenCalledOnce();
  });
  it('processes an interleaved POP and verifies the exact late restoration before compensation', () => {
    const f = historyFixture();
    window.history.pushState({}, '', '/app#older'); const older = f.snapshot();
    window.history.pushState({}, '', '/app#newer'); const newer = f.snapshot();
    f.pop(f.outside); expect(f.go).toHaveBeenLastCalledWith(3);
    // Not the pending destination: this must reach the router, rather than be swallowed.
    f.pop(older); expect(f.observed).toHaveBeenCalledOnce(); expect(window.location.hash).toBe('#older');
    f.pop(newer); expect(f.observed).toHaveBeenCalledOnce(); expect(f.go).toHaveBeenLastCalledWith(-1);
    f.pop(older); expect(f.observed).toHaveBeenCalledOnce();
    // Once settled, a later ordinary POP to the previous restoration target is allowed.
    f.pop(newer); expect(f.observed).toHaveBeenCalledTimes(2);
    expect(f.confirm).toHaveBeenCalledOnce(); expect(f.go).toHaveBeenCalledTimes(2);
  });
  it('expires an interrupted restoration instead of suppressing a future ordinary POP', () => {
    vi.useFakeTimers(); const f = historyFixture();
    window.history.pushState({}, '', '/app#later'); const later = f.snapshot();
    f.pop(f.outside); f.pop(f.workspace);
    expect(f.observed).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(1000);
    f.pop(later); expect(f.observed).toHaveBeenCalledTimes(2); expect(f.go).toHaveBeenCalledOnce();
  });
  it('settles a missing restoration event without reloading or trapping later navigation', () => {
    vi.useFakeTimers(); const f = historyFixture(); f.pop(f.outside);
    expect(window.location.pathname).toBe('/outside');
    vi.advanceTimersByTime(1000); expect(window.location.pathname).toBe('/app');
    expect(window.history.state.__applyflowWorkspaceEntry.position).toBeNull();
    f.pop(f.workspace); expect(f.observed).toHaveBeenCalledOnce();
    f.confirm.mockReturnValue(true); f.pop(f.outside);
    expect(f.observed).toHaveBeenCalledTimes(2); expect(f.go).toHaveBeenCalledOnce();
  });
  it('guards Forward departure with the same identity checks', () => {
    const f = historyFixture(); f.confirm.mockReturnValue(true);
    window.history.pushState({ idx: 1 }, '', '/outside'); const forward = f.snapshot();
    f.pop(f.workspace); f.confirm.mockReturnValue(false); f.confirm.mockClear();
    f.pop(forward); expect(f.go).toHaveBeenCalledExactlyOnceWith(-1);
    expect(f.confirm).toHaveBeenCalledOnce(); f.pop(f.workspace);
    // The first accepted POP reached the router; neither rejection nor restoration does.
    expect(f.observed).toHaveBeenCalledOnce();
  });
  it('preserves URL and draft admission for unrecognised entries without guessing go(0) or masking the next POP', () => {
    const f = historyFixture();
    f.pop({ href: f.outside.href, state: { idx: undefined } });
    expect(window.location.pathname).toBe('/app'); expect(f.go).not.toHaveBeenCalled();
    expect(window.history.state.__applyflowWorkspaceEntry.position).toBeNull();
    expect(f.observed).not.toHaveBeenCalled();
    window.history.pushState({}, '', '/app#main'); const fragment = f.snapshot();
    f.pop(fragment); expect(f.observed).toHaveBeenCalledOnce();
    f.pop(f.outside); expect(f.confirm).toHaveBeenCalledTimes(2);
  });
  it('never promotes unknown identities through repeated cancellation or replaceState', () => {
    const f = historyFixture();
    const foreign = { href: f.outside.href, state: {} };
    f.pop(foreign); const first = window.history.state.__applyflowWorkspaceEntry;
    expect(first.position).toBeNull();
    window.history.replaceState({ idx: 100 }, '', '/app#main');
    expect(window.history.state.__applyflowWorkspaceEntry).toEqual(first);
    f.pop(foreign); const second = window.history.state.__applyflowWorkspaceEntry;
    expect(second.position).toBeNull(); expect(second.id).not.toBe(first.id);
    f.pop(foreign); expect(window.history.state.__applyflowWorkspaceEntry.position).toBeNull();
    expect(window.location.href).toContain('/app#main');
    expect(f.go).not.toHaveBeenCalled(); expect(f.confirm).toHaveBeenCalledTimes(3);
    expect(f.observed).not.toHaveBeenCalled();
  });
  it('starts a separate proven push segment after unknown recovery, without relating it to old positions', () => {
    const f = historyFixture(); const originalSegment = window.history.state.__applyflowWorkspaceEntry.position.segment;
    f.pop({ href: f.outside.href, state: {} });
    f.confirm.mockReturnValue(true); window.history.pushState({}, '', '/new-outside'); const nextOutside = f.snapshot();
    const newPosition = window.history.state.__applyflowWorkspaceEntry.position;
    expect(newPosition.offset).toBe(0);
    expect(newPosition.segment).not.toBe(originalSegment);
    window.history.pushState({}, '', '/app'); const nextWorkspace = f.snapshot();
    expect(window.history.state.__applyflowWorkspaceEntry.position).toEqual({ ...newPosition, offset: 1 });
    f.confirm.mockReturnValue(false); f.pop(nextOutside); expect(f.go).toHaveBeenCalledExactlyOnceWith(1);
    f.pop(nextWorkspace);
    f.go.mockClear(); f.pop(f.outside);
    expect(f.go).not.toHaveBeenCalled(); expect(window.history.state.__applyflowWorkspaceEntry.position).toBeNull();
  });
  it('falls back without a delta when an interleaved unknown fragment becomes the accepted target', () => {
    const f = historyFixture(); f.pop(f.outside); expect(f.go).toHaveBeenCalledExactlyOnceWith(1);
    f.pop({ href: new URL('/app#foreign', window.location.href).href, state: {} });
    expect(f.observed).toHaveBeenCalledOnce(); expect(window.history.state.__applyflowWorkspaceEntry.position).toBeNull();
    f.pop(f.workspace); // Late restoration must not guess a delta to the unknown fragment.
    expect(window.location.hash).toBe('#foreign'); expect(f.go).toHaveBeenCalledOnce();
    expect(window.history.state.__applyflowWorkspaceEntry.position).toBeNull();
    f.pop(f.workspace); expect(f.observed).toHaveBeenCalledTimes(2);
    expect(window.location.hash).toBe('');
  });
  it('requires consent for pushes and replaces, and uses beforeunload for document departures', () => {
    const f = historyFixture();
    window.history.pushState({}, '', '/outside'); window.history.replaceState({}, '', '/outside');
    expect(window.location.pathname).toBe('/app'); expect(f.confirm).toHaveBeenCalledTimes(2);
    const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    f.confirm.mockReturnValue(true); window.history.pushState({}, '', '/outside');
    expect(window.location.pathname).toBe('/outside');
  });
  it('does not obstruct clean drafts or leave installed history wrappers behind', () => {
    const originalPush = window.history.pushState, originalReplace = window.history.replaceState;
    const f = historyFixture(); f.navigation.register({ dirty: false, confirm: f.confirm });
    f.pop(f.outside); expect(f.observed).toHaveBeenCalledOnce();
    const unload = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false); expect(f.confirm).not.toHaveBeenCalled();
    releases.splice(0).reverse().forEach(release => release());
    expect(window.history.pushState).toBe(originalPush); expect(window.history.replaceState).toBe(originalReplace);
  });
});

function ProgrammaticDeparture({ confirm }: { confirm: () => boolean }) {
  const navigation = useContext(WorkspaceNavigationContext), navigate = useNavigate();
  useLayoutEffect(() => navigation?.register({ dirty: true, confirm }), [navigation, confirm]);
  return <><button onClick={() => navigate('/outside')}>Leave by push</button><button onClick={() => navigate('/outside', { replace: true })}>Leave by replace</button></>;
}
describe('declarative router navigation before commit', () => {
  it.each(['push', 'replace'])('guards useNavigate %s before Router state changes', async method => {
    window.history.replaceState({}, '', '/app'); const confirm = vi.fn(() => false);
    render(<BrowserRouter><WorkspaceNavigationProvider><Routes>
      <Route path="/app" element={<ProgrammaticDeparture confirm={confirm} />} />
      <Route path="/outside" element={<h1>Outside</h1>} />
    </Routes></WorkspaceNavigationProvider></BrowserRouter>);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Leave by ${method}` })); });
    expect(window.location.pathname).toBe('/app'); expect(screen.queryByRole('heading', { name: 'Outside' })).toBeNull();
    expect(confirm).toHaveBeenCalledOnce(); confirm.mockReturnValue(true);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: `Leave by ${method}` })); });
    expect(window.location.pathname).toBe('/outside'); expect(screen.getByRole('heading', { name: 'Outside' })).toBeTruthy();
    expect(confirm).toHaveBeenCalledTimes(2);
  });
});
