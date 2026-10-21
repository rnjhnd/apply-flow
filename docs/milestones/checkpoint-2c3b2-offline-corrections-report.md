# Stage 2C.3B2 Gate A — Targeted rollback-dispatch correction

## Baseline and scope

Branch remains `feat/authentication`, HEAD
`a074958fc7e5fe542151d5c585c1c00001ddfcef`.
At entry, the audited Gate A implementation had three modified tracked files and
five untracked files. That work was preserved without reset, revert, stash or
replacement. The original Gate A report remains historical evidence; this report
supersedes its rollback/cancellation descriptions and verification counts.

Only these files were changed or added by this correction pass:

- `tests/e2e/support/read-only-database.ts`
- `tests/e2e/support/read-only-database.test.ts`
- `docs/milestones/checkpoint-2c3b2-offline-corrections-report.md`

No query strings, catalog expectations, environment/database guards, dependencies,
product files, schema, migrations, CI or execution gates changed.

## Root cause and internal state correction

The normal path set `rollbackAttempted` before calling the adapter's guarded query
helper. A connection error, cancellation, admission failure or peer failure could
then reject that helper before the underlying driver method was invoked. Cleanup
mistook that request for a dispatched rollback and skipped its own attempt.

Rollback now tracks three independent facts internally:

| State | Meaning |
| --- | --- |
| `requested` | The normal or cleanup path requested the fixed ROLLBACK operation; guards may still prevent handoff. |
| `dispatched` | The underlying driver query method was invoked. A synchronous invocation exception counts conservatively as handoff. |
| `outcome` | Unconfirmed until observed confirmation, or failed after an observed rejection/invalid result. Neither implies retry permission. |

The private `dispatch()` helper records driver handoff in a finally block around
the actual method invocation. Admission/peer checks execute outside that block.
Method lookup/type validation also occurs before it. A synchronous driver throw
therefore records a handoff, while an adapter guard rejection does not. BEGIN
dispatch is tracked at the same boundary instead of before adapter checks.
The helper rejects a second rollback dispatch. No public API or arbitrary SQL
surface was introduced; all call sites retain the existing fixed SQL vocabulary.

If BEGIN reached the driver but rollback did not, bounded cleanup can dispatch
only the fixed ROLLBACK directly. It bypasses failed application admission solely
to end the already-owned transaction, while retaining transport checks before
and after the operation. It requires the same protocol socket, the approved
actual peer, and an undestroyed/open transport without an observed client end.
It never reconnects or selects an alternate target.

Failure remains latched. Even if cleanup receives a rollback confirmation, an
earlier connection, admission, cancellation or peer failure still rejects the
preflight. Neither cleanup nor a late response restores success.

## Cancellation, unavailable transport and ambiguous outcomes

AbortSignal cancellation immediately latches failure and stops the normal read
continuation. It now gives bounded cleanup the opportunity to request rollback
before end()/the shutdown deadline destroys the still-usable owned transport.
An outstanding read may cause a real driver's rollback to queue; this is not
claimed as PostgreSQL cancellation or settlement.

The 20-second overall timer is unchanged and still destroys the owned socket
when it expires. Shutdown retains its shared two-second budget. Other existing
connection/server timeout settings are unchanged. No mutation retry, fallback or
reconnect was added.

Explicit rollback cannot be dispatched when the socket is destroyed/closed,
the stream is swapped, the peer remains invalid, or client end was observed.
Those cases fail closed and close the owned connection rather than sending SQL
through an untrusted/unusable transport. If a client error leaves owned transport
evidence intact, cleanup attempts dispatch; the real driver may reject it because
its own connection state is unusable. That is an attempted handoff, not a promise
that PostgreSQL received or completed the command.

A rollback already handed to the driver is never dispatched again, including
after synchronous throws, rejected promises, connection failures, wrong command
confirmation or timeouts. An unconfirmed result remains insufficient for success.
Late completion cannot resume inspection or change the completed operation's
failure. Socket closure alone never sets rollback confirmation.

Success still requires completed inspection, a requested and dispatched rollback
with observed ROLLBACK confirmation, confirmed closure, and no latched failure.

## Deterministic regression evidence

