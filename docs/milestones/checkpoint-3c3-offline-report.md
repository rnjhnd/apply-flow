# Stage 3C.3 - React application editing and status history

## Scope and evidence boundary

Implementation started from clean branch `feat/job-applications`, HEAD
`9a12e4f667a6d2a80c6c9826e8f1867ab6949dfa` (Stage 3C.2 integration documentation).
This pass implements the frontend only and records offline verification.

During implementation and offline verification, no database connection, migration, integration suite, browser test, service
launch, dependency installation, staging, commit, push or branch change was performed. The earlier
11/11 PostgreSQL integration result and verified test migration 0003 are prior
evidence supplied by the user, not tests rerun here. The development database
remains unmigrated to 0003 and was not accessed.

The report was subsequently updated during the final staging review to record
both navigation corrections. That review did not rerun tests or modify application files.

## Editing and history interactions

- Each listed application has a labelled Edit application button with expanded
  state and a relationship to its open detail panel.
- The existing workspace grid places the editor beside the list on desktop and
  above it on smaller screens. Opening an editor temporarily replaces the Add
  application form; its unfinished creation draft remains owned by the page.
- Fresh authenticated detail is fetched before prefilling all seven editable
  fields. Creation and editing share the same native controls, labels, date hint
  and design-system field styling, while shared Zod contracts validate input.
- Save changes submits the complete normalized representation plus the fresh
  expectedVersion. Confirmed success replaces only the matching loaded list
  item; page cursor, loaded order and other items remain intact. A server-confirmed
  no-op retains its revision and is reported as no changes needed.
- Status changes trigger an independent history read. Failure of that read keeps
  the confirmed save successful and exposes a separate retry.
- History uses newest revision first, local readable timestamps with machine-readable
  time attributes, an explicit no-recorded-changes state and Load older changes.
  Failed older-page reads retain loaded events and retry the failed cursor.
- Detail and history errors have explicit read retries. Missing history never
  causes invented transitions or synthetic creation events.

## Draft, session and concurrency protections

The editor controller lives above AuthRoute's temporary protected-content
unmounts. Draft, baseline application and history remain in memory through
same-account verification and temporary proof loss. Confirmed anonymous state or
an authenticated account replacement clears all editor-owned private state and
invalidates outstanding operation tickets. No drafts enter browser storage.

Reads carry abort signals and account/selection/request ownership checks; late
detail/history responses cannot populate another selection or authenticated
account. The existing private authentication coordinator verifies account and
proof before dispatch and holds its lock through settlement. No authentication
store, authentication endpoint or security policy was changed.

An immediate mutation flag prevents duplicate saves and conflicting selection,
reload and close actions. Accepted PUT requests are not aborted when content
unmounts, and uncertain writes are never automatically replayed. A confirmed
success from a superseded controller/account is not applied to the current UI.

409 APPLICATION_CONFLICT preserves the draft and offers read-only review or an
explicit confirmed reload/discard. Network, protocol and server uncertainty also
preserves the draft, blocks further PUT submissions and offers a fresh read-only
review. Reading the saved version does not silently replace the draft or infer
which earlier request committed; explicit reload is required before editing resumes.

Dirty close, selection replacement, reload and sign-out require confirmation.
Document departure uses beforeunload. The initial indexed-POP guard had a blocking
draft-lifetime defect discovered by the subsequent source audit. The targeted
navigation correction below supersedes that guard. Modified/new-tab links do not
discard the active draft.

The panel provides native keyboard controls, persistent labels, error associations,
focused local/server error summaries, focus on panel/review/history targets and
focus restoration to the current Edit action on close, with the list heading as
fallback. The existing reduced-motion and visible-focus styling is retained.

## Files created and modified

Created under `apps/web/src/features/applications/`:

- `application-editor.tsx`: editing, recovery and status-history presentation.
- `use-application-editor.ts`: page-owned editor lifecycle and recovery state.
- `application-fields.tsx`: shared creation/editing controls.
- `application-field-policy.ts`: seven field names, labels and status labels.
- `application-editor.test.tsx`: workspace/component tests through the real
  authentication coordinator with an in-memory HTTP double.
- `use-application-editor.test.tsx`: deferred-response controller tests.

Modified:

- `apps/web/src/lib/applications/api.ts` and `api.test.ts`: typed detail, PUT and
  revision-cursor history methods, strict validation and sanitized conflict codes.
- `apps/web/src/features/applications/application-form.tsx`: reuse shared controls.
- `apps/web/src/features/applications/application-list.tsx` and its test: Edit
  actions, selection state and action interlocks.
- `apps/web/src/features/applications/use-applications.ts` and its test: replace a
  saved loaded item without resetting pagination.
- `apps/web/src/features/auth/workspace-page.tsx`: compose editor above the
  existing session boundary and confirm dirty sign-out.
- This milestone report.

## Initial offline verification

| Command | Observed result |
| --- | --- |
| `npm.cmd run lint` | Final exit 0. |
| `npm.cmd run typecheck` | Exit 0; Prisma generation uses the existing offline wrapper. |
| `node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json` | Exit 0 during focused development. |
| `npm.cmd exec -- vitest run apps/web/src/features/applications apps/web/src/lib/applications/api.test.ts` | Exit 0; 101/101 tests in six files. |
| `npm.cmd exec -- vitest run` | Final exit 0; 1,678/1,678 tests in 54 files. Default configuration excludes database-backed integration suites. |
| `npm.cmd run build` | Exit 0 for contracts, API and frontend. |
| `git diff --check` and separate new-file whitespace inspection | Exit 0; no whitespace errors. |

Coverage includes fresh prefilling, complete payloads and autofill, local/server
error focus, dirty confirmation and focus restoration, save/no-op behavior,
conflict and uncertain outcomes, independent history errors and cursor retry,
stale selection/account results, logout, same-account session unmounts, no PUT
replay and existing creation/list/load-more regressions. History transport rejects
malformed, unordered, duplicate and nonprogressing cursor responses. New transport
methods are also checked for owner replacement and 401/403 reconciliation.

Initial checks identified shared exports incompatible with the Fast Refresh rule,
an unused test variable, inherited-versus-explicit button disabling, and reused
mock Response bodies. Those issues were corrected before the passing results.
No failing acceptance assertion was removed.

## Targeted navigation correction after source audit

The audit found that missing/equal history indexes bypassed confirmation while
`WorkspacePageContent` was keyed by location, allowing same-workspace fragments
to destroy the controller. Restoration also swallowed the next POP indiscriminately.

- Removed the workspace location key. The same controller now owns the draft,
  selection and history through fragment changes and session-boundary remounts.
- Added `workspace-navigation.ts`, `workspace-navigation-context.ts` and
  `workspace-navigation-provider.tsx`, mounted around App's existing Routes.
  Router push/replace departures are checked before commit. History entries have
  independent per-document identities and positions, without relying on router
  `idx`. The existing native document-leave guard is retained.
- Cancelled POPs restore only the recorded destination. Interleaved events are
  checked by identity and URL; unrelated POPs are processed normally. A one-second
  settlement bound disarms outstanding restoration expectations if events never
  arrive. No `go(0)` or reload is used for cancellation.
- The workspace skip link is router-managed, remains an anchor and explicitly
  focuses the main landmark. Native fragment entries are also admitted without
  replacing the controller.
- React Router 8.5.0's `useBlocker` requires a data router; this application uses
  declarative BrowserRouter. Its installed implementation additionally warns
  that unmanaged POPs without deltas cannot be blocked reliably. A router-mode
  migration alone would not meet this correction's requirements. The scoped
  adapter uses `UNSAFE_NavigationContext` and the native History API, adding no
  dependencies or authentication changes. Recheck the adapter on router upgrades.
- Extended `application-editor.test.tsx` with BrowserRouter and jsdom's actual
  asynchronous Back/Forward, fragment/skip-link, missing/equal/unexpected router
  indexes, cancelled/confirmed departure and clean-editor cases. Added
  `workspace-navigation.test.tsx` for programmatic push/replace, Forward departure,
  interleaved/delayed/missing restorations, document departure and foreign metadata.
  These replace the hook test's earlier mocked indexed-POP test; its behavior is
  now covered more directly. Session/account/conflict/uncertain-PUT regressions
  remain in the existing suite.

First navigation correction verification:

| Command | Observed result |
| --- | --- |
| `npm.cmd exec -- vitest run apps/web/src/features/applications apps/web/src/lib/applications/api.test.ts` | Exit 0; 121/121 tests in seven files. |
| `npm.cmd exec -- vitest run` | Exit 0; 1,698/1,698 tests in 55 files, including the tightened assertion. |
| `npm.cmd run lint` | Exit 0. |
| `npm.cmd run typecheck` | Exit 0; client generation remained offline. |
| `npm.cmd run build` | Exit 0. |

## Second navigation correction: untrusted POP positions

The next source audit found a separate blocking bookkeeping defect: unknown
POP arrivals were assigned `accepted.position + 1`, although an arrival proves
neither direction nor adjacency. After clean Back admission of an older unknown
entry, a later cancelled departure could consequently request the wrong traversal.

The correction separates entry identity from position. Unknown POP entries have
`position: null`. Trusted positions contain a segment and offset; only observed
pushes establish adjacent offsets. A push from an unknown parent starts a separate
segment without promoting that parent's identity or relating it to older positions.
`history.go(delta)` is used only for a safe nonzero delta within the same trusted
segment. Fallback replacement and ordinary replacement of an unknown entry keep
its position untrusted rather than copying a trusted target position.

The change was limited to `workspace-navigation.ts`, `workspace-navigation.test.tsx`
and `application-editor.test.tsx`. Regressions cover the exact older-unknown
sequence and its Forward counterpart using actual jsdom history traversal,
missing/equal/unexpected router indexes, repeated cancellations and return to a
known entry with the draft intact. Controlled-event tests additionally cover
interleaved restoration, untrusted fallback metadata and independent push segments.

Recorded results from that completed correction pass (not rerun during staging review):

| Command | Observed result |
| --- | --- |
| `npm.cmd exec -- vitest run apps/web/src/features/applications apps/web/src/lib/applications/api.test.ts` | Exit 0; 131/131 tests in seven files. |
| `npm.cmd exec -- vitest run` | Exit 0; 1,708/1,708 tests in 55 files. |
| `npm.cmd run lint` | Final exit 0. |
| `npm.cmd run typecheck` | Final exit 0 after correcting a test-helper optional-property type; client generation remained offline. |
| `npm.cmd run build` | Exit 0. |
| `git diff --check` and scoped untracked-file whitespace inspection | Exit 0; no whitespace errors. |

## Limitations and final inventory

Offline tests use controlled HTTP and session doubles. They do not establish live
browser layout, screen-reader behavior, real native confirmation/history behavior,
or browser-to-PostgreSQL acceptance. Native document-leave prompts remain subject
to browser policy. BrowserRouter Back/Forward is exercised in jsdom; interleaved
events and timeout paths additionally use controlled synthetic POPs. Neither
establishes real-browser behavior during rapid traversal, native modal prompts,
or document restoration from the back-forward cache.

For an unrecognised history entry with no private position, the adapter cannot
reconstruct its position safely. Cancellation restores the accepted URL/state
with replaceState instead of guessing traversal direction. This can replace that
unowned destination entry. It preserves the draft and URL, but cannot guarantee
return to the original history slot or preservation of the exact history stack.
The replacement receives an untrusted position. Traversal restoration requires
both endpoints to have trusted positions in the same segment; separate segments
also use the fallback rather than guessing a direction.
The bounded missing-event fallback has the same tradeoff. Manual browser review
should include these recovery paths. Drafts are intentionally memory-only and are lost after confirmed
departure or reload. Future dates are finally enforced by the existing backend
date policy, with field errors surfaced by the editor.

Development migration 0003 and manual browser acceptance still need separate
authorization. The blocking navigation defect identified after the initial
offline review and the subsequent untrusted-position defect are addressed by the
two corrections above; browser acceptance is pending. A separately scoped migration
to a data router with `useBlocker` would offer supported blocking for router-owned
navigation, but arbitrary foreign POPs would still require an explicit fallback policy.
Archive/delete and any generic activity-log or state-management framework remain
outside this stage.

Before the final staging review, the Git inventory was ten modified tracked
frontend files and eleven new files (ten frontend files plus this report), all
unstaged. Branch and HEAD remained unchanged. All backend source, contracts,
migrations and authentication internals are unchanged.

The tracked-only pre-staging diff was 203 insertions and 50 deletions; the eleven
new files were additional to those totals. The final staged filenames and complete
diff summary are reported separately by the staging review.
