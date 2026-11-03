# Stage 3D.2A - Application lifecycle API offline report

## Scope and result

Baseline: `feat/application-lifecycle`, HEAD
`5972221c6e2733232fc2c9b1d51c6d3f6d270545`, initially clean. Lifecycle contracts
and authenticated backend operations are implemented and pass offline checks.

No PostgreSQL connection, database fixture, integration test, migration, reset,
seed or database cleanup was performed. Prior test migration 0004 acceptance is
context only; neither database was inspected here. No lifecycle frontend UI or
authentication implementation was changed. Nothing is staged or committed.

## Contracts and endpoints

| Endpoint | Behavior |
| --- | --- |
| `POST /api/applications/:id/archive` | Strict `{ expectedVersion }`; 200 `{ application }`. Server clock assigns archivedAt; a real change increments version once and updates updatedAt. |
| `POST /api/applications/:id/restore` | Same request/response; clears archivedAt and increments version once for a real change. |
| `DELETE /api/applications/:id` | Strict `{ expectedVersion, confirmPermanentDeletion: true }`; only archived owned applications are eligible. Returns 200 `{ deletedApplicationId }`. |
| `GET /api/applications` | Defaults to view=active; explicit view=archived is supported. Owner and lifecycle predicates apply on every page. Existing limit, tuple cursor and createdAt/id descending ordering are unchanged. |
| Detail/history GET | Available for owned active and archived applications. Other-owner and missing records remain indistinguishable 404s without lifecycle disclosure. |
| Existing PUT | Archived editing, including an otherwise unchanged edit, is rejected after checking the locked version. Existing field/date/status policies remain intact. |

Application DTOs require nullable archivedAt, serialized as a canonical timestamp
with milliseconds. Create/edit payloads cannot set it. UUID path casing is
normalized after validation to match PostgreSQL's canonical UUID representation.

Conflicts retain code `APPLICATION_CONFLICT` and add optional constrained
`conflictReason`: `STALE_VERSION`, `APPLICATION_ARCHIVED` or
`APPLICATION_NOT_ARCHIVED`. Reasons are emitted only after owner verification;
the version comparison precedes state eligibility or no-op determination. The
shared error contract rejects a reason on a non-conflict error.

## Transactions and preservation

The existing service now shares one parameterized owned-row FOR UPDATE helper
across editing and lifecycle writes. Lock order remains Session -> JobApplication,
with session authentication, CSRF validation and refresh inside the same existing
Read Committed transaction pattern. There is no in-memory production mutex or
parallel repository implementation.

Archive/restore update only archivedAt, version and updatedAt. Current-version
no-ops leave those fields unchanged; stale repeats conflict even if the desired
state already holds. Substantive changes fail safely at the maximum integer
revision; no-ops remain valid. Status, applicationDate, content, creation time,
owner and status history are preserved. Lifecycle revisions may produce history
gaps; the next real status change still records its actual previous status.

Deletion explicitly removes history scoped by applicationId and parent userId,
then uniquely deletes the parent using application ID, owner, expected version
and non-null archivedAt predicates. It retains the existing RESTRICT foreign key
and does not require a new revision for a record being deleted. Both steps and
session refresh share one transaction. Public result validation happens before
commit, including returned-ID validation for deletion. Exceptions roll back the
transaction and become sanitized errors; commit/connection failures are not
automatically retried or treated as proof that nothing happened.

An archive/restore race can legitimately return two successful responses if the
first operation was a no-op: restore on an active version can finish before its
archive. Two substantive changes cannot share that revision. The integration
design preserves this distinction rather than asserting every race has a loser.

## Offline verification

| Command/check | Result |
| --- | --- |
| `npm.cmd run build -w @applyflow/contracts` | Exit 0; shared contracts rebuilt before focused tests. |
| `npm.cmd exec -- vitest run --project unit packages/contracts/src/applications.test.ts apps/api/src/modules/applications` | Initial exit 0; 378 tests in seven files. Additional cases were subsequently included in the final full run below. |
| `npm.cmd exec -- vitest run` | Final exit 0; 1,854/1,854 tests in 56 files. Default configuration excludes database integration suites. An earlier intermediate run passed 1,843 tests. |
| `npm.cmd run lint` | Final exit 0. |
| `npm.cmd run typecheck` | Final exit 0. The first run found generic type erasure from wrapping the new transaction double in vi.fn; using a spy on the generic method fixed the test typing. |
| `npm.cmd run build` | Exit 0; contracts, API and web. Prisma generation remained offline. |
| Filesystem-only protected-artifact verification | Exit 0; all four migration and three frozen-baseline hashes and bytes match HEAD. Schema content is unchanged. |
| `git diff --check` and new-file whitespace checks | Passed. |

Tests cover strict payload/query/DTO rules, conflict reasons, nullable archive
serialization, owner/state filters on cursor pages, foreign/deleted boundaries,
all seven statuses, no-op and stale precedence, overflow, archive/restore history
preservation, archived editing, active deletion, zero/one/multiple child deletion,
unrelated same-owner/foreign records, session/CSRF/Origin/method/JSON/body-size/rate
admission, and rollback on deletion, response or commit failure. Existing
create/list/edit/history and frontend tests remain passing.

The new service tests use local staged-state doubles with deterministic
serialization. They check rollback/control flow and SQL lock shape/order, not
actual PostgreSQL locking, FK enforcement or commit guarantees. No test assertion
was weakened to accept a failure.

## Changed files

Modified backend files: `apps/api/src/app.ts`; application `service.ts`,
`http-error.ts`, `routes.ts`, `service.test.ts` and `routes.test.ts`.
Modified shared files: `packages/contracts/src/applications.ts` and its test.
Five frontend test fixtures gained only `archivedAt: null`: application editor,
list, editor-controller, list-controller and application API tests. Frontend
implementation files are unchanged.

New files: application `lifecycle.test.ts`, this report, and the
[Stage 3D.2B integration design](../plans/stage-3d2b-postgres-integration-design.md).
There is no new database integration implementation or generic fixture framework.

## Remaining boundary and limitations

- Stage 3D.2B implementation and live execution require separate approval. Its
  design covers real lock races, history deletion/rollback, session activity,
  ownership/pagination and run-owned exact cleanup with stop-on-ambiguity rules.
- Existing integration catalog assertions still need their narrowly scoped 0004
  review during that preparation pass; no integration suite was run here.
- Lifecycle UI, inline confirmation, client lifecycle methods and conflict-reason
  presentation remain future work. The current frontend transport still handles
  generic conflict recovery; it does not yet retain the new structured reason.
- This backend selects archivedAt and therefore requires migration 0004. The
  development database is reported as unmigrated; do not start this backend
  against it before separately authorized migration and verification.
- Pagination remains a boundary-based sequence, not a snapshot. Restored records
  keep their original creation position; Refresh may be needed after changes.
- Unknown mutation outcomes must be reconciled with explicit read-only review;
  never automatically replay a destructive request or infer request provenance
  from a later 404. No durable idempotency ledger or deletion tombstone was added.

No blocking offline implementation defect remains. Live database behavior and
browser acceptance are unverified for these lifecycle operations.
