# Stage 2C.3B3C1B - Offline read-only Prisma inspection activation

## Status and baseline

C1B implementation and offline verification are complete. The inspection command
is technically enabled; **executing it is not authorized by C1B**. A separate
read-only audit and C1C approval are required before the first Prisma connection.

Independently checked before editing:

- Branch: `feat/authentication`.
- HEAD: `ef96258760383ed28dbb288a20ad8694a41220cc` (`ef96258`).
- Clean working tree; nothing staged.
- Zero behind/eight ahead of locally recorded `origin/feat/authentication`; no fetch.
- Active Node: `v24.22.0`.
- Accepted B3B support files, corrections and reports present. Historical B2 live
  success is recorded in `checkpoint-2c3b2-live-preflight-report.md`; it was not
  repeated or independently re-attested here.

Context included AGENTS.md, PRD.md, DESIGN_SYSTEM.md, the approved C1A plan in the
conversation, B3B and B2 reports, environment/execution guards, fixture and B2
adapters, discovery tests, package scripts, and installed pg/PrismaPg interfaces.
No separate C1A plan file was present under `docs/`.

## Changed-file inventory

Modified:

1. `tests/e2e/support/fixture-preflight.ts` - explicit native-main CLI composition,
   private capability lifetime, sequential adapters, signals and fixed reporting.
2. `tests/e2e/support/fixture-database.ts` - additive narrow inspection-and-close
   wrapper; existing connector/cleanup behavior and public installed hard gate
   unchanged.
3. `tests/e2e/support/fixture-database.test.ts` - three narrow-wrapper regressions.
4. `tests/e2e/support/discovery.test.ts` - inspection admission/import expectations
   updated for explicit activation; cycle/child and constructor tripwires retained.

Added:

5. `tests/e2e/support/fixture-preflight.test.ts` - 72 injected offline cases.
6. `docs/milestones/checkpoint-2c3b3c1b-offline-report.md` - this report.

`package.json` did not need modification. The only canonical command remains
`test:e2e:fixtures:inspect`, using the existing
`node --import tsx tests/e2e/support/fixture-preflight.ts` script. No
`test:e2e:fixtures` alias was added. Dependencies and lockfile are unchanged.

## Entry and admission boundary

Installed constructor composition appears only inside
`if (import.meta.main === true)`. Node 24's native main bit replaces the previous
argv-path comparison; there is no fallback. Importing with a spoofed argv cannot
activate the command. The native-main API is present in the installed Node 24
types. A harmless inline Node/tsx probe also returned
`{"node":"v24.22.0","nativeMain":true}`. It imported no harness entry or database
module; the actual inspection CLI was not launched to test this boundary.

The entry initializes `process.exitCode = 1` before work and catches unexpected
failures with fixed output. The exported runner requires explicit injected ports;
it has no installed/default driver, default environment or live runtime factory.

Before loading driver constructors, the runner rejects all command arguments,
requires explicit shell `NODE_ENV=test` and `TEST_DATABASE_URL`, and invokes the
unchanged environment/database guards. Only `127.0.0.1:5433/applyflow_test` as
`applyflow_test` is admitted. No .env loader, DATABASE_URL fallback, external URL,
mode argument or SQL argument exists. Existing optional `schema=public` URL policy
is retained; unsupported parameters reject and are not forwarded to pg.

Inherited PG/runtime overrides reject under the existing guard. The runner also
applies the fixture connector's diagnostic-variable rejection for DEBUG,
NODE_DEBUG, RUST_LOG, RUST_BACKTRACE and PRISMA log variables before even B2
constructor loading. Migration bytes are privately copied and their SHA-256 must
match `98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840`.
The invoking environment is re-admitted after awaited dependency/adapter work;
changing its target or adding a forbidden override cannot authorize Prisma.

## Private authority and resource lifetime

The authority issuer, WeakMap, token, private driver wrapper and installed loaders
are not exported. Only the injected runner is a runtime export of the CLI module.
Authority is an internally created frozen object, registered by object identity;
caller strings, flags, lookalike objects and exported factory calls cannot mint it.

