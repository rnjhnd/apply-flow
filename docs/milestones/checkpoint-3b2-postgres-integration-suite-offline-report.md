# Stage 3B.2 PostgreSQL integration suite: offline implementation report

## Scope and status

At HEAD `6890d71` on `feat/job-applications`, the focused suite was added at [applications.integration.test.ts](../../apps/api/tests/applications.integration.test.ts) under the reviewed [acceptance plan](../plans/stage-3b2-postgres-acceptance.md). This pass authorized source implementation and offline checks only. **The suite has not been run.** No PostgreSQL connection, SQL, migration, service, Docker container, or browser was started or used. The development database and account were untouched.

## Implemented acceptance checks

Eight focused integration cases compose Supertest with Express and the real Prisma application service, using the existing serial integration runner. They cover:

1. Authenticated HTTP creation, committed visibility through a separate guarded connection, a leap-day PostgreSQL DATE round trip, and exact public response fields.
2. Two-owner isolation and rejection of a client-supplied `userId`.
3. Default 20-item and explicit 50-item pages, equal-timestamp UUID ordering, cursor boundary and final page, owner-scoped reuse of another account's cursor, and invalid limit/cursor responses.
4. Missing, expired, and revoked sessions for create/list, including an explicit missing-cookie POST with no application created.
5. Missing and incorrect session-bound CSRF, unchanged owned rows and session activity after rejection, and successful valid proof.
6. A held Session row lock followed by expiry before release; the queued HTTP request must recheck validity and create nothing.
7. PostgreSQL status/date CHECK, owner foreign key, and varchar length rejection on owned probes.
8. An injected post-insert transaction failure, no committed application or session refresh, and a sanitized 503 response.

No requested scenario was deliberately omitted. Live behavior, including lock timing and database catalog assumptions, remains unverified until a separately authorized run.

## Admission and fixture safety

Before any write, `beforeAll` requires actual `NODE_ENV=test`, the exact configured `127.0.0.1:5433/applyflow_test` target and `applyflow_test` role. The connected query checks database, current and session users, PostgreSQL 17 version, internal server port 5432, and a nonempty server address. It reuses the approved migration-file SHA-256 checks and requires the completed two-migration history. It also rejects unexpected public tables, application columns, constraints, or indexes. Historical B2/C1 guards and migration files were not changed.

The suite uses a random per-run marker, temporary `@example.invalid` users, and recorded User, Session, and JobApplication UUIDs. Direct constraint probes use transactions. After each test, narrowly owned cleanup checks connected identity and row ownership, then deletes by recorded IDs and ownership predicates in application → session → user order. A response-lost application or any other unexpected row under an owned identity is reported by ID and **not** adopted for deletion. Cleanup stops rather than broadening deletion or retrying if ownership is uncertain, reports recorded and unexpected IDs, and refuses further fixture writes after cleanup failure. The lock test uses a bounded wait and releases its transaction in `finally`.

The repository has no independently pinned PostgreSQL cluster identifier. The checked address is the server's own report, and `openLocalDatabase` does not expose an independently inspected socket peer. The test URL, authenticated role, database, version, migration history, and schema provide layered admission, but they do not independently prove a particular Docker container or data volume. No unstable container IP was hardcoded.

## Offline verification

| Check | Result |
| --- | --- |
| `npm.cmd run lint` | Passed |
| `npm.cmd run typecheck` | Passed, including the new suite |
| `npm.cmd run build` | Passed |
| `git diff --check` | Passed; this checks tracked diffs, while the new suite was also checked for trailing whitespace separately |
| `npm.cmd test` | Not run under this pass's prohibition on test execution |
| `npm.cmd run test:integration` | Not run; PostgreSQL access requires separate authorization |

The ordinary Vitest configuration discovers `*.test.ts` in source and support directories; the new `*.integration.test.ts` file under `apps/api/tests/` is selected only by the separate integration configuration. Offline Prisma client generation during typecheck/build did not select or connect to a datasource.

## Final offline corrections

The source review's three findings were addressed in the integration test only: missing-cookie POST was added; connected session-user and PostgreSQL-version checks were added while documenting the lack of an independent stable cluster ID; and cleanup now enumerates unexpected application, session, and user IDs without adding them to its deletion sets. No production source, historical guard, migration, dependency, runner, or fixture framework changed. The corrected suite still awaits its first authorized PostgreSQL run.

## Exact Git inventory

At report creation, HEAD remained `6890d71`, with no tracked modifications and these untracked files:

```text
?? apps/api/tests/applications.integration.test.ts
?? docs/plans/stage-3b2-postgres-acceptance.md
?? docs/milestones/checkpoint-3b2-postgres-integration-suite-offline-report.md
```

The acceptance plan was already untracked before this implementation pass. The suite and this report are the only files added in this pass. Nothing was staged, committed, pushed, merged, or deployed.

## Proposed separately authorized run

From the repository root in PowerShell, after explicit PostgreSQL integration authorization and approved target/hash preflight:

```powershell
$env:NODE_ENV = 'test'
npm.cmd run test:integration -- apps/api/tests/applications.integration.test.ts
```
