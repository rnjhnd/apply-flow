# Stage 2C.3B3B — Offline fixture lifecycle implementation

## Baseline and scope

Confirmed before editing:

- Branch: `feat/authentication`.
- HEAD: `7eb5c0a0883bb0f869baf5cfb2acf5085f2d0ec7`.
- Working tree: clean; accepted B1/B2 infrastructure present.
- Node: `v24.22.0` (also checked after verification).

The approved B3A conversation plan, AGENTS.md, prior offline/correction reports,
the B2 live-preflight report, existing ownership/lifecycle/transaction modules,
authentication/session services, Prisma schema/migration, installed driver
interfaces, and package/test configuration informed this implementation.

Only B3B support code, deterministic tests, two disabled package scripts, and this
report were added or changed. The previously reported successful B2 live preflight
was not rerun. No new live execution has been authorized or performed.

## Actual changed-file inventory

Modified tracked files:

- `package.json`: adds disabled `test:e2e:fixtures:inspect` and
  `test:e2e:fixtures:cycle` commands; no dependency changes.
- `tests/e2e/support/discovery.test.ts`: imports all B3 modules under existing
  construction/startup tripwires; verifies disabled command behavior.

New support modules:

- `tests/e2e/support/fixture-database.ts`
- `tests/e2e/support/fixture-evidence.ts`
- `tests/e2e/support/fixture-files.ts`
- `tests/e2e/support/fixture-services.ts`
- `tests/e2e/support/fixture-process.ts`
- `tests/e2e/support/fixture-child.ts`
- `tests/e2e/support/fixture-lifecycle.ts`
- `tests/e2e/support/fixture-preflight.ts`
- `tests/e2e/support/fixture-cycle.ts`

New offline tests:

- `tests/e2e/support/fixture-database.test.ts`
- `tests/e2e/support/fixture-services.test.ts`
- `tests/e2e/support/fixture-process.test.ts`
- `tests/e2e/support/fixture-files.test.ts`

New documentation:

- `docs/milestones/checkpoint-2c3b3b-offline-report.md`

No existing product, database guard, environment policy, B2 SQL/rollback logic,
Prisma schema/migration, dependency/lockfile, HTTP/startup, Playwright scenario,
or GitHub Actions file changed. Existing B1 finalization/cleanup primitives remain
unchanged; stronger B3 behavior is composed through their existing injection points.

## Private database architecture and physical binding evidence

`openFixtureDatabase()` requires explicit injected factories and unchanged test
environment admission before constructing resources. The only target is
`127.0.0.1:5433/applyflow_test` as `applyflow_test`. It validates the approved SQL
digest, rejects additional diagnostic logging overrides in its private admission,
and constructs driver fields explicitly. It does not load environment files.

`installedFixtureDriver()` prepares lazy factories for the installed pg driver,
PrismaPg, and generated Prisma client. No factory is invoked on import or discovery.
Tests inject fakes instead. The returned public fixture facade contains only
inspection, the one service cycle, finalization, permit-based cleanup, closure,
and closure status; it exposes no pool, raw Prisma client, transaction callback,
or arbitrary SQL method.

Physical binding does not rely solely on `max: 1`:

1. One socket allocation is allowed. A second physical allocation rejects and
   latches review instead of reconnecting.
2. The pool's awaited `onConnect` hook captures the actual PoolClient and requires
   its protocol stream to be exactly the owned socket with the approved actual peer.
3. A fixed query verifies database/current/session user and backend PID. Its PID
   must match the installed pg client's BackendKeyData-derived `processID`.
4. A bound query wrapper guards the actual client's receiver and stream on every
   driver query, preserving original arguments, receiver, and return behavior.
   After authority failure only fixed rollback is permitted on usable transport.
5. Transaction inspection queries `pg_backend_pid()` and compares it with the
   admitted physical client. Stream/backend substitution cannot be satisfied by
   caller-supplied endpoint metadata.

Installed source/interface inspection established that PrismaPg accepts the
external pool, checks out a PoolClient for interactive transactions, and routes
transaction query/execute operations through that client's query method. Tests
also instantiate the actual installed PrismaPg adapter over a prototype-only fake
Pool and guarded fake PoolClient, execute its transaction methods, and reject a
substituted stream. No real Pool constructor, socket, PostgreSQL connection, or
Prisma query-engine database execution is involved in that probe.

