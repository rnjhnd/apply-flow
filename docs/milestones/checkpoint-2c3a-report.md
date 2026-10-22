# Stage 2C.3A — Offline Playwright harness foundation

Status: implemented and locally verified; awaiting review. Stage 2C.3B has not begun.

## Baseline and scope

Before edits, `git branch --show-current` returned `feat/authentication`,
`git rev-parse HEAD` returned `216029d4470bf1fda205e4460448d2768f8517ec`, and
`git status --short --untracked-files=all` was empty. Node was `v24.22.0`, npm
`11.19.1`. Existing authentication implementation and accepted 2A/2B/2C reports
were present. Repository instructions, product/design documents, database guards,
authentication injection points, normal server startup, production serving, and
test infrastructure were inspected. The approved 2C.3 plan is in the conversation.

## Dependency and browser installation

Explicit published-version registry metadata was retrieved for `@playwright/test`,
`playwright`, and `playwright-core` at **1.64.1**. Each requires Node `>=20`; the
test package has no React/Vite peer dependency. Node 24 satisfies this requirement.
No existing application stack package was upgraded.

- Initial `npm.cmd install --save-dev --save-exact @playwright/test@1.64.1` failed
  with EPERM against the global npm cache; no machine configuration was changed.
- `npm.cmd install --save-dev --save-exact @playwright/test@1.64.1 --cache .cache/npm`
  passed: three packages added, 522 audited, zero reported vulnerabilities.
- With `PLAYWRIGHT_BROWSERS_PATH` set only in the command process to the repository's
  `.cache/ms-playwright`, `npm.cmd exec -- playwright install chromium` passed.
  Chrome for Testing/headless shell **156.0.8078.4, revision 1248**, FFmpeg revision
  1013, and Winldd revision 1007 were downloaded there. Winldd's first CDN attempts
  failed; the installer's fallback succeeded. The latter two are Playwright's own
  companion binaries, not system package installations. No Firefox/WebKit or
  system packages were installed. No downloaded browser binary was launched.
- `npm.cmd ls @playwright/test playwright playwright-core` passed and confirmed
  all three exact versions. The single root lockfile has only the expected root
  dependency entry and three new package records (46 additions, no removals).

## Files changed

Modified:

- `apps/api/src/app.ts`
- `package.json`
- `package-lock.json`
- `vitest.config.ts`
- `README.md` (existing documentation retained; offline section appended)

Added:

- `apps/api/src/app.test.ts`
- `playwright.config.ts`
- `tsconfig.e2e.json`
- `tests/e2e/harness.e2e.ts`
- `tests/e2e/support/fixtures.ts`
- `tests/e2e/support/run.ts`
- `tests/e2e/support/environment.ts`
- `tests/e2e/support/environment.test.ts`
- `tests/e2e/support/database-preflight.ts`
- `tests/e2e/support/ownership.ts`
- `tests/e2e/support/ownership.test.ts`
- `tests/e2e/support/journal.ts`
- `tests/e2e/support/journal-file.test.ts`
- `tests/e2e/support/lifecycle.ts`
- `tests/e2e/support/lifecycle.test.ts`
- `tests/e2e/support/discovery.test.ts`
- `docs/milestones/checkpoint-2c3a-report.md`

## Express option

`createApp(env, authentication, { serveFrontend: true })` opts **test composition**
into the same existing fixed compiled frontend paths. Explicit opt-in outside
test mode throws. Production still serves the frontend by default; default
development/test stay API-only. No configurable filesystem/static root exists.
The existing asset caching, navigation fallback, API JSON 404 precedence, health
endpoint, authentication middleware, and error handling remain in place. Normal
`server.ts` startup is unchanged.

Seven isolated Supertest tests exercise defaults, fixed paths/static options,
GET/HEAD navigation, missing builds, API/asset/non-navigation 404 behavior, and
health precedence. Filesystem/static asset delivery and authentication services
are mocked. These are in-process HTTP unit tests, not a real database-backed
authentication server or proof of live compiled-asset delivery.

## Offline harness and admission

The config and listing import no database adapter or normal application startup.
There is no `webServer`, global setup, external baseURL, or saved session state.
The config selects one Chromium desktop project, one worker, zero retries,
1440×900 viewport, blocked service workers, bounded Playwright timeouts, and no
trace/video/screenshots. Browser contexts will be per-test when live fixtures
are implemented; this stage creates none.

`test:e2e:list` is safe discovery; `test:e2e:offline` runs only support unit tests.
`test:e2e` fails closed, and an automatic fixture also prevents direct scenario
execution. The one listed sentinel is explicitly marked Stage 2C.3B-required.
It is not an implemented or passing authentication E2E scenario. No live adapter,
server composition, or cleanup executor is wired, and no environment flag can
enable one in this stage.

Environment admission requires explicit `NODE_ENV=test` and the existing guarded
test URL, additionally requiring canonical `127.0.0.1:5433/applyflow_test` as
`applyflow_test`. It rejects inherited PG/connection/runtime overrides and builds
a small child environment allowlist. It does not load `.env` or use a development
fallback. The injected-only database preflight checks SQL bytes, database/user,
client endpoint, and exactly one completed matching migration, closing the mock
connection on both success and query/validation failure. A future live adapter
must report the client endpoint, not the container-internal PostgreSQL port, and
repeat admission/identity/history checks before fixture or cleanup transactions.

