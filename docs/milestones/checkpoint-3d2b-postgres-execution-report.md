# Stage 3D.2B - Lifecycle PostgreSQL execution report

## Result and evidence boundary

Stage 3D.2 backend verification passed: the previously completed Stage 3D.2A
offline checks and one separately authorized Stage 3D.2B live execution passed.
Execution baseline: `feat/application-lifecycle`, HEAD `5972221`, with the
expected uncommitted implementation, tests and documentation; nothing staged.

This report records the completed execution and independent inspections. The
[preparation report](checkpoint-3d2b-integration-preparation-report.md) remains
the historical offline record. No tests, database connections or migrations were
performed while writing this documentation.

## Authorized live execution

Executed exactly once against `127.0.0.1:5433/applyflow_test`:

```powershell
$env:NODE_ENV = 'test'
npm.cmd run test:integration -- apps/api/tests/application-lifecycle.integration.test.ts
```

Exit code **0**; **one test file and 22/22 lifecycle integration tests passed**.
Vitest duration: **27.93 seconds**. Terminal output confirmed selection of
`vitest.integration.config.ts` and only the named lifecycle suite. The earlier
incorrect `test` command was blocked before execution; it was not another attempt.
No assertions were changed, guards bypassed or failed/uncertain operations retried.

## Live concurrency evidence

Each of the seven passing race cases used two distinct authenticated sessions and
real service transactions, plus an independent transaction holding the exact owned
application row FOR UPDATE. Bounded polling required the first request to wait
before starting the second, then required both PostgreSQL application-row lock
waits in pg_stat_activity, with nonempty pg_blocking_pids, before releasing the
holder. Passing these assertions establishes actual overlapping transactions;
the evidence is the live test assertions, not mocked races or a separate lock trace.

| Ordered contenders | Observed/asserted outcome |
| --- | --- |
| Edit, then archive | 200 / 409 stale conflict; edit wins. |
| Archive, then edit | 200 / 409 stale conflict; archive wins. |
| Archive, then archive | 200 / 409 stale conflict; one archive increment. |
| Archive, then restore, initially active | 200 / 409 stale conflict. |
| Restore, then archive, initially active | 200 no-op / 200 archive; only one revision increment. |
| Restore, then delete, initially archived | 200 / 409 stale conflict; restored record survives. |
| Delete, then restore, initially archived | 200 / 404; parent and history are removed. |

Winning application/history state and committed session activity matched the
assertions. Losing operations did not commit session refreshes. A legitimate
restore no-op followed by archive was distinguished from two substantive writes.

## Other live results

- Archive/restore preserved details, current status, application date and existing
  history. Real changes incremented once; current-version no-ops preserved version,
  updatedAt and archivedAt. Subsequent status history used the actual prior status.
- Foreign and missing detail/history/edit/lifecycle requests had indistinguishable
  404 responses. Owner reads remained available for active and archived records.
- Permanent deletion removed only the archived owned parent and its zero, one or
  three history records. Same-owner siblings and another owner's records survived;
  repeated deletion returned 404. Active deletion and archived editing rejected.
- Failure after actual child deletion and invalid response after actual parent
  deletion rolled back parent/history/session activity. Lifecycle update and
  response failures also rolled back. These were controlled fault probes, not
  deliberate connection loss at an ambiguous COMMIT boundary.
- Actual RESTRICT FK, positive-version, required-date and history CHECK probes
  passed. Session, CSRF, Origin, request admission, strict validation, version
  exhaustion, default active/explicit archived pagination and cursor tests passed.

## Independent preflight and post-test verification

Separate bounded inspections before and after the attempt used REPEATABLE READ
READ ONLY transactions, explicit ROLLBACK and confirmed connection closure.
The actual socket was `127.0.0.1:5433`; database/current/session roles were all
`applyflow_test`. PostgreSQL was **17.11**; container-side server port was 5432.

Both inspections verified exactly these completed migrations, in order, with
approved checksums, one applied step each and no failure/rollback metadata:

1. `0001_init_auth`
2. `0002_job_applications`
3. `0003_application_status_history`
4. `0004_application_lifecycle`

Migration metadata was identical before/after. All four protected migration SQL
and three frozen baseline file hashes matched their approved pins. Migration 0004
SHA-256: `cfa58ef4e3bbe91b5271291033ef33412194e2ce8dba91071047982f42dcda8c`.

Exact schema definitions passed: **five tables, 39 columns, 12 constraints,
11 indexes and seven status labels**. archivedAt remained nullable TIMESTAMPTZ(3)
without a default; the history FK retained ON DELETE RESTRICT / ON UPDATE CASCADE.
No unexpected inspected schema objects were found. The SHA-256 fingerprint of the
ordered inspected column/constraint/index/enum definitions was identical before
and after:

`0436edae597989a0cb3b7cf088978d8792db74fbb60a2d8a31f4b0abd4172cb2`

| Table | Before | After |
| --- | ---: | ---: |
| User | 0 | 0 |
| Session | 0 | 0 |
| JobApplication | 0 | 0 |
| ApplicationStatusHistory | 0 | 0 |

Suite-owned cleanup passed; independent inspection found no residual IDs or
unexpected records. There were no competing/leftover test clients, unfinished
client transactions, prepared transactions or waiting locks. Suite teardown and
independent inspection connection closure completed. No manual cleanup occurred.
No development database was accessed or migration executed during this attempt.

Repository branch/HEAD/status and all 243 tracked/unignored file fingerprints were
unchanged by execution. The pre-existing 15 modified and five untracked files
remained, with an empty index. This new report is a subsequent documentation-only
addition, not part of those execution-time counts.

## Previously completed offline evidence

The [Stage 3D.2A report](checkpoint-3d2a-offline-report.md) records **1,854/1,854
offline tests in 56 files**, plus passing lint, typecheck and build. Its staged-state
doubles established service/control-flow behavior, not real PostgreSQL concurrency.
The [3D.2B preparation report](checkpoint-3d2b-integration-preparation-report.md)
records **400/400 relevant offline tests in six files**, passing lint/typecheck/build
and static integration-source checks. These results were not rerun for this report
and are separate from the live 22/22 result above.

## Remaining scope and limitations

- Lifecycle frontend functionality remains unimplemented: active/archived view
  controls, archive/restore actions, permanent-delete confirmation, client lifecycle
  methods and structured lifecycle-conflict/uncertain-operation recovery. No
  lifecycle browser acceptance has occurred.
- Development migration 0004 remains pending; development is reported at 0003.
  This is prior context, not a new development inspection. Fresh preflight,
  separate authorization and deployment verification are required before using
  the archive-aware backend against that database.
- Only the focused lifecycle integration suite ran. The older application suites
  received compatibility updates during preparation but were not rerun here.
- Cursors retain the approved view-agnostic tuple format; tests walk views
  independently and do not establish cross-view cursor rejection. Pagination
  across requests is not a shared snapshot. No durable idempotency ledger or
  deletion tombstone was added; uncertain mutations must never be auto-replayed.

No blocking defect or residual cleanup issue was observed in this execution.

Verdict: **STAGE 3D.2B POSTGRESQL INTEGRATION VERIFIED**.