No source/interface binding blocker was found. These are offline routing and
validation guarantees, not independently observed live socket/backend evidence.
B3C1 must establish the real connection behavior before fixture writes.

## Transaction modes, rollback and closure

Both modes first inspect through a PostgreSQL-enforced read-only transaction.
Inspect-only startup requests default read-only mode. Fixture-cycle startup permits
the separately authorized write path, but its inspection and post-cleanup checks
explicitly enter read-only transactions.

Read-only inspection uses REPEATABLE READ, verifies effective settings, reads the
unchanged fixed nonlocking B2 catalog vocabulary, and intentionally rejects the
callback with a private sentinel to request rollback through Prisma. Success
requires the sentinel rejection, completed inspection, and an actual driver
ROLLBACK command confirmation. Neither socket closure nor a generic rejection
counts as rollback confirmation.

Writes use the existing B1 guarded callback wrapper and actual transaction object.
Before/after inspection includes actual backend identity, a quiet-database check,
effective PostgreSQL settings, migration/history, and the pinned schema. Existing
READ COMMITTED, 3-second acquisition wait, 10-second transaction timeout, 5-second
statement timeout, 2-second lock timeout, and 10-second idle timeout are retained.

There is no mutation/transaction replay. Admission or permit loss during callback
execution rejects it; loss during commit confirmation remains review-required.
Read-only rollback confirmation is observed separately from commit evidence.

The connector bounds initialization, operations and shutdown. Review and abort
remain latched after late completion. Closure requires disconnect, external-pool
end and observed socket closure; unconfirmed closure fails. Deadline destruction
of the owned socket is failure handling, not evidence of PostgreSQL cancellation
or settled database work.

## Ownership and operation evidence

The existing version-1 journal retains exact immutable run/test identity, acknowledged
email intents, canonical UUID/email ownership, and pre-allocation token hashes.
The cryptographic token factory and production service implementations are unchanged.
Candidate hashes that never correspond to inserted sessions remain harmless.

The new bounded operation ledger has a strict allowlisted format, sequence/digest
chain, and references to validated ownership-journal prefixes. It permits only:

`started -> observed-before-commit -> confirmed-commit`

An unconfirmed started/observed operation may instead record uncertain-outcome and
close admission. Storage failures preserve incomplete evidence and terminal review.
Complete settlement requires exactly the anonymous and registration operations,
both confirmed; corruption, mismatched owner, operation changes, or incomplete
transitions cannot establish settlement.

Registration still runs the existing production callback on the original transaction.
A test-only wrapper observes its exact user UUID/email after successful callback
execution, records ownership synchronously before returning for commit, and returns
the original result. Persistence failure rejects the callback. A pre-commit record
does not assert commit. A receipt is marked confirmed only after the guarded host
promise resolves. Commit/reporting ambiguity never triggers automatic replay.

The B3 finalizer resolver accepts only rows matching already recorded canonical
UUID/email pairs. Finding a row by email intent alone is insufficient: a pre-existing,
manual, conflicting or otherwise unproven account causes review. Missing rows do
not expand ownership or deletion predicates.

The new fixed-path file adapter performs complete writes, fsync and descriptor
closure. Its tests mock filesystem functions. No real fixture evidence directory
was created by the B3 tests. Evidence contains no passwords, password hashes,
raw session tokens, cookies, CSRF proof, database URLs, raw driver exceptions,
or full authentication bodies/results.

## Headless parent/child lifecycle

The startup mismatch is resolved without pre-creating the child journal:

1. Parent admission, migration validation and both leases precede injected preflight
   and spawn. The parent rechecks admission/leases after the awaited preflight.
2. The fixed spawn adapter uses current Node, the repository child TS entry, a clean
   environment, no shell, a hidden Windows window and IPC. Child stdout/stderr are
   ignored rather than forwarded/persisted as potentially sensitive diagnostics.
3. Child alone exclusively creates its journal and sends journal-ready evidence.
4. Parent validates the empty initial snapshot, creates its finalization ledger,
   then acknowledges admission. No HTTP port or fake loopback origin is used.
