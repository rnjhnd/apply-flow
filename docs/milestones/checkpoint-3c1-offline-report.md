# Stage 3C.1 - Version and status-history foundation

## Scope and status

Baseline: `feat/job-applications`, HEAD
`3316a400840aee6357100aacdc6864daa85dabbc`, clean before implementation.
Only the Prisma schema, offline migration workflow/policy and focused tests were
changed, plus the requested Stage 3B.2 documentation correction. No API endpoints,
contracts, UI or authentication behavior changed. No database was accessed.

Migration 0003 was initially generated and pinned as **REVIEW_PENDING**. At that
time, its manifest entry blocked deployment before environment loading, driver
construction or subprocess execution. The complete SQL was subsequently reviewed
with no blocking defects, and source approval changed only the third migration
manifest entry to `approval: 'APPROVED'`.

The approved SQL SHA-256 remains
`7e607ec39d1c278e12bb6db8c5895f23d69ea3e695bd72519e96a34e9c93d85e`.
**Database deployment has not occurred and still requires separate authorization.**
No migration was applied; existing database records were not inspected or
modified. Stage 3C.2 has not begun. The offline verification evidence below records
the original implementation checks; this documentation update adds no test results.

## Candidate SQL and schema

Exact SQL: [0003_application_status_history/migration.sql](../../apps/api/prisma/migrations/0003_application_status_history/migration.sql).

SHA-256: `7e607ec39d1c278e12bb6db8c5895f23d69ea3e695bd72519e96a34e9c93d85e`.

- Adds required integer `JobApplication.version`, default 1, CHECK greater than 0.
  The additive SQL gives existing applications version 1 without changing their
  existing fields; this is source-level behavior, not a live preservation result.
- Creates ApplicationStatusHistory with Prisma-generated UUID ID, UUID parent FK,
  enum source/destination statuses, resulting application revision, and a
  server-default TIMESTAMPTZ(3) change time.
- CHECKs require different statuses and history revision at least 2. A unique
  `(applicationId, applicationVersion)` index prevents duplicate events for a
  revision and supports ordered history reads. Ownership follows the application;
  there is no independent user/actor field or generic activity payload.
- Uses ON DELETE RESTRICT and ON UPDATE CASCADE. Permanent deletion will require
  a separately approved history-cleanup policy. No history backfill is included.
- Wraps all statements in BEGIN/COMMIT. Application updates and transition
  recording behavior remain future service work; schema alone does not implement
  automatic version increments or event insertion.

## Migration guards

The frozen 0002 Prisma baseline is the pre-change schema with LF line endings:
`3d348c49d8756fa6d43372118f654ab4c45e8b87a9e96d86671ffaa03ec36521`.
Both earlier migration hashes and the frozen auth baseline hash remain unchanged.
Scoped .gitattributes rules pin LF for the new baseline and new SQL only.

The offline generator accepts only `--name application_status_history`, verifies
both prior migrations and baselines, requires exactly the two-migration directory
prefix, refuses overwrite, clears inherited datasource selectors and accepts only
the exact reviewed diff vocabulary before adding the three CHECKs.

SQL/source approval is complete. Future deployment, after separate execution
authorization, requires the exact third
checksum and exactly completed 0001 + 0002, or the exact full chain for a no-op.
It cannot use third-migration approval to apply a missing second migration. Exact
history membership, checksums, completion metadata and causal order remain
required; arbitrary extra tables/migrations are rejected. No reset/resolve/retry
path was added. Historical authentication-only B2/C1 safeguards are unchanged.

## Offline verification

| Check | Result |
| --- | --- |
| `npm.cmd run db:migrate:create -- --name application_status_history` | Exit 0; schema-to-schema diff only, no datasource selection |
| `npm.cmd exec -- vitest run --project unit apps/api/scripts/migration-policy.test.ts apps/api/scripts/db.test.ts` | Final exit 0; 110/110 tests, injected database/process ports only |
| `npm.cmd exec -- vitest run --project unit apps/api/scripts apps/api/src/modules/applications tests/e2e/support` | Exit 0; 900/900 tests across 27 files, before six additional metadata cases; focused rerun above includes them |
| `npm.cmd run lint` | Exit 0, including final rerun |
| `npm.cmd run typecheck` | Exit 0; offline Prisma generation |
| `npm.cmd run db:validate` | Exit 0; offline schema validation |
| `npm.cmd run build` | Exit 0; contracts, API and frontend |
| `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | Exit 0 after final test edits |
| Repeated offline Prisma diff, wrapped and byte-compared with pinned SQL | Exact match |
| `git diff --check` and new-file whitespace inspection | Passed |

An initial focused run found one stale two-migration test expectation; it was
corrected to assert the three-migration result. Rejection tests retain full valid
fixtures so malformed metadata is not accidentally rejected only for missing rows.

## Remaining verification and boundary

Real CHECK/FK/unique enforcement, migration locking, live preservation, history
cleanup and integration catalog assumptions are not verified by offline tests.
The generated client now knows the new model, but databases remain unmigrated;
database-dependent suites require separately approved migration and updated
Stage 3C catalog admission. No integration or browser test ran in this pass.

The Stage 3B.2 report now records the user-confirmed successful command and
8/8 result without the unsupported discrepancy claim. The environment assignment
is written as valid PowerShell `$env:NODE_ENV = 'test'`, rather than `$env = "test"`.
No test routing or package scripts were changed. Nothing was staged or published.
