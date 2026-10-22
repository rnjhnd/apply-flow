# Stage 3B.1 - Offline application model and contracts

## Result and approval boundary

**Offline implementation verified. Migration 0002_job_applications: REVIEW_PENDING.**

Baseline inspected: branch `feat/job-applications`, HEAD
`f1ddf9c17b8976efe050618d2969dee58e945217`, initially clean working tree and
empty staging area. The accepted authentication implementation and Stage 2D
user-confirmed 4/4 manual results remain historical evidence, not tests rerun here.

No PostgreSQL connection, introspection, shadow database, SQL execution,
migration application, database fixture/cleanup, live preflight, browser operation,
Docker/service operation or PostgreSQL integration suite was performed. No
dependency, product authentication, HTTP route, frontend, existing database guard,
historical B2/C1 harness, Prisma configuration, package script, lockfile or CI
change was made. No staging, commit, push, merge or deployment occurred.

The two ambiguous `npm.cmd run db` verification lines were interpreted as the
approved offline `db:validate` and `db:generate` commands after script inspection.
Neither `db` nor `db:verify` was run. Ordinary tests include existing unit/HTTP and
component tests; their success is not PostgreSQL integration evidence.

## Exact changed-file inventory

Tracked content changes:

- `apps/api/prisma/schema.prisma`
- `apps/api/scripts/db.ts`
- `apps/api/tests/authentication.integration.test.ts`
- `apps/api/tests/csrf.integration.test.ts`
- `apps/api/tests/persistence.integration.test.ts`
- `apps/api/tests/sessions.integration.test.ts`
- `packages/contracts/src/index.ts`
- `vitest.config.ts`

New files:

- `apps/api/prisma/baselines/0001_init_auth.prisma`
- `apps/api/prisma/migrations/0002_job_applications/migration.sql`
- `apps/api/scripts/db.test.ts`
- `apps/api/scripts/migration-policy.ts`
- `apps/api/scripts/migration-policy.test.ts`
- `apps/api/src/modules/applications/date-policy.ts`
- `apps/api/src/modules/applications/date-policy.test.ts`
- `packages/contracts/src/applications.ts`
- `packages/contracts/src/applications.test.ts`
- `docs/milestones/checkpoint-3b1-offline-report.md`

Additionally, the user explicitly approved restoring
`apps/api/prisma/migrations/0001_init_auth/migration.sql` to its exact approved LF
bytes. At baseline, Git's `core.autocrlf=true` had checked it out with CRLF:
raw SHA-256 `c565e6c7e3c7d1c66ec91fda8d6d8556a39f8d07bab766ba3d937f7681480bdc`.
The restored file matches the original approved digest below. No SQL content was
changed; Git reports no textual diff for this file, although status reports it
modified after the working-file restoration. No index/configuration changes were
made to suppress that status. The frozen schema and new migration use LF bytes.

## Schema and contracts

`JobApplication` has a Prisma-generated UUID, required owner UUID, company
VARCHAR(160), job title VARCHAR(200), the seven approved enum statuses with SAVED
default, nullable DATE applicationDate, nullable location VARCHAR(200), nullable
jobUrl VARCHAR(2048), nullable TEXT notes and TIMESTAMPTZ(3) creation/update times.
Prisma generates UUIDs and manages updatedAt; these are not PostgreSQL defaults.

User.applications is the inverse relation. User deletion is restricted while an
application references it. Existing User/Session fields and cascading Session FK
are unchanged. The lookup/order index is (userId, createdAt DESC, id DESC).
Company/title combinations are not unique. The named SQL CHECK requires a date
for non-SAVED statuses; the CHECK is documented in the Prisma model because Prisma
does not express it in the datamodel.

Shared strict Zod schemas provide create input/parsed request, safe application
DTO, create/list envelopes, list query and application error types. They reject
unknown fields and client-owned identifiers/timestamps; normalize optional blanks
to null; trim company/title/location/URL; preserve nonblank notes formatting; count
length in Unicode code points; reject malformed surrogate characters and NUL;
validate real YYYY-MM-DD dates, leap years and status/date consistency; and permit
only absolute HTTP(S) URLs without user-info, whitespace or backslashes.

DTOs exclude owner IDs, users, sessions and authentication material. Response
fields are validated without request-style trimming/defaulting. UTC timestamps
require millisecond precision. Lists default to 20 with a maximum of 50; cursors
are bounded base64url-shaped strings. Semantic cursor decoding and owner-scoped
pagination remain 3B.2 work. Error schemas constrain structure, not the contents of
arbitrary developer-supplied messages; future handlers must use sanitized messages.

