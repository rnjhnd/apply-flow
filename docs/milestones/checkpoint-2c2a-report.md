# Stage 2C.2A — Routing and Authentication Integration

## Scope and baseline

Stage 2C.2A is implemented with route placeholders only. Authentication forms, workspace/logout UI, browser E2E infrastructure, and later stages remain unimplemented.

Before changes, the branch was `feat/authentication`, HEAD was exactly `d1d826e77ab00fcda1b971ec3cac6161e458c751`, and `git status --short` was empty. Node was **24.22.0** and npm **11.19.1**. The accepted Stage 2C.1 transport, store, coordination, regression tests, implementation report, and corrections report were present in that commit. Earlier statements that those changes were uncommitted are historical reporting snapshots, not the current baseline; README now clarifies this without rewriting the earlier reports.

AGENTS.md, PRD.md, DESIGN_SYSTEM.md, the accepted reports, React/Vite configuration, authentication foundation, and existing unit/HTTP/integration test configurations were inspected. The approved Stage 2C.2A directions in the conversation define this stage's implementation boundary.

## Dependencies and test configuration

Published npm package metadata (versions, engines, and peers) was checked before installation. Exact versions were installed through npm workspaces with the existing single root lockfile.

| Package | Placement | Compatibility checked |
| --- | --- | --- |
| `react-router@8.5.0` | Web runtime dependency | Node >=22.22.0; React/React DOM >=19.2.7 and React types >=19.2.0 |
| `@testing-library/react@16.3.3` | Root development dependency | Node >=18; React 18/19; DOM library ^10 |
| `@testing-library/dom@10.4.2` | Root development dependency | Node >=18 |
| `@testing-library/user-event@14.6.8` | Root development dependency | Node >=12; DOM library >=7.21.4 |
| `jsdom@30.1.3` | Root development dependency | Node ^22.22.2, ^24.15.0, or >=26 |

The installed React/React DOM **19.3.1**, React types **19.3.0**, Node **24.22.0**, Vite **8.3.4**, Vitest **5.0.5**, and Vite React plugin **6.1.2** satisfy the relevant requirements. `npm.cmd ls react react-dom react-router @testing-library/dom jsdom vite vitest` passed without peer errors. The two installs reported zero audit vulnerabilities; this is installation-time package audit evidence, not a security guarantee. Optional canvas was not installed.

Executed installation commands:

```powershell
npm.cmd install --workspace @applyflow/web --save-exact react-router@8.5.0 --cache .cache/npm --fetch-retries 0 --fetch-timeout 15000
npm.cmd install --save-dev --save-exact @testing-library/react@16.3.3 @testing-library/dom@10.4.2 @testing-library/user-event@14.6.8 jsdom@30.1.3 --cache .cache/npm --fetch-retries 0 --fetch-timeout 15000
```

Vitest now has two explicitly separated projects. Existing `.test.ts` unit/HTTP tests continue in Node with the same include paths; web `.test.tsx` component tests run in jsdom with the real web Vite aliases/plugins. Component cleanup restores mocks, globals, and timers. The separate PostgreSQL integration configuration is unchanged. The web no-emit TypeScript project includes the new Vitest configuration and permits its explicit `.ts` configuration import.

## Implementation and route behavior

- `main.tsx` mounts declarative `BrowserRouter` inside the existing StrictMode boundary.
- `/` preserves the welcome content, health check, fonts, and responsive styling. It adds a working Sign in link and does not create the auth singleton or bootstrap authentication on a fresh public visit.
- `/login` verifies the session, admits anonymous users to a placeholder, and redirects verified authenticated users to `/app` with history replacement.
- `/register` admits only verified anonymous users with `registrationEnabled === true`. False shows an accessible explanation and Sign in link; unknown stays gated. Authenticated users redirect to `/app`. Backend registration authorization is unchanged and independent of display capability.
- `/app` verifies the actual session before rendering a protected placeholder. Verified anonymous users redirect to `/login`; unavailable/uncertain state does not imply logout. No safe-user display, workspace features, or logout UI was added.
- Unknown paths have an accessible not-found heading and home link without authentication bootstrap. The route shell provides a skip link, main landmark, route title, and navigation focus target using existing design tokens/components.

`AuthProvider` holds one small integration object around the existing lazy singleton. `useAuth` subscribes through `useSyncExternalStore`; it does not copy authentication state into React state. Ordinary cleanup removes React/event subscriptions and ignores obsolete callbacks, without disposing the singleton or aborting its requests.

The integration single-flights verification across StrictMode effects. If a mutation is pending, it observes completion and starts a fresh store revalidation when idle instead of treating the mutation promise's result as ready proof. Each route-history entry gates its content until verification succeeds. Old route completions cannot navigate a replacement route. The accepted store remains responsible for generation checks, session proof, cross-tab invalidation, cookie ordering, and ambiguous outcomes.

Visible-document focus/visibility events optionally revalidate with a 30-second coalescing interval, skipping busy/cooldown states. Explicit recovery bypasses that optional interval while honoring server deadlines and pending operations. A countdown updates feedback only; reaching its deadline does not send a request. The eight-second indicator remains informational and does not abort work or release a lock.

Guest children retain their DOM identity through background checks and recoverable failures. Controls are disabled while checking and hidden/inert when proof is unavailable; this retention flag never authorizes content. Explicit route navigation may intentionally remount content. A test-only draft input proves retention; there are no production login/register forms. Protected content is hidden during entry verification, background verification, and invalidation until verification permits it again.

