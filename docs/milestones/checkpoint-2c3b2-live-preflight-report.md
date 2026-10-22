# Stage 2C.3B2 Gate B2 — Live read-only PostgreSQL preflight record

## Status and evidence source

The user reports that the first explicitly authorized live read-only preflight
completed with the following exact terminal output:

```text
APPLYFLOW_PREFLIGHT PASSED: Read-only inspection, rollback and connection closure completed.
```

This report records that supplied observation and documents the requirements of
the committed implementation. The preflight was **not rerun** during this
documentation turn. No database connection or live inspection was performed here.

The supplied evidence does not include the invocation transcript, shell environment,
process exit status, execution time, PostgreSQL patch version, or individual query
results. Those details were not independently inspected. The implemented success
path returns exit code 0; this is a source-code fact, not an independently observed
exit status for the reported live run. No connection string or password is recorded.

## Repository baseline independently inspected

| Item | Result |
| --- | --- |
| Branch | `feat/authentication` |
| HEAD | `c3d916f35dd762a4d87b709fa94e755a8b0bb32a` |
| HEAD subject | `test(e2e): activate guarded read-only preflight CLI` |
| Working tree before documentation | Clean |
| Comparison with locally recorded `origin/feat/authentication` | Six commits ahead, zero behind; no fetch performed |

The HEAD commit contains the four Gate B1 changes to the preflight CLI, adapter
diagnostics, CLI tests, and discovery tests. The CLI, adapter, and related support
modules were read; no implementation or test file was modified.

Reviewed implementation and context:

- `tests/e2e/support/read-only-preflight.ts`
- `tests/e2e/support/read-only-database.ts`
- `tests/e2e/support/environment.ts`
- `apps/api/src/config/database.ts`
- `tests/e2e/support/catalog.ts`
- `tests/e2e/support/schema.ts`
- `tests/e2e/support/database-preflight.ts`
- `tests/e2e/support/execution.ts`, `fixtures.ts`, and `run.ts`
- The `test:e2e:*` package scripts
- [Gate A offline report](checkpoint-2c3b2-offline-report.md)
- [Gate A rollback correction report](checkpoint-2c3b2-offline-corrections-report.md)
- [B1 safety correction report](checkpoint-2c3b1-corrections-report.md)

The Gate A reports remain historical evidence. Their statements that the CLI was
disabled describe that earlier stage. The current HEAD activates only the explicit
read-only preflight CLI, with signal handling and sanitized reporting.

## Checks required by the implemented success path

These requirements were verified by reading source. Given execution of this
committed implementation, the supplied PASSED output indicates that its success
path completed. Individual live values were not queried again for this report.

### Invocation, environment, and connection admission

- The dedicated script is `npm.cmd run test:e2e:preflight`; no command arguments
  are accepted. Importing the module does not activate its live factories.
- The invoking shell must explicitly supply `NODE_ENV=test` and
  `TEST_DATABASE_URL`. There is no `.env` loading or `DATABASE_URL` fallback.
- Only host `127.0.0.1`, port `5433`, database `applyflow_test`, and username
  `applyflow_test` are accepted. A nonempty, non-placeholder password is required.
- URL fragments and unexpected query parameters reject. The existing optional
  single `schema=public` parameter is accepted but is not forwarded as driver
  connection configuration.
- Inherited `PG*`, `NODE_OPTIONS`, `NODE_PATH`, `APP_ORIGIN`, `PORT`, `HOST`,
  `DATABASE_URL`, `DIRECT_URL`, and `SHADOW_DATABASE_URL` overrides reject.
- Admission occurs before resource construction and is rechecked around awaited
  inspection work. Driver fields are explicitly constructed from admitted values.
- The pg protocol stream must be the exact owned socket. Its actual remote address
  and port must remain `127.0.0.1:5433`; missing evidence, stream replacement,
  destroyed/closed transport, or unexpected end rejects.
- Queried database identity is not taken from endpoint metadata. Both current user
  and session user must be `applyflow_test`; PostgreSQL major version must be 17.

Socket endpoint evidence does not cryptographically identify the Docker container.
The report does not independently attest the live container or inspect its logs.

### PostgreSQL read-only inspection