The pure server date policy requires an injected clock and validates its timezone
through existing configuration validation, default Asia/Manila. It computes today
on each call with an explicit Gregorian/Latin-digit timezone formatter and rejects
future nonnull dates. Structural schemas never read a clock or environment. The
existing global 16 KB JSON body limit is unchanged. No API/service/UI wiring was
added in this checkpoint.

## Generated SQL and exact chain

| Migration | SHA-256 | Approval |
| --- | --- | --- |
| 0001_init_auth | `98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840` | Previously approved; exact bytes preserved |
| 0002_job_applications | `74e056f699c2781c01f12d3195ed119074d5b0d4d04fef979c185e17d775a333` | **REVIEW_PENDING** |

Frozen authentication schema SHA-256:
`043b3e43163c7aa05f09be3d3a3dabd5e9698418bca265c40bad9fe022dd1129`.

Full final migration SQL:

```sql
BEGIN;

-- CreateEnum
CREATE TYPE "ApplicationStatus" AS ENUM ('SAVED', 'APPLIED', 'ASSESSMENT', 'INTERVIEW', 'OFFER', 'REJECTED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "JobApplication" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "company" VARCHAR(160) NOT NULL,
    "jobTitle" VARCHAR(200) NOT NULL,
    "status" "ApplicationStatus" NOT NULL DEFAULT 'SAVED',
    "applicationDate" DATE,
    "location" VARCHAR(200),
    "jobUrl" VARCHAR(2048),
    "notes" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "JobApplication_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "JobApplication_userId_createdAt_id_idx" ON "JobApplication"("userId", "createdAt" DESC, "id" DESC);

-- AddForeignKey
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Require a date after leaving SAVED.
ALTER TABLE "JobApplication" ADD CONSTRAINT "JobApplication_applicationDate_required_check"
CHECK ("status" = 'SAVED' OR "applicationDate" IS NOT NULL);

COMMIT;
```

## Generation, migration history and authorization

