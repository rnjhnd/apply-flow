# Stage 3F.1 - Kanban data controller offline report

## Result and scope

The Kanban data controller and narrow List handoff interfaces are implemented
offline for review. Starting repository: `feat/application-kanban`, HEAD
`90fc3f4`, clean working tree and empty index. No visual board, presentation
controls or workspace integration was added. The existing workspace is unchanged.

No database connection, PostgreSQL integration suite, migration, reset, seed,
fixture cleanup, browser session or application/database service ran. Normal
Prisma client generation used the existing offline wrapper, not a database
connection. Backend, shared contracts, authentication implementation, navigation,
schema, approved migration/baseline artifacts and dependencies are unchanged.
Nothing was staged, committed or pushed.

## Controller and shared filter ownership

`useApplicationBoard` owns an external snapshot local to its workspace lifetime;
it is not a new global state framework. Seven canonical status columns expose
items, independent nextCursor, unloaded/loading/ready/error/excluded phase,
loadingMore and sanitized error. A ready column with no items is a loaded empty
column; an excluded or interrupted first page is not represented as empty.

The existing `useApplications` remains the owner of draft/applied Active and
Archived filters. It now exposes `activeFilters` and the applied-filter type.
Board `configure({ enabled, filters })` consumes Active's submitted snapshot,
canonicalizes through the existing contract and ignores equivalent repeated
configuration. Draft changes do not change its query. Archived filters remain
independent. Presentation/filter changes cancel obsolete work and reset pages;
no URL/history synchronization or local text matcher was introduced.

Each included column requests existing `ApplicationsApi.list` with view=active,
its status, canonical q when present, limit=20 and its own server-issued cursor.
Load more appends only that column, retains transport order and deduplicates IDs.
There is no automatic fetch-all, total-count request or 50-card column ceiling.
Cross-column reads and successive pages are not a consistent database snapshot.

## Scheduling and future workspace integration contract

Initial reads are queued in canonical status order. One board collection promise
can be outstanding, including an obsolete read whose abort is ignored. Every
request uses the existing application transport and actual AuthStore admission,
session verification and coordinator; no alternative authentication path exists.
Busy/recovering authentication and cooldown prevent dispatch. Failed columns
require explicit Retry; eligible unrelated initial columns can continue. A failed
extra page retains its cursor. Retry-After pauses queued work and expiry updates
the snapshot without automatically retrying the failed column.

Stage 3F.2 must own this controller beside the editor above AuthRoute, and:

- Await List `setCollectionEnabled(false)` before enabling Board. This invalidates
  List presentation, preserves filter/draft ownership and waits for its read promise.
- Configure Board from `applications.activeFilters.applied`; call `resume()` only
  while editor mutation/detail/history work is idle.
- Await Board `pause()` before admitting editor work or returning to List.
  Abort alone cannot release the authenticated request lock. Disable Board with
  configure, then enable List and enter a fresh first page when returning to List.
- Keep Board paused throughout editor detail, mutation and follow-up history reads;
  queue notifications during that period and resume only after settlement.
- Preserve the existing editor controller and its dirty draft across presentation
  changes; retain existing consent for actual selection/lifecycle/workspace departure.

The controller starts disabled and paused. No existing workspace caller has been
changed to perform these future operations. Controls, creation notification wiring,
focus behavior and orchestration belong to the separately authorized UI checkpoint.

## Confirmed mutation notifications and stale data

Account-bound `confirmedSaved`, `confirmedCreated`, `confirmedArchived` and
`confirmedDeleted` notifications perform collection reconciliation only; they
never issue mutations. The editor's existing callback shape is adapted at the
future composition boundary without changing the editor implementation.

- Status edits invalidate old/destination included columns; company/title edits
  invalidate the included status column. Only authoritative reads place cards.
- Other confirmed edits replace matching loaded cards while preserving cursors;
  older confirmed versions cannot overwrite newer observed/confirmed versions.
- Creation queues its included status first page. Archive/delete remove the exact
  target, retaining unrelated cards/cursors. Restore remains an Archived workflow;
  re-entering Active/Board obtains fresh pages.
- Confirmed revisions and deletion identities protect against older reads. A
  membership disagreement quarantines the identity across affected columns,
  invalidates their cursors and requires explicit Retry/Refresh or a confirmed
  mutation. A third disagreeing column cannot silently become authoritative.
- A failed reconciliation remains a column read error; no mutation failure,
  editor closure, automatic mutation replay or synthetic history is introduced.

Snapshots hide cards/cursors without verified authenticated authority. Private
same-account state survives verification. Confirmed logout/account replacement
clears private pages, filters, cursors, queues and reconciliation metadata.
Generation guards reject old reads and old-account notification callbacks.

## Verification

The final focused command covers application/controller/navigation regressions,
application transport and the existing auth-store admission tests:

```powershell
npm.cmd run test -- apps/web/src/features/applications apps/web/src/lib/applications/api.test.ts apps/web/src/lib/auth/store.test.ts
```

All final commands exited 0:

| Command | Result |
| --- | --- |
| Focused command above | 314/314 tests in 11 files, including 37 new board cases. |
| `npm.cmd run test` | 2,051/2,051 offline tests in 60 files. |
| `npm.cmd run lint` | Passed. |
| `npm.cmd run typecheck` | Passed. |
| `npm.cmd run build` | Passed. |
| `git diff --check` | Passed; all three new files also passed independent whitespace checks. |

The normal Vitest configuration excludes PostgreSQL integration suites. An
unchanged-scope Git diff also confirmed no backend, contract, authentication,
workspace, transport, migration, schema, configuration or dependency edits.

Verification corrected new fixture/callback typing and fixture cursor/clock
setup. Source review added regressions for interrupted first-page state and a
third disagreeing status column. No existing safety assertions were weakened.

New controller coverage includes all seven filter cases, sequential real-store
admission, 51-card paging, independent cursors/deduplication, empty/error/Retry,
cooldown, ignored cancellation, List/Board/editor handoffs, authentication recovery,
same-account preservation, account replacement/logout, affected-column mutation
refresh, notes-only edits, failed reconciliation and stale membership/revisions.
An injected HTTP double exercises the real editor PUT/history sequence while
Board remains paused. Protected-child remounts do not restart completed reads.
These are offline HTTP-double/jsdom guarantees, not PostgreSQL or browser evidence.

## Changed files and remaining work

Added:

- `apps/web/src/features/applications/use-application-board.ts`
- `apps/web/src/features/applications/use-application-board.test.tsx`
- `docs/milestones/checkpoint-3f1-offline-report.md`

Modified:

- `apps/web/src/features/applications/use-applications.ts`: shared Active filter
  snapshot/type and awaitable collection-read handoff; default List behavior retained.
- `apps/web/src/features/applications/application-list.test.tsx`: supply the two
  additive controller fields in its typed fixture; existing assertions retained.

Stage 3F.2 still needs the visual board, List/Board controls, workspace scheduling
and notification wiring, accessible cards/column controls, responsive layout and
focus restoration. Serial verification/request latency, real-browser remount/focus
behavior, non-snapshot pagination and existing conflict/history/navigation/manual
acceptance limitations remain. No production-readiness claim or live operation
authorization follows from this report.