A grant is issued only after the unchanged B2 adapter returns its successful,
read-only, closed receipt. It binds the admitted environment, copied approved
migration and the invocation's single AbortSignal through a private assertion
closure. Its allocation budget is one pool, one physical socket and one Prisma
client. The pool wrapper independently requires inspect-only options before its
constructor. Installed configuration is allowlisted, with no spread of arbitrary
configuration: approved target, explicit password, ssl false, pipeline false,
max 1, idle timeout zero, fixed application name, fixed deadlines, read-only
startup and fixed search path. The zero idle timeout prevents intentional idle
eviction from silently replacing the physical client during this exercise.

The exact returned pool must be passed to Prisma. Its guarded stream/onConnect
callbacks reject after revocation, interruption, reuse or unexpected reconnection.
The budget is not reset for a second allocation. Completion, failure or interruption
revokes the grant. Retained callbacks cannot revive it. A pool returned while
cancellation races its constructor remains owned by the connector so it can be
closed rather than lost before shutdown.

The private Prisma facade projects only bound connect, disconnect and transaction
methods to the existing connector. It never reaches the caller. Necessary owned
rollback and disconnection remain possible after revocation; cancellation does
not turn resource closure into a forbidden operation.

The exported `installedFixtureDriver()` remains unconditionally disabled for
both inspect-only and fixture-cycle modes, including forged/missing authority
arguments. The new narrow `inspectFixtureDatabase()` also requires injection;
it hardcodes inspect-only and returns only a frozen `{ outcome, readOnly, closed }`
receipt. It exposes no pg/Prisma object, SQL callback, transaction callback,
model delegate, cycle, finalizer or cleanup method.

These boundaries constrain the harness's installed composition. Injected test
ports are trusted code, not a sandbox against arbitrary JavaScript that imports
pg and constructs its own connection outside the harness.

## Future invocation sequence and read-only evidence

1. Reject arguments and unsafe environment; read/copy/check approved migration.
2. Lazily load B2 constructor ports and call the unchanged read-only adapter.
3. Await B2 inspection, explicit confirmed rollback and confirmed closure.
4. Revalidate environment/interruption; issue the private inspect-only grant.
5. Lazily load Prisma constructor ports under that grant.
6. Open the existing fixture connector in inspect-only mode. Its **initial**
   inspection runs exactly once; no extra `inspect()` call is made.
7. Confirm rollback, disconnect Prisma, end the owned pool and confirm socket
   closure. Reject any review latch or interruption, including during closure.
8. Revalidate/revoke authority, remove signal handlers, and emit a fixed receipt.

B2 continues to use its exact REPEATABLE READ READ ONLY transaction, fixed catalog
queries and corrected rollback-dispatch state machine. Its SQL and implementation
were not edited. The Prisma connector continues to require startup
`default_transaction_read_only=on`, RepeatableRead interactive transaction,
explicit `SET TRANSACTION READ ONLY`, effective settings, PostgreSQL 17 identity,
quiet-database checks, approved migration/history/schema and backend rechecks.

Installed-source inspection confirms pg uses the supplied stream for protocol
traffic, pg-pool awaits onConnect, and PrismaPg routes interactive transaction
queries through the checked-out external PoolClient. The installed composition
uses `PrismaPg` with the exact owned pool and `disposeExternalPool: false`; the
connector owns pool shutdown. Error hooks carry no raw errors to the reporter.
The existing installed-PrismaPg-over-fake-PoolClient regression remains intact.

Actual socket identity, peer address/port, client.connection.stream, query receiver,
pg processID and queried backend PID checks are unchanged. Max:1 alone is not the
binding proof. Socket endpoint evidence is not cryptographic container identity.

## Interruption, rollback, shutdown and reporting

One AbortController handles SIGINT/SIGTERM plus SIGBREAK on Windows. The first
signal latches interruption and revokes authority; duplicates cannot restart or
replay work. Handlers are tracked before registration and removed after settlement,
including partially successful registration. A removal failure prevents success.

Constructor-module loading has a five-second bound and can be interrupted without
allocating resources on late completion. Once an adapter is running, the command
does not race away from its promise: the adapter retains its bounded rollback and
closure ownership. Existing B2 20-second overall/two-second shutdown and fixture
five-second connection/60-second operation/two-second closure bounds are retained.

