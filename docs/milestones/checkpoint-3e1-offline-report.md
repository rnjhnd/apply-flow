# Stage 3E.1 - Application search/filter backend offline report

## Result and evidence boundary

Stage 3E.1 backend/contracts implementation and offline verification passed.
Starting repository: `feat/application-search-filtering`, HEAD `be6b790`, clean
working tree and empty staging area. Changes remain unstaged for review.

No PostgreSQL database was accessed. No integration tests, migrations, fixtures,
cleanup, servers or browser sessions ran. Authentication, frontend, navigation,
Prisma schema, historical SQL/baselines and checksum policies were not modified.

## Contract and query behavior

The existing authenticated `GET /api/applications` accepts optional `q` and
`status` alongside `view`, `limit` and `cursor`. Responses and public DTOs are
unchanged. Default Active view, 20-row pages and maximum limit 50 remain intact.

- Search trims outer whitespace, preserves internal whitespace/case/combining
  sequences, and permits at most 200 Unicode code points after trimming.
- Blank search means no text predicate. Unicode validity and NUL checks run before
  trimming. Non-string queries, arrays/repeated parameters, objects and unknown
  keys reject with the established 400 INVALID_REQUEST response.
- One exact existing status enum is optional; omission includes all seven, with
  no special handling for Saved. Text, status, owner and lifecycle are conjunctive.
- The complete search phrase matches company OR job title using insensitive
  Prisma contains filters. Backslash, percent and underscore are escaped as
  PostgreSQL pattern characters; quotation marks remain unchanged bound values.
- The text OR is nested under AND, independently of the existing cursor OR.
  Owner/lifecycle predicates apply on every page, before database-side ordering
  and `limit + 1`. No in-memory filtering or total-count query was introduced.
- Ordering remains createdAt DESC, id DESC. The canonical tuple cursor and
  last-returned-row nextCursor calculation are unchanged. A cursor is a boundary,
  not authorization or evidence that its anchor belongs to the current filters.

Existing Session locking/refresh, request admission, error sanitization and
transaction behavior are reused without changes. Mutation version checks,
lifecycle operations, status history and uncertain-mutation handling are unchanged.

## Offline verification

The focused command passed **477/477 tests in eight files**, exit code 0:

```powershell
npm.cmd run test -- packages/contracts/src/applications.test.ts apps/api/src/modules/applications/search-filtering.test.ts apps/api/src/modules/applications/service.test.ts apps/api/src/modules/applications/routes.test.ts apps/api/src/modules/applications/pagination.test.ts apps/api/src/modules/applications/date-policy.test.ts apps/api/src/modules/applications/edit-history.test.ts apps/api/src/modules/applications/lifecycle.test.ts
```

| Command | Final result |
| --- | --- |
| `npm.cmd run test` | 1,981/1,981 offline tests in 58 files; exit 0 |
| `npm.cmd run lint` | Passed; exit 0 |
| `npm.cmd run typecheck` | Passed; exit 0 |
| `npm.cmd run build` | Passed; exit 0 |
| `git diff --check` | Passed; exit 0 |

The normal test configuration excludes PostgreSQL integration suites. Prisma
client generation used the existing offline wrapper/configuration; it did not
connect to a datasource or generate a migration.

New coverage includes 42 contract cases and 42 backend/HTTP/compiler cases:
normalization, Unicode boundaries and malformed input; all seven statuses;
combined text/status/view/owner/cursor predicates; strict HTTP rejection of
repeated/invalid parameters; session/request rejection; bounded projection and
cursor derivation; and sanitized query failure without retry. Existing offline
create/edit/history/lifecycle and frontend regressions also passed.

Six compiler cases use the installed Prisma 7.10.1 client with an entirely local
capture adapter: no pg driver, URL, socket or environment access. It returns empty
rows, rejects write/script/driver-transaction operations, and confirms disposal.
The actual generated SQL uses `ILIKE ('%' || $n || '%')`; raw contains values are
not auto-escaped. Service-generated bound values correctly escape `%`, `_` and
backslash, retain quotes literally, and preserve both independent OR groups.

Initial capture assertions expected surrounding percent signs in the bound
parameter; inspection showed Prisma adds them in SQL instead. Assertions were
corrected to the observed SQL shape. A generic transaction-mock typing issue was
also corrected before the final passing typecheck/full regression. No production
assertions or security guards were weakened.

## Remaining verification and scope

Offline doubles/compiler capture prove contract, control-flow and SQL-generation
behavior, not PostgreSQL matching, collation, transaction execution or performance.
Case-insensitivity follows the database locale; no accent-insensitive matching or
Unicode normalization is promised. Substring searches may inspect many owner
records despite the existing owner/order index; bounded result size does not
bound rows examined. No indexes, extensions or dependencies were added.

Stage 3E.2 requires separate authorization for real matching/escaping, owner/view
isolation across filtered cursor pages, sparse/tied-boundary pagination and query
performance verification on the exact guarded isolated test target. It must retain
the current migration 0001-0004 admission, run-owned fixture/cleanup safeguards
and independent post-verification. No live execution is authorized by this report.

Frontend search/filter controls and transport support remain Stage 3E.3 work.
The existing PRD lifecycle delivery-status drift was observed during planning and
is unchanged here. No blocking source defect remains from the offline checks.

## Changed files

- Modified `packages/contracts/src/applications.ts`.
- Modified `packages/contracts/src/applications.test.ts`.
- Modified `apps/api/src/modules/applications/service.ts`.
- Added `apps/api/src/modules/applications/search-filtering.test.ts`.
- Added this report, `docs/milestones/checkpoint-3e1-offline-report.md`.

No staging, commit, push or branch change occurred. No Stage 3E.2 execution or
frontend implementation began.