Uncertain outcomes remain visible, including when a current authenticated session is known but an earlier registration result remains unresolved. Read recovery does not clear that uncertainty or replay a mutation. Unsupported coordination displays the fail-closed limitation and asks for a supported secure browser/reload rather than sending an unsafe fallback request. The UI introduces no browser storage, secrets in URLs/logs, or new broadcast payloads.

## Focused test coverage

**28 deterministic component tests** use jsdom, StrictMode, MemoryRouter, the actual accepted store, and controlled API/coordination fixtures. They cover:

- Lazy production-singleton integration; public welcome and health behavior without auth requests.
- StrictMode single flight and cleanup without disposal.
- Fresh validation of cached authenticated state, expired-session rejection, protected gating, and authenticated/anonymous redirects.
- Registration capability true, false, and unknown; direct disabled-route explanation and navigation.
- HTTP 503/network uncertainty recovery, unsupported coordination, and unresolved earlier mutation notices.
- Pending login/logout navigation, fresh proof after logout, obsolete route callbacks, and history replacement.
- Exact accepted invalidation-during-login/400 and login-429/invalidation/cooldown reproduction sequences without mutation replay.
- Eight-second waiting, cooldown boundary feedback, and keyboard-activated explicit recovery.
- Visible/hidden document revalidation, foreground coalescing, cross-tab invalidation, retained guest DOM/input through outages, and immediate recovery within the coalescing interval.
- Accessible not-found navigation, document title/main focus, and no sensitive user/token values in the protected placeholder.

These are mocked transport/coordination tests, not real-browser or live-database evidence. Existing accepted security tests remain unchanged.

## Executed verification

| Command | Actual result |
| --- | --- |
| `npm.cmd exec -- vitest run --project web-components` | PASS: 28 tests, 1 file |
| `npm.cmd run lint` | PASS: exit 0, zero lint warnings/errors |
| `npm.cmd run typecheck` | PASS: exit 0, all workspaces and root |
| `npm.cmd test` | PASS: **352 tests in 15 files**, zero failures/skips: 324 existing Node unit/HTTP tests plus 28 component tests |
| `npm.cmd run build` | PASS: exit 0, contracts/API/frontend production builds; 209 frontend modules transformed |
| `git diff --check` | PASS: exit 0, no whitespace errors |
| `git status --short --untracked-files=all` | PASS: command exits 0; 8 modified tracked files and 10 new files remain uncommitted |

Resolved verification issues: the initial component run had one failing health assertion because its test mock reused an already-consumed Response across StrictMode effects; the mock now creates a fresh Response per call. Initial lint found three unused test imports, which were removed. One overlapping typecheck/test invocation collided while both generated the Prisma client (`EEXIST`); sequential typecheck and build passed without changing Prisma or database tooling. Checks that share generated outputs should run sequentially. No assertions were weakened.

The existing scripts regenerate the Prisma client as a local build artifact; generation applies no migration and performs no database writes. PostgreSQL integration tests were not rerun for this frontend-only stage. No database connection, fixture creation, migration execution, database reset, or data cleanup was performed. Development data was not queried, so this report does not claim fresh database row-count or migration-history evidence. Tracked backend, schema/migrations, database guards/tooling, shared contracts, accepted auth-library code/tests, integration configuration, and GitHub Actions have no diff from the accepted baseline.

## Files changed

Modified tracked files:

- `README.md` — current routing behavior, baseline clarification, report link.
- `apps/web/package.json` — exact Router dependency.
- `apps/web/src/App.tsx` — route declarations and minimal placeholders.
- `apps/web/src/main.tsx` — BrowserRouter integration.
- `apps/web/tsconfig.json` — typed web test configuration.
- `package.json` and `package-lock.json` — exact component-test dependencies and one root lockfile.
- `vitest.config.ts` — separated Node and jsdom projects.

New files:

- `apps/web/src/features/auth/auth-provider.tsx`
- `apps/web/src/features/auth/use-auth.ts`
- `apps/web/src/features/auth/auth-route.tsx`
- `apps/web/src/features/auth/route-shell.tsx`
- `apps/web/src/features/auth/auth-route.test.tsx`
- `apps/web/src/pages/welcome-page.tsx` — existing welcome implementation moved here, with the Sign in link/title.
- `apps/web/src/test/auth-fixtures.ts`
- `apps/web/src/test/setup.ts`
- `apps/web/vitest.config.ts`
- `docs/milestones/checkpoint-2c2a-report.md` — this report.

## Limitations and review boundary

- Forms, validation/credential feedback, password-manager integration, safe user display, and logout UI await 2C.2B authorization. The current placeholders make navigation verifiable but are not completed authentication screens.
- Actual browser history/refresh, cookie acceptance, Web Locks/BroadcastChannel coordination, tab lifecycle/BFCache, assistive technology, responsive visual quality, and keyboard behavior require real-browser/manual verification and subsequent 2C.3 tests. No real-browser verification is claimed here.
- Production deep links require the existing same-origin SPA fallback and API JSON-404 routing. Backend serving configuration is unchanged; no deployment or hosted CI execution was attempted.
- Coordination remains fail-closed on unsupported browsers. Cookie-changing requests can hold their lock indefinitely when the underlying request stalls; the known database query/lock timeout issue remains a separate backend operational follow-up. Browser crash/reload cannot prove an already-committed mutation rolled back.
- Route-entry verification and redirect destinations can each perform a fresh bounded read; no auth mutation is automatically retried. Returning to `/` after an auth visit does not destroy an already-started document-level operation.

No full forms, protected workspace/logout UI, Playwright, CI changes, backend changes, schema/migrations, database-guard changes, CRUD, commits, pushes, merges, or deployment were performed. All changes remain uncommitted for review. Stop after Stage 2C.2A.
