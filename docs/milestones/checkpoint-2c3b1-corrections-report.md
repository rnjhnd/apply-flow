# Stage 2C.3B1 — Targeted safety corrections

## Baseline and scope

Branch: `feat/authentication`. HEAD:
`f62e4942e0158ef4c2f30622d769e0c0c4d97fd5`.
The audited B1 working tree was preserved (two tracked modifications and 22 new
files at entry). No reset, stash, revert, dependency installation, or publication
occurred. This report supersedes the six corrected safety claims in the original
B1 implementation report; that report remains as historical evidence.

## Root causes and corrections

### 1. Connected identity could be overwritten by endpoint context

`inspectCatalog()` spread the caller's endpoint object over the queried identity.
TypeScript structural typing allowed extra database/user fields to replace the
actual results. It now validates and captures canonical host/port before querying,
strips all other endpoint fields, validates the queried identity independently,
and explicitly constructs a frozen four-field identity. Malformed endpoint fields
reject before queries; malformed/extended queried identity rejects without logging
its contents. Conflicting database/user properties in an extended endpoint cannot
replace actual queried values. Independently binding endpoint evidence to the
actual live connection remains required in B2; no mock proves a network peer.

### 2. Pending finalization could leave review-required

The old continuation checked evidence after resolution but not its current phase,
then directly assigned cleanup eligibility. A monotonic operation generation now
invalidates pending work when review is latched. Expected phase, generation, lease,
ledger and ownership digest are checked around awaited resolution, before and
after ownership appends, before terminal sealing, around validated eligibility
transitions, and immediately before permit issuance. Review is terminal and
duplicate review calls are idempotent. Errors after observed exit also invalidate
pending work rather than being ignored as channel closure.

Each controlled parent ownership append advances the expected sequence/digest
only after verifying the resulting journal. No stopped journal is reopened.
Ledger writes guard against reentrancy: review requested inside an injected I/O
operation latches immediately and is persisted after that operation settles,
without duplicate append sequence numbers or stale phase restoration.

An evidence write already handed to its adapter cannot be recalled. If review
races inside an append/fsync operation, that write may have completed before
the final review entry. Such evidence remains review-only, with no cleanup permit
and no automatic recovery. A failed/partial durable write is retained rather than
rewritten or silently salvaged.

### 3. Cleanup continued after authority loss

The old permit check surrounded the entire cleanup operation, so deletions could
commit before a final authorization check noticed review. A permit now supplies
an `assertLive` callback bound to its phase, generation and evidence. Cleanup
checks it after lock acquisition, before and after each deletion, before completing
its callback, after the transaction, and around post-commit verification.

The guarded transaction's additive optional authority assertion is checked during
setup/inspection, before product work, after work, and after the final inspection
before returning the callback. Its existing admission predicate is rechecked too.
Callback rejection still propagates unchanged through the injected host; nothing
automatically replays a transaction. The original transaction object and result
identity are preserved for admitted operations.

The host owns COMMIT. If authority changes after the callback finishes or while
commit confirmation is pending, a later check cannot cancel or undo that commit.
The wrapper reports a sanitized `AmbiguousCommitError` on an otherwise successful
host result after admission loss. Host/callback rejections retain their original
error identity. Cleanup latches review, retains ownership/evidence, does not claim
`cleaned`, and performs neither automatic retry nor automatic reconciliation in
this ambiguous path. Separately approved read-only reconciliation is required.

Exact token-hash/null-safe user predicates, canonical UUID AND exact email matching,
unrecorded-related-session blockers, RETURNING validation, lock order and empty-set
behavior are unchanged. Mock rollback checks demonstrate callback control flow;
they do not establish PostgreSQL cancellation or actual rollback settlement.

### 4. Additional owner properties entered evidence

UUID validation alone did not remove additional fields before object spreads.
The shared `canonicalOwner()` helper now validates both IDs, strips every other
property, and constructs an immutable two-field snapshot. Malformed IDs reject
with a fixed error before I/O, IPC or spawn. Unknown context properties are
intentionally discarded, never serialized or used as evidence.

Journals/readers, leases, fixed-path evidence adapters, finalizers, parent
composition, child recorders and parent intent clients use canonical snapshots.
Persistent entries and IPC messages explicitly list run/test IDs instead of
spreading input owner/context objects. Later mutations of the caller's original
object cannot alter captured identity or file paths. Existing strict ownership
event/journal validation is preserved.

### 5. Graceful channel closure was treated as an unsafe exit

The parent now accepts an exact run/test-bound `channel-closing` control message
only after a validated seal. This records an in-memory expectation of controlled
closure, not exit or database settlement. Repeated controlled disconnects remain
pending in `child-sealed`; only parent-observed normal exit can advance them.

Missing/mismatched seal, premature or unexplained disconnect, malformed/wrong-owner
control messages, process error, escalation, signal termination and incomplete
quiescence remain review-required. Existing negative disconnect assertions were
kept; positive tests explicitly establish the additional controlled-closure intent.
Immediate readiness/health closure, shared shutdown promises and the pre-kill
exit check are preserved. The later live child adapter must flush its seal and
closure-intent messages before deliberately closing IPC. No real process was run.

### 6. Read-only authentication delegate exposed writes at runtime

The TypeScript Pick did not remove write methods from `client.user` at runtime.
The adapter now exposes a frozen object containing only bound `findUnique`.
Arguments, method receiver, returned promise/result and rejection are forwarded
without changing product authentication code. Create/update/delete/upsert methods
are absent. Mutation paths continue through the guarded transaction adapter.

## Exact files changed by this correction pass

Support implementation:

- `tests/e2e/support/catalog.ts`
- `tests/e2e/support/guarded-database.ts`
- `tests/e2e/support/finalization.ts`
- `tests/e2e/support/cleanup.ts`
- `tests/e2e/support/ownership.ts`
- `tests/e2e/support/journal.ts`
- `tests/e2e/support/safety-io.ts`
- `tests/e2e/support/evidence-files.ts`
- `tests/e2e/support/child-protocol.ts`
- `tests/e2e/support/intent-client.ts`
- `tests/e2e/support/composition.ts`

Updated tests:

- `tests/e2e/support/guarded-database.test.ts`
- `tests/e2e/support/finalization.test.ts`
- `tests/e2e/support/cleanup.test.ts`
- `tests/e2e/support/evidence-files.test.ts`
- `tests/e2e/support/child-protocol.test.ts`

New tests: `tests/e2e/support/owner-projection.test.ts`.
New documentation: `docs/milestones/checkpoint-2c3b1-corrections-report.md`.
Other previously uncommitted B1 files remain present and were not discarded.

## Regression evidence and verification

The 45 added deterministic cases cover conflicting/extended endpoint metadata,
malformed endpoints, captured endpoint identity, read-only method surface and
forwarding, admission loss during all three inspections/callback completion,
commit-window invalidation, pending resolver success/failure after review,
duplicate finalizers/review requests, review around ownership/terminal/ledger/
permit operations, immutable owner projection across evidence and IPC, malformed
IDs before side effects, controlled closure versus premature/invalid closure,
and cleanup invalidation during locks, between deletions, before callback
completion, during commit confirmation and during post-commit verification.

Development offline checks passed at 269 existing cases and then 314 cases with
the regressions added. A focused E2E TypeScript check caught nullable seal typing;
an explicit verified terminal seal fixed it and the check passed. No assertion
was weakened. All required final checks ran sequentially, awaiting completion:

| Command | Actual result |
| --- | --- |
| `npm.cmd run test:e2e:list` | Exit 0; one disabled-runtime sentinel listed in one file, no browser test executed |
| `npm.cmd run test:e2e:offline` | Exit 0; **314 passed**, 14 files |
| `npm.cmd run lint` | Exit 0; no errors or warnings |
| `npm.cmd run typecheck` | Exit 0; contracts/API/web, root and E2E setup |
| `npm.cmd test` | Exit 0; **758 passed**, 33 files |
| `npm.cmd run build` | Exit 0; contracts/API/web; 216 Vite modules transformed |
| `git diff --check` | Exit 0; no whitespace errors, LF/CRLF advisories only |
| `git status --short --untracked-files=all` | Exit 0; three tracked modifications and 24 untracked files, including preserved B1 work |

Added cases by test file: guarded database 13, finalization 14, cleanup seven,
owner projection five, evidence files one, child protocol five: **45 total**.
The accepted 713 tests remain included in the 758 result; the prior 269 offline
tests remain included in 314. No existing regression assertion was removed or
relaxed, including the tests rejecting unexplained disconnect after a seal.

## Remaining B2/B3 and operational limitations

- B2 remains disabled and needs separate approval for read-only PostgreSQL
  preflight. A real connector must bind host/port to actual connection evidence,
  use the dedicated test target without environment fallback, and verify the
  catalog/migration rendering against the pinned SQL. No live adapter was invoked.
- Fixture mutations, real cleanup, child authentication servers and browser
  scenarios require later separate approval. Live composition must acquire the
  run lease, use the guarded authentication database, recording token factory,
  tracked service wrapper and controlled IPC shutdown protocol.
- An admission predicate for already accepted work must describe its authority
  through settlement; ordinary quiescence separately blocks new service requests.
  Review invalidates both pending finalization and cleanup authority permanently.
- Real transaction commit/rollback, timeout/cancellation, FK locking/cascades,
  deadlocks and relationship races remain unproved. The quiet test-database
  assumption and existing bounded test-only transaction settings remain.
- Neither generation checks nor mocks can cancel an SQL command already accepted
  by PostgreSQL, undo an already dispatched commit, or prove its final outcome.
  Ambiguous outcomes retain evidence and require explicit reconciliation.
- Filesystem tests use mocked fs. OS crash durability, directory metadata fsync,
  external file tampering/conditional unlink and actual child event order remain
  unverified. No abandoned-run cleanup or terminal journal reopening exists.
- Existing product timeout and browser/Web Lock limitations, HTTPS cookies and
  real-browser accessibility/session behavior are unchanged and unverified here.

## Scope and Git

All live gates remain disabled. No PostgreSQL connection/read/write/cleanup,
integration suite, real authentication server, Chromium launch, live browser test,
migration/reset/schema change, new dependency, product authentication/policy
change, existing database-guard change, CI change, commit, push, merge or deployment
occurred. Required unit/HTTP tests use existing isolated mocked services, not the
normal application runtime or a database-backed authentication server. Existing
Prisma generation/build scripts produce offline artifacts only.

The protected-path diff was empty for `apps/api`, `apps/web`, `packages`, `.github`,
root manifests/lockfile and Playwright/Vitest configuration. No existing database
guard, Prisma schema or migration history file changed. The approved migration
file SHA-256 remains
`98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840`.
No live database identity/history or development/test data was queried.

All 24 untracked files additionally passed scope and trailing-whitespace checks;
ordinary `git diff --check` does not inspect their contents. Diff/status were
checked again after finishing this report. Branch and HEAD remain unchanged.
The full working tree contains 27 pending files (three tracked modifications and
24 untracked files), combining the original B1 work with these corrections. The
18 files listed above were changed/added in this correction pass. No commit or
push was made. Stage 2C.3B2 has not begun.
