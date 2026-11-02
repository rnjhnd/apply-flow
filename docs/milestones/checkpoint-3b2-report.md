# Checkpoint 3B.2 - Offline application create/list implementation

## Baseline and execution boundary

Before editing, independently confirmed branch `feat/job-applications`, HEAD
`53ba96f14eb2bac17ae721116b0d4dd0913c42a9`, clean working tree and the approved
migration hashes. The prior test-database migration verification is historical
context; no database identity, migration history or contents were inspected in
this implementation turn. Development migration remains separately unauthorized.

Only the approved create/list feature and deterministic offline tests were
implemented. No PostgreSQL connection, database write, migration command, live
preflight, fixture/child/cleanup command, Docker/service operation, browser
operation, dependency installation or Git publication occurred. Supertest tests
compose Express with injected services and no database; they do not start the
application runtime. Existing database guards and B2/C1 inspection code are
unchanged. No Stage 3C feature was started.

## API behavior and ownership

The runtime composes an application service with the existing Prisma client and
validated APP_TIMEZONE. There are no new pools or per-request clients. createApp
accepts an optional injected application service, preserving older isolated
authentication compositions; normal runtime composition always supplies it.

- POST `/api/applications` validates the strict shared create contract and returns
  201 with `{ application }`.
- GET `/api/applications` validates the strict list contract and returns 200 with
  `{ items, nextCursor }`, default 20 and maximum 50 items.
- Admission runs before JSON parsing, reusing the existing custom request header,
  Origin, Fetch Metadata, JSON and bounded request-limiter primitives. The
  application limiter has its own stores; authentication quotas are unchanged.
- Both routes use the existing session-cookie parser. Each service transaction
  locks the presented Session row FOR UPDATE, then rechecks validity and a
  non-null authenticated owner. POST additionally checks the session-bound CSRF
  proof. The existing authenticated refresh method runs in that transaction.
- Owner IDs come exclusively from the locked session. Create data and public
  projections are explicit; every list predicate includes the session owner.
  No owner IDs, password fields or session data enter application DTOs.
- The global 16 KB JSON limit, authentication routing, cookie policy, health
  route, API JSON 404 precedence and compiled frontend serving remain intact.
  Application routes set no-store and do not issue or clear cookies.
- Application HTTP errors use the existing shared application error shape,
  allowlisted field names and fixed messages. Unexpected storage/transaction
  failures become sanitized 503 responses without replay.

Structural validation and normalization reuse the existing contracts. The server
date policy uses an injected clock and validated application timezone. Dates are
sent to Prisma as ISO UTC-midnight Date values. DTO serialization rejects
non-midnight DATE representations and uses UTC ISO calendar components rather
than local time. createdAt/updatedAt use millisecond ISO timestamps.

Pagination uses createdAt DESC then id DESC, with a strict less-than timestamp/UUID
boundary and limit + 1 lookahead. Cursors are canonical base64url JSON containing
only version 1, a validated canonical timestamp and UUID. Unknown fields,
noncanonical encodings and malformed tuples fail with 400. Cursors are opaque
transport positions, not signed authorization; the owner predicate is always
required. A cursor row need not still exist. New insertions do not promise a
snapshot across separate pages; Refresh restarts at the newest page.

## Private request gateway and workspace

The additive auth-store authenticatedRequest gateway serializes feature requests
with cookie-changing authentication work through the existing coordinator. It
requires live proof, revalidates after acquiring the lock, checks intended user,
proof and generation, and supplies private CSRF proof only to the feature
transport callback. Proof remains absent from React state, snapshots, browser
storage and broadcasts. Existing login/register/logout paths are unchanged.

The gateway keeps its Web Lock through accepted request settlement. Application
validation, transport and storage failures do not invent authentication-mutation
or registration uncertainty. A 401/403 triggers one bounded session read
reconciliation without repeating POST. Invalidation/disposal/suspension rejects
obsolete successful results. Receipts still arise from authoritative session
reads, never from an application response. Existing unresolved registration
uncertainty is not cleared by this gateway.

