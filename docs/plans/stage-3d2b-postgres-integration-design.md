# Stage 3D.2B - PostgreSQL lifecycle integration design

## Boundary and admission

Design only, prepared during Stage 3D.2A. No integration file, database fixture or
live test was created or executed. Implementation and execution require separate
authorization. The previously verified test migration 0004 is prior evidence,
not a database inspection performed for this design.

Proposed focused file: `apps/api/tests/application-lifecycle.integration.test.ts`.
Reuse the existing edit/history suite's guarded, suite-local test infrastructure
and actual HTTP/service composition; do not create a generic fixture framework.

- Require NODE_ENV=test, exact socket endpoint 127.0.0.1:5433/applyflow_test and
  current/session roles applyflow_test. Never select DATABASE_URL or development.
- Verify source approval, protected file hashes and exactly completed migrations
  0001-0004. Expected catalog is five tables, 39 columns, 12 constraints, 11
  indexes and seven status labels, checked by exact names/definitions. archivedAt
  must be nullable TIMESTAMPTZ(3), without a default; history FK stays RESTRICT.
- Fresh bounded read-only admission must find all four data tables empty, with
  no unrelated clients, open transactions, prepared transactions or blocking
  locks. Roll back and close that inspection connection before test execution.
- Narrowly update existing application integration catalog assertions for 0004
  during the separately approved preparation pass. Do not change historical
  authentication-only B2/C1 guards or declare old suites compatible without review.

## Proposed cases

| Case | Required real-database evidence |
| --- | --- |
| Archive/restore persistence | Server archive time and version increments persist across independent reads. All original fields, date, status, IDs and history remain unchanged. Current-version no-ops preserve timestamps/version; stale repeats conflict even when the desired state already holds. |
| Eligibility and conflict reasons | Archived edit and active delete return owner-only state reasons; stale version takes precedence. Missing and foreign records share the same 404 without state disclosure. |
| Edit/archive race | Two authenticated sessions submit substantive operations from the same expectedVersion. Exactly one succeeds and one conflicts. The saved row and history match the winner; loser session activity is unchanged. Test both winner directions. |
| Archive/restore races | Concurrent archives from one active revision produce one substantive success and one stale conflict. A restore racing an archive from that revision either no-ops first or conflicts after archive; never claim two substantive successes. Also race restore against delete on an archived revision: exactly one succeeds, with conflict or missing-parent response for the loser as appropriate. |
| Permanent deletion | Delete archived owned parents with zero, one and multiple events. Only the selected parent/history disappear; same-owner siblings, other owners and their history remain identical. Repeat deletion returns 404 without another child deletion. |
| Delete rollback | Inject an exception through the real transaction's parent-delete delegate after actual scoped history deletion. Independently verify parent, children and committed session activity are unchanged. Also inject malformed deletion response after the actual parent delete to prove response validation rolls back both deletes. |
| Other rollback paths | Stale requests, active-delete rejection, archived-edit rejection, archive response failure and lifecycle update failure preserve committed session activity and application/history state. No automatic transaction replay. |
| Ownership and pagination | Active default and explicit archived pages independently enforce owner/state filters, ordering and strict tuple boundaries, including tied creation times and foreign/deleted cursor anchors. Restore retains original creation position. Separate pages do not promise a shared snapshot. |
| History and constraints | Archive/restore create no events; the next status change records the actual prior status at its resulting revision, including lifecycle gaps. Existing positive-version/date/history checks and RESTRICT FK remain enforced. |
| Admission | Missing/expired/revoked/anonymous sessions, missing/wrong CSRF, invalid Origin/request metadata, malformed UUID/payload/query and explicit deletion confirmation are rejected without committed mutation or session activity. |

## Concurrency and fault methodology

Use two real authenticated sessions and an independent guarded transaction holding
the exact owned application row FOR UPDATE. Start both HTTP requests with rejection
handlers attached immediately. Observe their real lock waits with bounded polling,
then release the holder and collect both outcomes. This establishes SQL contention,
unlike the deterministic in-memory serialization used in Stage 3D.2A.

Capture safe row/history snapshots and session activity timestamps before each
probe. Compare independent committed reads afterward. Fault wrappers must forward
the actual Prisma transaction/delegates and retain identity/ownership checks; do
not replace SQL writes or locks with mocks. Keep Session -> Application -> history
lock order. Use bounded transaction, query and lock waits with no automatic retry.

Do not intentionally sever a connection at an ambiguous COMMIT boundary in this
suite. If an unexpected connection/commit outcome occurs, stop all writes and
cleanup, report recorded possible residual IDs, and request separate diagnosis.
Read-only reconciliation may establish current state but cannot prove which
request committed. Never replay DELETE, archive or restore automatically.

## Fixture ownership and cleanup

Use random per-run identifiers and unique `@example.invalid` identities for two
test-owned accounts, their sessions, applications and known history IDs. Preserve
the application marker when exercising company edits. Record IDs before writes
where possible; verify run identity, target and exact linked ownership before
every delegated fixture or HTTP write. Never print credentials, hashes, proof
headers, session tokens or private application contents.

After each test, prove the live inventory contains only this run's records.
Recorded IDs already removed by successful product deletion are allowed to be
absent; disappearance does not authorize deleting any replacement or unrelated
row. Clean up remaining proven history IDs with parent-owner predicates, then
proven application IDs/owners, exact sessions, and exact user IDs/run identities.
Retain RESTRICT ordering and the stop-on-ambiguity behavior. No table-wide DELETE,
TRUNCATE, DROP, reset, seed or cleanup retry is permitted.

Separately verify committed zero counts and no residual recorded IDs, exact
migration/catalog preservation, no unrelated clients/locks, read-only rollback and
connection closure. Report IDs only if cleanup cannot be proven complete.

The future targeted command, after preparation and execution authorization, is:

```powershell
$env:NODE_ENV = 'test'
npm.cmd run test:integration -- apps/api/tests/application-lifecycle.integration.test.ts
```

This selects `vitest.integration.config.ts` and the single named file. It was not
run during Stage 3D.2A. Development migration and browser acceptance remain separate.
