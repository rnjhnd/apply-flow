# Stage 2C.3B1 — Offline harness implementation

## Baseline and scope

Resumed the interrupted drafts without discarding or replacing the accepted
Stage 2C.3A implementation. Branch is `feat/authentication`, HEAD is
`f62e4942e0158ef4c2f30622d769e0c0c4d97fd5`. The interrupted baseline had one
modified file (`journal.ts`) and seven new support drafts. The original clean
baseline and the recovery state were inspected before implementation resumed.

This stage implements injected infrastructure and deterministic tests only.
Live execution remains disabled in `run.ts`, `fixtures.ts`, and the new phase
gate. There is no approval environment variable or external base URL override.

## Exact files

Modified existing files:

- `tests/e2e/support/journal.ts`
- `tests/e2e/support/discovery.test.ts`

Added support modules (including completed interrupted drafts):

- `tests/e2e/support/schema.ts`
- `tests/e2e/support/catalog.ts`
- `tests/e2e/support/guarded-database.ts`
- `tests/e2e/support/safety-io.ts`
- `tests/e2e/support/evidence-files.ts`
- `tests/e2e/support/child-protocol.ts`
- `tests/e2e/support/intent-client.ts`
- `tests/e2e/support/child-runtime.ts`
- `tests/e2e/support/composition.ts`
- `tests/e2e/support/finalization.ts`
- `tests/e2e/support/cleanup.ts`
- `tests/e2e/support/execution.ts`
- `tests/e2e/support/b1-fakes.ts` (in-memory test fixtures only)

Added eight test files:

- `tests/e2e/support/guarded-database.test.ts`
- `tests/e2e/support/evidence-files.test.ts`
- `tests/e2e/support/child-protocol.test.ts`
- `tests/e2e/support/intent-client.test.ts`
- `tests/e2e/support/child-runtime.test.ts`
- `tests/e2e/support/finalization.test.ts`
- `tests/e2e/support/cleanup.test.ts`
- `tests/e2e/support/execution.test.ts`

Added this report: `docs/milestones/checkpoint-2c3b1-report.md`.
No dependencies, manifests, lockfiles, product code, database guards, schema,
migrations, CI, or normal production startup files changed.

## Database admission and Prisma 7.10.1 composition

Every connector and transaction host is explicitly injected. Modules do not
instantiate Prisma/pg clients or load environment files. The existing browser
environment guard is reused unchanged: explicit `NODE_ENV=test`, canonical
`127.0.0.1:5433/applyflow_test`, username `applyflow_test`, explicit
`TEST_DATABASE_URL`, no `DATABASE_URL` fallback, no inherited PG/runtime overrides.
The migration file must hash to
`98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840`.

Connected database/user and connector-reported endpoint are checked, together
with exactly one completed `0001_init_auth` row, matching checksum, one applied
step, no rollback, valid completion date, and no failure logs. Catalog inspection
checks public relation names, the twelve User/Session columns and defaults, six
indexes (including uniqueness, validity, method, predicates and expressions),
three constraints, user triggers and enabled/forced RLS. Comparison is pinned at
module initialization; catalog order is irrelevant and duplicates remain visible.
It is a structural fingerprint of these fields, not a universal attestation of
database functions, privileges, every index option, or the entire server.

The installed generated Prisma 7.10.1 interactive transaction signature supports
the callback, `maxWait`, `timeout`, and isolation options used here. Wrappers pass
the actual `Prisma.TransactionClient` to the original callback and preserve its
return identity and rejection. No nested transaction, mutation retry, query
rewriting, cookie delivery, or result substitution is introduced.

Each guarded transaction rechecks environment and migration bytes before entry,
uses explicit READ COMMITTED, `maxWait=3000ms`, `timeout=10000ms`, and establishes
transaction-local `lock_timeout=2000ms`, `statement_timeout=5000ms`,
`idle_in_transaction_session_timeout=10000ms`, and `search_path=public` through
`$queryRaw(Prisma.sql)`. `$executeRaw` acquires ROW SHARE table locks on User and
Session and a SHARE lock on migration history. The inspector runs before table
locks, after locks, and after the callback, before commit. Migration rows are
also inspected with FOR SHARE. Any mismatch rejects the transaction. The future
connector still needs a bounded connection timeout (planned 5000ms).

The authentication adapter retains the existing read-only user lookup delegate;
all existing authentication writes remain inside the guarded transaction
callback. Standalone anonymous session allocation is composed through its own
guarded transaction. The same cryptographic recording token factory is supplied
to authentication and bootstrap. No expiry-cleaner method is exposed by this
composition. Test registration requires an acknowledged exact email intent.
Existing product security policy and cookie-after-commit code are unchanged.

## Ownership, IPC, and lifecycle

The existing strict version-1 ownership history and bijective UUID/email checks
remain. Journal snapshots now expose validated sequence and SHA-256 digest.
The child writer can seal without setting the terminal `stopped` state or
pretending it observed its own exit. A sealed writer cannot allocate or append.

