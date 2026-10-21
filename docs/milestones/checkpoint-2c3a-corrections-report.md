# Stage 2C.3A — Targeted offline safety corrections

Status: corrections implemented; verification results below. Stage 2C.3B remains disabled.

## Scope and changed files

The correction pass continues on `feat/authentication` at
`216029d4470bf1fda205e4460448d2768f8517ec`, with the original uncommitted 2C.3A
foundation present. Only these six files are added/changed by the correction pass:

- `tests/e2e/support/ownership.ts`
- `tests/e2e/support/ownership.test.ts`
- `tests/e2e/support/lifecycle.ts`
- `tests/e2e/support/lifecycle.test.ts`
- `tests/e2e/support/discovery.test.ts`
- `docs/milestones/checkpoint-2c3a-corrections-report.md`

The prior implementation report is historical; this report supersedes its test
counts and the corrected ownership/shutdown behavior. No dependencies, runtime
composition, journal format/finalization interface, or live cleanup executor were added.

## Root causes and corrections

### Unambiguous fixture ownership

The validator tracked user UUIDs, but not emails already assigned to users. It
also compared UUID spelling directly, allowing casing aliases. It now requires
a one-to-one relationship between canonical lowercase user UUIDs and exact owned
emails, with exactly one prior email intent for each user. Duplicate email intents,
duplicate token-hash metadata, duplicate user records, conflicting email/UUID
assignments, and missing/out-of-order intents reject the entire input. The planner
validates first and returns no partial plan on failure. User UUIDs in valid plans
are canonical; run/test identifiers and email predicates retain exact matching.

Journal append validation still precedes persistence and fixture handoff. A new
regression proves conflicting records neither change the journal nor invoke the
write callback. Empty ownership still yields no targets. Existing crypto, hash
recording before insertion, privacy restrictions, and narrow predicates are unchanged.

Eleven new ownership tests cover the audit conflict, casing aliases on the same
and different emails, one UUID on multiple emails, missing/different/late intents,
duplicate intent/hash entries, canonical independent users, and rejected write handoff.

### Shutdown closes readiness synchronously

Previously `stop()` marked failure inside its deferred shutdown work, leaving an
admission interval. It now synchronously sets stopping state and rejects pending
readiness. Messages arriving afterward are ignored and health is immediately false.
The shared shutdown promise is still published before channel methods run, so
reentrant/repeated stop or disconnect notifications join one operation. No existing
request is aborted or unrelated process targeted.

New tests reproduce stop immediately followed by readiness and immediate health
invalidation after an already-ready child. They assert one shutdown request, the
same promise, no premature exit confirmation, listener/timer cleanup, and no kill
after a normal observed exit. The accepted synchronous-disconnect regression remains.

### Exit is rechecked before escalation

A timeout can win the grace-period race before exit is delivered, while the
continuation runs after exit was observed. A second exit check now skips `kill()`
in that interval. The new deterministic test advances only the timeout synchronously,
then delivers exit between promise reactions. Existing genuinely stalled-child tests
still require bounded escalation and reject unconfirmed termination. Only an owned
child handle can be signalled; no PID or port lookup is introduced.

### Discovery tripwires

The earlier regression covered known database helpers, fetch, and several process
functions, but not direct sockets/HTTP/database clients or synchronous spawning.
The discovery test now temporarily patches the actual Node module objects and
relevant prototypes, synchronizes named builtin exports, and restores descriptors,
builtin exports, environment stubs, and globals after each case. It also mocks
the project Prisma constructor/connection and database helpers. No native I/O
implementation is invoked by the intentional fault probes.

Twenty-nine new discovery cases prove interception of TCP/socket constructors and
prototype connection, TLS, HTTP(S) requests, HTTP client/server and TCP server
construction, fetch, all seven child-process entry points including `spawnSync`,
pg client/pool construction/connect/query, and project Prisma construction/connect.
CommonJS property lookups and a named builtin import are covered. The original
configuration/import assertions remain and require zero tripwire calls.

These are scoped JavaScript regressions, not OS isolation. Previously captured
function references, unlisted transports/driver entry points, native addons,
other workers/processes, and arbitrary future imports are not comprehensively
sandboxed. The generated Prisma mock covers the project's import path; it is not
a universal interception of every possible Prisma runtime entry point. Imports
and future dependencies still require review. No claim of live database safety
or browser behavior follows from these tests.

