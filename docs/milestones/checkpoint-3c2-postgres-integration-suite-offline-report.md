# Stage 3C.2 PostgreSQL integration coverage: offline preparation

## Scope and evidence

Baseline verified: branch `feat/job-applications`, HEAD
`79fe0d3fc21670746a0dd30d17a2c05782ee87d5`, clean before this work.

Added `apps/api/tests/application-edit-history.integration.test.ts` using the
existing serial integration configuration, local database guards, migration
policy, Prisma client, session service, Express application and application
service. No application implementation, existing integration file, historical
authentication guard, migration, dependency or runner was changed.

**The integration suite has not been executed.** No PostgreSQL connection,
fixture, SQL write, cleanup, migration, browser or service launch occurred in
this pass. The earlier verified test migration state is supplied historical
evidence, not a new observation. The development database was not accessed.

## Implemented cases

Eleven test cases cover the twelve requested coverage areas:

1. Authenticated detail retrieval with persisted version 1, exact public fields
   and no synthetic creation history.
2. Identical missing/foreign 404 responses for detail, update and history, with
   application, history and session-activity snapshots unchanged.
3. Normalized complete no-op preserving version/updatedAt; substantive non-status
   edit incrementing once without history.
4. Eight sequential transitions through all seven statuses, checking the actual
   prior database status and resulting revision for every event, date retention
   when returning to Saved, and no duplicate history for unchanged status.
5. Two different sessions submitting one expectedVersion while both real
   PostgreSQL application-row lock waits are observed: one 200, one 409
   APPLICATION_CONFLICT, version 2, one correct event, winner state retained and
   losing-session activity unchanged.
6. Stale-version conflict preserving application, history and committed session
   activity after advancing the controlled session clock.
7. Real history uniqueness failure injected after a successful history insert,
   requiring sanitized 503 and rollback of application, version, both history
   attempts and session refresh.
8. History default 20/max 50, descending revisions, equal timestamp fixtures,
   revision gaps, strictly older cursor pages, no duplicates, final null cursor,
   exact public history fields and invalid-query rejection.
9. Existing create/list version defaults, PostgreSQL leap-day DATE persistence
   and default-page application cursor pagination across 21 owned applications.
10. Anonymous, expired, revoked and missing sessions; missing/incorrect CSRF;
    origin/request-marker rejection; UUID validation; incomplete/unknown update
    fields; and missing, invalid or future application dates, with no committed
    update or session refresh.
11. Deliberately rolled-back PostgreSQL probes for positive version, required
    status/date, distinct history statuses, minimum history revision and history
    parent FK constraints. Each checks the expected allowlisted SQLSTATE; an
    unexpectedly accepted probe is forced to roll back.

The sequential integration case does not claim all 42 transitions were executed.
The earlier offline unit-test transition coverage remains separate evidence.

## Admission and fixture safeguards

- Before fixture writes, require NODE_ENV=test and exactly
  `127.0.0.1:5433/applyflow_test` as `applyflow_test`. No target fallback exists.
- Verify actual database, current/session roles, PostgreSQL 17, internal server
  port 5432, reported server address and Read Committed isolation. Reject
  competing client backends at initial admission.
- Reuse approved source-chain, migration SHA-256 and frozen-baseline checks;
  require exactly completed 0001 + 0002 + 0003 history with pinned checksums.
- Require the exact five-table migrated catalog, column types/defaults, twelve
  constraints, eleven indexes and seven status labels; reject unexpected
  inspected schema objects. Check the catalog before each test.
- Initial ownership inventory requires zero users, sessions, applications and
  history. Random per-run markers and pre-recorded UUIDs identify fixtures;
  emails use `example.invalid`. Session proofs use the existing token/session
  service and remain internal.
- Every write transaction checks identity, migration history and the full live
  ownership inventory. API SQL and delegate writes receive additional admission
  checks and use the real Prisma transaction, not a transaction double. Successful
  callbacks are checked again before commit. Session -> Application SQL lock
  ordering is forwarded unchanged.
- Cleanup verifies inventory before each delete and uses only recorded IDs with
  owner/marker or exact session-identity predicates. History is deleted before
  applications, then sessions and users. All four zero counts are checked both
  inside cleanup and after committed cleanup, before recorded IDs are cleared.
- Unexpected records or uncertain transaction/cleanup outcomes stop further
  writes. No automatic retry or expanded cleanup occurs. Recorded/possible
  residual and unexpected UUIDs are reported without adopting unknown records.
  Recorded IDs can include rolled-back attempts; they are not assertions that
  those rows still exist.
- The concurrency gate is bounded, releases its held lock and settles both HTTP
  requests before cleanup. Connections are closed in afterAll, including failure
  paths. Database errors are sanitized; only allowlisted error codes are retained,
  never session secrets, connection strings, driver objects or raw causes.

## Observed offline verification

| Command/check | Result |
| --- | --- |
| `npm.cmd run lint` | Final exit 0. Initial three lint findings in the new file were corrected. |
| `npm.cmd run typecheck` | Exit 0, including integration-file compilation; Prisma client generation was offline. |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | Final exit 0 after the last test-only changes. |
| `npm.cmd run build` | Exit 0 for contracts, API and frontend. |

No unit, integration or browser test run is claimed. Syntax/type verification
does not prove live SQL catalog assumptions, lock timing, adapter error metadata,
rollback or cleanup. These remain the purpose of the separately authorized run.

## Later targeted execution

From the repository root, only after separate authorization and fresh readiness
verification of the isolated test database:

```powershell
$env:NODE_ENV = 'test'
npm.cmd run test:integration -- apps/api/tests/application-edit-history.integration.test.ts
```

The script explicitly selects `vitest.integration.config.ts`; the filename
filter selects only this new suite. The existing isolated test credentials must
already be configured locally; do not put them in the command or report.

## Remaining limitations and inventory

Live behavior is unverified. A new client or external change after initial
admission cannot be excluded by an initial snapshot; unrelated live records are
rechecked throughout writes and cleanup. The local utility verifies configured
endpoint and server-reported identity, not an independently pinned Docker volume
or cluster identifier. A forced process termination can leave owned fixtures;
cleanup must never be inferred or retried automatically in that case.

Only the focused integration file and this report were added. Branch and HEAD
remain unchanged, with no tracked-file modifications or staged changes. No
Stage 3C.3 UI work was started.