Parent email intents bind exact run/test/message UUIDs and generated emails.
The child durably appends intent before acknowledgment. The parent verifies
the exact receipt against a validated journal prefix, even if later token
allocations have appended. Malformed, conflicting, missing, wrong-owner, timed
out, or failed acknowledgments close admission. Identical duplicates do not
repeat writes. There is no automatic resend or fixture request replay.

All accepted service calls are tracked through settlement, including password
work outside a transaction. Quiescing immediately rejects new work and waits
for accepted requests, listener close, and database close before sealing. Known
authentication rejections may settle cleanly; unknown failures/storage 5xx cause
review because settlement may be ambiguous. An indefinitely pending operation
cannot manufacture a seal. Parent grace/exit timeouts bound shutdown escalation,
not completion of an in-flight database operation.

The parent persists evidence before invoking its injected spawn function. Only
events from the returned owned child are forwarded as exit evidence; IPC cannot
attest exit. Readiness retains the accepted dynamic loopback validation. Stop
closes health synchronously, shares shutdown, handles synchronous/asynchronous
send failures, and preserves the accepted pre-kill exit recheck. No PID/port
lookup or unrelated process termination exists. Child composition has no actual
HTTP/server/connector default; its injected listener must reject traffic until
application attachment, and it derives test APP_ORIGIN from loopback port zero.
The future application attachment uses the accepted fixed frontend-serving option.

## Finalization and crash windows

The parent ledger records:

`recording → quiescing → child-sealed → exit-confirmed → finalizing → cleanup-eligible → cleaned`

Unexpected exit, signal termination, premature disconnect, escalation,
contradictory ownership, changed evidence, uncertain settlement, or persistence
failure latches `review-required`. Failed test assertions do not imply a child
crash; a clean independently observed shutdown may still finalize its fixtures.

Each ledger entry binds owner, sequence, previous-line digest, phase, and the
current ownership digest/sequence. The ledger is exclusively created, compared
against its exact in-memory history before each append, and not reopened after
interruption. A finalizer lease must match owner and purpose, and one lease
cannot be assigned to multiple coordinators. Cleanup permits are process-local
opaque objects issued only after observed clean exit and durable finalization.

Only a guarded transaction may resolve exact pre-recorded email intents. A
missing row adds no ownership; unexpected emails, duplicate or conflicting
canonical UUID/email pairs reject the entire handoff. The parent may append only
resolved user ownership, then the unchanged terminal stopped snapshot. It never
reopens a stopped journal or creates fixture users/sessions during finalization.
Lost responses and session rotation remain covered by pre-recorded email
intents and token hashes, including harmless unmatched CSRF-candidate hashes.

A crash between resolution, user-record append, terminal stop, eligibility
append, or cleanup commit does not authorize automatic resumption. Partial
durable writes, stale leases, missing metadata, and ambiguous termination retain
evidence for separately approved review. No abandoned-run deletion exists.

Fixed-path evidence adapters use private exclusive files, complete writes,
fsync, and descriptor close. Lease release checks exact contents and never
steals stale leases. B1 exercises filesystem operations through mocks only.
These files assume cooperating writers; they are not a security boundary against
another process with filesystem access. File fsync does not prove directory
metadata durability, Windows/power-loss behavior, or atomic conditional unlink
against outside tampering. Missing/changed evidence fails closed.

## Cleanup safeguards

Only finalized permits can enter cleanup; unfinalized or forged metadata cannot
produce deletion. Empty sets perform no database work. Concurrent attempts are
rejected; successful repeated calls perform no additional deletes.

Within one guarded transaction the repository locks recorded user UUIDs in
order FOR UPDATE, then sessions matching exact recorded hashes OR related to
those users, also in order FOR UPDATE. It checks canonical UUID AND exact email,
unique rows, recorded token hashes, and null/owned session relationships before
deleting. Any unrecorded related session blocks user deletion.

Session deletion uses exact hash plus null-safe user-ID equality. User deletion
uses exact UUID AND email AND NOT EXISTS related sessions. Sessions are deleted
first. RETURNING rows must match the locked rows exactly; unexpected counts or
relationships throw and roll back. A separate guarded post-commit inspection
must confirm absence before `cleaned` is persisted. Ambiguous commits or failed
verification preserve evidence and block automatic retry.

The intended PostgreSQL argument is that FOR UPDATE on the parent user conflicts
with foreign-key KEY SHARE used by new relationships; after acquiring that lock,
READ COMMITTED session inspection sees prior committed relationships. Session
locks and NOT EXISTS are additional safeguards against unintended cascade.
The migration SHARE lock prevents history writes during a guarded transaction.
The quiet-test-database assumption remains required. ROW SHARE does not exclude
every concurrent schema operation; unrelated DDL/manual/integration writers must
not run alongside this harness. Conflicting product lock order may deadlock and
must fail through bounded timeouts, without retry or expanded predicates.

