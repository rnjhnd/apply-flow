# Stage 3E.3 - Frontend search/filter offline report

## Result and evidence boundary

Frontend search and single-status filtering are implemented for review on
`feat/application-search-filtering`, HEAD `b5228b3`, starting from a clean working
tree. Offline verification passed. No database connection, PostgreSQL integration
execution, browser session, application/database service, migration, reset, seed
or database cleanup occurred. Nothing was staged, committed or pushed.

Prior Stage 3E.2 live PostgreSQL results are separate evidence and were not rerun.
Backend queries, shared contracts, authentication/session policies, navigation
adapter, Prisma schema, historical SQL/baselines and checksum policies are unchanged.
No dependencies or URL/storage synchronization were added.

## State, interactions and reconciliation

- The existing workspace-owned list controller holds independent draft/applied
  filters for Active and Archived above temporary protected-content unmounts.
  Same-account verification preserves them. Confirmed logout/account replacement
  clears both views, list data, cursors and pending reconciliation/focus state.
- A labelled native search input and single-status select expose All statuses
  and the seven existing statuses. Typing/selecting does not fetch. Search/Enter
  validates using the existing contract and applies canonical values. Clear filters
  clears both values in the current view and immediately requests page one.
  Applied criteria and unapplied draft changes are displayed separately.
- Transport sends optional normalized q/status with existing view/limit/cursor
  conventions; blank/omitted filters are omitted. Responses remain server-filtered
  and server-ordered. No client-side search matcher or total-count request exists.
- Search/Clear restart pagination. Re-entering a view remembers its draft/applied
  filters but fetches the applied first page; inactive pages are not cached.
  Load more captures applied criteria, never unsubmitted input, and retains existing
  server order and ID deduplication. Initial loading, loading more, read errors and
  completed empty states are distinct. A failed extra page retains loaded rows and
  its retry cursor; authentication rejection quarantines rows and clears the cursor.
- Reads capture account, view, applied-filter object and request generation.
  Superseded reads are aborted; late successes/errors cannot apply after replacement,
  even if the injected transport ignores cancellation. Existing session-coordinated
  transport authority checks remain in place.
- Applying/clearing filters does not close the editor, replace its draft or refetch
  its history. A selected application may remain open outside the loaded list.
  The outside-results notice requires a successful, idle, error-free list with no
  next cursor; an unloaded page is never treated as a definitive nonmatch.
- A confirmed company/title/status change supplies its previous saved snapshot to
  the list callback and queues first-page reconciliation. Workspace admission waits
  for editor mutation/detail/history work to settle before dispatching that GET,
  preserving the coordinated history read. Notes/date/location/URL-only edits and
  no-ops retain normal matching-item replacement and pagination.
- Archive/restore/delete retain exact-target removal and existing pagination.
  Creation retains applied filters and refreshes them, explaining that a saved
  application may not appear. Follow-up GET failure is a list error, not a failed
  mutation. Conflict and uncertain-save drafts/recovery remain; no mutation is replayed.
- Existing discard consent for selection/view changes, Cancel, sign-out and workspace
  departure remains. The BrowserRouter adapter and Skip to content behavior are unchanged.

## Accessibility and presentation

The small search landmark uses existing field/button tokens, native labels/select,
minimum-height controls, visible focus and a wrapping/stacking responsive layout.
It introduces no animation; existing reduced-motion button styling is retained.
Validation announces an alert, identifies the invalid input and focuses it.
Explicit filter actions can restore lost focus after a protected-content remount,
but completion does not displace a meaningful editor/control focus. Read status
announces the number currently shown, not a claimed total. Filtered empty results
offer another search/status or Clear; unfiltered empty views retain their existing copy.

## Verification

All final commands below exited 0:

| Command | Result |
| --- | --- |
| `npm.cmd run test -- apps/web/src/lib/applications/api.test.ts apps/web/src/features/applications` | 207/207 focused frontend tests in nine files. |
| `npm.cmd run test` | 2,014/2,014 offline tests in 59 files. |
| `npm.cmd run lint` | Passed. |
| `npm.cmd run typecheck` | Passed. |
| `npm.cmd run build` | Passed. |
| `git diff --check` | Passed; new-file whitespace also checked independently. |

The default Vitest configuration excludes PostgreSQL integration suites. Normal
client generation uses the established offline wrapper/inert datasource metadata;
it is not a database connection or migration.

Coverage includes transport encoding/omission, native Enter versus unsubmitted
input, Clear, per-view filters, applied pagination, stale filter/view/account replies,
ignored aborts, account clearing and same-account reconciliation; dirty editor/history
preservation, notes-only versus relevant edits, history-before-list sequencing,
confirmed saves followed by read failure or zero matches, uncertain saves without
replay, honest empty/error feedback and guarded focus. Existing create/edit/lifecycle,
conflict/recovery, navigation and Skip-link regressions passed.

An existing editor HTTP double returned an obsolete company even after a successful
PUT. It now returns that confirmed saved row on the required follow-up list GET;
the test expects that additional read while preserving its payload/list/history/
single-PUT assertions. List presentation fixtures also include the new controller
fields. No security assertions were removed or weakened.

## Changed files

Added:
- `apps/web/src/features/applications/application-filters.tsx`
- `apps/web/src/features/applications/application-search.test.tsx`
- `docs/milestones/checkpoint-3e3-offline-report.md`

Modified:
- `apps/web/src/features/applications/use-applications.ts`
- `apps/web/src/features/applications/use-applications.test.tsx`
- `apps/web/src/features/applications/application-list.tsx`
- `apps/web/src/features/applications/application-list.test.tsx`
- `apps/web/src/features/applications/use-application-editor.ts`
- `apps/web/src/features/applications/application-editor.test.tsx`
- `apps/web/src/features/auth/workspace-page.tsx`
- `apps/web/src/lib/applications/api.ts`
- `apps/web/src/lib/applications/api.test.ts`

## Remaining manual acceptance

No real-browser acceptance, exhaustive accessibility or production-readiness claim
is made. Separately authorized Stage 3E.4 should verify keyboard/Enter/Clear and focus
across session-related remounts; mobile layout and screen-reader announcements;
independent Active/Archived filtered pagination beyond 20 records; dirty editor
preservation, confirmed nonmatching saves and refresh failures; lifecycle/conflict/
uncertain-operation recovery; account switching; Back/Forward and Skip to content.
Filters intentionally do not survive a full reload.

Previous manual limitations, including full Review saved application recovery,
history pagination beyond 20 entries, uncertain network/commit reconciliation,
reduced-motion measurement and exhaustive browser/history cases, remain unverified.
The documented unknown-history-entry navigation fallback limitation is unchanged.
No blocking defect remains from the offline verification. Stage 3E.4 was not started.
