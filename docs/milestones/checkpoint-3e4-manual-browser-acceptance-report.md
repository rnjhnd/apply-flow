# Stage 3E.4 - Search/filter manual browser acceptance

## Result and evidence boundary

Stage 3E search and filtering completed backend offline verification, one guarded
PostgreSQL integration execution, frontend offline verification and user-performed
manual browser acceptance, subject to the limitations below. The user reported
**17/17 Phase 1 checks** and **6/6 Phase 2 scenarios** passing. These are manual
observations, not Playwright or other automated browser execution evidence.

Repository baseline for this documentation pass: `feat/application-search-filtering`,
HEAD `b5228b3`, with the expected 12 unstaged Stage 3E.3 files and nothing staged.
This report and the minimal PRD delivery-status update add documentation only.
No database access, test rerun, EXPLAIN, service/browser launch, migration, reset,
seed, fixture cleanup, staging, commit or push occurred during this pass.
No production readiness or complete browser/accessibility coverage is claimed.

## Previously completed automated verification

These historical results were inspected, not newly executed:

| Evidence | Recorded result |
| --- | --- |
| [Stage 3E.1 backend offline report](checkpoint-3e1-offline-report.md) | 1,981/1,981 full offline regression tests; lint, typecheck and build passed. |
| [Stage 3E.2A integration preparation](checkpoint-3e2a-integration-preparation-report.md) | 601/601 relevant offline tests; lint, typecheck, build, protected-file and static integration-source checks passed. Preparation alone did not establish live database behavior. |
| [Stage 3E.2B PostgreSQL execution](checkpoint-3e2b-postgres-execution-report.md) | One authorized execution, exit 0; 18/18 integration tests passed. Real matching/escaping, owner/lifecycle/status predicates, cursor pagination and workflow/security compatibility verified. |
| [Stage 3E.3 frontend offline report](checkpoint-3e3-offline-report.md) | 207/207 focused frontend tests and 2,014/2,014 full offline tests; lint, typecheck, build and whitespace checks passed. |

The historical live command was:

```powershell
$env:NODE_ENV = 'test'
npm.cmd run test:integration -- apps/api/tests/application-search-filtering.integration.test.ts
```

The live execution targeted only `127.0.0.1:5433/applyflow_test`; no development
database was accessed during integration execution. Independent read-only checks
verified unchanged completed migration history 0001-0004 and schema fingerprints,
zero User/Session/JobApplication/ApplicationStatusHistory records after cleanup,
no residual fixture IDs or clients, rollback and connection closure.
Parameterized selective/no-match query-plan probes succeeded, but detailed metrics
were not captured. No production-scale search performance claim follows.

## User-reported manual browser observations - Phase 1

All 17 checks below were reported passing against the development application:

| Check | Reported observation |
| --- | --- |
| 1. Company search | Company-name substrings matched. |
| 2. Title search | Job-title substrings matched. |
| 3. Case handling | Case-insensitive results behaved as expected. |
| 4. Status | Single-status filtering worked. |
| 5. Combined criteria | Search and status worked together. |
| 6. Submission | Search and Enter explicitly submitted criteria. |
| 7. Draft versus applied | Unsubmitted criteria did not change applied results. |
| 8. Clear | Clear filters reset the applied criteria. |
| 9. Lifecycle views | Active and Archived retained independent filters. |
| 10. No matches | Filtered empty results were displayed. |
| 11. Active pagination | Loaded beyond the default first page. This does not establish filtered or Archived pagination beyond 20 matches. |
| 12. Applied pagination | Load more used applied filters rather than unsubmitted draft criteria. |
| 13. Open editor | Search and Clear preserved the dirty editor and status history. |
| 14. Selection consent | Selecting another application retained existing discard confirmation. |
| 15. Keyboard/focus | Tested keyboard and focus interactions worked. This was not exhaustive accessibility testing. |
| 16. Responsive/Skip link | Mobile layout and Skip to content worked. |
| 17. Navigation | Back/Forward worked without search-generated history entries. This does not cover every browser-history edge case. |

## User-reported manual browser observations - Phase 2

All six disposable-application scenarios were reported passing:

| Scenario | Reported observation |
| --- | --- |
| 1. Create outside filters | Disposable application creation succeeded despite absence from the applied results. |
| 2. Company membership change | Saving a changed company name removed the application from matching search results. |
| 3. Status membership change | Saving a status change updated filter membership; saved status history remained correct. |
| 4. Archive under filters | Archiving the disposable application succeeded under active filters. |
| 5. Restore | Restoring the disposable application preserved status and history. |
| 6. Create matching filters | Another disposable application was created and matched the current filters. |

Confirmed mutations succeeded without classifying absence from filtered results
as a failed save. These observations do not establish forced refresh-failure or
uncertain-commit recovery behavior.

## Development inventory and intentionally retained fixtures

The earlier bounded read-only development readiness inspection verified
`127.0.0.1:15432/applyflow_dev`, role `applyflow_dev`, PostgreSQL 17.11, completed
migrations 0001-0004 and the expected schema. Its pre-acceptance inventory was
27 applications: 23 Active and four Archived. That is historical pre-acceptance
evidence, not a new inspection performed for this report.

Two clearly marked development applications were created and intentionally retained:

| Fixture | Company | Last reported lifecycle | Last reported status |
| --- | --- | --- | --- |
| A | AF-3E4-Renamed-Company-A | Active | Applied |
| B | AF-3E4-Test-Company-B | Active | Saved |

Assuming no other changes, the expected post-acceptance total is **29 applications**
(25 Active, four Archived), including these two fixtures. These are inferred
counts, **not independently verified post-acceptance database counts**. No cleanup
is authorized or required. This documentation pass did not modify existing records
or the retained fixtures.

## Unverified manual paths and remaining limitations

The following are **unverified, not passed**:

- Archived pagination beyond 20 matching results.
- Filtered pagination beyond 20 matching results; Active Load more and use of
  applied criteria do not conclusively establish this boundary case.
- Forced successful-mutation/follow-up-list-failure behavior and deterministic
  stale-response/request races: covered offline, not manually established in a browser.
- Cross-account replacement; existing automated owner/account guards are separate evidence.
- Exhaustive screen-reader/accessibility, browser and browser-history behavior;
  reduced-motion behavior was not independently measured.
- Full Review saved application conflict recovery, uncertain-operation/read-only
  reconciliation and history pagination beyond 20 entries. Prior limitations in
  the [Stage 3D.4 acceptance report](checkpoint-3d4-manual-browser-acceptance-report.md)
  remain, including the documented unknown-history-entry navigation fallback.
- Production-scale substring-search performance. Successful small-fixture plan
  probes without detailed measurements do not establish latency or scaling.

Filters intentionally do not persist across a full reload and are not synchronized
to URLs; search/status/view changes do not create browser-history entries. In-memory
per-view filter retention is distinct from persistence through URL navigation.

These are remaining verification boundaries, not reported blocking defects.
Dashboard overview, Kanban, analytics, employment type, salary information and
broader activity history remain planned MVP work. Archive/restore/permanent deletion
and Stage 3E search/single-status filtering are implemented; this report does not
authorize any next milestone or runtime operation.