5. Exact intent acknowledgments precede the single tracked service cycle.
6. Shutdown closes operation admission; accepted work is awaited. The operation
   ledger must be settled and database closure confirmed before child sealing.
7. Parent validates the journal and operation-ledger digests and acknowledges the
   seal and controlled channel closure. The child cannot attest its own exit.
8. Only the owned process's actual normal exit advances parent exit evidence.

Parent handling closes health immediately on stop, shares the shutdown promise,
cleans up its subscriptions, rechecks exit before escalation, and can signal only
the owned handle. Startup/work/IPC/shutdown waits are bounded. Premature disconnect,
missing seal, uncertain closure, process error, forced termination or unexpected
exit prevents cleanup eligibility. A late successful operation after interruption
cannot publish cycle completion.

The finalization authority also checks the sealed operation-ledger digest through
its lease assertion. Changes after sealing invalidate pending finalization and
cleanup authority. The existing lifecycle remains:

`recording -> quiescing -> child-sealed -> exit-confirmed -> finalizing -> cleanup-eligible -> cleaned`

Review-required is terminal. Leases release only after cleaned state and the parent
orchestrator's confirmed database closure. Journals/ledgers remain as evidence.
There is no abandoned-run reopening, lease stealing, or automatic recovery.

## Smallest prepared cycle and cleanup

The cycle exposes only one acknowledged exact email, one anonymous allocation,
one registration, and exact read-back/rotation assertions. Production Argon2id and
session/authentication injection points are reused. Unit tests inject a password
backend; no live fixture account is created. Credentials/proofs remain local to the
service call; only fixed safe counts leave the cycle.

There is no fixture login, logout, expiration cleanup, multiple-user seeding,
HTTP, cookie processing or browser runtime.

Parent finalization begins only after successful child shutdown and observed exit.
Cleanup reuses the process-local permit and unchanged B1 predicates:

- Canonical User UUID AND exact email.
- Recorded session token hashes and null-safe exact user relationships.
- Ordered user/session locking and validation of all related sessions.
- Rejection of any unrecorded related session before deletion.
- Session deletion before user deletion; NOT EXISTS guards against hidden cascades.
- Live authority assertions around locks/deletions and callback completion.
- Exact RETURNING-row verification; mismatches reject/roll back.

After confirmed cleanup commit, the injected verifier uses a separately enforced
read-only Prisma transaction and fixed exact-target absence queries. Only then can
the existing finalizer persist cleaned. Empty permits perform no deletion, and
repeated successful cleanup does not issue further deletes. Ambiguous commit,
invalidated permits, failed absence checks or durable-state failures retain evidence
and require review; they do not authorize a retry or broader query.

## Deterministic regression evidence

Added **87 tests**. The previous 936 full-suite and 492 offline-support tests remain
included, without weakening existing assertions.

| File | New cases |
| --- | ---: |
| `fixture-database.test.ts` | 39 |
| `fixture-services.test.ts` | 22 |
| `fixture-process.test.ts` | 21 |
| `fixture-files.test.ts` | 4 |
| Added discovery case | 1 |
| Total | 87 |

Coverage includes invalid admission before construction, peer/client/backend
substitution, reconnect rejection, effective read-only/isolation discrepancies,
migration/catalog/quiet checks, rollback confirmation, bounded closure, actual
installed adapter routing over fakes, guarded finalization/cleanup, permit revocation,
unrecorded sessions, incorrect returned rows, failed absence checks, and invalidation
during commit.

Other cases exercise real product service code over staged in-memory transactions,
session rotation, missing intent/hash evidence, pre-commit journal failures,
uncertain commit, failed commit-receipt persistence, strict user resolution,
digest/sequence/owner corruption, startup/send/ack races, late work and late success,
child termination, exact lease release, safe spawn configuration, sensitive sentinels,
mocked filesystem failures, inert imports and disabled commands.

## Actual verification results

The final revision ran the required sequence in order, waiting for completion:

| Command | Result |
| --- | --- |
| `npm.cmd run test:e2e:list` | Exit 0; one disabled-runtime sentinel listed; none executed |
| `npm.cmd run test:e2e:offline` | Exit 0; **579 passed**, 20 files |
| `npm.cmd run lint` | Exit 0; no errors or warnings |
| `npm.cmd run typecheck` | Exit 0; workspaces, root and E2E configuration |
| `npm.cmd test` | Exit 0; **1,023 passed**, 39 files |
| `npm.cmd run build` | Exit 0; contracts/API/web; 216 Vite modules transformed |
| `git diff --check` | Exit 0; no whitespace errors; existing LF/CRLF advisories only |
| `git status --short --untracked-files=all` | Exit 0; scoped inventory below |