The fixture connector's sentinel rollback recognition and observed ROLLBACK
command are unchanged. Review or abort during closure prevents a passed receipt
even if the socket subsequently closes. Throwing destruction remains nonthrowing,
deadline settlement stays sanitized, late completion cannot become success, and
destruction is not proof of database cancellation or explicit rollback.

Reporting uses only the fixed APPLYFLOW_FIXTURE_INSPECTION prefix and allowlisted
codes PASSED, ARGUMENTS, ADMISSION, MIGRATION, B2_FAILED, PRISMA_FAILED, TIMEOUT,
INTERRUPTED and UNEXPECTED. There are no raw error/stack/result dumps, connection
strings, credentials, authentication values, journals or IPC diagnostics. Success
returns 0; interruption returns 130 (INT/SIGBREAK) or 143 (TERM); other failure
returns 1. Reporter failure returns 1 without raw fallback output.

## Deterministic regression evidence

There are **75 added cases**: 72 in the new CLI test file and three wrapper cases
in fixture-database.test.ts. Discovery cases were adapted for the approved command
activation without removing the installed-constructor tripwires or other gates.

Coverage includes invalid args/environment before construction; diagnostic and
inherited overrides; migration mismatch; environment changes between phases;
B2 rollback/closure/peer/interruption failures; ordering before Prisma allocation;
one initial Prisma transaction/rollback and only safe receipt fields; socket,
stream, PID, identity, receiver, replacement-client and reconnect rejection;
read-only/isolation/history/schema failures; closure failures; cancellation during
loading, connection, inspection, rollback and closure; duplicate signals; retained
callbacks after revocation/completion; independently budgeted invocations; missing
or forged public activation attempts; throwing destruction at connection,
operation and shutdown deadlines; late success/rejection; partial signal
registration; reporter/privacy failures; and inert imports under spoofed argv.

The direct-entry block is additionally evaluated in an injected AsyncFunction with
fake process/loading/output ports. It checks native-main selection, initial failure
status, real-runner argument rejection and outer exception sanitization. This is
source-block fault injection, **not** an actual Node/tsx CLI invocation or OS
process/signal test. Ordinary module imports are separately tested under real
JavaScript-level constructor/connect tripwires. Those tripwires are not OS isolation.

Development failures were corrected without changing accepted security assertions:

- First focused run: 122 passed/23 failed. The new B2 fake incorrectly returned
  SELECT for BEGIN, preventing later-phase cases from being reached. Corrected
  the fake to match the actual driver's BEGIN command tag; all 58 then-current
  CLI cases passed on rerun.
- Expanded focused run: 157 passed/one failed. A cancellation assertion incorrectly
  expected no B2 client during Prisma loading, even though B2 must already have
  completed. It now asserts exactly one closed B2 client in that phase and zero
  before B2 loading. The next focused run passed 159/159 across three files.
- First lint: exit 1 for one redundant outcome initializer. Removed that unused
  initializer; exhaustive success/catch assignment and initial CLI exit status 1
  remain. Lint rerun passed. No suppression, timeout increase or guard weakening.

## Verification commands and actual results

Commands ran sequentially, with each process awaited before the next verification
command. No inspection/preflight/integration/fixture command was executed.

| Command | Result |
| --- | --- |
| Focused `npm.cmd exec -- vitest run --project unit tests/e2e/support/fixture-preflight.test.ts tests/e2e/support/fixture-database.test.ts tests/e2e/support/discovery.test.ts` | Final focused run exit 0; 159 passed, three files. Subsequent entry-block additions were exercised by both full suites below. |
| `npm.cmd exec -- tsc --noEmit -p tsconfig.e2e.json` | Exit 0 during development. |
| `npm.cmd run test:e2e:list` | Exit 0; one disabled-runtime sentinel listed, none executed. |
| `npm.cmd run test:e2e:offline` | Exit 0; **685 passed**, 21 files. |
| `npm.cmd run lint` | Initial exit 1 described above; corrected rerun exit 0, no warnings. |
| `npm.cmd run typecheck` | Exit 0; contracts/workspaces/root/E2E checks. |
| `npm.cmd test` | Exit 0; **1,129 passed**, 40 files. |
| `npm.cmd run build` | Exit 0; contracts/API/web, 216 Vite modules. |
| `node --import tsx --input-type=module -e "console.log(JSON.stringify({node:process.version,nativeMain:import.meta.main}))"` | Exit 0; Node v24.22.0, nativeMain true. Harmless inline entry metadata only. |
| `git diff --check` | Exit 0; LF/CRLF conversion advisories only. |
| `git status --short --untracked-files=all` | Four modified tracked files and two untracked additions; nothing staged. |

