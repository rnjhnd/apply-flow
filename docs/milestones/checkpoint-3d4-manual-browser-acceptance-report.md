# Stage 3D.4 - Development rollout and manual browser acceptance

## Result and evidence boundary

Stage 3D.4 development rollout and manual browser acceptance are complete, with
the unverified paths below. Browser results are user-reported manual observations;
migration results come from the previously verified guarded execution and its
independent read-only checks. Automated results are referenced separately.

Repository baseline verified for this report: `feat/application-lifecycle`, HEAD
`423a625`, initially clean with an empty index. This documentation pass did not
access a database, rerun tests, launch services or perform browser checks. No
browser automation, exhaustive accessibility coverage or production readiness is
claimed.

## Previously verified development migration

Migration `0004_application_lifecycle` was applied exactly once through the guarded
development wrapper to `127.0.0.1:15432/applyflow_dev` as `applyflow_dev`, with
NODE_ENV=development. The command completed with exit code 0:

```powershell
$env:NODE_ENV = 'development'
npm.cmd run db:migrate:deploy -- --approved-sql-sha256 cfa58ef4e3bbe91b5271291033ef33412194e2ce8dba91071047982f42dcda8c
```

Its recorded checksum matched that approved SHA-256, and exactly migrations
0001-0004 were successfully completed. Independent post-verification confirmed
nullable TIMESTAMPTZ(3) archivedAt without a default, preserved existing schema
constraints/indexes, and all 22 pre-existing applications with archivedAt=NULL.
All three pre-existing status-history records were preserved. Application and
history fingerprints matched their pre-migration values, covering original fields,
versions and timestamps. Inspection transactions rolled back and connections closed.
No unauthorized database operation or migration retry occurred.

These are immediate post-migration preservation findings, not a claim about record
counts after subsequent manual creation, lifecycle actions or disposable-record
deletion. This completes the development-migration prerequisite that remained
pending in the earlier offline report.

## User-reported manual browser observations

| Check | Reported result |
| --- | --- |
| Development launch and login | Application launched and login succeeded. |
| Archive | Removed the application from Active and displayed it in Archived. |
| Archived details | Details, status and history remained available; editing was disabled. |
| Restore | Returned the application to Active with its original details, status and history. |
| Deletion confirmation | Inline confirmation identified the application and displayed the permanent-removal warning. |
| Cancel deletion | Preserved the disposable test application. |
| Confirm deletion | Removed the disposable application; it remained absent after refresh. |
| Two-tab stale archive | Two tabs editing the same application detected a stale archive conflict in Tab B. This observation alone does not establish overlapping SQL transactions. |
| Cancel dirty archive | Unsaved Notes draft was preserved. |
| Confirm dirty archive | Unsaved Notes were discarded; saved application content remained unchanged as the application was archived. |
| Active/Archived switching | Displayed the correct records. |
| Cancel dirty view switch | Preserved the editor and draft. |
| Confirm dirty view switch | Discarded the draft. |
| Active Load more | Loaded additional applications without observed duplicates. |
| Back/Forward cancellation | Preserved unsaved changes. |
| Skip to content | Preserved the draft and moved focus. |
| Deletion keyboard behavior | Confirmation keyboard focus and Escape cancellation worked. |
| Mobile viewport | Controls were readable and usable; viewport dimensions were not recorded. |

## Unverified manual paths and limitations

The following are **unverified, not passed**:

- Full Review saved application conflict-recovery interaction.
- History pagination beyond 20 entries.
- Archived-view pagination beyond 20 records.
- Uncertain network/commit outcomes and read-only reconciliation.
- Exhaustive accessibility, browser and browser-history edge cases.
- Reduced-motion behavior, which was not independently measured.

These remain future verification work, not reported blocking defects. Passing
Active Load more does not establish Archived pagination or history pagination.
The existing unknown-history-entry navigation fallback limitation documented in
the [Stage 3D.3 report](checkpoint-3d3-offline-report.md) remains: observed navigation
cancellation does not prove preservation of every original history slot/stack or
cover foreign entries, rapid traversal or back-forward-cache behavior. No request
should be automatically replayed to exercise an uncertain destructive outcome.

## Previously completed automated evidence

These recorded results were not rerun for this report and are separate from the
user-reported browser observations above:

| Milestone | Existing evidence |
| --- | --- |
| [Stage 3D.2A](checkpoint-3d2a-offline-report.md) | 1,854/1,854 offline tests; passing lint, typecheck and build. Local doubles do not prove PostgreSQL lock behavior. |
| [Stage 3D.2B](checkpoint-3d2b-postgres-execution-report.md) | 22/22 live PostgreSQL lifecycle integration tests, including seven genuine concurrency races requiring observed application-row lock waits; ownership, rollback, scoped deletion and zero-residual cleanup verified. |
| [Stage 3D.3](checkpoint-3d3-offline-report.md) | 1,897/1,897 offline tests, including 174 focused frontend tests; passing lint, typecheck and build. HTTP doubles/jsdom do not substitute for unverified manual paths. |

Only this acceptance report was added. Application source, tests, existing reports,
migrations and Git history were unchanged; no database access, migration, reset,
seed, cleanup, test execution, service launch, staging, commit or push occurred
during this documentation task. No further operation is authorized by this report.