The fixed generator compares the frozen 0001 Prisma schema to the current schema
using installed Prisma 7.10.1's `migrate diff --from-schema ... --to-schema ...
--script --output ...`. It does not use --from-empty, database/shadow inputs or
live datasource selection. Offline branches precede local environment loading;
child configuration clears PRISMA_MIGRATION_TARGET and PG overrides and retains
the existing inert offline datasource. Imports do not execute the database CLI.

Generation verifies the original migration and frozen-schema bytes, refuses
unexpected directories or existing output, and restricts the generated diff to
the four expected additive operations before adding BEGIN/COMMIT and the CHECK.
This fixed-vocabulary guard is not a general SQL parser or proof against live
schema drift. Final byte hashes, SQL review and explicit approval remain required.

The immutable manifest pins the exact names/digests and keeps 0002 REVIEW_PENDING.
Both applying commands reject this before environment loading, database-module
import or subprocess dispatch, even with the candidate digest supplied. The four
ordinary integration suites likewise reject pending approval before connecting;
their authentication assertions and fixture cleanup are unchanged.

After separate approval, the wrapper is prepared to accept only the completed
initial prefix or completed two-migration chain. It rejects missing/extra/duplicate
entries, unknown names, wrong checksums, invalid timestamps, unfinished/rolled-back
migrations, non-successful step/log metadata and reversed/overlapping execution
history. SELECT row order is not treated as physical migration order. Table
inventory must match the corresponding prefix. Empty databases are not implicitly
created/baselined. Test deployment requires actual NODE_ENV=test rather than a
fabricated environment copy. Existing target/connected-identity guards are reused.

Future deployment closes preflight, rechecks local files, invokes deploy once and
reopens a guarded connection to verify the complete chain. A complete existing
chain reports no changes. Failure has no automatic retry/reset/repair. These paths
were exercised only with injected database/process ports; no deployment command
was executed. Current table inventory checks are not a complete catalog fingerprint.

Historical B2/C1 checks remain auth-only and unchanged. They will fail closed
after the new migration is applied; do not loosen them or rerun them expecting
support for the expanded schema. Fixture-cycle/child/cleanup/browser gates remain
disabled. No new migration application is performed by test, build or startup.

## Tests and command evidence

Four new test files contribute **168 passing deterministic tests** covering strict
contracts and field bounds, Unicode/NUL handling, date/URL correctness, safe DTOs,
list bounds, timezone-midnight/DST cases, moving clocks, invalid configuration,
byte hashes, schema/SQL expectations, forbidden operations, exact chain/history,
pending approval, inert CLI imports, generation flags, no overwrite, target
admission, future idempotency/postchecks and failure/no-retry behavior.

Database/process ports in the new command tests are mocked. Future approval is
simulated in an isolated test module; the production manifest remains frozen and
pending. Existing Node tests, HTTP tests, jsdom component project and PostgreSQL
integration configuration retain their respective discovery boundaries.

| Command | Actual result |
| --- | --- |
| `npm.cmd run db:migrate:create -- --name job_applications` | Exit 1 after generating the four expected offline operations: the first guard mistakenly classified ON DELETE RESTRICT as a forbidden DELETE. No database access/application. The guard was corrected and the retained generated file finalized with BEGIN/CHECK/COMMIT; it was not deleted or regenerated. |
| `npm.cmd run build -w @applyflow/contracts` | Initial exit 1 because the shared non-DOM tsconfig does not declare URL. Corrected to use installed Zod URL validation with explicit authority restrictions; rerun exit 0. |
| Focused Vitest command below | Initial 155 passed/7 failed: parameterized argument fixtures and mixed-line-ending comparison. Fixed fixtures/comparison without relaxing assertions. Latest run: exit 0, **168/168**, four files. |
| `npm.cmd run db:validate` | Exit 0; Prisma schema valid; offline only |
| `npm.cmd run db:generate` | Exit 0; Prisma 7.10.1 client generated into ignored output |
| `npm.cmd run lint` | Exit 0, including rerun after test corrections |
| `npm.cmd run typecheck` | First exit 1 on additional array-shaped parameterized fixtures. Fixed those tests; rerun exit 0 across workspaces/root/E2E TypeScript. |
| `npm.cmd test` | Exit 0; **1,338/1,338 tests**, **44/44 files**; includes prior 1,170 tests and 168 new tests |
| `npm.cmd run build` | Exit 0; contracts, API and production Vite build; 217 frontend modules transformed |
| `git diff --check` | Passed after implementation/documentation |
| Changed/new file content checks | Passed, including this untracked report and exact SQL-block comparison |
| `git status --short --untracked-files=all` | Final inventory below; staging area empty |

Focused command:

```powershell
npm.cmd exec -- vitest run --project unit packages/contracts/src/applications.test.ts apps/api/src/modules/applications/date-policy.test.ts apps/api/scripts
```

The table records development failures as well as successful reruns. No success is
inferred from the previous milestone's test totals.

## Final Windows environment-isolation correction

The independent read-only audit accepted the offline checkpoint with a
nonblocking Windows finding: deleting only the uppercase
PRISMA_MIGRATION_TARGET property from a copied record left lowercase/mixed-case
selectors intact. Windows environment lookup is case-insensitive. Such an
inherited selector could select live datasource metadata and load local database
configuration in an otherwise offline child. The fixed schema-to-schema diff did
not itself become a database query, and pending deployment admission was not
bypassed.

Only these three files were changed during this correction pass:

- `apps/api/scripts/db.ts`
- `apps/api/scripts/db.test.ts`
- `docs/milestones/checkpoint-3b1-offline-report.md`

The existing child-environment loop now removes every key whose uppercase form is
PRISMA_MIGRATION_TARGET, alongside the unchanged case-insensitive PG filtering.
Only after filtering may an explicitly selected target assign the canonical
uppercase selector. Offline children receive no selector; deliberate target
assignment, migration approval checks and all deployment behavior otherwise
remain unchanged. No environment-policy, Prisma configuration or package-script
change was needed.

Ten additional deterministic cases cover uppercase/lowercase/mixed-case selectors
for both validation and client generation, colliding case variants, and canonical
replacement for deliberately selected development/test targets. The existing
mocked SQL-generator test now includes selector collisions while preserving its
fixed arguments and expected candidate digest. It does not execute Prisma or
regenerate SQL.

The tests temporarily substitute a plain process-environment record to represent
case collisions that native Windows environments collapse, restoring the original
reference in finally. A Windows-style case-insensitive lookup also evaluates the
unchanged real Prisma configuration against the captured offline child record.
It resolves to the existing inert offline URL; environment-loader and connection
tripwires remain untouched. No real child or database driver is constructed by
these tests. This is deterministic configuration evidence, not a live Windows
child-process/PostgreSQL test.

Before the source fix, the targeted regression run reported 9 failures and 23
passes, reproducing retained variants in offline and deliberate-target children.
After the fix, the same 32 database-script tests passed. Typecheck subsequently
caught a test-only record-index annotation error (TS7053); adding the explicit
NodeJS.ProcessEnv annotation corrected it without changing assertions or source
behavior.

Final correction verification, executed sequentially:

| Command/check | Result |
| --- | --- |
| `npm.cmd exec -- vitest run --project unit apps/api/scripts/db.test.ts` | Exit 0; 32/32 after the source fix |
| Focused four-file Vitest command above | Exit 0; 178/178, including rerun after the annotation fix |
| `npm.cmd run lint` | Exit 0, including final rerun |
| `npm.cmd run typecheck` | Exit 0 on final rerun; workspaces/root/E2E checked |
| `npm.cmd test` | Exit 0; 1,348/1,348 tests across 44/44 files |
| `npm.cmd run build` | Exit 0; contracts, API and production frontend |
| Migration byte hashes and report SQL comparison | Unchanged; exact values in the migration table above |
| `git diff --check` and changed-file content checks | Passed; existing initial-migration autocrlf warning remains |
| Scope and Git inventory | Only the three authorized files changed relative to the correction baseline; inventory below unchanged; nothing staged or committed |

Scripts were inspected before execution. Typecheck/test/build invoke offline
Prisma client generation into ignored output; none invokes SQL generation or
application. No live preflight, fixture, integration, database, service, browser,
Git-configuration or publication operation was performed in this correction.
0002 remains REVIEW_PENDING, with the exact original candidate SQL/digest.

The audit's year-0001 timezone/era finding is **deferred**: a UTC year-0001 clock
can underflow into BC in a western timezone while the formatter omits era. A
future scoped fix should validate the local era/range and add the boundary test.
Neither date-policy source nor its tests changed here. No live-clock or production
verification is claimed.

## Remaining limitations and next approvals

- The SQL/digest and changing its approval state require separate review. Applying
  to test and applying to development require separate explicit authorization.
- No live constraint, enum, transaction rollback, FK restriction, DDL locking or
  concurrency behavior is established by static SQL checks or injected tests.
- No database fingerprint was taken, because all database access was forbidden.
  This work issued no database operations; it does not claim independent live data
  comparison or revalidation of the historical smoke test.
- Notes length and future dates are enforced by application validation, not DB
  constraints. DATE serialization and cursor decoding will be wired in 3B.2.
- The migration uses an explicit SQL transaction, but Prisma history bookkeeping
  and interrupted/ambiguous deployment still require later live verification.
  A quiet database and no independent schema writers are prerequisites; local
  prechecks are not a cross-process schema lock or full drift detector.
- `core.autocrlf=true` can change migration/baseline bytes on a later checkout.
  Hashing intentionally remains byte-exact and fails closed. No Git config or
  .gitattributes change was made. Any future line-ending policy should preserve
  the approved LF bytes and receive a separately scoped review.
- Restricting User deletion is intentional; future application fixtures must be
  removed only under their own approved ownership/cleanup procedures. No such
  fixture infrastructure was added or enabled here.
- No create/list endpoint, frontend, status-history, archive/delete feature,
  browser scenario, production verification or Stage 3B.2 work occurred.

## Final Git inventory

```text
 M apps/api/prisma/migrations/0001_init_auth/migration.sql
 M apps/api/prisma/schema.prisma
 M apps/api/scripts/db.ts
 M apps/api/tests/authentication.integration.test.ts
 M apps/api/tests/csrf.integration.test.ts
 M apps/api/tests/persistence.integration.test.ts
 M apps/api/tests/sessions.integration.test.ts
 M packages/contracts/src/index.ts
 M vitest.config.ts
?? apps/api/prisma/baselines/0001_init_auth.prisma
?? apps/api/prisma/migrations/0002_job_applications/migration.sql
?? apps/api/scripts/db.test.ts
?? apps/api/scripts/migration-policy.test.ts
?? apps/api/scripts/migration-policy.ts
?? apps/api/src/modules/applications/date-policy.test.ts
?? apps/api/src/modules/applications/date-policy.ts
?? docs/milestones/checkpoint-3b1-offline-report.md
?? packages/contracts/src/applications.test.ts
?? packages/contracts/src/applications.ts
```

The initial migration entry reflects the approved LF working-file restoration,
not changed SQL. Branch and HEAD remain unchanged. There are eight tracked content
changes plus that restoration, ten new files, and nothing staged or committed.