The existing scripts regenerate ignored Prisma 7.10.1 client/build output. They do
not apply migrations or perform a live database verification. The 1,129 tests
include the accepted baseline plus 75 added cases; no PostgreSQL integration suite
was run. Whitespace and Git inventory checks were performed after report creation.

## Remaining limitations and C1C boundary

No new live evidence exists. Real Prisma callback-error identity/rollback delivery,
server-enforced read-only settings, physical backend/socket binding, quiet-database
admission, pg/Prisma closure ordering, real cancellation/timeout settlement and
Windows Node/tsx/process-signal behavior require separately authorized C1C work.
The native-main source-block test does not attest a real Windows invocation.
The existing structural catalog fingerprint is unchanged and is not an exhaustive
audit of privileges, every function/extension, or all PostgreSQL behavior.

No writes, lock/cascade behavior, fixture ownership, interrupted-run recovery,
filesystem crash durability, browser authentication or production readiness are
proven by these fakes. C1C, if separately approved, permits only sequential read-only
inspections against an already-running, quiet approved test service. It does not
authorize fixture creation or cleanup.

Fixture-cycle, direct child, general E2E/browser/smoke and cleanup gates remain
disabled. Public installedFixtureDriver remains closed in both modes. B2 adapter,
rollback logic, product authentication, child/process/finalization/cleanup,
database guards, schema/migrations, CI, browser scenarios and dependencies were
not modified.

Final Git inventory: branch/HEAD unchanged, four modified tracked files and the
two additions listed above; nothing staged or committed. No reset/revert/stash,
dependency install, live PostgreSQL connection, B2 preflight, fixture inspection,
fixture creation/deletion/cleanup, integration run, Docker/service operation,
application-service launch, browser, migration, commit/push/merge or deployment
occurred. C1B stops pending the separate read-only safety audit; C1C has not begun.

## Focused late-resource-error correction - 2026-10-22

This section supersedes the earlier failure-observation description and test
counts. The original C1B implementation was audited as NOT READY because an
owned-resource failure could be followed by a successful CLI report. This narrow
offline correction is complete and awaits a separate read-only re-audit. It does
not approve the Git checkpoint or authorize C1C execution.

### Baseline and files edited in this correction

At entry, independently confirmed branch `feat/authentication`, HEAD
`ef96258760383ed28dbb288a20ad8694a41220cc`, four modified tracked files, two
untracked files, and nothing staged. Existing C1B work was preserved.

Only five existing working-tree files were edited in this pass:

- `tests/e2e/support/fixture-preflight.ts`
- `tests/e2e/support/fixture-preflight.test.ts`
- `tests/e2e/support/fixture-database.ts`
- `tests/e2e/support/fixture-database.test.ts`
- `docs/milestones/checkpoint-2c3b3c1b-offline-report.md`

No additional files were created. The pre-existing C1B modification to
`tests/e2e/support/discovery.test.ts` was retained without further edits.
Consequently, the complete C1B inventory remains the same six files listed above:
four modified tracked files and the untracked CLI test/report files.

### Reproduction and root cause

Before modifying implementation, added the two exact audited regressions. After
successful fake pool end, each schedules the error through six nested microtasks,
matching the audit's receipt-to-reporting ordering. All ten pool runs and all ten
socket runs returned **0**, confirming the defect. The targeted run failed both
tests with ten unexpected zero results each; 72 unrelated cases were filtered out.

`inspectFixtureDatabase()` had checked a local review flag and then returned a
frozen receipt. Later errors still latched that flag, but the CLI did not observe
it. Its final private-authority check covered environment, migration and abort,
not the connector's late resource failure. Moreover, installed PrismaPg removes
its external-pool error listener on disconnect when disposeExternalPool is false,
so that adapter hook cannot be the sole observer during subsequent shutdown and
reporting.