The owned-process wrapper accepts an injected child handle only. It validates
run-tagged loopback readiness, handles startup/error/disconnect failures, sends
one coordinated shutdown request, escalates after a grace deadline, and requires
observed exit before reporting successful termination. Unconfirmed exit fails
with a retain-fixtures/manual-review result. It never searches for or kills a PID,
process group, or port owner. Loopback binding requests port zero and derives the
origin from the actual listener address, with error/timeout handling. All process
and listener tests use controlled mocks; no actual server/listener is started by
these support tests.

## Ownership and cleanup safeguards

Strict journals contain run/test UUIDs, lifecycle state, exact fixture-email
intents, user UUID/email pairs, and candidate session-token hashes only. Unknown
fields, missing metadata, foreign email namespaces, unmatched user intent,
duplicate user ownership, incomplete snapshots, reordered history, and competing
writers fail closed. Exact ownership is required; no prefix/age/expiry-only
cleanup predicate is generated. Empty journals yield empty target arrays.

The fixed repository-local journal adapter exclusively creates the file, appends
complete snapshots (including partial-write handling), and synchronously fsyncs
before returning. Mock filesystem regressions exercise ordering/failures. There
is one writer per journal: future child composition owns it; a parent must obtain
a durable IPC acknowledgment before the associated fixture request/write, not
append concurrently.

The recording token factory calls unchanged cryptographic generation, journals
only candidate hashes before returning, and fails before insertion if recording
fails or is asynchronous. An actual anonymous-session primitive with a mocked
database confirms both candidates are journaled before `session.create`, and no
insertion occurs on journal failure. Existing authentication-service rotation
already forwards the same token injection to its transactional session primitive;
future composition must inject the recording factory into both services. No raw
token/CSRF/password/cookie/database URL is persisted in the journal.

Cleanup remains a **pure plan**. A future executor must wait for observed child
exit, resolve exact email intents, record resolved UUIDs, verify row ownership,
and delete only exact UUID/email pairs and recorded session hashes. Global
expired-session cleanup must remain disabled in that composition. Interrupted
running journals require manual review; abandoned runs are never auto-cleaned.
Filesystem durability/Windows ACL and live row ownership are not proved by mocks.

## Verification results

The final sequence ran sequentially after the last code correction:

| Command | Result |
| --- | --- |
| `npm.cmd run test:e2e:list` | Exit 0; one marked sentinel listed in one file; no scenario executed |
| `npm.cmd run test:e2e:offline` | Exit 0; **90 passed**, five files |
| `npm.cmd run lint` | Exit 0; zero errors/warnings |
| `npm.cmd run typecheck` | Exit 0; all workspaces plus root and E2E setup |
| `npm.cmd test` | Exit 0; **534 passed**, 24 files; 436 Node/HTTP/harness + 98 components |
| `npm.cmd run build` | Exit 0; contracts/API/frontend; 216 Vite modules transformed |
| `git diff --check` | Exit 0; no whitespace errors (Git LF/CRLF normalization notices only) |
| `git status --short --untracked-files=all` | Exit 0; five tracked modifications and seventeen new files, all uncommitted |

There are **97 new deterministic tests**: 90 harness tests and seven Express
serving tests. All 437 baseline tests remain passing. No test was skipped or had
its safety assertions weakened. Additional focused development checks included
`npm.cmd exec -- vitest run --project unit tests/e2e/support apps/api/src/app.test.ts`.

Development failures corrected: an unused fixture parameter failed lint; a
Windows path-separator assumption failed one new filesystem test. Fixed-path
joining/portable assertions and the unused parameter were corrected. Review also
identified synchronous disconnect re-entrancy in the new shutdown wrapper; the
wrapper now publishes one shared promise before channel invocation, covered by
a dedicated regression. Required checks were rerun after the correction.

The approved migration SQL SHA-256 remains
`98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840`.
`git diff --name-only -- apps/api/prisma apps/api/src/config/database.ts .github`
was empty. No live migration history or development data was queried; no claim
of live database verification is made. Existing scripts regenerated ignored
Prisma client/build artifacts offline, without applying SQL.

## Remaining limits and next approval

Stage 2C.3B must separately authorize and implement guarded test-database
connections/read-only preflight, narrowly owned fixture user/session writes,
exact ownership cleanup, a real compiled-asset authentication server, and browser
contexts/authentication scenarios. The server IPC adapter, durable intent
acknowledgments, transaction-level cleanup executor, and interruption integration
remain to be wired and live-verified. No broad deletion/reset is planned.

Mobile/320px layout, keyboard/native inert, real cookie/CSRF behavior, Web Locks,
cross-tab races, password-manager behavior, BFCache, and screen-reader delivery
remain browser/manual testing. HTTP test mode does not establish production
Secure-cookie/TLS readiness. Existing backend query/lock deadline and indefinitely
held client-request/lock risks remain separate operational follow-ups.

No PostgreSQL connection or row write/delete, migration/reset/schema change,
real authentication runtime, browser launch/authentication scenario, integration
suite, CI edit, application CRUD, commit, push, merge, or deployment occurred.
Dependency metadata/download traffic was limited to package/browser distribution
services. Stage 2C.3B was not begun.