The applications transport uses only fixed same-origin routes, same-origin
credentials, no-store, redirect rejection and strict response schemas. It does
not retain arbitrary server messages or exceptions. A shared in-memory cooldown
prevents new application create/list requests before Retry-After expires; expiry
itself issues no requests. Obsolete GETs may be aborted. Accepted POSTs are never
aborted/replayed by component cleanup or retried automatically.

The protected workspace retains its safe identity display and logout flow and
adds:

- Company, job title, Saved-default status, application date, optional location,
  job URL and notes. Dates are required outside Saved. Native FormData is parsed
  by the shared schema, including values assigned without React change events.
- Persistent labels, linked field errors, deliberate invalid-submit summary
  focus, native keyboard controls, explicit loading/error/empty/success feedback
  and manual refresh/load-more controls.
- A page-owned draft and request controller above protected children. Existing
  guards may unmount those children while verification runs; same-account draft
  values survive. Confirmed account replacement or anonymous state clears
  account-owned drafts, rows and feedback. Route lifetime/request tickets and
  owner checks prevent stale completions from updating a newer page/account.
- Confirmed save clears the draft, announces success and refreshes the first
  page. A failed follow-up read does not turn confirmed creation into failure.
  Unknown POST outcomes retain the draft and explain possible duplicate creation
  on resubmission. A list refresh is not proof of the original transaction outcome.
- An editorial two-column desktop layout and stacked mobile layout, using the
  existing warm background, forest/copper tokens, Manrope/Inter and Button/input
  styles. Only `/app` is widened; auth pages retain their narrow layout. Long
  content wraps, native date fields have min-width constraints, external links
  use noopener/noreferrer, notes render as escaped text, and existing reduced
  motion/focus rules remain in use.

## Original implementation tests and verification (before audit corrections)

Added 89 tests: 51 backend pagination/service/HTTP cases, 11 feature-transport
cases, 8 private gateway cases and 19 component/controller/workspace cases. Seven
new test files join the existing store regression file. All prior 1,354 tests
remain in the full suite, for 1,443 total.

Coverage includes strict cursors and page bounds, owner predicates and injection
rejection, missing/anonymous/expired sessions, session recheck/refresh failure,
CSRF failures, hostile/missing Origin metadata, body limits, unsupported methods,
public projections, sanitized transaction failure, future/invalid dates and
UTC DATE round trips including years 0001 and 0099. These tests use injected
database ports; they do not demonstrate PostgreSQL rollback or lock settlement.

Frontend cases cover private proof, lock ownership, duplicate operations,
replacement/invalidation, ambiguous network/protocol outcomes without replay,
cooldowns, safe DTO parsing, autofill/FormData, linked errors/focus, keyboard
navigation, list states, pagination deduplication, late callbacks/unmount,
account replacement and draft retention through real-store background checks.
The workspace integration test uses the actual auth store/coordinator interface
with fake authentication and fetch ports. No real browser or database is used.

Commands were inspected before execution and run sequentially. Standard
typecheck/test/build run offline Prisma client generation into ignored output;
none deploys migrations or opens the application runtime.

| Command | Final observed result |
| --- | --- |
| `npm.cmd exec -- vitest run --project unit apps/api/src/modules/applications apps/web/src/lib/applications apps/web/src/lib/auth/store.test.ts` | Exit 0; 148/148 tests, 6/6 files |
| `npm.cmd exec -- vitest run --project web-components` | Exit 0; 117/117 tests, 7/7 files |
| `npm.cmd run lint` | Exit 0 |
| `npm.cmd run typecheck` | Exit 0; workspaces and root/E2E TypeScript |
| `npm.cmd test` | Exit 0; 1,443/1,443 tests, 51/51 files |
| `npm.cmd run build` | Exit 0; contracts, API and Vite production frontend; 221 modules transformed |
| `git diff --check` | Passed before and after report creation |
| New-file whitespace/content checks and migration hashes | Passed; final inventory below |

Development failures were corrected without weakening assertions:

1. The first component run had 115 passes and two existing logout-test failures.
   Their auth-only fixtures left the newly mounted list transport unmocked,
   producing an unrelated additional alert. A fake empty list response now
   isolates those tests; their logout/recovery assertions are unchanged. The
   placeholder-copy assertion now checks the implemented form heading.
2. The first typecheck rejected Vitest's inferred generic transaction mock return
   type. A test-only typed forwarding adapter preserves the generic transaction
   interface; product code and test assertions did not need relaxing.

Focused unit and component suites and lint were rerun after the final source
changes. Full-suite tests and build then passed on the corrected implementation.

## Deferred acceptance and limitations

- PostgreSQL-backed integration execution requires separate approval. Verify
  actual Prisma DATE behavior, committed create/read persistence, owner isolation,
  UUID/timestamp ordering, session locking/refresh, constraints and transaction
  failure/concurrency semantics on the isolated migrated test target.
- Development migration execution requires separate authorization before manual
  feature acceptance. Startup does not migrate automatically; a missing application
  table produces a sanitized unavailable response, not schema repair.
- After that authorization, manually verify create, reload persistence, paging,
  second-account isolation and logout, including keyboard/320px layouts. This
  turn provides jsdom evidence, not browser layout or screen-reader verification.
- Unknown creates have no idempotency key. Explicit resubmission may duplicate a
  committed record; list refresh cannot conclusively resolve a lost response.
- Indefinitely pending mutation/network work can retain a coordinator lock. The
  eight-second indicator remains informational; no unsafe early lock release or
  implicit server cancellation is introduced. Read cancellation likewise does
  not prove server-side work stopped.
- The accepted year-0001 timezone/era policy edge case remains deferred. The new
  serialization tests concern calendar conversion, not correction of that clock
  policy edge case. date-policy.ts is unchanged.
- Historical B2/C1 schema guards remain auth-only and unchanged. Fixture-cycle,
  direct-child, cleanup and general/browser E2E gates remain disabled; the existing
  separately authorized read-only entry points were not invoked.
- No edit, history, archive, restore, delete, search, filtering, dashboard,
  notifications, fixture framework, dependency or CI work was added.

## Exact changed-file inventory (including authentication integration corrections)

Ten modified tracked files and sixteen new files (including this report):

```text
 M apps/api/src/app.test.ts
 M apps/api/src/app.ts
 M apps/api/src/server.ts
 M apps/web/src/features/auth/auth-corrections.test.tsx
 M apps/web/src/features/auth/auth-route.test.tsx
 M apps/web/src/features/auth/auth-ui.test.tsx
 M apps/web/src/features/auth/route-shell.tsx
 M apps/web/src/features/auth/workspace-page.tsx
 M apps/web/src/lib/auth/store.test.ts
 M apps/web/src/lib/auth/store.ts
?? apps/api/src/modules/applications/http-error.ts
?? apps/api/src/modules/applications/pagination.test.ts
?? apps/api/src/modules/applications/pagination.ts
?? apps/api/src/modules/applications/routes.test.ts
?? apps/api/src/modules/applications/routes.ts
?? apps/api/src/modules/applications/service.test.ts
?? apps/api/src/modules/applications/service.ts
?? apps/web/src/features/applications/application-form.test.tsx
?? apps/web/src/features/applications/application-form.tsx
?? apps/web/src/features/applications/application-list.test.tsx
?? apps/web/src/features/applications/application-list.tsx
?? apps/web/src/features/applications/use-applications.test.tsx
?? apps/web/src/features/applications/use-applications.ts
?? apps/web/src/lib/applications/api.test.ts
?? apps/web/src/lib/applications/api.ts
?? docs/milestones/checkpoint-3b2-report.md
```

Migration bytes remain unchanged:

- 0001_init_auth: `98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840`
- 0002_job_applications: `74e056f699c2781c01f12d3195ed119074d5b0d4d04fef979c185e17d775a333`

No staging, commit, push, merge or deployment. Branch and HEAD remain at the
confirmed baseline. Stop after this offline checkpoint; live acceptance and
Stage 3C require separate authorization.

## Authentication integration audit corrections

### Scope and corrected defects