### Actual correction and monotonic failure signal

The CLI now owns one private `resourceFailed` latch. It only transitions from false
to true and immediately revokes construction authority. It stores no error object,
message, stack, URL, query result or authentication material.

Two sources share this same latch:

1. CLI-owned pool/socket error listeners, installed when each owned resource is
   returned. These are independent of PrismaPg's disposal-sensitive listeners.
2. An additive optional `onFailure()` argument to the injected narrow inspection
   wrapper. Existing connector review calls forward to it, including a review
   arriving after the frozen receipt was created. It receives no error payload.

The callback defaults to a no-op for existing injected callers. The wrapper still
rejects its own reviewed/interrupted completion and returns only its original
three frozen receipt fields. This is not a product or authentication contract
change, authority issuer, raw driver export, or write-capable interface.

The private authority assertion now also checks the failure latch. The command
checks it again after asynchronous inspection continuation and immediately before
reporting, independently of the earlier receipt and normal authority revocation.
Multiple errors, later successful callbacks or completed shutdown cannot clear it.
Resource failure reports fixed PRISMA_FAILED with exit 1; latched user interruption
has priority and retains exit 130/143.

Listener registration is tracked before on() and a registration exception marks
failure without throwing away ownership of the returned pool/socket. Necessary
rollback, Prisma disconnection and pool/socket closure remain permitted after
revocation. Nothing aborts or races away from the active adapter shutdown promise,
retries a rollback, reconnects, or adds SQL.

### Observation lifetime and exact finite completion boundary

The CLI's additional error observers remain attached through inspection, explicit
rollback confirmation, Prisma disconnection, pool end, socket closure, frozen
receipt creation, and the caller's receipt continuation. They are not removed by
PrismaPg disposal.

After receiving and validating the closed receipt, the CLI records closure
separately from health. Even if a late error then invalidates health, confirmed
closure permits removal of the CLI's additional observers. Removal occurs only
after awaited work has settled. Signal handlers remain installed throughout that
observer teardown and are removed afterward. Registration/removal failures and
errors delivered synchronously during teardown prevent success. Existing
connector error sinks remain; this pass does not remove or redesign them.

The **finite positive-completion boundary** is the final synchronous failure/abort
check immediately before calling the fixed synchronous reporter, after confirmed
rollback/resource closure, revoked allocation authority, and handler/observer
teardown. There is no await between this check, reporting and the returned status.
Under the owned-resource closure contracts, no protocol operation or usable
transport remains and private callbacks cannot allocate replacement resources.
Orderly end/close events alone do not mark failure; error events do.

This is a point-in-time guarantee. It does not claim every arbitrarily delayed
synthetic or buggy post-close event has been drained, nor that future events after
reporting begins can retract already reported success. No arbitrary grace sleep
or unbounded event-draining loop was added. Existing passive sinks may still
handle such synthetic events; their presence is not an indefinite success guard.
Actual pg/Prisma closure and native event ordering remain live-verification limits.

If the CLI does not receive a successful closed receipt, it conservatively retains
its sanitized observers on those resource objects. It does not infer settlement
from destruction or a timeout, or declare successful closure. These are
resource-local references, not a global registry or new background service.
Unconfirmed shutdown still reports failure and never triggers another operation.

### Regression evidence

Added **20 tests**: 17 CLI cases and three narrow-wrapper cases. Current focused
files contain 89 CLI tests, 50 fixture-database tests and 40 discovery tests.

- Both original late-error sequences run ten times each. The tests observe both
  frozen B2 and Prisma receipts before injecting the error, then assert event
  order `owned-error -> FAILED`, exit 1, and fixed PRISMA_FAILED output.
- Repeated pool/socket errors preserve failure and leak none of the injected URL,
  password, token, SQL-result or stack sentinels.
- SIGINT, SIGTERM and SIGBREAK at the same receipt boundary reject with the
  appropriate nonzero code. Duplicate interruption during observer teardown is
  also handled while signal listeners are still installed.
