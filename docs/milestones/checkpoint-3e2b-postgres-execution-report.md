# Stage 3E.2B - Search/filter PostgreSQL execution report

## Result and evidence boundary

Stage 3E backend verification passed: the previously completed offline checks and
one separately authorized live PostgreSQL execution passed. Execution baseline:
`feat/application-search-filtering`, HEAD `be6b790`, with three modified and four
untracked Stage 3E files, nothing staged.

This report records that completed execution and its independent inspections.
The [Stage 3E.1 offline report](checkpoint-3e1-offline-report.md) and
[Stage 3E.2A preparation report](checkpoint-3e2a-integration-preparation-report.md)
remain historical evidence. No database access, test or EXPLAIN rerun, migration,
cleanup or service launch occurred while writing this report.

## Authorized live execution

The explicit execution authorization and terminal output confirm this command,
executed exactly once against `127.0.0.1:5433/applyflow_test`:

```powershell
$env:NODE_ENV = 'test'
npm.cmd run test:integration -- apps/api/tests/application-search-filtering.integration.test.ts
```

Exit code **0**; **one integration file and 18/18 tests passed**. Vitest duration:
**19.63 seconds**. Terminal output confirmed `vitest.integration.config.ts` and
only the named search/filter suite. No execution retry, source change, assertion
weakening or manual cleanup occurred.

## Live search, filtering and compatibility results

All 18 prepared cases passed; the preparation report contains the exact inventory.

- PostgreSQL matched case-insensitive complete substrings in company OR job title,
  including middle-of-field phrases, without searching notes/location/URL fields.
- Literal percent, underscore, backslash, single/double quotation marks and
  punctuation matched without unintended wildcard expansion.
- Outer whitespace, blank searches, preserved internal whitespace, Unicode length
  boundaries and malformed-query rejection passed. Unpaired-surrogate checks used
  direct service input, since normal UTF-8 HTTP cannot preserve those strings.
- All seven statuses, omitted status and independent Active/Archived filtering
  passed. Combined owner/search/status/view predicates excluded foreign records
  on every tested page; Archived records were absent from default Active results.
- Sparse matches and tied timestamps preserved createdAt DESC, id DESC ordering,
  database filtering before limit+1, last-returned-row cursors and duplicate-free
  pagination. Search OR and cursor OR remained independent. Reused cursors across
  filter/view/owner boundaries and absent anchors remained safe tuple boundaries.
- Create/edit/archive/restore compatibility, changed filter membership, revision
  increments, application date and preserved status history passed.
- Session, Origin, CSRF, request metadata/rate admission and strict query validation
  passed. Rejected requests did not commit the tested session-activity changes;
  valid GET requests retained their existing CSRF policy.

## Query-plan evidence and limitations

Both parameterized `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` probes succeeded in
bounded read-only transactions against 96 owned application fixtures and one
foreign fixture per probe. Selective and no-match queries returned one and zero
rows respectively. Transactions intentionally rolled back.

The probes used representative first-page SQL with the list projection, predicates,
ordering and limit; they were not captures of the exact ORM-issued statement.
Detailed planner node, buffer and timing metrics were not captured in the
execution report. No index choice, latency measurement or production-scale
performance is claimed. Small controlled fixtures do not resolve substring-search
scaling concerns. No indexes, extensions, migrations or standalone ANALYZE command
were introduced, and probes were not rerun to recover output.

## Independent preflight and post-test verification

Separate fresh inspections before/after execution verified the actual socket
`127.0.0.1:5433`, database/current/session roles `applyflow_test`, PostgreSQL 17.11
and REPEATABLE READ READ ONLY settings. Both inspections explicitly rolled back
and confirmed connection closure. No development database was accessed.

Exactly migrations `0001_init_auth`, `0002_job_applications`,
`0003_application_status_history` and `0004_application_lifecycle` were completed
once each, in approved order, with matching checksums, valid completion metadata
and no failure/rollback records. Metadata was identical before/after. All four
protected migration SQL and three frozen-baseline hashes matched their pins.

Exact catalog definitions passed before/after: **five tables, 39 columns,
12 constraints, 11 indexes and seven status labels**. Nullable archivedAt without
a default, ownership/history FKs, ON DELETE RESTRICT, version/date/history checks
and existing indexes remained intact. No unexpected inspected objects existed.
The ordered catalog fingerprint matched before/after:

`d86ee5be2c3753e989e7e81efaaa237c5785ced347a5a8b1e29a04323014c670`

| Table | Before | After |
| --- | ---: | ---: |
| User | 0 | 0 |
| Session | 0 | 0 |
| JobApplication | 0 | 0 |
| ApplicationStatusHistory | 0 | 0 |

Run-owned cleanup completed without hook failures. Independent inspection found
no residual fixture IDs or unrelated records, leftover/competing clients, peer or
prepared transactions, waiting locks or conflicting write/DDL locks. No manual
cleanup was needed. All 251 tracked/unignored file fingerprints and the Git
inventory were unchanged by execution; nothing was staged.

## Previously completed offline evidence and remaining work

- Stage 3E.1: **1,981/1,981** full offline tests in 58 files; passing lint,
  typecheck and build.
- Stage 3E.2A: **601/601** relevant offline tests in ten files; passing lint,
  typecheck, build, protected-file checks and static integration-source checks.

These are linked historical results, not newly executed checks. Offline doubles
and compiler capture are distinct from the live PostgreSQL matching evidence.

Frontend search/filter controls, transport and controller integration remain
**Stage 3E.3** work. No browser acceptance or production readiness is claimed.
Only this execution report was added during documentation finalization; application
source, contracts, tests, migrations and prior reports were unchanged. No staging,
commit, push or Stage 3E.3 implementation occurred.

Verdict: **STAGE 3E.2B POSTGRESQL INTEGRATION VERIFIED**.
