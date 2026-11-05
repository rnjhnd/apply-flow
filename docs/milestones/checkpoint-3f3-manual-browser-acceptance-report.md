# Stage 3F.3 - Kanban manual browser acceptance

## Result and evidence boundary

Stage 3F completed controller implementation, workspace/UI integration, offline
verification and user-performed browser acceptance, subject to the limitations
below. The user reported **22/22 checks passing**: five initial checks, ten
interaction checks and seven mutation checks. These are user-reported manual
observations, not Playwright or other automated browser execution evidence.

Repository baseline for this Stage 3F.4 documentation pass: `feat/application-kanban`,
HEAD `90fc3f4`, with the expected 11 uncommitted Stage 3F.1/3F.2 files and nothing
staged. This acceptance report and the minimal PRD update add documentation only.
No database access, test rerun, browser/service launch, migration, reset, seed,
fixture cleanup, staging, commit or push occurred during this pass. No production
readiness or complete browser/E2E coverage is claimed.

## Previously completed automated verification

These are historical results, not new executions:

| Evidence | Recorded result |
| --- | --- |
| [Stage 3F.1 controller offline report](checkpoint-3f1-offline-report.md) | 314/314 focused tests in 11 files; 2,051/2,051 full offline tests in 60 files. Lint, typecheck, build and whitespace checks passed. |
| [Stage 3F.2 workspace/UI offline report](checkpoint-3f2-offline-report.md) | 435/435 focused tests in 17 files; 2,074/2,074 full offline tests in 62 files. Lint, typecheck, build and whitespace checks passed. |

Stage 3F introduced no backend changes or new PostgreSQL integration suite.
The existing [Stage 3E search/pagination integration evidence](checkpoint-3e2b-postgres-execution-report.md)
and [Stage 3D lifecycle integration evidence](checkpoint-3d2b-postgres-execution-report.md)
remain relevant to reused APIs, but do not independently prove the Kanban UI.
Offline tests use jsdom/controlled HTTP responses and are distinct from the manual
browser observations below.

## User-reported manual observations - Phase 1

All five initial checks were reported passing:

| Check | Reported observation |
| --- | --- |
| 1. Default presentation | The workspace started in List. |
| 2. Columns | Seven Kanban columns appeared in canonical order: Saved, Applied, Assessment, Interview, Offer, Rejected, Withdrawn. |
| 3. Initial loading | Sequential loading completed without persistent admission errors or repeated loops. |
| 4. Saved pagination | Load more expanded Saved from 20 to 23 applications without duplicates. This establishes one column's pagination, not multiple independently paginated columns. |
| 5. Empty columns | Empty-column feedback was correct after loading. |

## User-reported manual observations - Phase 1B

All ten interaction checks were reported passing:

| Check | Reported observation |
| --- | --- |
| 1. Shared filters | List and Board shared applied search filters. |
| 2. Single status | Selecting one status excluded the other six columns. |
| 3. Draft criteria | Unsubmitted draft filters did not affect applied results. |
| 4. Lifecycle views | Active/Archived presentation and filters remained independent; Archived stayed List-only. |
| 5. Dirty editor | List/Board switching preserved the dirty editor. |
| 6. Discard consent | Existing discard confirmation remained available. |
| 7. Editor and loading | Editor focus worked and background Board loading eventually progressed. |
| 8. Input/layout | Keyboard activation, responsive layout and horizontal scrolling worked in the exercised paths. |
| 9. Browser history | Presentation/search changes did not add browser-history entries. |
| 10. Logout | Logout cleared protected data. |

## User-reported manual observations - Phase 2

All seven disposable-application mutation checks were reported passing:

| Check | Reported observation |
| --- | --- |
| 1. Matching creation | Creating an application matching applied Board filters succeeded and reconciled the relevant column. |
| 2. Status change | Saved-to-Applied reconciled the old and destination columns. |
| 3. Company membership | Renaming a company changed its search membership. |
| 4. Notes-only edit | Saving Notes preserved visible Board state. |
| 5. Nonmatching creation | Creation outside applied filters succeeded without treating absence from results as a failed mutation. |
| 6. Lifecycle | Archive and restore retained application data and history. |
| 7. Date validation | Application-date validation prevented an invalid status transition. |

These observations do not establish forced reconciliation failures, complete
conflict recovery or uncertain-commit behavior.

## Development inventory and intentionally retained fixtures

Before Stage 3F acceptance, bounded read-only inspection verified
`127.0.0.1:15432/applyflow_dev`, role `applyflow_dev`, PostgreSQL 17.11 and
completed approved migrations 0001-0004. The inventory was **29 applications:
25 Active and four Archived**, plus one User, one Session and three status-history
records. These are historical pre-acceptance findings, not a new inspection.

Two new Stage 3F disposable applications were created:

| Fixture | Last reported company | Last reported status | Last reported lifecycle |
| --- | --- | --- | --- |
| A | AF-3F-Renamed-Company-A | Applied | Active |
| B | AF-3F-Test-Company-B | Saved | Active |

Both are intentionally retained; no cleanup or deletion is authorized. They are
separate from the existing Stage 3E fixtures, which were not Stage 3F disposable
mutation targets. Assuming no unrelated changes, the expected post-acceptance
inventory is **31 applications: 27 Active and four Archived**. These counts are
inferred, **not independently verified post-acceptance database counts**. No
post-acceptance User, Session or history counts are asserted.

## Unverified manual paths and remaining limitations

The following are unverified, not passed:

- Multiple independently paginated columns beyond 20 records.
- Deterministic aborted/late network responses and forced reconciliation failures:
  covered offline, not manually established in a browser.
- Cross-account browser replacement and two-tab stale conflicts for Stage 3F.
- Exhaustive screen-reader, focus, reduced-motion and browser-history edge cases;
  the reported keyboard/layout/history checks do not establish exhaustive coverage.
- Full conflict/uncertain-operation recovery and history pagination beyond 20.
  Prior limitations in the [Stage 3E acceptance report](checkpoint-3e4-manual-browser-acceptance-report.md),
  including the unknown-history-entry navigation fallback, remain.
- Live latency metrics and production-scale performance, which were not measured.

Seven sequential status queries and subsequent cursor pages do not form a shared
database snapshot; concurrent external changes can affect column membership
between reads. Manual acceptance does not remove this consistency limitation.

Drag-and-drop remains deferred. Dashboard overview, analytics, recent activities,
employment type, salary information and broader activity history remain
unimplemented MVP work. These remaining scope and verification boundaries are not
reported blocking browser defects. This report does not authorize runtime work,
fixture cleanup or the next milestone.
