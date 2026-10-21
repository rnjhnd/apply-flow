# Stage 2C.3B2 Gate A — Offline read-only preflight foundation

## Baseline and authorization

At entry, branch was `feat/authentication`, HEAD was
`a074958fc7e5fe542151d5c585c1c00001ddfcef`, and the working tree was clean.
The accepted 2C.3A/B1 code and reports were inspected, including database guards,
the catalog fingerprint, disabled execution gates, Prisma adapter configuration,
and the installed pg driver's connection/stream implementation.

Only Gate A implementation and injected offline verification were performed.
The CLI remains disabled by the unchanged `requireLivePhase('preflight')` gate.
There is no environment variable, argument, external URL, or server-reuse option
that enables it. Gate B and all fixture/browser execution require separate review.

## Exact files changed

Modified:

- `package.json`: one disabled `test:e2e:preflight` script; no dependency changes.
- `tests/e2e/support/catalog.ts`: additive read-only catalog inspection; existing B1 inspection retained.
- `tests/e2e/support/discovery.test.ts`: inert B2 imports and disabled-command construction tripwires.

Added:

- `tests/e2e/support/read-only-database.ts`
- `tests/e2e/support/read-only-database.test.ts`
- `tests/e2e/support/read-only-preflight.ts`
- `tests/e2e/support/read-only-preflight.test.ts`
- `docs/milestones/checkpoint-2c3b2-offline-report.md`

No lockfile, dependency, product code, existing environment/database guard, Prisma
schema, migration, Playwright/Vitest configuration, CI, or startup file changed.

## Driver and actual peer-binding implementation

The installed dependency is `pg@8.23.1`, already supplied by the pinned Prisma
PostgreSQL adapter. No package was installed. Its source was read directly:

- `pg/lib/client.js` passes `c.stream` to its protocol Connection constructor.
- `pg/lib/connection.js` evaluates a stream factory once, retains the returned
  object, calls `stream.connect(port, host)`, and attaches PostgreSQL protocol
  listeners to that stream when TLS is disabled.
- `pg/lib/client.js` also shows that normal non-pipelined `end()` destroys the
  connection when a query remains active; it is not proof of query settlement.

The prepared composition supplies one owned `net.Socket` through `ClientConfig.stream`.
The adapter requires `client.connection.stream === ownedSocket` before connecting,
after connection, and around every inspection query. Actual socket remote address
and port must be present and exactly `127.0.0.1:5433`; destroyed/closed sockets or
swapped streams reject. Configured host/port fields and container-side port 5432
are not used as peer evidence. This does not cryptographically attest a container.

The adapter requires explicitly injected socket/client factories. It returns only
an immutable passed/readOnly/closed result, never a client or executable query
handle. The disabled CLI's real factories are unreachable in Gate A. All adapter
tests use EventEmitter-based fakes; no actual socket, pg client, or pool is created.

## Admission and read-only transaction design

Unchanged guards require explicit shell `NODE_ENV=test` and `TEST_DATABASE_URL`.
Only `127.0.0.1:5433/applyflow_test` as `applyflow_test` is admitted. No `.env` loader,
development/production fallback, inherited PG/runtime override, or arbitrary URL
parameter is accepted. The existing optional single `schema=public` parameter is
accepted but not forwarded. Driver fields are constructed explicitly; the full URL
is not passed to pg configuration. Admission and migration bytes are rechecked
around awaited work. Invalid admission constructs neither socket nor client.

Startup options establish `default_transaction_read_only=on` and the fixed
catalog-first search path. The one explicit transaction begins with:

```sql
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY
```

Before catalog inspection, a fixed settings query requires actual database,
current user and session user `applyflow_test`, PostgreSQL major version 17,
effective transaction/default read-only mode `on`, repeatable-read isolation,
and the expected timeouts/search path. No B1 write-capable Prisma wrapper is used.
No caller SQL or callback reaches the driver. The vocabulary consists only of
fixed transaction control, settings/identity, activity-count and catalog/history
queries. No DML, DDL, explicit table locks, row locks, fixture SQL or cleanup SQL
is issued by this path.

The read-only history SELECT has no row-locking clause. B1's existing `FOR SHARE`
query is unchanged. Exactly three ordinary permanent relations are required before
reading migration history. Existing strict history and structural validators are
reused, without updating expected metadata:

- Local SQL SHA-256 and history checksum:
  `98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840`.
- Exactly one completed `0001_init_auth`, one applied step, no rollback/failure logs.
- Expected public relation names, twelve columns, six indexes, three constraints,
  no unexpected noninternal public triggers or enabled/forced RLS.
- Queried database/user identity is independently projected; extended socket or
  endpoint metadata cannot overwrite it.

The fingerprint does not exhaustively cover database functions/privileges,
disabled RLS policies, all index options/collations/operator classes, sequences,
every migration-table column, or server configuration. PostgreSQL enforcement is
designed here, not demonstrated by injected responses.

## Rollback, interruption and shutdown

Limits are 5 seconds to connect, 5 seconds per server statement, 2 seconds for lock
waits, 10 seconds idle-in-transaction, 20 seconds overall, and a shared 2-second
shutdown grace. Timeout, AbortSignal cancellation and unexpected connection events
latch failure. Late responses cannot resume later inspection or publish success.

