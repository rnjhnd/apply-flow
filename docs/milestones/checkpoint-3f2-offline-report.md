# Stage 3F.2 - Kanban presentation and workspace integration offline report

## Result and evidence boundary

The Active Kanban presentation and workspace integration are implemented offline
for review on `feat/application-kanban`, HEAD `90fc3f4`. The starting inventory
was the five unstaged [Stage 3F.1 files](checkpoint-3f1-offline-report.md), with an
empty index. Offline verification passed; no browser or production-readiness
claim is made.

No database connection, PostgreSQL integration suite, migration, reset, seed,
fixture cleanup, browser session or development/database service ran. Prisma
client generation in normal verification used the established offline wrapper.
Backend, shared contracts, authentication implementation, navigation adapter,
schema, historical SQL/baselines, checksum policies and dependencies are unchanged.
Nothing was staged, committed or pushed.

## Presentation, filters and pagination

- List remains the default. Native pressed-state List/Board controls apply only
  to Active and remember the selected presentation for the workspace lifetime.
  Archived remains List-only; returning to Active restores its presentation.
- Both presentations consume the existing Active draft/applied filters; Archived
  retains independent criteria. Typing does not fetch. Search/Enter and Clear
  apply canonical criteria without changing browser history or closing the editor.
- Seven semantic status sections remain visible in canonical order. A selected
  single status excludes the other six with explicit copy and no requests.
- Each column retains its independent 20-record cursor and Load more/Retry.
  Counts describe shown records, not database totals. Unloaded, loading, failed,
  excluded and successfully exhausted empty columns have distinct feedback.
  Removing the last shown card with a remaining cursor offers Load more rather
  than claiming the status is empty. No truncated global page is client-filtered.
- Full Refresh resets included column pages. Presentation re-entry starts fresh
  pages, while drafts and filters remain. Selected applications outside completed
  results can remain open; unloaded pages never establish a definitive nonmatch.

## Workspace ownership and admission

`useApplicationWorkspace` owns List, Board, editor, presentation and handoff state
above AuthRoute's temporary protected-content unmounts. It composes the existing
controllers rather than adding an authentication path or global state framework.

Before Board starts, List is disabled and its collection promise is awaited.
Before returning to List, Board is paused and awaited, then disabled. Board
configuration consumes Active's applied snapshot; equivalent configuration does
not restart reads. The orchestration effect depends on presentation, submitted
criteria and actual editor/creation work, not every auth receipt or Board render.
Coalesced presentation intents cannot leave the destination collection disabled.

Editor reads pause Board and await outstanding collection work, including a
transport that ignores abort. Account/intent guards reject obsolete handoffs.
Board remains paused through detail, mutation and follow-up history activity and
resumes after it settles. An idle read action retains synchronous selection/discard
consent; only genuinely pending work requires an asynchronous handoff.

Mutations retain synchronous route receipt admission. Save/create/lifecycle/logout
actions pause collection scheduling before invoking existing guarded operations;
they are never queued for later dispatch or automatically replayed. Existing
expectedVersion, date rules, CSRF, conflict and uncertainty handling remain intact.

Confirmed logout/account replacement clears presentation, pending intent and focus
memory; controller account generations clear protected data and reject old results.
Same-account verification preserves valid private state. AuthRoute still hides
protected controls while a coordinated request is busy or authority is unavailable.
This integration does not relax that gate to show cards during verification.

## Card actions and confirmed mutation reconciliation

Native card buttons identify company/title, optional location and application date.
They open the existing fresh-detail editor; no drag-and-drop, inline status update
or alternative mutation endpoint exists. Presentation changes preserve editor,
draft and history without consent; actual selection, lifecycle-view departure,
closing, sign-out and workspace navigation retain existing discard safeguards.

Editor callbacks notify both collection controllers. Confirmed status changes
refresh old/destination included columns; company/title changes refresh their
included status column. Other edits replace matching loaded cards without resetting
cursors. Creation notifies the relevant column. Archive/delete remove only the
confirmed target; restore stays in Archived and Board re-entry reads fresh Active
pages. Existing revision and disputed-membership guards remain unchanged.

Reconciliation waits for editor/history settlement. Failed follow-up reads remain
column errors and do not turn confirmed saves into failures. Dirty/conflict/uncertain
drafts remain available for explicit recovery; no mutation is replayed.

## Accessibility and responsive layout

