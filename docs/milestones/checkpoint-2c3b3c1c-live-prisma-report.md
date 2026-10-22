# Stage 2C.3B3C1C - Live read-only Prisma inspection record

## Status and evidence source

The user reports that the first explicitly authorized C1C live read-only Prisma
inspection passed. This document records that supplied observation and the checks
required by the committed implementation. The live command was not rerun during
this documentation turn. No database connection or database query was made here.

User-confirmed terminal transcript:

```text
PS C:\Users\arene\Documents\Projects\apply-flow> npm.cmd run test:e2e:fixtures:inspect

> applyflow@0.0.0 test:e2e:fixtures:inspect
> node --import tsx tests/e2e/support/fixture-preflight.ts

APPLYFLOW_FIXTURE_INSPECTION PASSED: Sequential read-only inspections, rollbacks and owned resource closure completed.
```

The user-confirmed shell invocation is `npm.cmd run test:e2e:fixtures:inspect`,
which launches `node --import tsx tests/e2e/support/fixture-preflight.ts`. The
invocation and banner match the committed package script. Neither documentation
turn reran the command or performed a separate database verification.

No shell environment, process exit status, timestamp/duration, driver trace,
PostgreSQL logs, individual catalog results or backend PID was supplied for this
run. The normal committed success path returns exit code 0; that is a source-code
fact, not a separately captured exit status for the reported run. No credentials,
connection string, authentication result or private database output is recorded.
Neither documentation turn independently inspected PostgreSQL logs, internal query
results, process exit status or backend PID.

## Repository baseline independently inspected

| Item | Result |
| --- | --- |
| Branch | `feat/authentication` |
| HEAD | `89666cc9b94e6ad2d62562a8c6f8b268dc911f3b` |
| Commit subject | `test(e2e): activate guarded read-only Prisma inspection` |
| Working tree before documentation | Clean |
| Staging area before documentation | Empty |

The commit contains the six C1B implementation, regression-test, discovery and
milestone-report files. The current source was read directly; this report does not
use earlier test totals as proof of new live behavior.

Reviewed implementation and context:

- `AGENTS.md` and the current root package scripts.
- `tests/e2e/support/fixture-preflight.ts` and `fixture-database.ts`.
- `tests/e2e/support/read-only-database.ts`, `environment.ts`,
  `database-preflight.ts`, `catalog.ts`, `schema.ts`, and `guarded-database.ts`.
- `apps/api/src/config/database.ts` and the local approved migration checksum.
- The fixture-cycle, direct fixture-child and general execution gates.
- [B2 live preflight record](checkpoint-2c3b2-live-preflight-report.md),
  [B2 offline foundation](checkpoint-2c3b2-offline-report.md),
  [B3B offline report and corrections](checkpoint-2c3b3b-offline-report.md), and
  [C1B offline report and corrections](checkpoint-2c3b3c1b-offline-report.md).

Earlier reports describe the gates at their historical checkpoints. The committed
C1B path now activates explicit inspect-only composition; it does not activate the
fixture-cycle or child runtime.

## Requirements of the committed success path

The following are independently inspected source requirements. Given execution of
this committed path, the supplied PASSED line indicates that it reached the
successful reporting decision. The underlying live query values and server logs
were not independently inspected during this turn.

### Sequential admission and B2 closure

`fixture-preflight.ts` accepts no arguments and uses native `import.meta.main`
for explicit entry. Imports alone do not create installed sockets or clients.
The invoking shell must provide `NODE_ENV=test` and `TEST_DATABASE_URL`.
Environment files are not loaded and there is no `DATABASE_URL` fallback.

Only `127.0.0.1:5433/applyflow_test`, as `applyflow_test`, is admitted. The password
must be nonempty and non-placeholder. URL fragments and unexpected query options
reject; the existing single optional `schema=public` parameter remains allowed
without being forwarded as a driver override. Inherited `PG*`, runtime/connection
overrides and forbidden diagnostic logging variables reject. The invoking
environment and migration bytes are rechecked after awaited stages.