## Stage 2C.3B design note — post-exit finalization (not implemented)

The current `stopped` journal is terminal: neither its writer nor reader permits
additional ownership events. A child cannot observe its own process exit, and a
parent cannot safely resolve lost-response user UUIDs through the current writer
after sealing. Do not use the existing `markExited()` call as an exit attestation
or weaken stopped-journal validation to work around this.

The future implementation needs an explicit, reviewed handoff/finalization API:

1. Quiesce and seal the child's fixture-writing side; stop admitting requests and
   finish/drain owned work. Only the parent observes actual process exit through
   the owned lifecycle handle. Sending shutdown/kill or losing IPC is insufficient.
   Forced/ambiguous termination must retain fixtures for review unless database
   work settlement can be safely established; process exit alone does not inspect
   pending database transaction state.
2. Permit exactly one parent-side finalizer to take ownership of the validated
   existing run/test journal after exit. It must preserve append sequence/history
   and distinguish child sealing from final cleanup eligibility. No fixture writes
   or token allocations may resume after child exit.
3. With separately approved test-database access, revalidate environment, endpoint,
   connected database/user, migration checksum/history, and transaction target.
   Resolve only exact pre-recorded email intents, never a prefix/age/expiry scan.
   Check canonical UUID/email associations against all existing ownership records;
   conflicting, unexpected, malformed, or ambiguous rows stop finalization.
4. Durably record resolved ownership and the final handoff/exit state before any
   cleanup is eligible. Cleanup must use exact UUID-plus-email and recorded session
   hash predicates on the guarded connection, and must be idempotent/fail closed.
   An absent row is not permission to expand the predicate. There is no cleanup
   executor or transaction-level write gate in this stage.
5. An abandoned/interrupted run remains review-required; never automatically
   reopen or delete it. Any explicit recovery workflow needs separate approval.

Required future interfaces include parent-controlled existing-journal handoff,
distinct child-sealed versus fully-finalized lifecycle semantics, and a narrow
post-exit metadata finalizer bound to observed exit and guarded database access.
These require Stage 2C.3B design review; none is implemented by this correction.
No raw credentials, cookie/token/CSRF material, or database URLs belong in that metadata.

## Verification

The required sequence completed in order, awaiting each command before the next:

| Command | Actual result |
| --- | --- |
| `npm.cmd run test:e2e:list` | Exit 0; one Stage 2C.3B-required sentinel listed in one file; no test executed |
| `npm.cmd run test:e2e:offline` | Exit 0; **133 passed**, five files |
| `npm.cmd run lint` | Exit 0; zero errors/warnings |
| `npm.cmd run typecheck` | Exit 0; all workspaces, root configuration, and E2E setup |
| `npm.cmd test` | Exit 0; **577 passed**, 24 files: 479 Node/HTTP/harness + 98 components |
| `npm.cmd run build` | Exit 0; contracts/API/frontend; 216 Vite modules transformed |
| `git diff --check` | Exit 0; no whitespace errors; existing LF/CRLF notices only |
| `git status --short --untracked-files=all` | Exit 0; five modified tracked files and eighteen new files, all uncommitted |

All 534 tests from the initial 2C.3A implementation remain passing, plus **43 new
regressions** (11 ownership, three lifecycle, 29 discovery). The original audit's
conflicting-ownership, immediate stop/readiness, and exit-before-escalation sequences
are covered and pass. No check failed during this correction pass; no test assertion
was weakened. Focused development offline checks also passed before the final sequence.

The approved SQL digest was read from disk and remains
`98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840`.
`git diff --name-only -- apps/api/src/config apps/api/src/modules/auth apps/api/prisma .github apps/web packages/contracts`
was empty. No live database identity/history/data was queried. The original 2C.3A
package/config/Express edits remain uncommitted and were not expanded by this pass.
After completing this documentation, whitespace and Git status checks were repeated.

## Boundaries

Live `test:e2e` remains disabled. No PostgreSQL connection, row write/delete,
migration/reset, actual authentication test server, browser launch, cleanup,
dependency install, backend/security-policy change, CI change, commit, push, merge,
or deployment was performed. The required full suite includes existing isolated
Supertest HTTP unit tests with mocked services; no normal application runtime or
database-backed authentication server is started. Generated Prisma/build artifacts
are produced offline by existing scripts only.