Existing typecheck/test/build scripts regenerate the ignored Prisma client and
build artifacts. They did not apply migrations or connect to PostgreSQL. No live
preflight, fixture command, integration suite or browser test was executed.

Development failures were corrected within scope:

- Initial service tests needed the fake query port to support tagged-template calls,
  not only Prisma.sql objects. Three initial focused cases failed; corrected tests
  then passed without changing the product code.
- A fault test attempted to spy on a frozen ledger API; it now injects persistence
  failure at the transaction/IO boundary instead.
- Five initial composed process cases exposed the intent-ack continuation race.
  The child now permits the already-authorized operation to start before send
  completion, while retaining interruption checks. All cases subsequently passed.
- Strict typing caught the driver's untyped runtime processID, a query receiver
  annotation, optional environment fixtures and an extended-owner test literal.
  Runtime PID validation and fixture typing were corrected.
- Lint caught a discarded caught-error rethrow pattern. Rollback confirmation now
  records a boolean outcome and emits a fixed error after the catch, preserving
  privacy without suppressing lint or attaching sensitive causes.
- Final review added interruption-completion and fixed-spawn regressions; the full
  sequence was repeated for those revisions. A PowerShell glob used for source
  inspection was corrected; it had no implementation or live-execution effect.

Final protected-path diff (`apps`, `packages`, `.github`, `package-lock.json`) is
empty. The migration's local SHA-256 remains
`98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840`.
New-file whitespace/content checks and Git inventory were repeated after this report.

## Remaining limitations and C1/C2 gates

Both `test:e2e:fixtures:inspect` and `test:e2e:fixtures:cycle` unconditionally report
disabled and return failure. Arguments/environment flags cannot enable them.
The direct child entry is also disabled. General E2E/fixture/browser gates remain
unchanged and closed. The previously activated B2 read-only CLI is unchanged and
was not invoked.

Actual live runtime wiring/activation remains a future reviewed change, not just
an approval environment variable. C1 must authorize and verify the real Prisma
connector in read-only mode. C2 must separately authorize the exact service-created
fixture cycle, rotation deletion, finalization and cleanup. The headless runtime
and spawn adapters were tested with injected process handles only.

These tests do not prove real Prisma query-engine/pg transaction settlement,
PostgreSQL cancellation or lock modes, FK/cascade safety under concurrent writes,
absence of deadlocks, real socket peer/backend binding, OS IPC/signal ordering,
filesystem/directory/power-loss durability, or Windows ACL guarantees. They assume
cooperating filesystem writers and an operator-controlled quiet database. Quiet
activity checks are observations, not a lock against future external clients/DDL.

Forced child exit or socket closure cannot prove pending PostgreSQL work settled.
Ambiguous operations require separately approved read-only reconciliation; no
automatic cleanup/replay is provided. Real interruption/fault/concurrency exercises
need separate approval beyond the first successful serial fixture cycle.

No unchanged-development-data snapshot is claimed: the development database was
not accessed at all. No real fixture ownership, cleanup or browser evidence exists
from this stage. HTTP admission/cookies, browser coordination, accessibility,
production HTTPS behavior, and CI remain later work.

## Scope and Git status

Branch and HEAD are unchanged. Final working tree: **two modified tracked files
and fourteen untracked files** (nine modules, four test files, this report).
Nothing is staged; no commit, push, merge, fetch or deployment occurred.

No PostgreSQL connection/read/write/live cleanup, B2 preflight, database integration
test, Docker/service operation, real fixture child, authentication server, browser,
migration/reset/schema change, dependency installation, product security change,
database-guard change or CI change occurred. Required existing unit/HTTP tests ran
as requested; they are not a live fixture/authentication environment. In-memory
cleanup and mocked filesystem/process behavior in tests are not live operations.

B3B stops here pending the separately requested read-only safety audit. Neither
B3C1 nor B3C2 has begun.

## Focused offline safety corrections after the audit