This pass began at the same HEAD with the eight modified tracked and sixteen
untracked implementation files, and nothing staged. Existing work was preserved.
Only these ten directly affected files changed during the correction pass:

- `apps/web/src/lib/applications/api.ts`
- `apps/web/src/lib/applications/api.test.ts`
- `apps/web/src/lib/auth/store.ts`
- `apps/web/src/lib/auth/store.test.ts`
- `apps/web/src/features/applications/use-applications.ts`
- `apps/web/src/features/applications/use-applications.test.tsx`
- `apps/web/src/features/auth/auth-corrections.test.tsx`
- `apps/web/src/features/auth/auth-route.test.tsx`
- `apps/web/src/features/auth/auth-ui.test.tsx`
- `docs/milestones/checkpoint-3b2-report.md`

The two additional tracked files are directly affected authentication component
tests. No backend, contract, environment, migration, guard, lifecycle, fixture,
cleanup, dependency or CI implementation changed in this correction pass.

1. Mixed-account GET pagination: the old transport checked a cached snapshot
   before and after GET, but a missed broadcast left that snapshot unchanged
   when another tab changed the shared cookie. GET now uses the existing private
   authenticatedRequest gateway. It acquires the shared auth lock and performs
   the existing authoritative CSRF/session verification before HTTP dispatch.
   The lock covers verification, the GET and its response settlement. The
   intended user, private proof and generation must remain valid. A queued GET
   discovering B instead of A updates authoritative auth state but rejects the
   old A operation before sending its application request. The controller clears
   A's rows/draft when the verified principal changes and rejects old tickets.
   B data can subsequently load only under B's newly verified admission. A second
   cooperating auth store cannot change the cookie while the GET owns the lock.
   Delayed/missed/reordered notifications are invalidation hints, never proof.

2. GET 401/403 recovery: old GET failures became generic list errors without
   invalidating authentication. The shared gateway now atomically records a
   sanitized auth rejection while clearing proof/receipt through invalidate,
   then attempts one existing authoritative session-read reconciliation. It
   never repeats the GET or any POST. The controller clears rows/cursors and
   latches a rejected-read state; successful recovery, new receipts and protected
   child remounts do not automatically request the list again. AuthRoute handles
   anonymous, uncertain/unavailable and replacement states with its existing
   admission/redirect/recovery rules. For a verified account, Refresh is the
   explicit action that may start a new list request.

   Presentation cancellation is distinct from settlement: an owned settlingRead
   ticket remains until its promise finishes. This lets a late rejection after
   broadcast cancellation still quarantine rows and block automatic reads. The
   ticket also avoids misclassifying an unrelated logout rejection as a list
   failure. Older settlement cannot clear a newer read's ownership. Same-account
   drafts remain private and retained while the route is gated; replacement
   clears account-owned drafts as before.

3. Gateway completion race: the previous check happened inside coordinator work.
   Invalidation/disposal/suspension during release could occur before the caller
   resumed. Successful completion now rechecks live user, private proof,
   generation, suspension/disposal/cooldown, cancellation, busy admission and the
   completed authoritative receipt immediately after coordinator settlement.
   An obsolete success rejects; a dispatched POST remains an unknown outcome to
   the feature transport rather than a proven failed server mutation. No early
   lock release, automatic retry or POST abortion was added.

An optional AbortSignal is passed only for GET. It prevents an abandoned queued
read from dispatching application HTTP work and rejects cancelled completion.
The controller no longer cancels a coordinated GET merely because that GET
published busy. Existing cookie-changing auth mutations, receipt issuance,
registration uncertainty, CSRF privacy and public snapshot shape are preserved.
The final check has no asynchronous gap before gateway success resolution.

### Regression and failure evidence

Added 23 tests beyond the original 1,443: 12 Node transport/store tests and 11
component/controller/workspace tests. Existing files were extended; no new test
framework, support fixture infrastructure or test file was added in this pass.

- Before source correction, the targeted two-file Node run had 78 passes and
  eight failures. These reproduced delayed/missed cookie replacement, a queued
  GET bypassing the lock, GET 401/403 not invalidating/reconciling, and successful
  gateway return after release-boundary invalidation, suspension or disposal.
