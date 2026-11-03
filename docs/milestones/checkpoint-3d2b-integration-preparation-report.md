# Stage 3D.2B - Lifecycle PostgreSQL integration preparation

## Scope and evidence boundary

Prepared offline on `feat/application-lifecycle`, HEAD
`5972221c6e2733232fc2c9b1d51c6d3f6d270545`, with the existing uncommitted
Stage 3D.2A work preserved. This checkpoint implements test source only. Neither
PostgreSQL database was accessed; no integration suite, fixture, cleanup or
migration was executed. The previously verified test migration 0004 is supplied
context, not a new observation.

The suite has 22 parameter-expanded cases. The table below describes assertions
prepared for a future live run, not passing PostgreSQL results.

## Test inventory

| Cases | Prepared coverage |
| --- | --- |
| 1 | Archive/restore persists server timestamps and single revision increments while preserving original details, status, date and existing events. A subsequent status change records the actual prior status at revision 5, with the lifecycle gap after revision 2. |
| 1 | Current-version restore/archive no-ops preserve application timestamps and revision; stale repeats conflict before eligibility/no-op checks. Archived edits, including unchanged payloads, and active deletion reject without committed session refresh. |
| 1 | Owned detail/history remains readable in either view; foreign and missing detail, history, edit, archive, restore and delete have identical 404 bodies without committed session activity. |
| 3 | Permanent deletion with zero, one and three events removes only the archived owned parent and its children. Same-owner siblings and another owner's application/history survive. Repeated deletion returns 404. |
| 2 | Failure after real child deletion, and invalid response after real parent deletion, each roll back parent/children/session activity. Probe flags assert that the underlying deletes actually ran before failure. |
| 2 | Lifecycle update failure and invalid archive response roll back application and session activity. |
| 1 | Deliberately rolled-back SQL probes require the RESTRICT parent FK, positive application version, required non-Saved date, differing history statuses and history revision >=2. |
| 7 | Real transaction contention: edit/archive in both orders; archive/archive; archive/restore in both orders; restore/delete in both orders. Assertions distinguish the legitimate restore no-op followed by archive from competing substantive operations. |
| 1 | Default active view and explicit archived pages independently enforce owner/lifecycle filters, createdAt/id descending order, tied timestamps, strict cursor boundaries, foreign anchors and removed anchors. Restore retains original ordering. Each view starts its own cursor walk. |
| 1 | Anonymous, expired, revoked, unknown and absent sessions; missing/wrong CSRF; missing/untrusted Origin; request marker/fetch metadata and unsupported content type reject without committed effects. Detail/history also reject invalid stored sessions. |
| 1 | Strict payloads, UUIDs, query parameters, malformed/oversized JSON, maximum limits and explicit boolean deletion confirmation are enforced. |
| 1 | Substantive lifecycle changes fail at INTEGER version exhaustion; current-version lifecycle no-ops remain valid. |

## Admission and fixture safeguards

The new suite reuses the edit/history suite's local patterns rather than adding
a shared fixture framework or importing another test file.

- No top-level connection. Before any test write, require NODE_ENV=test and the
  exact configured endpoint `127.0.0.1:5433/applyflow_test`, role applyflow_test.
  Select only the guarded test connection utility, never a development target.
- Verify all four source-approved SQL hashes and three frozen baseline hashes.
  Validate exact completed migration membership, order, checksums and metadata.
- Inspect actual database/current/session roles, PostgreSQL 17 and isolation.
  The server reports its container-side port 5432; the configured client endpoint
  must remain the approved host port 5433.
- A bounded REPEATABLE READ READ ONLY preflight checks empty data tables and
  exact catalog definitions: five tables, 39 columns, 12 constraints, 11 indexes
  and seven enum labels. archivedAt is nullable TIMESTAMPTZ(3), without a default.
  Unexpected inspected schemas, types, routines, triggers, relations or RLS stop
  admission. Source/code configuration does not substitute for actual identity.
- Reject unrelated clients, prepared transactions and lock waits at preflight,
  before cases, before cleanup and during final inspections. The read-only
  preflight intentionally rejects its transaction to invoke rollback; its pool
  is closed before the separate execution pool is opened.
- Every guarded write transaction rechecks identity, migration history, exact
  catalog and live ownership inventory. Delegated service SQL and mutations
  retain admission and exact ownership predicates. Real service Session ->
  Application locking and Read Committed behavior are forwarded unchanged.
- Pre-record random fixture IDs and a unique run marker. Users require exact
  IDs/run emails; sessions require exact IDs/owners/token hashes internally;
  applications require recorded IDs/owners/company markers; history requires
  recorded IDs/parents/revisions/statuses. Newly allocated create IDs are checked
  for collisions. Authentication material and raw driver exceptions are never
  logged; diagnostics expose recorded/possible residual UUIDs only.
- Cleanup first verifies the whole live inventory, then deletes only exact
  recorded history predicates, application IDs/owners/markers, session proofs
  and user IDs/run identities, in RESTRICT-compatible order. Missing IDs from
  successful product deletion or rolled-back probes are allowed; unrelated or
  ambiguous records stop writes. There is no broad deletion, reset or retry.
- Independently verify committed zero counts, catalog/history preservation and
  clients after cleanup through another explicitly rolled-back read-only
  inspection. Disconnect in afterAll even when admission or final checks fail.
  An ambiguous commit, transaction/connection error or cleanup failure stops
  further writes and retains recorded possible residual IDs for diagnosis.

These are source safeguards, not evidence that live cleanup or closure passed.