The preceding sections retain the original implementation and verification
history. This section supersedes the installed-driver availability and test-count
statements above. The independent audit reproduced three defects; only those
defects and their deterministic regressions were addressed in this pass.

### Baseline and changed files

Reconfirmed `feat/authentication` at
`7eb5c0a0883bb0f869baf5cfb2acf5085f2d0ec7`, with two modified tracked files,
fourteen untracked B3B files, and nothing staged. Existing work was preserved.

Files edited during this correction pass:

- `tests/e2e/support/fixture-child.ts`
- `tests/e2e/support/fixture-process.ts`
- `tests/e2e/support/fixture-database.ts`
- `tests/e2e/support/fixture-process.test.ts`
- `tests/e2e/support/fixture-database.test.ts`
- `tests/e2e/support/discovery.test.ts`
- `docs/milestones/checkpoint-2c3b3b-offline-report.md`

`package.json` remains modified from the original B3B implementation; this pass
did not change its scripts or dependencies. No additional files were introduced.

### 1. Terminal child review and shutdown acknowledgments

The child previously awaited seal/closure acknowledgments and then assigned
`closed` without checking whether interruption had latched review in the meantime.
An acknowledgment could resolve, interruption could occur, and its continuation
could subsequently overwrite review and exit successfully.

Shutdown now captures a process-local operation generation. It checks that
generation, cancellation, and the expected lifecycle state after outstanding
work, resource closure, sealing, each shutdown send, and each acknowledgment.
Checks also immediately precede disconnect and successful exit, including a check
after the injected disconnect call. Review increments the generation and remains
terminal; duplicate interruption requests cannot reopen it.

The child additionally sends one bounded, secret-free `review-required` notice
containing only the exact run/test identifiers. Delivery failures are caught and
cannot authorize a successful child exit. The parent handles review notices
synchronously, before queued protocol continuations or a later code-zero exit,
and latches its existing finalizer/lease admission closed. Malformed review
notices also fail closed.

Four new process regressions cover:

- Seal acknowledgment resolution immediately followed by duplicate interruptions.
- The exact audited closure-ack resolution/interruption ordering.
- Interruption during disconnect, before the successful exit call.
- A late shutdown-send continuation after interruption and acknowledgment activity.

The acknowledgment regressions inject a subsequent normal exit event and verify
that it cannot establish exit-confirmed or admit finalization. They also verify
one review notification and no successful child exit. Existing normal controlled
shutdown remains covered and passing.

Two initial new assertions incorrectly required a durable review ledger entry.
Existing parent admission is latched closed before best-effort review persistence;
its lease guard can therefore reject that append. The tests now assert the actual
safety contract: preserved sealed evidence, unhealthy/closed parent admission,
no exit-confirmed/cleanup eligibility, and no accessible finalizer. No existing
test assertion was weakened or removed. The existing finalizer implementation
and cleanup authorization were not changed.

### 2. Installed-driver activation is hard-closed by mode

The exported lazy installed-driver factory previously returned real pg/socket/
Prisma constructors despite the disabled CLI stubs. An alternate programmatic
composition could consequently reach those constructors without phase activation.

`installedFixtureDriver()` now rejects unconditionally before importing or
constructing an installed driver. Inspect-only and fixture-cycle modes have
distinct fixed C1/C2 rejection paths. Missing, forged, or unexpected mode inputs
also reject. There is no live factory implementation, activation-token issuer,
environment switch, or argument override available through this B3B API. Future
C1/C2 activation requires separate reviewed code changes and approval.

The private database composition still accepts explicitly injected test ports.
Its actual installed PrismaPg adapter-routing test continues to run over a fake
Pool/PoolClient without invoking a real Pool constructor or socket. Injected
dependencies are trusted test ports, not an OS sandbox against arbitrary caller
code that independently imports networking libraries.

Six new discovery/admission regressions cover:

- The audited installed-factory-to-database composition for both modes under
  constructor/socket tripwires, while the fixture phase gate remains closed.
- Missing/forged mode and extra approval/argument values.
- The direct inspection, cycle, and child entry branches under simulated argv,
  with captured output and construction/startup tripwires.