The driver startup options request `default_transaction_read_only=on` and
`search_path=pg_catalog,public`. The explicit transaction is:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY
```

Before catalog inspection, fixed settings queries require effective transaction
and default read-only settings to be `on`, repeatable-read transaction isolation,
the expected search path, a five-second statement timeout, two-second lock timeout,
and ten-second idle-in-transaction timeout.

Only fixed transaction-control, identity/settings, client-activity, migration-history,
and catalog queries are available. The read-only history query has no `FOR SHARE`
or other row-locking clause. No write-capable Prisma transaction wrapper, DML, DDL,
migration, fixture, or cleanup operation is used by this path.

Quiet-database checks require zero other client backends connected to this database.
A second check occurs after rollback in a fresh read-only autocommit statement;
effective settings are checked again. These observations do not exclude a client
connecting later or establish continuous exclusivity.

### Migration and structural schema validation

The implementation requires the local approved migration bytes and database
history checksum to match:

```text
98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840
```

The on-disk SQL file was independently hashed during this documentation turn and
matches that value. This local file check made no database connection.

Before reading history, `User`, `Session`, and `_prisma_migrations` must be ordinary
permanent relations. History must contain exactly one completed `0001_init_auth`
record with the approved checksum, one applied step, no rollback timestamp, and
no nonempty failure logs.

The strict structural fingerprint requires the expected public relation names,
twelve User/Session columns with their types/nullability/defaults, six indexes,
three constraints including the cascading User/Session foreign key, no unexpected
noninternal public triggers, and no enabled or forced public-table RLS. Missing,
duplicate, malformed, or unexpected metadata rejects; expectations are not adjusted
to fit the connected database.

This fingerprint is intentionally incomplete. It does not exhaustively validate
functions, privileges, disabled RLS policies, every index option/collation/operator
class, sequences, every migration-table column, or all server configuration. Passing
it is not proof that future writes or cleanup are safe.

### Rollback, closure, interruption, and reporting

- Success requires requested and dispatched rollback, an observed `ROLLBACK`
  command confirmation, completed inspection, confirmed owned-connection closure,
  and no latched failure or interruption.
- Rollback request, actual driver handoff, and confirmation are tracked separately.
  If BEGIN was dispatched but rollback was not, bounded failure cleanup may attempt
  the fixed rollback on the still-usable owned transport. A rollback already handed
  to the driver is never retried, including after an ambiguous result.
- Socket closure alone does not establish explicit rollback confirmation. A late
  response cannot restore success after failure.
- Connection admission has a five-second deadline; the adapter has a twenty-second
  deadline and a shared two-second shutdown grace. Shutdown can destroy only its
  owned socket; it does not terminate processes by PID or port.
- One AbortController coordinates SIGINT/SIGTERM and Windows SIGBREAK. The CLI
  awaits adapter shutdown and removes its signal handlers. This successful run does
  not exercise interruption, forced termination, or failure-path settlement.
- Output uses fixed outcome codes/messages without raw driver errors, stacks,
  query results, migration logs, credentials, cookies, or CSRF/session proof.

## Evidence limits and remaining work before B3

The user-supplied success is a positive live observation of the read-only preflight.
This documentation review independently confirms its code requirements and local
repository baseline, not the individual live query responses. It does not establish
development-data equality, write rollback behavior, cleanup correctness, or safety
under concurrent activity. No live error or interruption was reproduced here.

The following remain subject to separate approval and live verification:

| Area | What remains unverified |
| --- | --- |
| Write-capable Prisma transactions | Actual Prisma 7.10.1 callback/result/error behavior with the guarded adapter, transaction-local settings, admission rechecks, commit/rollback settlement, and ambiguous commit handling. The read-only pg path does not exercise this wrapper. |
| Fixture ownership and cleanup | Durable intent-before-write ordering, owned users and token hashes, lost-response resolution, exact-match deletion, affected-row checks, idempotency, evidence retention, and preservation of unrelated rows on real PostgreSQL. No fixture was created or cleaned by the reported preflight. |
| Foreign-key locking and cascades | Real lock modes/order, concurrent relationship changes, unrecorded-session blockers, lock/deadlock timeouts, and prevention of unintended cascade deletion. Catalog matching alone cannot establish these behaviors. |
| Interrupted-run reconciliation | Child quiescence/sealing, parent-observed exit, durable finalization handoff, crash windows, filesystem durability, and explicit review of ambiguous or abandoned runs. No automatic abandoned-run cleanup is authorized. |
| Authentication browser execution | Actual Express/browser composition, registration/login/logout, cookie/CSRF behavior, rotation, Web Locks/BroadcastChannel concurrency, browser navigation, accessibility, and mobile layout. No browser or application server was started by the reported read-only path. |

Production HTTPS Secure/__Host- cookie behavior and production deployment readiness
remain separate requirements. This result does not authorize B3 or any write probe.

The fixture/runtime, smoke, and full E2E execution gates remain disabled. The general
`requireLivePhase()` gate still rejects all phases; only the dedicated read-only
CLI has its own explicit entry-point composition. Further live execution requires
separate human authorization; no new technical approval flag was added here.

## Documentation-turn verification and Git inventory

Only repository/file inspection, local migration hashing, documentation creation,
and Git status/diff checks were performed. No tests, lint/typecheck/build commands,
preflight command, or database integration suite were run in this turn. Historical
test counts in prior reports were not revalidated or presented as new results.

Git inspection included `git branch --show-current`, `git rev-parse HEAD`,
`git status --short --untracked-files=all`, `git log -1`,
`git rev-list --left-right --count origin/feat/authentication...HEAD`, and
`git show --stat --oneline HEAD`. Final status/diff and report-content checks were
also performed after creating this file.

Final inventory:

- Branch and HEAD unchanged from the baseline above.
- No existing tracked file modified; no staged changes.
- One new, untracked file: `docs/milestones/checkpoint-2c3b2-live-preflight-report.md`.
- No commit, push, merge, fetch, or deployment performed.

No PostgreSQL connection, database read/write/cleanup, service startup, Docker
operation, application server, browser launch, migration/reset, dependency install,
application/test implementation change, database-guard/schema/CI change, or later
stage work occurred during this documentation turn. Stage 2C.3B3 was not begun.