Every attempted BEGIN is followed by a ROLLBACK request, including successful
inspection and inspection failures. An already failed ROLLBACK is not retried.
Success requires a ROLLBACK command confirmation and confirmed connection closure.
Failure cleanup makes its rollback request and closes the driver within the shared
shutdown budget. If necessary it destroys only the owned socket. No unrelated
process, PID or port is targeted. Missing rollback/close confirmation cannot pass.

Normal completion removes timers, AbortSignal and adapter-owned event listeners.
An unconfirmed driver retains a sanitized error sink until its end event, with
one-shot listener removal, so late errors do not expose raw diagnostics.

Other client connections to the test database cause failure. The final activity
check runs after rollback in a fresh read-only autocommit statement, avoiding reuse
of the transaction's cached activity snapshot. The operator must still maintain a
quiet database; activity checks do not exclude future connections. A transient
Compose health check can conservatively reject a run. There is no automatic retry.

Errors use an allowlisted code and fixed message, with no original exception,
database URL, password, response body or server notice. No journal/evidence records
are written by this adapter. Client deadlines/disconnects are not claimed to prove
PostgreSQL cancellation or rollback settlement.

## Regression coverage and actual verification

Added **117 tests**: 109 adapter/catalog cases, seven command/driver-contract cases,
and one discovery case. The prior 758 cases remain included, unchanged.

Coverage includes unsafe/missing environment and URL parameters; construction
ordering; socket identity, peer and stream changes; effective settings and actual
identity/version mismatches; relation replacements; migration/catalog differences;
query, rollback and close failures; unexpected clients; changing admission; timeout,
cancellation and late completion; error privacy; disabled command/phase gates; and
listener cleanup. A static installed-driver contract regression checks version and
the inspected stream wiring. It does not connect or execute a real pg client.

The final required sequence ran in order, awaiting each command before the next:

| Command | Actual result |
| --- | --- |
| `npm.cmd run test:e2e:list` | Exit 0; one disabled-runtime sentinel listed in one file; none executed |
| `npm.cmd run test:e2e:offline` | Exit 0; **431 passed**, 16 files |
| `npm.cmd run lint` | Exit 0; no errors or warnings |
| `npm.cmd run typecheck` | Exit 0; workspace, root and E2E checks |
| `npm.cmd test` | Exit 0; **875 passed**, 35 files |
| `npm.cmd run build` | Exit 0; contracts/API/web; 216 Vite modules transformed |
| `git diff --check` | Exit 0; no whitespace errors; LF/CRLF advisories only |
| `git status --short --untracked-files=all` | Exit 0; scoped uncommitted files listed below |

Focused development verification finished with **148 passed** across the two new
test files and existing discovery file. A focused E2E TypeScript check also passed.
Earlier development checks caught and corrected a multiline type-assertion parse
error, strict fixture/driver signature typing errors, and array-table fixtures
needing object wrappers. The first full lint attempt caught an unused cleanup
assignment and a throw inside finally; both were corrected without suppressing
rules or weakening assertions. Listing, offline tests and lint were then rerun
before continuing the successful final sequence.

Offline Prisma generation/build artifacts were produced by existing scripts;
these commands do not apply migrations. The approved migration digest was checked
again on disk and remained unchanged. Protected-path diffs for `apps`, `packages`,
`.github` and `package-lock.json` were empty. Whitespace/status checks were repeated
after this report; new files were also checked for trailing whitespace.

## Gate B and later limitations

No live peer, PostgreSQL catalog rendering, transaction enforcement, network
cancellation, role capability or connection shutdown behavior has been verified.
Mocks establish application control flow and validation, not OS or database safety.
Read-only PostgreSQL transactions may still cause internal statistics/disk activity;
this is not a privilege sandbox against a compromised privileged server.

Gate B needs separate explicit approval to open only the read-only command and
make the first test-database connection. Its enabling review must cover CLI signal
wiring and runtime error reporting (the current command deliberately reports only
that execution is disabled). It must not enable fixture/smoke/full gates, bypass
guards, silently adjust schema expectations, start Docker, or issue write probes.
The invoking shell must provide the test URL privately and the database must
already be running in an operator-controlled quiet window. No connection URL
should be included in shell transcripts or reports.

B3 fixture writes, Prisma write-transaction lock/rollback/commit behavior, FK/cascade
races, journal finalization and cleanup remain separately unverified/unauthorized.
Browser/server phases, HTTPS cookies and real-browser accessibility remain later work.

## Scope and Git status

Branch and HEAD remain unchanged. Final working tree: three modified tracked
files and five new files, all listed above; no commit or push was made.

No PostgreSQL connection/read/write/cleanup, integration suite, live preflight,
Docker/database startup, application runtime, Chromium/browser test, migration,
reset, dependency installation, product/security change, CI change, commit, push,
merge or deployment occurred. Existing mocked Supertest HTTP unit tests are part
of the required full suite; no normal or database-backed authentication server was
started. Gate B and B3 were not begun.
