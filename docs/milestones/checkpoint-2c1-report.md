# Stage 2C.1 — Contracts and Client Foundation

Date: **2026-10-20 (Asia/Manila)**. Branch: **feat/authentication**. Runtime: **Node v24.22.0 / npm 11.19.1 / Windows**.

Stage 2C.1 is implemented and locally verified. **314 unit/HTTP tests and 110 PostgreSQL integration tests pass: 424 total, no failures or skips.** This adds 74 unit/HTTP and two database cases to the committed Checkpoint 2B baseline. No dependency installation, UI pages/routes, Playwright, GitHub Actions changes, schema changes, migration execution, commit, push, merge, or deployment occurred.

## Implemented behavior

### Server-derived registration display capability

The strict shared CSRF response now requires `{ csrfToken, registrationEnabled: boolean }`. Both new and reused anonymous/authenticated sessions use the server-derived flag. One `isRegistrationEnabled` helper is called by the display response and the independent POST registration gate: only explicit development/test enablement succeeds, and production always denies, including misconstructed production configuration. The existing production parser still rejects attempted enablement.

Tests cover both allocation and reuse across development/test/production with both flag values; real PostgreSQL cases cover enabled/disabled allocation and reuse without timestamp changes. Existing gate tests now also submit a forged client-side `registrationEnabled: true`; registration remains unavailable. The flag grants no authorization. Strict contracts still reject secret-bearing fields and malformed tokens. Existing response assertions were updated to require the exact new shape.

### Typed transport

`createAuthApi` exposes the existing csrf/me/register/login/logout endpoints through fixed relative paths. It uses `credentials: same-origin`, `cache: no-store`, redirect rejection, required custom headers, JSON mutations, and session-bound CSRF proof. Browser Origin and Fetch Metadata are left untouched. Shared Zod contracts validate requests and responses; passwords retain their exact bytes and email normalization matches the server.

Logout accepts exactly 204 without JSON parsing. Register accepts 201, other JSON successes 200. HTTP errors retain only recognized codes, status, affected field names, and safe retry deadlines; arbitrary messages, response objects, credentials, and underlying exceptions are discarded. HTML, malformed JSON, secret-bearing DTOs, unexpected success statuses, and network failures produce sanitized failures. No transport operation automatically retries.

Retry-After handles numeric seconds (including zero), HTTP dates, invalid/past/overflow values, and a conservative 60-second fallback. A malformed/HTML 429 still retains its cooldown. Only cookie-free `/me` reads have an eight-second abort signal. CSRF bootstrap and mutations are not aborted by a client timer.

### In-memory state and ordering

The lazy module singleton exposes initializing, anonymous, authenticated, unavailable, and uncertain states through `getSnapshot`/`subscribe`, plus bootstrap/revalidation/authentication operations. CSRF tokens remain private in the coordinator; public snapshots expose safe user/display state, busy/waiting flags, error metadata, cooldown, and uncertainty. No local/session storage, cookie access from JavaScript, or credential logging was introduced.

Bootstrap single-flights across StrictMode-style unsubscribe/remount and reentrant observers. It reads CSRF then `/me`; only the intended unauthenticated response establishes anonymous state. Errors do not falsely establish logout. Components will subscribe in 2C.2; the current welcome page is unchanged and does not initiate these flows yet.

One named exclusive Web Lock covers bootstrap, mutation preflight, the underlying mutation, and bounded recovery. Mutation preflight rereads session/proof after acquiring the lock; a queued intent for a replaced session is canceled even when the replacement has the same user. Duplicate per-tab mutation submissions are rejected rather than queued. Invalidated reads and successful mutation responses cannot restore stale authenticated state.

BroadcastChannel sends only the literal `invalidate`, with no tokens, cookies, passwords, user details, or authentication responses. Arbitrary messages are ignored; accepted invalidation messages trigger server verification rather than authenticate anyone. Notifications coalesce into pending work, and cooldowns prevent broadcast-driven request storms.

After eight seconds, snapshots expose `waiting: true` while retaining `busy` and the lock until the request settles. Unsupported/insecure APIs and lock-acquisition failures fail closed. Page exit invalidates proof without allocating another session; BFCache restoration revalidates. Disposal never aborts an in-flight mutation or prematurely releases its lock. Unsubscribing a React observer must not dispose the module singleton.

400/credential failures retain safe feedback; 401 session loss, 403, and 409 trigger bounded reconciliation where appropriate. 429 blocks further admission until its deadline without automatic retry. Network/protocol/503 mutation failures are treated conservatively and reconciled at most once; register/login/logout are never replayed. Failed logout does not imply revocation if `/me` still proves authentication. Reading an anonymous session does not prove an ambiguous registration failed to create an account, so uncertainty remains until a later successful explicit authentication operation.

## Actual verification

