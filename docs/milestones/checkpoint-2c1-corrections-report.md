# Stage 2C.1 — Targeted audit corrections

Date: **2026-10-21 (Asia/Manila)**. Runtime: **Node v24.22.0 / npm 11.19.1 / Windows**. Branch: **feat/authentication**.

The three authorized client-foundation corrections are complete. Final verification passes **324 unit/HTTP tests in 14 files**, including **10 new regression cases**. No Stage 2C.2 work was started. This report supplements the original October 20 implementation report; its earlier integration-test results are historical, not a fresh database verification for this correction pass.

## Corrections and root causes

### 1. Stranded initialization after invalidation

**Root cause:** invalidation always set `initializing`, even when cooldown rejected the subsequent bootstrap or an existing pending operation absorbed it. An eventual 400 only updated the error, so the operation could settle with `initializing`, `busy: false`, and no scheduled work.

**Changed path:** `apps/web/src/lib/auth/store.ts:34`, `invalidate()`.

Invalidation still increments the generation and clears private CSRF proof immediately. It now exposes `unavailable`, or preserves `uncertain` when an outcome is unresolved. During cooldown it retains the server deadline and exposes a sanitized cooldown reason. It does not imply that verification is running, that the user is logged out, or that a failed authentication request was replayed.

The cleared proof is the retained revalidation requirement: even ordinary `bootstrap()` cannot return cached authentication state afterward. Explicit `bootstrap()`/`revalidate()` remains available once admission permits it. There is no cooldown-expiry request timer, new retry loop, or new state-management abstraction. A pending invalidated mutation that later fails leaves a recoverable state; the caller must explicitly recover before submitting new credentials.

### 2. Page suspension versus broadcast invalidation

**Root cause:** a boolean notification represented both lifecycle and broadcast events. The store assigned that boolean to `suspended`, so a broadcast could undo pagehide suspension.

**Changed paths:** `apps/web/src/lib/auth/coordination.ts:4` and `apps/web/src/lib/auth/store.ts:168`.

The internal coordination callback now distinguishes `invalidate`, `suspend`, and `resume`. Only pagehide emits suspend; a persisted pageshow emits resume. A broadcast can invalidate proof but cannot change document suspension. Suspended documents do not start another CSRF bootstrap, including after repeated broadcasts or a nonpersisted pageshow notification. BFCache restoration requests fresh verification through the existing coordinator.

The wire message is still only the literal `invalidate`; the internal lifecycle labels are not additional broadcast payloads. Unsupported coordination remains fail-closed. No request cancellation or lock-release policy changed.

### 3. Obsolete uncertainty after confirmed authentication

**Root cause:** a confirmed mutation cleared uncertainty only when its response generation was unchanged. When invalidation forced successful reconciliation, ordinary session synchronization intentionally preserved uncertainty, and no confirmed-success step cleared it afterward.

**Changed path:** `apps/web/src/lib/auth/store.ts:138`, confirmed mutation reconciliation.

After a definitively successful login/register/logout requires reconciliation, the coordinator clears obsolete uncertainty only after synchronization succeeds. A final generation comparison also checks invalidation between synchronization and the caller resuming. If reconciliation fails or is superseded, no uncertainty is cleared and no old response is committed as current authentication.

Ambiguous mutation error recovery remains separate: successful reads may establish current session state but cannot prove whether an earlier registration created an account. They retain `outcomeUncertain`. No ambiguous mutation is retried.

## Regression coverage

Added nine store cases and one adapter/store lifecycle case:

| Test starting location | What it proves |
| --- | --- |
| `store.test.ts:52` | Exact 429 → broadcast → cooldown-expiry sequence; stable unavailable state, no automatic requests, explicit recovery at the deadline, no POST replay |
| `store.test.ts:71` | Exact pending login → broadcast → 400 sequence; no idle initialization; recovery failure is unavailable rather than proof of logout; later explicit recovery works |
| `store.test.ts:85` | Repeated invalidations cannot create an unbounded reconciliation loop or commit the stale user |
| `store.test.ts:95` | Three cases: confirmed login, register, and logout clear prior registration uncertainty only after valid reconciliation; uncertainty remains while the read is pending |
| `store.test.ts:120` | Ambiguous registration plus invalidation retains uncertainty despite authenticated read recovery and subsequent revalidation |
| `store.test.ts:131` | Confirmed login with failed reconciliation preserves uncertain state, hides the invalidated user, and never replays the mutation |
| `store.test.ts:146` | Late invalidation before the confirmed-success caller resumes prevents obsolete-generation uncertainty clearing |
| `coordination.test.ts:24` | Exact pagehide → repeated broadcasts sequence using the actual adapter and store with mocked browser APIs; no bootstrap until persisted pageshow |