- Errors while rollback or closure is held pending retain observation, await
  settlement, accept no late success, and dispatch no duplicate rollback or retry.
- Normal shutdown retains observation through disposal/end and removes only the
  CLI's two additional listeners before PASSED. Expected close/end stays healthy.
- Errors after an observer is removed still reach the shared connector callback
  before the final check. Observer removal/partial registration exceptions fail
  safely and preserve ownership and sanitized output.
- Reporter failure returns 1 after owned observer teardown.
- Direct wrapper cases prove the shared callback can mark failure after its frozen
  receipt exists, and that a throwing callback cannot leak or grant completion.

Observed corrected results: **10/10 pool runs and 10/10 socket runs rejected with
exit 1 and no PASSED output**, while all earlier regressions remain passing.
These are injected fake-resource results, not observations of real PostgreSQL.

### Verification and development failures

One targeted typecheck initially failed TS2345 in a new test spy because its
pool/socket union produced incompatible return types. Narrowed the spy target to
their actual shared EventEmitter interface. No runtime guard, test assertion,
timeout, typecheck configuration or lint rule was weakened; the rerun passed.

After adding explicit receipt-observation assertions and the final teardown-signal
regression, the entire required sequence was rerun one command at a time. Earlier
intermediate runs passed 704/1,148 tests; the final counts below include all changes.

| Command | Final actual result |
| --- | --- |
| `npm.cmd exec -- vitest run --project unit tests/e2e/support/fixture-preflight.test.ts -t "audited late"` | Before implementation: exit 1, two failed/72 filtered; 20 erroneous zero results. After correction: exit 0, both selected tests passed. Final full runs also exercise the stronger receipt assertions. |
| `npm.cmd exec -- vitest run --project unit tests/e2e/support/fixture-preflight.test.ts tests/e2e/support/fixture-database.test.ts tests/e2e/support/discovery.test.ts` | Exit 0; **179 passed**, three files. |
| `npm.cmd exec -- tsc --noEmit -p tsconfig.e2e.json` | Initially exit 1 for the test-spy type error above; corrected rerun exit 0. |
| `npm.cmd run test:e2e:list` | Exit 0; one disabled-runtime sentinel listed, none executed. |
| `npm.cmd run test:e2e:offline` | Exit 0; **705 passed**, 21 files. |
| `npm.cmd run lint` | Exit 0; no errors or warnings. |
| `npm.cmd run typecheck` | Exit 0; all workspace/root/E2E checks. |
| `npm.cmd test` | Exit 0; **1,149 passed**, 40 files. |
| `npm.cmd run build` | Exit 0; contracts/API/web, 216 Vite modules. |
| `git diff --check` | Exit 0; LF/CRLF conversion advisories only. |
| `git status --short --untracked-files=all` | Same four modified tracked files/two untracked files; nothing staged. |

The standard verification scripts regenerated ignored Prisma 7.10.1/build output
only. No PostgreSQL integration suite, live preflight, fixture command or browser
suite was run. Whitespace and Git inventory checks were made after this update.

### Preserved boundaries, limitations and Git status

B2 read-only success and closure still precede private inspect-only authority and
Prisma construction. Only the existing initial Prisma inspection runs. Public
installedFixtureDriver remains disabled in both modes. Fixture-cycle, direct child,
cleanup, general E2E/smoke and browser gates remain closed. Inspection still returns
no raw client, transaction, user/session delegate or cleanup interface.

Read-only settings, fixed identity/catalog SQL, socket/PoolClient/backend binding,
reconnect rejection, migration digest/history/schema validation, corrected B2
rollback dispatch, bounded deadlines and nonthrowing destruction are unchanged.
Product authentication, environment/database guards, child/process lifecycle,
finalization, exact cleanup, Prisma schema/migrations, package scripts/lockfile,
dependencies, CI and browser scenarios were not modified. A protected-path diff
against HEAD confirmed those files unchanged.

Live PostgreSQL/Prisma rollback identity, server-enforced read-only behavior,
physical binding, closure/event ordering, cancellation settlement and Windows
process signals remain unverified. Mock assertions do not prove native shutdown
or PostgreSQL cancellation. The trusted injected-port boundary remains as already
documented; the CLI is not a sandbox for arbitrary caller-supplied JavaScript.