| Command/check | Actual result |
| --- | --- |
| `node --version`, `npm.cmd --version` | v24.22.0 / 11.19.1 |
| `npm.cmd run db:verify` | Exit 0; both approved targets and connected identities validated |
| `npm.cmd run lint` | Exit 0; no warnings or errors |
| `npm.cmd run typecheck` | Exit 0; strict checks across workspaces/tooling |
| `npm.cmd test` | Exit 0; **314 passed / 14 files**, no failures/skips |
| `npm.cmd run test:integration` | Exit 0; **110 passed / 4 files**, no failures/skips |
| `npm.cmd run build` | Exit 0; contracts, offline Prisma generation, API compilation, Vite production bundle |
| `node --import tsx .cache/2c1-audit.ts before` / `after` | Exit 0; identical ordered data/schema/history fingerprints on both targets |
| Protected-path Git diff | No changes to schema/migrations, database guards/client/tooling, package manifests/lockfile, or CI |
| `git diff --check` | Exit 0; no whitespace errors (normal Windows LF/CRLF conversion notices only) |

The initial focused run found an over-permissive Date.parse Retry-After fallback and a policy test that omitted its fixture clock: four failures, corrected without weakening assertions. A subsequent lint check caught a test mock aliasing `this`; the mock was corrected without disabling the rule. Final review also corrected loss of registration uncertainty across a later read outage/rejected mutation, with a targeted regression proving that only a successful explicit authentication operation clears it. Final verification above has no outstanding failures. Tests use deterministic mocked clocks/locks/channels for client behavior; they are not claims of real browser automation.

## Database safety evidence

Read-only auditing captured ordered User/Session content, public columns, indexes, constraints, and every migration-history field before and after integration verification. No raw row contents or credentials were printed.

| Target | Actual host/port | Connected database / username | User / Session before → after |
| --- | --- | --- | --- |
| Development | 127.0.0.1:15432 | applyflow_dev / applyflow_dev | 0 / 0 → 0 / 0 |
| Test | 127.0.0.1:5433 | applyflow_test / applyflow_test | 0 / 0 → 0 / 0 |

Identical combined content/schema/history SHA-256 fingerprints:

```text
Development: 141c4057b605100e98072f43d93ae05f6d1923f20ba0705b6cd6a7fb0546b2f8
Test:        0727611e06f5d6c14c5c02a5c898cea37d018f94cedc21b6255d77b315c86b54
SQL:         98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840
```

The existing integration suites require the dedicated test URL/identity, NODE_ENV=test, approved SQL checksum, and completed migration history before writes. New database fixtures use their existing tracked UUID cleanup hooks. Development received only read-only inspection. No target guard changes, resets, broad cleanup, SQL migrations, schema modifications, Docker/volume operations, or machine configuration changes occurred. Ignored `.cache` audit artifacts and normal ignored build/generated outputs are local verification aids, not source changes.

## Files changed

| Files | Purpose |
| --- | --- |
| `packages/contracts/src/auth.ts`, `auth.test.ts` | Required strict display capability and contract regressions |
| `apps/api/src/config/auth.ts`, `auth.test.ts` | Shared independent registration policy and defense-in-depth tests |
| `apps/api/src/modules/auth/csrf.ts`, `csrf.test.ts` | Flag on new/reused sessions and policy matrix |
| `apps/api/src/modules/auth/routes.ts`, `routes.test.ts` | Reuse policy helper, update exact response expectation, reject forged capability |
| `apps/api/tests/csrf.integration.test.ts` | Strict response assertion plus two guarded capability cases |
| `apps/web/src/lib/auth/api.ts`, `api.test.ts` | Transport and 22 deterministic cases |
| `apps/web/src/lib/auth/coordination.ts`, `coordination.test.ts` | Browser adapter and seven cases |
| `apps/web/src/lib/auth/store.ts`, `store.test.ts` | Singleton/coordinator and 35 cases |
| `vitest.config.ts` | Discover frontend foundation unit tests |
| `README.md`, this report | Current contract, usage, limits, and verification evidence |

There are **11 modified and seven new source/documentation files**, all uncommitted. No React Router installation was necessary without routes; Playwright was not installed. The single root lockfile is unchanged.

## Remaining risks and manual verification

- **Cooperative browser coordination has limits:** tab termination, reload, network interruption, or browser lock release cannot cancel an operation that may already have committed. A new document must bootstrap from the server; neither a lost response nor a new anonymous session proves rollback. Broadcast delivery is best effort. Same-origin XSS remains outside these defenses.
- **Pending requests can retain locks indefinitely:** the approved eight-second notice does not release them. Existing unbounded database statement/lock execution remains a tracked backend follow-up; no timeout policy or backend architecture was changed.
- **No real browser evidence yet:** actual Web Locks/BroadcastChannel ordering, browser headers, cookie acceptance/clearing over HTTPS, BFCache/reload behavior, multi-tab workflows, accessibility, and mobile behavior remain for stages 2C.2/2C.3. The waiting flag has no visible consumer until those UI stages.
- **Registration and operations remain restricted:** production registration stays disabled pending verification/recovery/abuse protections; in-memory admission remains process-local. Production configuration support is not production readiness.
- **No later stages:** no screens, protected routes, browser harness, GitHub Actions changes/hosted run, production connection, CRUD, Redis, or AI. Existing reports are preserved. Stop after 2C.1 for review before beginning 2C.2.