Existing lifecycle assertions now require explicit event labels, and existing invalidation assertions require the corrected unavailable state. Their security assertions were retained. Existing unsupported-coordination, slow request/eight-second waiting, single-flight, cookie ordering, stale intent, transport privacy, and backend policy tests continue passing.

The initial store regression run reproduced two stranded states and three obsolete-uncertainty cases. It reported six failures because one new test also had an incorrect total-call expectation; that assertion was corrected from six calls to the exact five-call sequence (initial bootstrap, registration preflight/recovery, login preflight/recovery). The separate lifecycle regression failed before correction because bootstrap incorrectly resolved after pagehide plus broadcast. No tests were disabled and no assertions were weakened to hide defects.

## Verification performed

| Command | Actual result |
| --- | --- |
| `node --version`, `npm.cmd --version` | v24.22.0 / 11.19.1 |
| `npm.cmd exec -- vitest run apps/web/src/lib/auth/store.test.ts` before corrections | Exit 1; 6 failed, 37 passed; includes the corrected new call-count expectation described above |
| `npm.cmd exec -- vitest run apps/web/src/lib/auth/coordination.test.ts` before corrections | Exit 1; 1 failed, 7 passed; lifecycle defect reproduced |
| `npm.cmd exec -- vitest run apps/web/src/lib/auth` after initial corrections | Exit 0; 73 passed; the late-generation regression was subsequently added and included in the final full suite |
| `npm.cmd run lint` | Exit 0; no errors/warnings |
| `npm.cmd run typecheck` | Exit 0; strict workspace/tooling checks |
| `npm.cmd test` | Exit 0; **324 passed, 14 files, no failures or skips** |
| `npm.cmd run build` | Exit 0; contracts, offline Prisma client generation, API compile, Vite bundle |
| `git diff --check` | Exit 0; no whitespace errors; normal Git LF/CRLF conversion notices |

**PostgreSQL integration tests were not run.** The changes affect only the authentication client and its mocked tests; AGENTS.md requires relevant checks but does not require database integration tests for every client-only change. The requested lint/typecheck/unit/build verification was completed. No database connection, fixture creation/cleanup, migration, reset, or database configuration command was executed in this pass. Existing build/test preparation generates the ignored Prisma client offline, without selecting a database or applying SQL. This report does not add historical PostgreSQL test counts to the fresh unit total.

## Files and scope verification

A SHA-256 inventory of all 94 committable files was captured before editing and compared afterward. This correction pass changes exactly:

- `apps/web/src/lib/auth/store.ts` — recovery state and confirmed-success handling.
- `apps/web/src/lib/auth/coordination.ts` — explicit internal lifecycle/invalidation events.
- `apps/web/src/lib/auth/store.test.ts` — nine added cases and updated lifecycle/state assertions.
- `apps/web/src/lib/auth/coordination.test.ts` — one added combined lifecycle regression and explicit event assertions.
- `README.md` — recovery, lifecycle, and uncertainty behavior documentation.
- This new report.

The transport implementation, shared/backend contracts, backend registration policy, database guards/tooling/configuration, Prisma schema/migrations, frontend components/routes, package manifests, root lockfile, and GitHub Actions retain their exact pre-correction contents. Earlier uncommitted Stage 2C.1 changes were preserved rather than attributed to this correction pass. No dependencies were installed and no commit, push, merge, or deployment occurred. All changes remain uncommitted for review.

## Remaining risks and stop point

- These are deterministic mocked tests, not real-browser verification. Actual browser headers/cookies, cross-tab timing, BFCache behavior, reload/termination, and accessibility remain later-stage work.
- Browser coordination remains cooperative. Document termination and network failure cannot cancel an operation already committed on the server or guarantee late cookie ordering across documents.
- The eight-second indicator remains informational. Cookie-changing work retains its lock until settling; a hung request/database can retain it indefinitely. Backend query/lock timeout policy remains a separate operational concern and was not changed.
- Unsupported coordination remains unavailable for the document lifetime when adapter construction fails; no unsafe fallback or automatic capability-reconstruction loop was added.
- Production registration remains disabled by the unchanged backend. Production configuration support is not deployment readiness.

Stop after these Stage 2C.1 corrections. Stage 2C.2 and all later stages remain unimplemented pending review.
