# Stage 3E.2A - Search/filter PostgreSQL integration preparation

## Result and evidence boundary

One focused integration suite was prepared and checked offline. Its **18 live
cases have not run**. No PostgreSQL connection, fixture creation/deletion,
migration, integration execution, browser session or service launch occurred.

Baseline: `feat/application-search-filtering`, HEAD `be6b790`, with the five
expected uncommitted Stage 3E.1 files and an empty index. Their SHA-256 fingerprints
were compared before/after this preparation and remained identical. No existing
integration suite, application/authentication/frontend source, migration, baseline
or checksum policy required a compatibility change.

Added files only:

- `apps/api/tests/application-search-filtering.integration.test.ts`
- `docs/milestones/checkpoint-3e2a-integration-preparation-report.md`

## Exact prepared test inventory

The six punctuation parameters and two plan parameters expand to 18 cases.

| Case | Prepared assertion |
| --- | --- |
| 1 | Case-insensitive complete phrases in the middle of company OR title; separated words and notes/location/URL-only text do not match; no-match response. |
| 2 | Literal percent sign, with wildcard-expansion decoys. |
| 3 | Literal underscore, with single-character-wildcard decoys. |
| 4 | Literal backslash in company and title. |
| 5 | Literal single quotation mark. |
| 6 | Literal double quotation mark. |
| 7 | Literal `C++ / R&D?!` punctuation and spaces. |
| 8 | Outer whitespace trimming, empty/whitespace-only equivalence to default listing, and preserved internal double spaces. |
| 9 | 200 supplementary Unicode code points after trimming; over-limit, NUL and malformed-surrogate rejection without committed session activity. Unpaired surrogates are passed directly to the service because they cannot be represented faithfully by normal UTF-8 HTTP encoding. |
| 10 | All seven statuses in Active and Archived; omitted status includes all seven; archived text-plus-status queries. |
| 11 | Combined text/status/view predicates on every page for two owners; exact owner-specific expected results exclude every foreign match. |
| 12 | Sparse matches, tied timestamps, createdAt/id descending order, filtering before limit+1, exact nextCursor, no duplicates, and unchanged default 20-row pagination. |
| 13 | Reused cursors from another search, status, view and owner remain tuple boundaries; absent anchor does not grant access or invalidate safe pagination. |
| 14 | HTTP create/edit changes subsequent filter membership; real status history survives archive/restore; revision increments, archived detail and status/date behavior remain compatible. |
| 15 | Repeated/bracketed/unknown HTTP queries, NUL, excess length, invalid status/view/limit/cursor reject without fixture or committed session-activity changes. |
| 16 | Anonymous/expired/revoked/unknown/missing sessions, hostile Origin, cross-site metadata, missing request marker, request-rate admission and mutation CSRF; valid GET retains its existing CSRF policy. |
| 17 | Selective-search EXPLAIN observation on 96 owned applications and one foreign match. |
| 18 | No-match EXPLAIN observation on the same controlled fixture shape. |

Pagination walkers compare each page against independently specified fixture IDs,
verify last-returned-row cursor contents and reject duplicate/repeated cursors.
The sparse and combined cases exercise the independent search OR and cursor OR
against real queries when separately authorized. There are no mocked concurrency
claims or new concurrency scenarios in this read-focused suite.

## Admission, ownership and cleanup design

The suite follows the existing lifecycle integration patterns locally; it does
not extract a generic fixture framework. There is no top-level database opening.
Only the separately selected integration runner can invoke its hooks.

Before any fixture write it requires NODE_ENV=test, exact configured endpoint
`127.0.0.1:5433/applyflow_test`, role `applyflow_test`, matching connected database,
current/session roles, PostgreSQL 17 and expected isolation. The Docker-side server
port is checked as 5432; it is distinct from the approved host port 5433.

Source admission verifies the approved four-entry migration chain and all four
SQL/three frozen-baseline hashes. Database admission checks exactly completed
0001-0004 with approved checksums and valid completion metadata, then exact catalog
definitions: five tables, 39 columns, 12 constraints, 11 indexes and seven enum
labels, including nullable archivedAt and the restrictive history FK. Unexpected
inspected schemas/objects, unrelated records, competing clients, prepared
transactions, foreign open transactions or waiting locks stop writes.

The initial inspection is REPEATABLE READ READ ONLY, bounded by timeouts, requires
zero User/Session/JobApplication/ApplicationStatusHistory records and deliberately
throws a sentinel to require Prisma transaction rollback. Its pool closes before
the execution pool opens. Failed admission does not open a replacement execution
or post-test connection.

