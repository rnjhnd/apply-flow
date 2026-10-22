# Stage 3B.2 PostgreSQL integration acceptance plan

Status: **plan for review; not executed**. The repository was inspected read-only. No PostgreSQL connection, SQL, integration suite, service start, or migration was performed while preparing this plan.

## Scope and entry gate

Add one focused `apps/api/tests/applications.integration.test.ts` suite using Supertest against `createApp` composed with the real Prisma application service. Use the existing serial `vitest.integration.config.ts` runner; no listener or browser is needed. Before fixture writes, require `NODE_ENV=test`, validate `TEST_DATABASE_URL` for `127.0.0.1:5433/applyflow_test` as `applyflow_test`, assert the connected database and user, verify both pinned migration files, and require exactly the completed `0001_init_auth` and `0002_job_applications` history. Stop on any mismatch. Database access and test writes require separate explicit authorization.

Migration SHA-256 values:

- `0001_init_auth`: `98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840`
- `0002_job_applications`: `74e056f699c2781c01f12d3195ed119074d5b0d4d04fef979c185e17d775a333`

## Targeted checks

| Area | Acceptance check |
| --- | --- |
| Persistence and DATE | POST with an authenticated, CSRF-proven session; read the committed application through a separate guarded test connection and GET. Compare PostgreSQL `DATE` and exact `YYYY-MM-DD` response, including a leap day and a date whose UTC midnight falls on the previous local day in `America/Los_Angeles`. Confirm public DTOs omit owner/session fields. |
| Owner isolation | Create distinct temporary users, sessions, and applications. Each session sees only its own rows on every page. An owner A cursor used by owner B cannot expose A rows. Client-supplied owner IDs are rejected. |
| Pagination | Exercise default 20, explicit limit, 50 maximum, lookahead cursor, final null cursor, malformed cursor, and `createdAt DESC, id DESC` ordering with controlled timestamp ties. Compare the complete walk with the expected owned UUID set; no duplicates or omissions. |
| Session locking | Check missing, anonymous, expired, and revoked sessions. Hold an owned Session row lock in a separate transaction; queue an HTTP request, change the locked session to invalid before commit, then release it. The queued request must recheck the row and return 401 without an application write. Use bounded gates and release in `finally`. |
| CSRF | Missing and incorrect proofs return 403 for POST and leave owned applications and session activity unchanged. Valid proof permits one create. |
| Constraints and rollback | Within owned test transactions, check the database rejects non-`SAVED` status with null date, nonexistent owner, and overlong bounded fields. Inject a failure after an application insert but before transaction commit: require sanitized 503, no committed application, and no committed session refresh. |

## Temporary records and cleanup ownership

Use a random per-run email prefix ending in `@example.invalid`; record every temporary User, Session, and JobApplication UUID. Create only records tied to those owned users. Prefer intentional transaction rollback for direct constraint probes. For committed HTTP cases, cleanup on the guarded test connection after checking database identity again: delete applications by recorded IDs **and** owned user IDs; delete sessions by recorded IDs; then delete users by recorded IDs **and** email prefix. Assert the recorded IDs are absent. If identity or ownership verification fails, stop and report the remaining owned IDs; never widen deletion to table-wide or prefix-only cleanup. Do not touch the development database or account.

## Proposed commands after review and explicit database authorization

From the repository root in PowerShell:

```powershell
Get-FileHash -Algorithm SHA256 apps/api/prisma/migrations/0001_init_auth/migration.sql
Get-FileHash -Algorithm SHA256 apps/api/prisma/migrations/0002_job_applications/migration.sql
$env:NODE_ENV = 'test'
npm.cmd run test:integration -- apps/api/tests/applications.integration.test.ts
npm.cmd run lint
npm.cmd run typecheck
git diff --check
```

Compare both reported hashes with the pinned values above before the test command. The targeted integration command must run only the new suite. Existing B2/C1 guards and disabled fixture/browser gates stay unchanged. No migration, reset, seed, development database command, staging, commit, push, or deployment is included.