Added **15 injected-only tests**. Before the implementation correction, eight
new cases failed with zero driver rollback calls; all prior adapter cases passed.
After the correction, all 124 adapter/catalog tests pass without weakening any
existing assertion.

New coverage includes:

- The audit's four microtask orderings (depths 2, 3, 4 and 5): BEGIN dispatched,
  final catalog result completed, connection error before normal rollback
  handoff; exactly one cleanup rollback and a failed preflight.
- AbortSignal cancellation at that same boundary, with one rollback attempt.
- Lost environment admission and temporarily unavailable peer evidence before
  normal handoff; only fixed cleanup rollback is dispatched when transport can
  be validated.
- Destroyed, swapped, wrong-peer and ended connections: zero rollback calls on
  unusable transport, failed preflight and connection shutdown.
- A rollback already handed to the driver followed by connection error and late
  confirmation: one dispatch, no further reads and no restored success.
- Synchronous driver throws in both normal and cleanup rollback paths: no retry
  and sanitized failure.
- A dispatched rollback left pending until the overall deadline, then completed
  late: no second dispatch, no resumed reads and no success.

Existing tests retain successful rollback/closure confirmation, asynchronous
rollback rejection, wrong command confirmation, stalled rollback/close, late
read completion after timeout, connection errors, guard/privacy validation and
disabled-gate/discovery coverage. Every fake uses in-memory EventEmitters and
injected methods; no actual pg client or socket was constructed by these tests.

## Actual verification results

The following commands ran sequentially, awaiting completion before proceeding:

| Command | Actual result |
| --- | --- |
| `npm.cmd run test:e2e:list` | Exit 0; one disabled-runtime sentinel listed in one file, none executed |
| `npm.cmd run test:e2e:offline` | Exit 0; **446 passed**, 16 files |
| `npm.cmd run lint` | Exit 0; no errors or warnings |
| `npm.cmd run typecheck` | Exit 0; all workspaces, root and E2E configuration |
| `npm.cmd test` | Exit 0; **890 passed**, 35 files |
| `npm.cmd run build` | Exit 0; contracts/API/web; 216 Vite modules transformed |
| `git diff --check` | Exit 0; no whitespace errors; existing LF/CRLF advisories only |
| `git status --short --untracked-files=all` | Exit 0; scoped pending files retained |

The prior 875 tests remain included in 890; the prior 431 offline cases remain
included in 446. Focused adapter tests, E2E TypeScript checking and lint also
passed before the final sequence. Apart from the intentional failing regression
run, no verification command failed during this correction pass.

Existing Prisma generation/build scripts produced offline artifacts only; they
did not connect or apply migrations. Final scope, migration-file hash, new-file
whitespace and Git status checks were performed after writing this report.

## Remaining Gate B requirements and limits

`test:e2e:preflight` remains disabled by the unchanged live-phase gate. The CLI
still needs separately reviewed signal wiring and runtime error reporting before
activation: its prepared call supplies no AbortSignal, and the current catch
deliberately reports only that execution is disabled. This correction does not
open that gate or complete that separate activation work.

Mocks verify dispatch ordering, request counts, bounded application control flow
and late-response rejection. They do not prove actual TCP peer evidence, PostgreSQL
read-only enforcement, server cancellation, rollback settlement, SQL/catalog
rendering or pg shutdown behavior. A driver invocation is not proof of a command
reaching the server. Those remain subject to explicit Gate B approval and live
read-only review. Fixture writes, cleanup, real Prisma write transactions,
authentication servers and browser execution remain later, separately approved work.

## Scope and Git confirmation

Final working tree has three modified tracked files and six untracked files,
including the preserved Gate A work and this new report. Branch and HEAD are
unchanged. The original Gate A report was not edited. Protected-path diffs remain
empty, and the approved migration SQL file SHA-256 remains
`98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840`.

No PostgreSQL connection/read/write/cleanup, integration suite, live preflight,
Docker/database startup, application runtime, browser launch, migration/reset,
dependency install, product authentication/database-guard change, CI change,
commit, push, merge or deployment occurred. The required full suite includes
existing isolated mocked Supertest HTTP unit tests, not a normal or database-backed
authentication server. Gate B and all later phases remain disabled and unstarted.