Each test owns UUID ledgers, unique email/company run markers, session identity
metadata and exact history identities/revisions/statuses. Collision checks precede
inserts. Guarded transactions revalidate target, migrations, catalog, inventory and
clients around fixture work; HTTP mutation ports also check run ownership before
individual writes. Real application service queries and locking are forwarded.
Missing ledger IDs are tolerated for rollback/revocation/intentional deletion;
unexpected or altered ownership stops all further writes.

Cleanup uses only ledger-derived ID/owner/marker predicates: history first, then
applications, sessions and users. History predicates additionally include its
revision/status metadata and owned parent relation; session predicates include
the recorded owner and token hash internally. No unqualified delete, reset,
TRUNCATE, seed or migration exists. IDs alone are reported if cleanup cannot be
proven; authentication material and raw driver errors are not logged. Ambiguous
transaction outcomes stop writes and are never retried.

After cleanup, committed zero counts and a read-only rollback are required before
discarding ledgers. Final verification closes the execution pool, opens a separate
read-only inspection connection, rechecks zero counts, unchanged migration/catalog
fingerprints and clients/locks, then closes that connection. These are prepared
assertions, not evidence of cleanup or connection closure against a live database.

## Query-plan observation design

Each plan probe uses a bounded REPEATABLE READ READ ONLY transaction, confirms
read-only settings/admission and intentionally rolls back. Parameterized
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` uses representative first-page SQL with
the same public projection, owner/Active/status/text predicates, descending tuple
ordering and limit 21. It is **not captured ORM-issued SQL** and does not inspect
a cursor-page plan. Fixed probe text contains no pattern metacharacters; actual
escaping is exercised separately through the HTTP matching cases.

Output selects only node/index names, actual rows/loops, rows removed by filters,
buffer counters and planning/execution times. Raw plans, SQL filter expressions,
parameters, application content and authentication secrets are not dumped.
The probes require one or zero matching rows as appropriate, without asserting
an index choice or latency threshold. Small fixtures, tied timestamps, default
statistics and warm caches cannot establish production-scale performance. No
ANALYZE command, index, extension or migration is introduced. Planner observations
and performance recommendations remain pending actual authorized execution.

## Offline verification

| Check | Result |
| --- | --- |
| `npm.cmd run typecheck` | Passed, exit 0; includes compilation of integration source without evaluation. |
| `npm.cmd run lint` | Passed, exit 0 after correcting teardown-only lint findings. |
| Relevant offline tests below | 601/601 passed in ten files, exit 0. |
| `npm.cmd run build` | Passed, exit 0. |
| `assertApprovedChain(); await verifyMigrationFiles()` through `node --import tsx` | Four approved SQL and three frozen-baseline hashes verified offline, exit 0. |
| TypeScript AST parse without importing the suite | Zero syntax diagnostics; exactly 18 cases identified, exit 0. |
| Tracked diff and both new-file whitespace checks | Passed; no whitespace diagnostics. |

```powershell
npm.cmd run test -- packages/contracts/src/applications.test.ts apps/api/src/modules/applications/search-filtering.test.ts apps/api/src/modules/applications/service.test.ts apps/api/src/modules/applications/routes.test.ts apps/api/src/modules/applications/pagination.test.ts apps/api/src/modules/applications/date-policy.test.ts apps/api/src/modules/applications/edit-history.test.ts apps/api/src/modules/applications/lifecycle.test.ts apps/api/scripts/migration-policy.test.ts apps/api/src/config/database.test.ts
```

The normal test configuration excludes integration files. Client generation uses
the existing offline wrapper with inert datasource metadata. The earlier
[Stage 3E.1 report](checkpoint-3e1-offline-report.md) records its full 1,981-test
offline regression; that full suite was not rerun in this preparation pass.

Future targeted command, **not executed or authorized by this report**:

```powershell
$env:NODE_ENV = 'test'
npm.cmd run test:integration -- apps/api/tests/application-search-filtering.integration.test.ts
```

Fresh independent read-only preflight, review and separate execution authorization
remain required. Live matching, PostgreSQL collation, planner observations, runtime
timing, fixture cleanup and final connection closure remain unverified. There is
no claim of production performance or browser acceptance. Development database
access, frontend implementation, staging, commits and pushes remain out of scope.