Final branch/HEAD remain `feat/authentication` / `ef96258`; same four modified
tracked and two untracked files, with nothing staged, committed or published.
No live database connection, B2 preflight, Prisma inspection command, fixture
creation/deletion/cleanup, Docker/service operation, application-service or browser
launch, integration run, migration/reset, dependency installation, staging,
commit/push/merge or deployment occurred. No existing work was discarded.

This correction stops for the requested focused read-only re-audit. C1C has not
begun and requires separate approval.

## Queued socket closure correction - 2026-10-22

### Baseline and reproduced failure

Branch `feat/authentication`, HEAD `ef96258760383ed28dbb288a20ad8694a41220cc`.
The existing four modified tracked files and two untracked files were preserved;
the staging area was empty. Node was `v24.22.0`. No work was reset or discarded.

Before changing implementation, two deterministic tests set the owned fake
socket's destroyed/closed flags, queued an error followed by close on
`process.nextTick`, and fulfilled fake pool shutdown. The connector issued a
successful receipt in **10/10** runs; the actual injected CLI runner returned
**0 in 10/10** runs. The regression command exited 1 with two failed tests and
139 filtered tests. This confirmed that the flags and fulfilled pool promise
were insufficient evidence that queued teardown notifications had been delivered.

### Narrow implementation change

`fixture-database.ts` now installs an owned socket `close` observer in the stream
factory immediately after allocation and error-listener installation, before
returning the stream to pg or starting asynchronous connection work. A monotonic
`closeObserved` flag and one private promise record actual event delivery. The
flag is never reset. Duplicate close, close with `hadError=true`, and close before
controlled shutdown latch the existing terminal failure callback.

The same existing **2,000 ms shared shutdown budget** covers confirmed Prisma
disconnect, confirmed pool end, and waiting for observed socket close. A true
`socket.closed` flag remains a consistency check; it cannot satisfy the event
requirement. No socket means no close event is required for that unallocated
resource. A missing event expires the budget and fails with fixed output.

Rollback confirmation remains independent and unchanged. Physical socket close
does not prove PostgreSQL rollback, cancellation or transaction settlement.
Queued errors before close reach the connector failure callback and CLI latch;
the wrapper refuses the receipt even after all shutdown steps settle. Confirmed
resource closure and healthy inspection remain distinct requirements.

The CLI's independent error observers, retained connector error sinks, monotonic
failure latch, capability revocation, final synchronous reporting checks and
sanitized outcome codes are unchanged. Its completion-boundary comment now
explicitly names observed socket close. No new public interface was added.
The connector close observer is retained with its existing error sinks; there is
no new close-listener removal operation that could discard pending evidence.

On timeout, best-effort destruction stays nonthrowing and idempotent. A late
close may resolve the private observation promise but cannot change the rejected
shared close promise or restore success. There are no sleeps, scheduling-based
success assumptions, retries, reconnects, additional connections or SQL changes.

### Changed-file inventory for this correction

- `tests/e2e/support/fixture-database.ts`: observed-close tracking and bounded wait.
- `tests/e2e/support/fixture-database.test.ts`: connector regressions and accurate
  fake close-event delivery.
- `tests/e2e/support/fixture-preflight.test.ts`: injected runner regressions and
  accurate fake close-event delivery.
- `tests/e2e/support/fixture-preflight.ts`: completion-boundary comment only.
- This milestone report: appended correction evidence; historical sections kept.

The pre-existing `discovery.test.ts` working-tree modification was not edited in
this correction. Both default socket fakes now emit one orderly close from their
idempotent destroy method. The normal-shutdown test no longer emits a second
artificial close. Existing throwing-destruction tests advance through the
additional already-approved shutdown budget when no close is observed; security
assertions and deadlines were not weakened.

### Deterministic regressions and development failures

Added **21 test cases**, using injected resources only:

- Original queued error-before-close reproduction, ten iterations each at the
  connector receipt and actual CLI runner. After correction: **10/10 rejected
  receipts and 10/10 exit-1 failures**, with error/close preceding failure output.
- Fulfilled pool end and true closed flag with close still pending: no receipt
  until event delivery. Close before pool end: no receipt until pool end fulfills.