The direct-entry tests reset module discovery and simulate the entry filename in
the current test process; they do not spawn Node or invoke fixture commands. They
restore argv, exit status, output interception, and builtin exports afterward.
This is not real OS child-process execution evidence.

### 3. Nonthrowing owned destruction and bounded failure settlement

The deadline callback previously called `socket.destroy()` before rejecting its
controlled promise. A synchronous destruction exception could escape the timer,
leave the operation pending, and bypass fixed reporting. Closure failure handling
had the same exception exposure.

All explicit owned-socket destruction now goes through one nonthrowing,
best-effort helper. It records that destruction was requested before invoking
the socket, catches exceptions, and never repeats the explicit destruction
request. Deadlines latch failure and reject with a fixed error independently of
destruction success. Closure failure uses the same helper and a fixed sanitized
error. No raw destruction exception is rethrown or attached as a cause.

Five new database regressions use throwing fake sockets and controlled promises:

- Connection deadline, followed by late successful connection completion.
- Operation deadline, followed by late query completion.
- Shutdown deadline, followed by late closure completion and repeated cancellation.
- Disconnect failure followed by throwing destruction.
- Pool-end failure followed by throwing destruction.

They verify bounded rejection, latched failure, one explicit destruction attempt,
no reconnection/operation replay, and no late successful admission. Socket
destruction is never counted as rollback, cancellation, or server settlement.

### Surrounding invariants rechecked

The exact durable intent receipt still gates parent mutation dispatch. The
child's prior intent-send continuation correction is preserved. Token recording,
pre-commit UUID/email observations, and post-transaction commit receipts remain
separate. Unknown commit outcomes and uncertain process settlement do not permit
automatic cleanup or retry.

Finalizer review remains terminal. Exact UUID/email/hash deletion predicates,
unrecorded-related-session blockers, permit liveness checks, returned-row
validation, and independent read-only absence verification are unchanged.
Existing database guards, B1 transaction/finalization/cleanup modules, approved
schema/migration, and the B2 read-only SQL/rollback/CLI implementation are unchanged.

Inspection/cycle CLI stubs, the child entry, and general browser/E2E gates remain
disabled. Their existing package commands were not executed. The previously
approved B2 read-only preflight remains unchanged and was not rerun.

### Observed verification

Added **15 deterministic tests**, retaining the prior 579 offline/1,023 full-suite
tests. The initial focused run had 107 passing and two failing assertions about
best-effort review persistence, described above. The corrected focused run passed
**109 tests across three files**.

The following required commands then ran sequentially, each completing before
the next began:

| Command | Actual result |
| --- | --- |
| `npm.cmd run test:e2e:list` | Exit 0; one disabled-runtime sentinel listed, none executed |
| `npm.cmd run test:e2e:offline` | Exit 0; **594 passed**, 20 files |
| `npm.cmd run lint` | Exit 0; no errors or warnings |
| `npm.cmd run typecheck` | Exit 0; workspace/root/E2E checks |
| `npm.cmd test` | Exit 0; **1,038 passed**, 39 files |
| `npm.cmd run build` | Exit 0; contracts/API/web, 216 Vite modules |
| `git diff --check` | Exit 0; existing LF/CRLF advisories only |
| `git status --short --untracked-files=all` | Exit 0; same two modified tracked and fourteen untracked files |

The new-test breakdown is four process, five database, and six discovery cases.
No tests were skipped or assertions in prior regressions relaxed. Existing scripts
regenerated ignored Prisma/build output without connecting to PostgreSQL.
Whitespace and Git inventory checks were repeated after this documentation update.

### Remaining limits and scope confirmation

Mocks do not prove real Prisma commit/rollback behavior, protocol/backend binding,
PostgreSQL cancellation or foreign-key lock/cascade safety, crash durability,
or real Windows IPC/signal/termination ordering. Directory durability/ACL and
operator-controlled quiet-database assumptions remain unchanged. A failed review
ledger append preserves prior evidence and retained leases; it is not a durable
success or permission to resume an abandoned run.

No database connection/read/write, live fixture creation or cleanup, B2 preflight,
database integration run, Docker/service operation, actual fixture child/server,
browser execution, migration/reset, dependency installation, CI/product/security
change, staging, commit, push, merge, or deployment occurred. Offline fake deletion
and simulated entry branches are not live cleanup or process execution. Existing
authorized unit/HTTP tests are not a live fixture environment.

