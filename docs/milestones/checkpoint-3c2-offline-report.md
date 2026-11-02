# Stage 3C.2 - Application edit and history API offline report

## Scope and evidence boundary

Implementation baseline: `feat/job-applications`, HEAD
`5260361a27fe5b914d38cf0b2e4ff5d4fcb4bc20`, clean before implementation.
Stage 3C.2 contracts and backend support are implemented and verified offline.
This report records the preceding implementation pass; no checks were rerun to
create this document.

No PostgreSQL connection, migration, fixture execution, cleanup, browser test or
service launch occurred during implementation. Prior verification of migration
0003 on the isolated test database is separate historical evidence. Development
remains at migrations 0001 + 0002 and was not accessed. No editing/history UI,
authentication behavior, dependency, schema or migration changes were made.

## API and contract behavior

| Endpoint | Implemented behavior |
| --- | --- |
| `GET /api/applications/:id` | Validates UUID and authentication; returns `{ application }` for the session owner only. |
| `PUT /api/applications/:id` | Requires authentication, session-bound CSRF, and all eight update keys; returns `{ application }`. |
| `GET /api/applications/:id/history` | Verifies parent ownership; returns `{ items, nextCursor }`, default 20/max 50, ordered by applicationVersion descending. |

Application DTOs now include a required positive integer `version`, including
existing create/list responses. PUT requires company, jobTitle, status,
applicationDate, location, jobUrl, notes and expectedVersion. Nullable-value keys
must still be supplied; undefined or omitted keys fail. Existing normalization,
length, URL and date policies are reused. Unknown properties and client-supplied
ownership, timestamps, history or version overrides are rejected.

Missing and other-owner applications produce the same 404. Stale expectedVersion
produces 409 `APPLICATION_CONFLICT`. History exposes only id, fromStatus,
toStatus, applicationVersion and changedAt. Its cursor is a canonical positive
integer revision; subsequent pages select strictly older revisions. Revision gaps
are allowed. Existing status/date rules and all seven statuses are preserved.

## Transaction and security behavior

PUT uses the existing Read Committed transaction behavior and locked session
validation/refresh. It then selects the owned application FOR UPDATE using both
application ID and authenticated owner ID, preserving Session -> Application lock
order. Version comparison occurs against that locked row before application or
history changes.

Normalized complete no-ops preserve version and updatedAt. Substantive changes
update only explicit editable fields, updatedAt and version, incrementing once.
Only an actual status change inserts history with the locked previous status and
resulting revision; changedAt uses the database default. Creation adds no history.
PostgreSQL INTEGER overflow is rejected safely.

Response validation occurs before commit. Exceptions propagate through the
transaction so application changes, history insertion and session refresh roll
back together. Unexpected failures are sanitized 503 responses, with no automatic
mutation retry. Read endpoints also validate public responses before committing
their session refresh. Existing request admission, origin checks, body/JSON limits,
cookie parsing, no-store responses and CSRF conventions are retained.

## Files changed

- `packages/contracts/src/applications.ts` and `applications.test.ts`.
- `apps/api/src/modules/applications/service.ts`, `routes.ts`, their existing
  tests, and new `edit-history.test.ts`.
- `apps/api/tests/applications.integration.test.ts`: expected migration-0003
  table/column/constraint admission and version DTO field; not executed.
- Frontend test fixtures only: `apps/web/src/features/applications/application-list.test.tsx`,
  `use-applications.test.tsx`, and `apps/web/src/lib/applications/api.test.ts` received
  the required version field. Frontend implementation is unchanged.
- This Markdown report was added after the implementation summary.

## Offline verification results

| Command/check | Observed result |
| --- | --- |
| `npm.cmd exec -- vitest run --project unit packages/contracts/src/applications.test.ts apps/api/src/modules/applications` | Exit 0; 280/280 tests, 6 files at the initial focused checkpoint. |
| `npm.cmd exec -- vitest run` | Exit 0; 1,621/1,621 tests, 52 files, before six additional focused cases. Ordinary configuration excludes database-backed integration suites. |
| `npm.cmd exec -- vitest run --project unit packages/contracts/src/applications.test.ts apps/api/src/modules/applications apps/web/src/lib/applications/api.test.ts` | Final exit 0; 306/306 tests, 7 files, including the additional six cases and canonical cursor check. |
| `npm.cmd run lint` | Exit 0. |
| `npm.cmd run typecheck` | Exit 0; Prisma generation was offline. |
| `node node_modules/typescript/bin/tsc --noEmit -p apps/api/tsconfig.json` | Final exit 0 after the additional test cases. |
| `npm.cmd run build` | Exit 0; contracts, API and frontend. |
| `git diff --check` | Passed for implementation changes. |

Coverage includes all 42 distinct status transitions, complete/strict payloads,
normalization, no-ops, non-status edits, revision gaps, stale conflicts, owner
isolation on all three endpoints, sessions and CSRF, UUID validation, history
ordering/cursors, date preservation and rejection, response validation, and
rollback/no-retry behavior. A deterministic staged transaction double exercises
competing saves: one succeeds, one conflicts, and a subsequent transition records
the actual previous status. Supertest composes the real routes/service with that
offline database double.

Initial typechecking exposed a Zod generic composition issue and a generic mock
transaction typing issue; both were corrected before the passing results above.
No tests or assertions were weakened to obtain a pass.

## Limitations and final inventory

Offline doubles establish service orchestration and failure handling; they do not
prove PostgreSQL lock timing, isolation, commit ambiguity or live rollback. A
separately authorized database-backed integration pass remains necessary. The
existing integration suite was updated but not run. No browser acceptance or
automation result is claimed.

The updated application queries require migration 0003. The development database
is still unmigrated; running the updated application endpoints against it requires
separately authorized migration first. Editing/history presentation remains
Stage 3C.3. No blocking defect was found in the offline review.

Before this report: 10 modified tracked files (281 insertions, 19 deletions), plus
the new 260-line offline test file. This report adds one further untracked file.
Branch and HEAD remained unchanged; nothing was staged, committed or published.