- Queued orderly close without error: PASSED only after close is observed.
- Missing close: no success before the deadline, bounded failure at expiry,
  including throwing destruction and late close/error callbacks.
- Abnormal `hadError`, duplicate close, premature close and inconsistent flags.
- SIGINT, SIGTERM and SIGBREAK while waiting for close, repeated interruption,
  retained independent error observation, and one rollback/pool shutdown.
- Close-listener registration failures before and after attachment, with fixed
  sanitized output and no premature success.

Earlier pool/socket receipt-boundary regressions (ten iterations each), listener
removal faults, reporter faults, incomplete rollback, read-only checks and
physical-binding tests remain passing.

One preliminary regex-filter command failed at Windows command argument parsing
(exit 1, no tests executed); the safe filter below was used instead. During test
development, one assertion initially checked an unconnected fake review spy;
the test was corrected to supply that spy to the actual failure hook. Typecheck
then reported TS2339 for `this.emit` in the two fake socket helpers. Explicit
EventEmitter receiver types fixed those errors without changing compiler rules
or assertions. Verification was restarted sequentially after the typing fix.

### Executed verification

| Command | Actual result |
| --- | --- |
| `npm.cmd exec -- vitest run --project unit tests/e2e/support/fixture-database.test.ts tests/e2e/support/fixture-preflight.test.ts -t "error-before-close ordering"` | Before implementation: exit 1, two failed/139 filtered; ten premature receipts and ten erroneous zero exits. After implementation: exit 0, both passed/139 filtered. |
| `npm.cmd exec -- vitest run --project unit tests/e2e/support/fixture-database.test.ts tests/e2e/support/fixture-preflight.test.ts` | Exit 0; **160 passed**, two files. |
| `npm.cmd run test:e2e:list` | Exit 0; one sentinel test listed, none executed; no browser/server/database startup. |
| `npm.cmd run test:e2e:offline` | Exit 0; **726 passed**, 21 files. |
| `npm.cmd run lint` | Exit 0; no warnings/errors. |
| `npm.cmd run typecheck` | Final exit 0; workspace, root and E2E type checks passed. |
| `npm.cmd test` | Exit 0; **1,170 passed**, 40 files. No PostgreSQL integration configuration invoked. |
| `npm.cmd run build` | Exit 0; contracts, API and Vite production frontend built. |
| `git diff --check` | Exit 0; no whitespace errors; existing LF/CRLF advisories only. |
| `git status --short --untracked-files=all` | Same four modified tracked and two untracked files; nothing staged. |

The prescribed typecheck/test/build scripts generated the ignored Prisma client
locally. Client generation did not connect to PostgreSQL or run migrations.

### Preserved gates, scope and limitations

B2 confirmed rollback/closure still precedes Prisma construction. The public
`installedFixtureDriver()` remains hard-disabled in both modes. The private
installed path is inspect-only; no mutation delegate, SQL callback, finalizer or
cleanup interface is added. Fixture-cycle, direct child, cleanup, general E2E and
browser execution remain disabled. Read-only settings, socket/client/backend
checks, schema/migration validation and exact cleanup predicates are unchanged.

A protected-path diff against HEAD was empty for product code, CI, root package
manifest/lockfile, B2 adapters, environment/execution guards, cleanup/finalization
and child/process modules. The only working-tree files remain the original six.
No existing documentation was removed.

These tests demonstrate the state machine using injected pg/Prisma/socket ports.
They do not prove actual PostgreSQL rollback/cancellation, Prisma transaction
settlement, native socket or pool shutdown, Docker identity, Windows signals or
real-process behavior. The finite success boundary now requires observed close
and confirmed owned shutdown, then observer/handler teardown and the final
synchronous failure/abort check. Arbitrary synthetic events on closed objects
after reporting begins remain outside that boundary.

No PostgreSQL connection or read, live B2 preflight, fixture inspection/cycle,
fixture write/deletion/cleanup, service/Docker operation, browser launch, live
integration run, migration/reset, dependency installation, staging, commit,
push, merge or deployment occurred. C1C has not begun. This correction stops for
the requested independent read-only re-audit.