The unchanged B2 adapter runs first. It requires its own owned protocol socket,
peer identity, effective read-only settings, migration/schema inspection,
confirmed explicit rollback and completed connection closure. The CLI awaits its
immutable passed/readOnly/closed receipt before issuing private Prisma inspection
authority or constructing the Prisma pool. Failed, interrupted or unconfirmed B2
shutdown prevents Prisma allocation.

### Migration, identity and structural schema

Both inspections require the approved migration `0001_init_auth` and SHA-256:

```text
98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840
```

The local SQL file was hashed during this documentation turn and matches. This
was a filesystem-only check, not a migration operation or database inspection.

Fixed queries require the actual connected database, current user and session
user to be `applyflow_test`, and PostgreSQL major version 17. The catalog identity
is constructed from queried database/user fields and checked socket endpoint
fields, without allowing caller metadata to overwrite database identity.

Before history is read, `User`, `Session` and `_prisma_migrations` must be ordinary
permanent relations. History must contain exactly one completed approved migration
with the matching checksum, one applied step, no rollback timestamp and no
nonempty failure logs. The fixed read-only history query has no row-lock clause.

The structural fingerprint checks public relation names, twelve User/Session
columns, six indexes, three named constraints including the cascading foreign
key, noninternal public triggers, and enabled/forced RLS settings. Missing,
duplicate, malformed or unexpected metadata rejects. Expectations are not changed
to accommodate a connected database.

This fingerprint is not exhaustive: privileges, functions, disabled RLS policies,
all index options/collations/operator classes, every migration-table column and
all server configuration are outside its coverage. Catalog equality does not
establish safe future writes, locking or cascades.

### Owned physical Prisma connection and read-only execution

The private authority is invocation-scoped and permits only inspect-only
composition, one pool, one physical socket and one Prisma client. It is revoked
on failure, interruption and completion. Installed driver configuration is built
from explicit admitted fields; no external URL, arbitrary SQL, mutation callback
or cleanup interface is accepted by the inspection CLI.

The captured PoolClient's PostgreSQL protocol stream must be the exact owned
socket. Actual remote address/port must be `127.0.0.1:5433`. Replacement sockets,
PoolClients, query receivers and reconnect attempts reject. The fixed backend
query requires `pg_backend_pid()` to match the captured backend PID and pg
PoolClient `processID`, with checks on the actual Prisma transaction path.
`max: 1` is not used as the sole proof of physical binding. Socket peer evidence
does not cryptographically identify a Docker container.

The owned external pool is passed to PrismaPg. Startup requests
`default_transaction_read_only=on` and `search_path=pg_catalog,public`. Exactly one
initial Prisma inspection runs in repeatable-read isolation and explicitly issues
`SET TRANSACTION READ ONLY`. Effective settings must report transaction/default
read-only on, the required isolation/search path, five-second statement timeout,
two-second lock timeout and ten-second idle-in-transaction timeout.

The B2 transaction separately uses
`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`. Fixed activity checks require
zero other client backends at their observation points; B2 also checks activity
after rollback. These snapshots do not establish continuous exclusivity or prove
the absence of later concurrent writers.

### Rollback, closure and final reporting

Prisma inspection deliberately exits its callback through a private rollback
sentinel. Success requires the expected rejection and exactly one observed driver
`ROLLBACK` command confirmation. Socket destruction is not rollback evidence.

Prisma disconnect, pool end and actual owned socket close-event observation must
complete within the shared two-second shutdown budget. The monotonic close
observer is installed when the socket is allocated. A true closed/destroyed flag
or fulfilled pool end alone is insufficient. Premature, abnormal or duplicate
close and owned resource errors latch failure. Missing close times out; late
completion cannot restore success.

The connector returns only a frozen inspection receipt. A separate monotonic CLI
failure latch remains effective after receipt creation, through resource-observer
teardown and the final synchronous failure/abort check. Retained connector error
sinks remain distinct from PrismaPg's and the CLI's removable observers. No await
intervenes between the final check and the fixed synchronous reporter.