- Three targeted component tests failed against the original source: B-cookie
  pagination was accepted under A and 401/403 left the previous rows visible.
- Coverage now includes two real auth stores over a fake shared cookie/lock,
  delayed/missed and reverse-delivered broadcasts, queued replacement, lock
  ownership through a pending GET, cancelled queued dispatch, late response
  invalidation, previously displayed A rows followed by B-cookie pagination, and
  explicit subsequent loading under B.
- Both 401 and 403 exercise reconciliation to the original account, anonymous,
  replacement and failed/unavailable states. Component cases assert no repeated
  list request after receipt recovery/remount, explicit retry after original
  recovery, explicit Check session after unavailable recovery without a list
  retry, and rejection of an older read completion during pending recovery.
- A final reordered-event regression also failed before its fix: broadcast
  cancellation cleared the reading flag before a late 401 reached reconciliation.
  Tracking settlement separately closes that window. An initial overly broad
  quarantine condition also produced an unrelated extra list alert in one logout
  regression; scoping it to settling read ownership corrected that distinction.
- The first full component run after GET coordination had nine failures from
  authentication-only request-count assertions: real feature GETs now necessarily
  perform their own session preflight. The three directly affected auth test
  files now inject an empty feature transport, preserving their original exact
  auth counts and assertions. Feature tests independently exercise the real
  transport/gateway and assert the added preflights and bounded reconciliation.
- Typecheck caught a release-boundary test wrapper returning Promise<void>
  instead of preserving its generic callback result. Returning that result fixed
  the test adapter without changing product behavior or weakening assertions.

All mocks are in-process injected ports. Passing them does not prove real Web
Locks, BroadcastChannel timing, Windows IPC, PostgreSQL locks/rollback, or browser
layout/accessibility. Cookie-changing application flows must continue to use the
existing coordinator; arbitrary external cookie editing is not a new supported
authentication mechanism. No live browser, service or database was exercised.

### Final correction verification and inventory

After the final source change, the approved sequence was rerun in order:

| Command | Actual final result |
| --- | --- |
| `npm.cmd exec -- vitest run --project unit apps/api/src/modules/applications apps/web/src/lib/applications apps/web/src/lib/auth/store.test.ts` | Exit 0; 160/160, 6/6 files |
| `npm.cmd exec -- vitest run --project web-components` | Exit 0; 128/128, 7/7 files |
| `npm.cmd run lint` | Exit 0 |
| `npm.cmd run typecheck` | Exit 0, workspaces/root/E2E; offline Prisma generation only |
| `npm.cmd test` | Exit 0; 1,466/1,466 tests, 51/51 files |
| `npm.cmd run build` | Exit 0; contracts/API/frontend, 221 Vite modules |
| `git diff --check` | Passed, including after report update |
| New/modified file whitespace, report inventory and migration checks | Passed |
| `git status --short --untracked-files=all` | Ten tracked modifications and sixteen untracked files; exact inventory above |

The original 1,443-test result and intermediate 1,465-test result are historical;
the final 1,466-test run includes the additional reordered-event regression.
All previous tests remain passing. Branch/HEAD and both exact migration hashes
are unchanged, and the staging area remains empty. Nothing was committed or
published. Only this existing report was updated; no separate correction report
was created.

GETs now retain the coordinator lock until their transport settles, as POSTs do.
Indefinitely pending transport/session-bootstrap work remains an operational
limitation; read cancellation is allowed but does not prove database cancellation,
and accepted mutations are never aborted or replayed by this correction. Existing
live PostgreSQL/Prisma, manual/browser, production and year-0001 policy limitations
listed above remain deferred. Development migration remains unauthorized. No
database connection, SQL execution, fixture/cleanup operation, service/browser
operation, integration suite, Git staging or publication occurred in this pass.

Offline correction verdict: READY FOR STAGE 3B.2 GIT CHECKPOINT. Stop here; this
does not authorize live acceptance, migration execution or Stage 3C.