Mocks establish callback/control-flow and staged-store rollback behavior only.
They do not prove SQL syntax/catalog rendering, actual PostgreSQL lock conflicts,
FK/cascade behavior, driver cancellation, rollback settlement, or connection
failure behavior. These require separately approved live verification.

## Privacy and execution gates

Ownership/evidence/IPC carry fixture emails, UUIDs, token hashes, sequence/digests,
and fixed lifecycle information only. No raw passwords, session/CSRF tokens,
cookies, database URLs, authentication bodies, arbitrary error text, or stacks
are persisted. Diagnostic output allows only numeric case IDs and fixed outcomes;
the response gate retains no request/response payload and never retries a mutation.
The future live reporter must use this sanitized path rather than arbitrary
Playwright failure dumps. Existing trace/video/screenshot disabling remains.

New module imports are exercised under the accepted database/socket/process
tripwires. These JavaScript mocks are not OS-level isolation and do not intercept
every native addon, cached reference, transport, subprocess, or future import.

## Verification

The required checks ran sequentially, waiting for each process to finish:

| Command | Actual result |
| --- | --- |
| `npm.cmd run test:e2e:list` | Exit 0; one disabled-runtime sentinel listed in one file; no browser test executed |
| `npm.cmd run test:e2e:offline` | Exit 0; **269 passed**, 13 files |
| `npm.cmd run lint` | Initial exit 1 for one `prefer-const` declaration; corrected and rerun: exit 0, no warnings |
| `npm.cmd run typecheck` | Exit 0; all workspaces, root and E2E configuration |
| `npm.cmd test` | Exit 0; **713 passed**, 32 files |
| `npm.cmd run build` | Exit 0; contracts/API/frontend, 216 Vite modules transformed |
| `git diff --check` | Exit 0; no whitespace errors; LF/CRLF advisories only |
| `git status --short --untracked-files=all` | Exit 0; two tracked files modified and 22 untracked files; no commit |

The full result includes the accepted **577 tests plus 136 new regressions**.
The offline harness result includes the accepted **133 plus 136**. Existing
Node/HTTP/component discovery is preserved; 98 component tests remain included
in the full suite. No accepted safety assertion was weakened or removed.

New coverage includes unsafe environment/target and connected identity,
migration/schema drift, same-object transaction callback/result delivery,
post-callback inspection failure, delayed commit and rejected commit results,
staged-store rollback, IPC acknowledgment ordering/duplicates/failures/timeouts,
missing or late intents, fsync/append failures before session insertion, tracked
quiescence, child crash/disconnect/escalation, exact parent-observed exit, digest
and ownership conflicts, competing leases/finalizers, unrecorded relationships,
unexpected RETURNING rows, ambiguous cleanup commits, absent/empty ownership,
idempotency, sanitized output, inert imports, and disabled phase gates.

Development offline runs passed at 241, 259, and 267 tests as coverage grew.
Two focused E2E TypeScript runs failed on test typing (an untyped acknowledgment
mock/tuple table and an implicitly typed mock callback), then passed after
corrections. The final full typecheck passed. The final lint failure and correction
are recorded above. No assertion was relaxed to obtain passing results.

The protected-path diff was empty for `apps/api`, `apps/web`, `packages`, `.github`,
root manifests/lockfile, Playwright configuration and Vitest configuration. The
approved migration file's SHA-256 still matches the pinned checksum. Actual
database data/history was not queried. All 22 untracked files also passed a
separate trailing-whitespace/scope inspection, since ordinary `git diff --check`
does not cover untracked contents. Whitespace and status were rechecked after
finalizing this report. Branch and HEAD remain unchanged; work is uncommitted.

## Remaining approval boundaries

- B2 needs separate approval for guarded read-only PostgreSQL connection/catalog
  verification. It must not automatically write fixtures or clean records.
- Fixture creation, mutations and exact cleanup need separate explicit approval.
- Actual child authentication servers, Chromium/context launches, and browser
  scenarios require later execution approval and phase-gate implementation.
- Live wiring must acquire the exclusive run lease, use admitted connector
  endpoint metadata, enforce the injected listener's pre-attachment rejection,
  wire guarded services/token recording, and use sanitized diagnostics.
- HTTPS Secure/__Host- cookies and real browser behavior remain unverified.
- Existing product query/lock timeout and indefinite browser request/Web Lock
  limitations are not changed by test-only transaction timeouts.
- Schema/migration/guard/policy/CI changes and Git publication remain unapproved.

No database connection/read/write/delete, database cleanup, migration/reset,
actual authentication server, Chromium launch, live browser test, dependency
installation, commit, push, merge, or deployment was performed. The required full
suite includes existing isolated mocked Supertest HTTP unit tests; it does not
start the normal application runtime or a database-backed authentication server.
Existing client generation and build scripts generate only offline artifacts.