The full-width board follows the in-page editor/form. Desktop columns have readable
minimum widths inside a labelled, focusable horizontal scrolling region; mobile
uses stacked sections in canonical order. Existing surface/border/type/button
tokens, visible focus, native labels/selects and semantic lists are reused.
No card-motion animation or new UI dependency was added; existing reduced-motion
styles remain.

Closing the editor focuses its card when present, otherwise the collection heading.
Focus memory restores a control only when session work actually removed its focused
DOM; intentionally cleared focus and meaningful current focus are not overridden.
Skip to content remains functional without discarding drafts. Screen-reader and
real scroll/touch behavior still require browser acceptance.

## Offline verification

Final commands exited 0:

| Command | Result |
| --- | --- |
| `npm.cmd run test -- apps/web/src/features/applications apps/web/src/features/auth apps/web/src/lib/applications/api.test.ts apps/web/src/lib/auth/store.test.ts` | 435/435 focused tests in 17 files. |
| `npm.cmd run test` | 2,074/2,074 offline tests in 62 files. |
| `npm.cmd run lint` | Passed. |
| `npm.cmd run typecheck` | Passed. |
| `npm.cmd run build` | Passed. |
| `git diff --check` | Passed; untracked-file whitespace checked separately. |

The two new test files add 23 cases. Component tests cover semantics, state copy,
native Enter/Space activation, metadata, pagination controls and responsive classes.
Workspace tests use the actual AuthStore, application transport and controlled HTTP
responses: mode/filter ownership, discard/focus/Skip behavior, cursor retries,
mutation/history sequencing, lifecycle workflows, conflict/uncertainty without PUT
replay, cooldown, account replacement/logout, same-account verification and ignored
abort handoffs with eventual Board progress. Existing editor/lifecycle/navigation
and authentication regressions passed. These are jsdom/injected HTTP results, not
real-browser, PostgreSQL matching or lock evidence.

Verification corrected asynchronous idle consent, preserved existing eager
List-to-List view reads, fixed new test query/label expectations, constrained focus
restoration and added the remaining-cursor empty-state regression. Existing safety
assertions were retained. The React best-practices skill informed hook/component
review; sequential requests intentionally preserve the approved auth constraints.

## Changed-file inventory

Stage 3F.1 files carried unchanged:

- `apps/web/src/features/applications/use-application-board.test.tsx`
- `docs/milestones/checkpoint-3f1-offline-report.md`

Stage 3F.1 files narrowly extended in this checkpoint:

- `apps/web/src/features/applications/use-application-board.ts`: expose pending-read
  inspection for settlement-aware handoff; no weakening of revision/membership guards.
- `apps/web/src/features/applications/use-applications.ts`: confirmed-creation
  notification and read-settlement inspection, retaining default List behavior.
- `apps/web/src/features/applications/application-list.test.tsx`: additive typed fixture fields.

Stage 3F.2 additions:

- `apps/web/src/features/applications/application-board.tsx`
- `apps/web/src/features/applications/use-application-workspace.ts`
- `apps/web/src/features/applications/application-board.test.tsx`
- `apps/web/src/features/applications/application-board-workspace.test.tsx`
- `docs/milestones/checkpoint-3f2-offline-report.md`

Stage 3F.2 modification:

- `apps/web/src/features/auth/workspace-page.tsx`: presentation, layout, actions
  and focus wiring only; authentication implementation remains unchanged.

## Remaining acceptance and limitations

No approved product architecture was changed. The narrow idle fast path is needed
to preserve existing consent timing and route-receipt admission; pending reads
still require real settlement. AuthRoute's existing privacy behavior limits when
controls are visible during sequential verification and must be assessed for
perceived responsiveness in real browsers.

Stage 3F.3 requires separate authorization for desktop horizontal scrolling and
mobile/touch usability; actual screen-reader announcements and focus through
session remounts; filtered per-status pagination beyond 20; status/date/history
editing, lifecycle actions and stale conflicts; read failures, cooldown and
uncertain-operation review; logout/account switching; Back/Forward and Skip behavior.
Use only separately authorized disposable records. No database fixture or cleanup
operation is authorized by this report.

Serial multi-request latency, non-snapshot cross-column/paginated reads, external
changes and production-scale search performance remain limitations. Prior full
conflict/uncertain-recovery, history pagination, exhaustive accessibility/browser
and unknown-history-entry navigation limitations remain unverified. No Stage 3F.3
execution or further milestone was begun.