One AbortController handles SIGINT, SIGTERM and Windows SIGBREAK. Owned rollback
and bounded closure remain available after authority revocation. No reconnect,
fallback or transaction replay is introduced. A successful run does not exercise
interruption, uncertain shutdown, timeout, or late-error failure paths.

The CLI reports allowlisted codes/messages and catches unexpected errors without
printing raw driver exceptions, stacks, SQL results, database URLs or secrets.
Its finite positive-completion boundary covers observed close and confirmed owned
shutdown, teardown and final reporting; it does not claim observation of arbitrary
synthetic events on closed objects after reporting begins.

## Evidence limits and requirements before B3C2

The supplied success is positive live evidence for the reported sequential
read-only pg and Prisma path. This documentation turn independently establishes
the committed source requirements and repository baseline only. It does not
independently attest individual live responses, database logs, container identity,
exit status, development-data equality or the absence of unrelated database work.

| Area | Remaining requirement |
| --- | --- |
| Write-capable Prisma transactions | Separately review and verify actual guarded write callbacks, results/errors, transaction-local locks/timeouts, commit/rollback settlement and ambiguous commit handling. Read-only Prisma inspection does not exercise the write wrapper. |
| Live fixture ownership and rotation | Verify durable exact intent acknowledgment, pre-commit versus confirmed-commit evidence, anonymous/authenticated session ownership, registration rotation, lost responses and conflicts. No live user/session fixture evidence was supplied or collected here. |
| Cleanup and FK/cascade safety | Verify exact UUID/email/token-hash predicates, related-session blockers, permit liveness, affected-row checks, independent read-only absence verification and preservation of unrelated rows. Real FK locking/cascade behavior remains untested; no cleanup was performed. |
| Interrupted runs and concurrent writers | Verify child quiescence/seal, parent-observed exit, durable ownership finalization, Windows IPC/process behavior, crash windows, competing leases, relationship changes and ambiguous outstanding database work. No automatic abandoned-run cleanup is authorized. |
| Authentication server/browser execution | Real Express/browser registration, login/logout, cookies, CSRF, cross-tab coordination, navigation, accessibility and responsive behavior remain outside this read-only inspection. |

B3C2 implementation and any live fixture write/cleanup require separate approval
and the planned safety review. No broader readiness or production deployment
claim follows from this success. Production HTTPS cookie verification also remains
a separate requirement.

## Execution gates and documentation-turn verification

Source inspection confirms that exported `installedFixtureDriver()` still rejects
both modes. The private installed CLI path is inspect-only. Fixture-cycle and
direct child entry points print fixed disabled outcomes and return failure; the
general runtime gate still rejects. No fixture service, cleanup permit, browser
or application server is activated by this documentation change.

Performed only local source/report reads, Git inspection, local migration hashing,
this report creation, and content/whitespace checks. No tests, builds, preflight,
fixture commands or database integrations were executed. Earlier verification
totals remain historical results, not fresh results from this turn.

Git commands used included `git branch --show-current`, `git rev-parse HEAD`,
`git status --short --untracked-files=all`, `git diff --cached --name-only`,
`git log -1 --format="%h %s"`, `git show --stat --oneline HEAD`, and final
unstaged/staged diff, whitespace and inventory checks. A separate filesystem
content check covers this untracked report, which ordinary `git diff --check`
does not include.

Final inventory:

```text
?? docs/milestones/checkpoint-2c3b3c1c-live-prisma-report.md
```

Branch/HEAD unchanged; staging area empty; no existing tracked file modified.
Report content/whitespace checks and `git diff --check` passed. Nothing was staged,
committed, pushed, merged or deployed.

No PostgreSQL access/read/write, live command, fixture operation, authentication
service execution, cleanup, Docker/service startup/shutdown, application server,
browser, migration, dependency install, implementation/script/guard/test/schema/CI
change or B3C2 work occurred during this documentation turn.
