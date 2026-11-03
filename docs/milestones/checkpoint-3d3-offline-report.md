# Stage 3D.3 - Application lifecycle frontend offline report

## Scope and result

Implemented on `feat/application-lifecycle`, HEAD `c99331b`, from a clean working
tree. The lifecycle frontend and offline verification are complete for review.
No development/test PostgreSQL access, integration execution, migration, reset,
seed, database cleanup, browser acceptance or service launch occurred. Nothing
is staged or committed. Prior Stage 3D.2 live results are separate evidence.

## Architecture and interactions

- Extended the existing workspace-owned list and editor controllers above the
  protected-content boundary. No parallel state store, form framework, dependency,
  backend/authentication change or navigation-adapter rewrite was introduced.
- Active is the default. Native Active/Archived buttons expose aria-pressed state.
  A switch starts a fresh first-page request, clears the previous page/cursor,
  aborts superseded reads and tags responses by request generation and view.
  Cursors never carry between views. No browser-history entry is created.
- Application creation remains in Active; its controller rejects creation from
  Archived. Existing creation, refresh, ordering and Load more behavior remain.
- Actions use freshly retrieved details and the current application version.
  Archive confirms abandonment of a dirty edit but retains that draft until a
  successful response. It removes only the target from Active after confirmation.
- Archived details show the seven supported fields, current status/date, archive
  time and existing status history without edit/status controls. History retry
  and older-page loading remain independent of mutation outcomes.
- Restore uses expectedVersion, removes only the restored target from Archived,
  retains unrelated items/cursor and does not switch views or reposition it.
  Refreshing Active retrieves server ordering by original creation position.
- Permanent deletion requires inline confirmation naming the role and company,
  explaining removal of all status history and the irreversible result. Cancel
  receives initial focus; Escape or Cancel dismisses and restores initiating-action
  focus. Only the final confirmation sends the strict expectedVersion/true payload.
  No item is removed before confirmed deletion.

## Recovery, account isolation and navigation

The transport retains only the contract-validated conflictReason, never arbitrary
server messages or exception bodies. The panel distinguishes STALE_VERSION,
APPLICATION_ARCHIVED and APPLICATION_NOT_ARCHIVED, retaining drafts and recovery
context with explicit read-only review or confirmed reload/discard. Review displays
the current saved lifecycle state as well as fields without replacing the draft.

Unknown archive/restore/delete outcomes retain context and block replay. A later
404 says the application is unavailable without attributing removal to any request.
Details retry remains read-only during recovery, including after that 404; only
explicit consent followed by reload can replace the draft. Mutation requests are
neither aborted nor automatically retried. Duplicate/conflicting panel mutations
are rejected synchronously, with strict response target/state checks in transport.

Existing same-account reconciliation retains editor/view state across temporary
protected-content unmounts. Confirmed logout or account replacement clears private
selection, draft, history, confirmation and list state. Owner/generation/selection
checks reject late responses. Additional ID checks prevent retained action handlers
from transferring an earlier application's version or deletion confirmation to a
new selection.

Dirty-draft navigation/sign-out consent and Skip to content remain on the existing
BrowserRouter adapter. Focus restoration now runs after the workspace DOM mounts,
so mutation completion cannot lose focus while protected content is temporarily
absent. This also preserves close-to-entry focus with a list-heading fallback.
Native controls, visible focus, role=status/alert feedback, existing mobile/desktop
grid and motion-reduce Button styling are retained. No new animation was added.

## Offline verification

| Command/check | Final observed result |
| --- | --- |
| `npm.cmd exec -- vitest run apps/web/src/lib/applications/api.test.ts apps/web/src/features/applications` | Exit 0; **174/174** focused tests in eight files. |
| `npm.cmd exec -- vitest run` | Exit 0; **1,897/1,897** offline tests in 57 files. Default configuration excludes PostgreSQL integration suites. |
| `npm.cmd run lint` | Exit 0. |
| `npm.cmd run typecheck` | Exit 0, including root/test TypeScript checks. |
| `npm.cmd run build` | Exit 0; contracts, API and web. Prisma client generation is offline. |
| Scope, protected hashes and whitespace | Passed; all four migration and three frozen baseline hashes remain pinned; backend, contracts, dependencies, historical safeguards and navigation adapter are unchanged. |

The focused set includes 43 added cases over the existing 131. Coverage includes
strict transport/payload/version targeting, all three conflict reasons, unknown
writes without replay, isolated view pagination, stale responses, scoped list
updates, read-only archived details/history, explicit confirmation, Escape/focus,
dirty view switching, account replacement/logout during pending operations,
same-account recovery, retained-handler targeting and existing create/edit/history
and navigation regressions.

Verification found and corrected a post-mutation focus timing defect and the
retained-handler targeting risk. Test typing initially required the new API/list
mock fields and valid Testing Library options. A Skip-link assertion was adjusted
to await session reconciliation before inspecting the preserved draft. Final
assertions pass without relaxing security or data-preservation expectations.

Tests use injected HTTP doubles and jsdom, including existing BrowserRouter
history traversal regressions. They do not establish real browser behavior, live
frontend-to-PostgreSQL behavior or exhaustive accessibility conformance. React
best-practices review covered functional state updates, effect cleanup, stable
controller ownership, stale-response checks and semantic/focus behavior.

## Changed files

Modified production frontend files:

- `apps/web/src/lib/applications/api.ts`
- `apps/web/src/features/applications/use-applications.ts`
- `apps/web/src/features/applications/use-application-editor.ts`
- `apps/web/src/features/applications/application-editor.tsx`
- `apps/web/src/features/applications/application-list.tsx`
- `apps/web/src/features/auth/workspace-page.tsx`

Modified tests:

- `apps/web/src/lib/applications/api.test.ts`
- `apps/web/src/features/applications/use-applications.test.tsx`
- `apps/web/src/features/applications/use-application-editor.test.tsx`
- `apps/web/src/features/applications/application-list.test.tsx`

New files:

- `apps/web/src/features/applications/application-lifecycle.test.tsx`
- `docs/milestones/checkpoint-3d3-offline-report.md`

This report is the only documentation addition. Final inventory is ten modified
files and two new files, with an empty index; existing milestone reports remain
unchanged.

## Remaining acceptance boundary

- Development migration 0004 remains pending according to the supplied baseline;
  development was not inspected. Do not start this archive-aware backend against
  that database before separate migration authorization and verification.
- After that prerequisite, manual browser acceptance must exercise archive/restore
  and permanent deletion, real multi-tab conflicts and uncertain-operation review,
  same-account/session changes, keyboard/focus/Skip-link behavior, Back/Forward,
  mobile layout and reduced motion. No browser acceptance is claimed here.
- Exercise history beyond 20 entries and view-specific Load more against real
  data. Pagination remains a keyset sequence across requests, not a snapshot.
  External lifecycle changes may require Refresh; restoring does not jump views
  or insert a record into an unloaded page.
- The previously documented unknown-history-entry navigation fallback limitation
  remains; the adapter is unchanged. Synthetic/jsdom tests do not remove that
  real-browser verification requirement.

No known blocking defect remains after offline verification. Stage 3D.4 and
development database operations require separate authorization.
