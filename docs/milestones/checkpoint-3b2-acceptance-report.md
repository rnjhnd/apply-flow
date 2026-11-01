# Stage 3B.2 - Create/list acceptance report

## Result and evidence boundary

**Stage 3B.2: ACCEPTED**, based on the user-confirmed PostgreSQL integration
result, completed development migration verification, and manual browser results
recorded below. Report recorded on 2026-11-02 (Asia/Manila).

Repository baseline independently checked for this documentation pass:
`feat/job-applications`, HEAD `6785b64ed9cb48c1037d3ffe463dfd47856bfaf0`, clean
working tree. No tests, database connections, migrations, services or browser
operations were performed in this pass. Browser observations and integration
execution results are user-reported; database inspection and migration results
also have earlier assistant tool output in the session. No browser automation
pass is claimed.

This report completes the live acceptance record following the historical
[offline implementation report](checkpoint-3b2-report.md),
[offline integration-suite report](checkpoint-3b2-postgres-integration-suite-offline-report.md)
and [PostgreSQL acceptance plan](../plans/stage-3b2-postgres-acceptance.md).
Their statements that live work was pending describe those earlier passes.

## PostgreSQL integration

The user confirmed **one targeted test file, 8/8 tests passed**, using the Vitest
integration configuration. Covered behavior includes committed persistence and
DATE serialization, two-owner isolation, owner-scoped pagination, session
rejection, CSRF, session-row locking and validity rechecks, PostgreSQL constraints,
and transaction rollback with sanitized errors. These are integration results,
not evidence that all security properties have been exhaustively tested.

Earlier guarded read-only post-test inspection verified
`127.0.0.1:5433/applyflow_test` as `applyflow_test`, exactly completed migrations
0001 and 0002 with approved checksums, expected schema, no competing clients,
and **User 0 / Session 0 / JobApplication 0**. No residual test-owned IDs remained;
rollback and connection closure were confirmed.

Execution-record discrepancy: the earlier manually reported command was
`npm.cmd run test -- apps/api/tests/applications.integration.test.ts`. At this
HEAD, `test` uses the ordinary Vitest configuration; `test:integration` selects
`vitest.integration.config.ts`. The latest user confirmation explicitly states
that the targeted integration configuration passed. Raw execution logs resolving
the earlier command/configuration mismatch were not captured in this report;
the reported command is not presented as independently verified runner evidence.

## Development migration and preservation

The guarded wrapper was executed once with exit code 0:

```powershell
npm.cmd run db:migrate:deploy -- --approved-sql-sha256 74e056f699c2781c01f12d3195ed119074d5b0d4d04fef979c185e17d775a333
```

Only `0002_job_applications` was applied to
`127.0.0.1:15432/applyflow_dev` as `applyflow_dev` (PostgreSQL 17.11).
Completion was `2026-11-01T15:01:43.240Z`.

Subsequent read-only verification confirmed exactly completed `0001_init_auth`
and `0002_job_applications`, matching these approved file/history hashes:

| Migration | SHA-256 |
| --- | --- |
| 0001_init_auth | `98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840` |
| 0002_job_applications | `74e056f699c2781c01f12d3195ed119074d5b0d4d04fef979c185e17d775a333` |

Verification checked the four tables and nine indexes by exact names and
definitions, 11 JobApplication columns, ownership FK, status/date CHECK, seven
ApplicationStatus values, and unchanged User/Session schema digest. All indexes
were valid and ready; no unexpected inspected objects or competing clients were
found. At migration verification, counts were **User 1 / Session 0 /
JobApplication 0**. The existing development user was preserved. These counts
precede the later manual browser records; they are not current database counts.
Read-only rollback and connection closure were confirmed. No database reset or
seed was performed.

The first post-migration script incorrectly expected 14 relations rather than
13 and stopped. A separately authorized read-only completion pass checked exact
object membership and definitions successfully; the migration was not rerun.

## User-confirmed manual browser acceptance

The user reports **all 12 planned manual checks passed**, with no remaining
observed browser failure. The supplied outcomes are grouped below rather than
inventing a missing numbered checklist or network trace:

- Existing-account login succeeded and the protected workspace loaded.
- Saved application creation succeeded and persisted after refresh.
- Applied creation with a valid date succeeded; Applied without the required
  date was rejected; Saved without a date succeeded.
- Duplicate company/title applications were accepted.
- Logout prevented access to protected application data; re-login preserved
  existing applications.
- Pagination with **22 applications** loaded the first **20**, then **Load more
  applications** appended the remaining **2**, with no duplicates observed.
  **Refresh applications** returned to the first **20**.

Cross-account isolation was verified in PostgreSQL integration tests, **not**
manually browser-tested. No automated browser execution logs are claimed.

## Remaining scope and limitations

- Editing existing applications and status-history functionality are not yet
  implemented.
- Pagination is forward, cursor-based load-more; there are no Next/Previous
  page controls. Ordering is `createdAt DESC, id DESC`. Separate page requests
  do not promise a shared snapshot during concurrent changes.
- Manual acceptance establishes the reported flows, not exhaustive browser,
  accessibility, security, performance or production-readiness coverage.
- The historical integration command/configuration discrepancy remains an
  evidence-record limitation; no new execution was used to resolve it here.

Stage 3B.2 acceptance is recorded. Stage 3C, Git publication and further runtime
work are outside this documentation pass.
