// The declarative BrowserRouter has no supported blocker API. Its data-router
// blocker also requires reliable router idx deltas. Track our own same-document
// entry positions instead; never infer a rollback from a POP or router idx.
const marker = '__applyflowWorkspaceEntry';
type Position = { segment: string; offset: number };
type Stamp = { document: string; id: string; position: Position | null };
type Entry = Stamp & { href: string; state: Record<string, unknown> };
export type DepartureGuard = { dirty: boolean; confirm: () => boolean };
export const isWorkspace = (pathname: string) => pathname.replace(/\/+$/, '').toLowerCase() === '/app';

export function createWorkspaceNavigation(view: Window) {
  let guard: DepartureGuard | null = null;
  let accepted: Entry | null = null, restoring: Entry | null = null;
  const superseded = new Map<string, Entry>();
  let restorationDeadline: ReturnType<typeof setTimeout> | undefined;
  const documentId = view.crypto.randomUUID();
  const originalPush = view.history.pushState, originalReplace = view.history.replaceState;
  const push = originalPush.bind(view.history), replace = originalReplace.bind(view.history);
  const go = view.history.go.bind(view.history);
  let installed = false, approvedWrite = false;
  const object = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null ? { ...value } : {};
  function read(): Entry | null {
    const state = object(view.history.state), stamp = state[marker] as Partial<Stamp> | undefined;
    if (stamp?.document !== documentId || typeof stamp.id !== 'string') return null;
    const position = stamp.position;
    if (position !== null && (!position || typeof position.segment !== 'string' || !Number.isSafeInteger(position.offset))) return null;
    return { document: documentId, id: stamp.id, position, href: view.location.href, state };
  }
  function stamp(state: unknown, position: Position | null) {
    return { ...object(state), [marker]: { document: documentId, id: view.crypto.randomUUID(), position } satisfies Stamp };
  }
  const origin = (): Position => ({ segment: view.crypto.randomUUID(), offset: 0 });
  function same(first: Entry, second: Entry) {
    return first.id === second.id && first.href === second.href;
  }
  function allow(href: string) {
    return isWorkspace(new URL(href, view.location.href).pathname) || !guard?.dirty || guard.confirm();
  }
  function settled() {
    clearTimeout(restorationDeadline); restorationDeadline = undefined;
    restoring = null; superseded.clear();
  }
  function preserveLocation(target: Entry) {
    // This physical entry is not the target's original history slot. Preserve
    // its public URL/router state, but never copy the target's trusted position.
    replace(stamp(target.state, null), '', target.href);
    const current = read();
    if (!current || current.href !== target.href) throw new Error('Workspace location restoration failed.');
    accepted = current;
  }
  function restore(destination: Entry | null, target: Entry) {
    // Unrecognised foreign metadata has no provable traversal delta. Preserve
    // the draft and URL synchronously; never guess a go() direction or reload.
    const from = destination?.position, to = target.position;
    const delta = from && to && from.segment === to.segment ? to.offset - from.offset : null;
    if (delta === null || delta === 0 || !Number.isSafeInteger(delta)) {
      preserveLocation(target); settled(); return;
    }
    restoring = target;
    // A missing/delayed history event must never leave a wildcard suppression
    // armed indefinitely. After this bound, later POPs are ordinary navigation.
    restorationDeadline ??= setTimeout(() => {
      if (restoring && accepted) preserveLocation(accepted);
      settled();
    }, 1000);
    go(delta);
  }
  const pop = (event: PopStateEvent) => {
    if (!accepted) return;
    let destination = read();
    if (restoring && destination && same(destination, restoring) && same(restoring, accepted)) {
      settled();
      event.stopImmediatePropagation(); return;
    }
    if (restoring) { superseded.set(restoring.id, restoring); restoring = null; }
    const stale = destination ? superseded.get(destination.id) : undefined;
    if (stale && destination && same(stale, destination)) {
      superseded.delete(stale.id); event.stopImmediatePropagation();
      if (!same(destination, accepted)) restore(destination, accepted);
      return;
    }
    if (!allow(view.location.href)) { event.stopImmediatePropagation(); restore(destination, accepted); return; }
    if (!destination) {
      // A POP proves identity/arrival, never direction, adjacency or distance.
      replace(stamp(view.history.state, null), '', view.location.href);
      destination = read();
    }
    accepted = destination;
  };
  const unload = (event: BeforeUnloadEvent) => {
    if (guard?.dirty) { event.preventDefault(); event.returnValue = ''; }
  };
  function install() {
    if (installed) throw new Error('Workspace navigation already installed.');
    installed = true;
    replace(stamp(view.history.state, origin()), '', view.location.href); accepted = read();
    const guardedPush: History['pushState'] = (state, unused, url) => {
      const href = new URL(url == null ? view.location.href : String(url), view.location.href).href;
      if (!approvedWrite && !allow(href)) return;
      // Only an observed push proves one new adjacent entry. An unknown parent
      // starts a separate segment; it gains no inferred relationship to this one.
      const previous = read()?.position;
      const position = previous && Number.isSafeInteger(previous.offset + 1)
        ? { ...previous, offset: previous.offset + 1 } : origin();
      push(stamp(state, position), unused, url); accepted = read();
    };
    const guardedReplace: History['replaceState'] = (state, unused, url) => {
      const href = new URL(url == null ? view.location.href : String(url), view.location.href).href;
      if (!approvedWrite && !allow(href)) return;
      const current = read();
      replace(current ? { ...object(state), [marker]: { document: documentId, id: current.id, position: current.position } }
        : stamp(state, null), unused, url);
      accepted = read();
    };
    view.history.pushState = guardedPush; view.history.replaceState = guardedReplace;
    view.addEventListener('popstate', pop, true); view.addEventListener('beforeunload', unload);
    return () => {
      view.removeEventListener('popstate', pop, true); view.removeEventListener('beforeunload', unload);
      if (view.history.pushState === guardedPush) view.history.pushState = originalPush;
      if (view.history.replaceState === guardedReplace) view.history.replaceState = originalReplace;
      installed = false; guard = null; settled();
    };
  }
  return { install,
    register(value: DepartureGuard) { guard = value; return () => { if (guard === value) guard = null; }; },
    navigate(href: string, commit: () => void) {
      if (!allow(href)) return;
      approvedWrite = true; try { commit(); } finally { approvedWrite = false; }
    }
  };
}