## Concurrency and fault methodology

Each race uses two distinct authenticated sessions plus an independent real
PostgreSQL transaction holding the exact owned application row FOR UPDATE.
The first HTTP request must be observed waiting before the second starts. Both
must then appear in pg_stat_activity with application FOR UPDATE lock waits and
nonempty pg_blocking_pids before the holder releases. Requests are awaited and
failures handled immediately; there is no mocked SQL, in-memory race mutex or
sequential-request claim of concurrency. Bounded gates, SQL timeouts and polling
fail the case if actual overlap is not established.

Both orders are covered where winner order affects semantics. Competing
substantive operations must produce one success and one stale conflict, or a
missing-parent response when deletion wins. The losing session's committed
activity is compared with its original timestamps. Restore on an active row may
legitimately no-op before archive; both requests then succeed with only one
revision increment. Parent/history state must match the actual winning operation.

Fault wrappers forward actual Prisma deletes and updates inside the real service
transaction. They inject an exception after child deletion or corrupt the return
value after parent deletion to exercise pre-commit response validation. Independent
committed snapshots compare parent, events and safe session activity afterward.
No connection is deliberately severed at COMMIT and no uncertain write is replayed.

## Compatibility changes

- `apps/api/tests/application-edit-history.integration.test.ts`: require the
  four-migration table inventory and append the exact archive column definition.
- `apps/api/tests/applications.integration.test.ts`: require that inventory,
  nullable archive timestamp precision/default and the additive public DTO key.
  Existing fixtures naturally receive NULL; no fixture framework was expanded.
- Historical authentication-only B2/C1 guards, migration policy, migration files,
  baselines, application implementation and existing Stage 3D.2A work are unchanged
  by this checkpoint.

## Offline verification

| Command/check | Observed result |
| --- | --- |
| `npm.cmd run typecheck` | Exit 0, including compilation of integration test source. Prisma client generation was offline. |
| `npm.cmd run lint` | Final exit 0. Initial lint caught error-redaction/finally handling and unused projection variables; these were corrected in the new test source. |
| `npm.cmd exec -- vitest run --project unit apps/api/src/modules/applications/lifecycle.test.ts apps/api/src/modules/applications/routes.test.ts apps/api/src/modules/applications/service.test.ts packages/contracts/src/applications.test.ts apps/api/src/config/database.test.ts apps/api/scripts/migration-policy.test.ts` | Exit 0; 400/400 offline tests in six files. The default unit configuration excludes integration suites. |
| `npm.cmd run build` | Exit 0; contracts, API and web. |
| Protected-artifact SHA-256 inspection | All four migration and three frozen baseline hashes match their existing pins; no artifact changes. |
| `git diff --check` | Exit 0; no whitespace errors. |

No integration file was imported or collected by the offline runner. Typecheck
and lint parse source without invoking its hooks. No new dependency was added.

## Remaining limits and later execution

SQL behavior, actual race ordering, runtime budgets, rollback assertions, residual
counts and connection closure remain unverified until separate live authorization.
No blocking source defect was identified during this preparation review. Existing
create/list/edit/history integration suites received compatibility updates but
were not rerun. Browser behavior and lifecycle UI remain outside this checkpoint.

Cursor format remains the approved view-agnostic tuple format. The tests keep
separate view cursor streams; they do not claim the API rejects cross-view cursor
strings. A cursor grants no access, and every query still filters owner and view.
Pagination across separate requests is not a shared database snapshot.

Future targeted command, ONLY after fresh preflight and execution authorization:

```powershell
$env:NODE_ENV = 'test'
npm.cmd run test:integration -- apps/api/tests/application-lifecycle.integration.test.ts
```

This selects `vitest.integration.config.ts` and only the named file. It was not
executed. No staging, commit, push or database operation occurred.

## Final change inventory

This checkpoint adds the lifecycle integration suite and this report, and modifies
only the two existing application integration suites listed above. The pre-existing
Stage 3D.2A changes remain uncommitted. Final tracked diff: 15 files, 220 insertions
and 50 deletions, including this checkpoint's nine insertions/seven deletions across
the two compatibility files. New files are not included in git diff --stat.

Final Git status is 15 modified and five untracked files; the index is empty:

```text
 M apps/api/src/app.ts
 M apps/api/src/modules/applications/http-error.ts
 M apps/api/src/modules/applications/routes.test.ts
 M apps/api/src/modules/applications/routes.ts
 M apps/api/src/modules/applications/service.test.ts
 M apps/api/src/modules/applications/service.ts
 M apps/api/tests/application-edit-history.integration.test.ts
 M apps/api/tests/applications.integration.test.ts
 M apps/web/src/features/applications/application-editor.test.tsx
 M apps/web/src/features/applications/application-list.test.tsx
 M apps/web/src/features/applications/use-application-editor.test.tsx
 M apps/web/src/features/applications/use-applications.test.tsx
 M apps/web/src/lib/applications/api.test.ts
 M packages/contracts/src/applications.test.ts
 M packages/contracts/src/applications.ts
?? apps/api/src/modules/applications/lifecycle.test.ts
?? apps/api/tests/application-lifecycle.integration.test.ts
?? docs/milestones/checkpoint-3d2a-offline-report.md
?? docs/milestones/checkpoint-3d2b-integration-preparation-report.md
?? docs/plans/stage-3d2b-postgres-integration-design.md
```

Filesystem-only TypeScript AST inspection confirmed the 22-case inventory without
importing the integration module. New-file trailing-whitespace checks also passed.