Branch and HEAD remain unchanged; nothing is staged or committed. Both C1/C2
commands remain disabled. This correction pass stops pending review and does not
authorize or begin B3C1.

## Terminal review / exit safety correction (2026-10-22)

This section records the subsequent narrow correction for the remaining re-audit
finding. It supersedes the preceding correction's exit-safety and latest-count
claims; earlier results remain historical evidence.

### Reproduced defect and root cause

The prior generation/state checks prevented the child from explicitly executing
its successful shutdown path after interruption. However, review notification
and persistence were best effort and did not latch the owned process's exit
status. A transport send acknowledgment was also incorrectly tied to handler
completion in the main composed process fake.

The audit's injected sequence therefore remained possible: closure-ack resolved,
interruption latched child review, review reporting failed, and a later apparent
normal exit allowed the uninformed parent to reach cleanup-eligible. Valid sealed
journal/operation evidence did not communicate that later terminal failure.

### Exact correction files

- `tests/e2e/support/fixture-child.ts`
- `tests/e2e/support/fixture-process.ts`
- `tests/e2e/support/fixture-process.test.ts`
- `docs/milestones/checkpoint-2c3b3b-offline-report.md`

No new files or dependencies were added. Existing installed-driver hard gates,
nonthrowing destruction, database guards, B1 finalization/cleanup predicates,
B2 preflight, product code, schema/migrations, CI and browser scenarios are unchanged.

### Owned child exit contract

`createFixtureExitHost()` is an explicit injected owned-process adapter. It has
no import-time behavior and is not installed by the still-disabled child entry.
It sets a nonzero default exit status before child work can begin, so premature
natural termination is not successful settlement.

The adapter returns an immutable observation-only capability. Its failure and
successful-completion operations are private in a WeakMap; forged or reused
capabilities cannot compose a child, and one exit port cannot have competing
exit hosts. Only the fully verified child shutdown path can request success.

Terminal review synchronously sets the private failure latch and exit status 1
before AbortSignal callbacks, persistence callbacks or IPC reporting. No method
clears that latch. Generation/state checks remain in place after awaits and
before disconnect/successful exit.

An owned-process exit listener reasserts status 1 whenever failure is latched.
This covers natural exit and an attempted explicit exit with code zero, even if
a later callback assigned zero to the mutable public exitCode property. The
private success operation checks failure both before requesting exit and after
an injected exit operation returns. The public capability exposes no reset or
successful-exit method.

The installed Node 24 implementation was inspected read-only: its process.exit
implementation emits exit listeners before using process.exitCode in reallyExit.
No real process exit or global process-status/listener modification was used in
the tests. This is installed-source support plus fake-port evidence, not actual
Windows process execution proof. The guard is for cooperating owned runtime code,
not a sandbox against arbitrary code replacing/removing process machinery.

When separately activated in the future, the child entry must create this host
over its actual process, not a surrogate. `createFixtureChild()` now requires the
factory-issued, single-use capability and no longer accepts an arbitrary exit
callback. The current direct entry remains disabled, sets failure status, and
cannot launch a runtime. No live wiring was activated in this pass.

### Parent exit admission

The owned child handle now provides its observed exitCode and signalCode.
Before forwarding an exit event to finalization, the parent requires a first
normal code-zero event whose code/signal match that handle. Nonzero, missing,
inconsistent, signaled or duplicate exit evidence latches parent review instead.
Missing exit remains subject to bounded owned-handle termination; no PID/port
lookup or unrelated-process termination was added.

Review notices remain sanitized diagnostics. A send callback acknowledges only
transport, not parent handling or durable persistence. Neither notification
delivery nor a successful review-ledger append is required to reject an abnormal
exit. Existing finalizer review remains terminal when durable review persistence
fails, and sealed evidence cannot override abnormal exit admission.

The main composed fake now acknowledges transport before dispatching/settling
the child handler. Its fake owned process emits exit listeners before exposing
the final exit status to the parent, modeling the inspected Node ordering.
No actual child process, socket, database or server is used.

### Regression evidence and original reproduction outcome

Added **16 deterministic cases** to `fixture-process.test.ts`; its prior 25 tests
remain passing, for **41 passing lifecycle tests**. Cases cover:

- Three exact closure-ack/interruption reproductions with rejected review send,
  transport accepted without parent handling, or parent handling delayed until
  after exit. Reporting throws and parent durable storage is unavailable.
- Transport acknowledgment while accepted service work remains pending; no
  operation completion or finalizer admission is inferred from that acknowledgment.
- Failure status preceding reporting, duplicate interruption, attempted status
  reset and an attempted explicit successful exit.
- An actual injected parent-finalizer ledger append failure, retaining terminal
  review and rejecting finalization before any database query.
- Forged and reused host capabilities rejected before journal/service construction.
- Seven abnormal/missing/conflicting/duplicate exit-evidence cases despite valid
  sealed journal and operation evidence.
- Missing observed exit with bounded termination of only the owned fake handle.

For the audited sequence, the observed fake child now remains in review, retains
its private failure latch, and exposes exit status **1** to the parent. Parent
shutdown rejects, finalizer access is denied, and no cleanup permit can be issued.
This holds when the review message fails or its transport succeeds without parent
application handling. Delayed diagnostics and subsequent contradictory callbacks
cannot reopen admission. No deletion is executed by these new regressions.

The original normal-clean-shutdown test still reaches exit-confirmed, and the
transport-ordering regression independently confirms successful normal exit with
status zero after tracked work settles. Earlier acknowledgment/disconnect/late
continuation, activation-tripwire and throwing-destruction regressions remain
included and passing. No accepted assertion was removed or weakened.

### Verification results

Commands ran one at a time, awaiting completion. The initial typecheck found
TS18048 for a validated host captured in an async callback. A narrowed local
authority binding fixed it without behavior changes or type/test suppression;
typecheck and lint were rerun successfully before continuing.

| Command | Actual result |
| --- | --- |
| Focused `npm.cmd exec -- vitest run --project unit tests/e2e/support/fixture-process.test.ts` | Exit 0; **41 passed**, one file |
| `npm.cmd run test:e2e:list` | Exit 0; one disabled-runtime sentinel listed, none executed |
| `npm.cmd run test:e2e:offline` | Exit 0; **610 passed**, 20 files |
| `npm.cmd run lint` | Exit 0; no errors or warnings, including rerun after the typing correction |
| `npm.cmd run typecheck` | Initially exit 1 (TS18048); corrected rerun exit 0 |
| `npm.cmd test` | Exit 0; **1,054 passed**, 39 files |
| `npm.cmd run build` | Exit 0; contracts/API/web, 216 Vite modules |
| `git diff --check` | Exit 0; existing LF/CRLF advisories only |
| `git status --short --untracked-files=all` | Exit 0; same two modified tracked files and fourteen untracked B3B files |

The full test run includes the current code after the typing correction. Existing
scripts regenerate ignored Prisma/build output; no migration or connection is
performed by that generation. Whitespace/protected-path/staging/Git inventory
checks were repeated after this report update.

### Scope and remaining limits

Real Windows process termination, natural exit, IPC ordering, signal behavior and
failure enforcement remain unverified by actual child execution. Runtime activation
must bind the host to the real owned child process and preserve its lifetime exit
listener. Test ports model Node semantics; arbitrary malicious process ports or
unreviewed code that rewrites process machinery are outside that trust boundary.

Real Prisma transaction settlement, PostgreSQL cancellation, physical binding,
FK locks/cascades, interrupted database work and filesystem crash durability remain
later live-verification requirements. No socket destruction or process status
alone proves database rollback/settlement. Cleanup still requires all existing
ownership, permit, relationship, result and absence checks.

Reconfirmed branch `feat/authentication`, HEAD
`7eb5c0a0883bb0f869baf5cfb2acf5085f2d0ec7`. Inventory remains two modified tracked
files and fourteen untracked files; nothing is staged or committed. The full B3B
inventory above is unchanged.

No PostgreSQL connection, B2 preflight, live fixture creation/deletion/cleanup,
integration suite, Docker/service operation, real fixture child, browser,
migration/reset, dependency installation, staging, commit, push, merge or deployment
occurred. Only injected offline tests and authorized local verification ran.
Both C1/C2 commands, direct child execution and general live browser/E2E gates
remain disabled. B3C1 has not begun; this pass stops pending read-only re-audit.
