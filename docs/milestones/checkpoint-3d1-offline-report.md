# Stage 3D.1 - Archive schema foundation offline report

## Scope and result

Implementation baseline: `feat/application-lifecycle`, HEAD
`1775effda93ceb0d211f33ffed245ca20219f4b7`, initially clean with an empty staging
area. The offline schema/migration foundation is complete. Migration 0004 is
**REVIEW_PENDING**; neither source approval nor database deployment is granted.

No database connection, migration deployment, integration suite, browser session,
service launch, staging or commit occurred. Lifecycle contracts, routes, services
and UI are unchanged. Stage 3D.2 has not begun.

## Schema, frozen baseline and exact candidate SQL

The only Prisma schema change is:

```diff
   version         Int              @default(1)
+  archivedAt      DateTime?         @db.Timestamptz(3)
```

Null means active; a server-assigned archive timestamp is future API work. The new
frozen `0003_application_status_history.prisma` baseline is byte-for-byte identical
to the committed pre-archive schema, with LF bytes and SHA-256:
`3cee89893fdea259cd3dfcbae5b85939508c01f646866d68adedc31e05d87229`.

Generated file: [0004_application_lifecycle/migration.sql](../../apps/api/prisma/migrations/0004_application_lifecycle/migration.sql).

```sql
BEGIN;

-- AlterTable
ALTER TABLE "JobApplication" ADD COLUMN     "archivedAt" TIMESTAMPTZ(3);

COMMIT;
```

Candidate SHA-256:
`cfa58ef4e3bbe91b5271291033ef33412194e2ce8dba91071047982f42dcda8c`.

The SQL adds one nullable column without a default, data UPDATE or history
backfill. Existing rows would remain active, with original fields, versions and
timestamps preserved. Existing indexes, CHECKs, enums and ownership/history FKs
are untouched, including ON DELETE RESTRICT. These are source-level conclusions;
live data preservation and transactional rollback were not exercised.

## Migration policy and wrapper

- The immutable manifest explicitly contains four names/digests. Only 0004 is
  REVIEW_PENDING; historical approvals and pins are unchanged.
- The new offline generator requires exactly `--name application_lifecycle`, the
  exact three-migration directory prefix, and all protected migration/baseline
  bytes before directory creation. It refuses overwrite and unexpected arguments.
- The schema-to-schema diff selects no live datasource or shadow database. Child
  environment handling strips inherited migration selectors and PG variables;
  the unchanged Prisma configuration uses the inert offline URL.
- An exact diff guard permits only nullable TIMESTAMPTZ(3) archivedAt. Defaults,
  NOT NULL, other columns/tables, data writes, indexes and FK changes are rejected.
- File verification defaults to all four migrations and all three baselines. Its
  explicit three-file mode exists for pre-generation inspection, not deployment.
- Deployment approval is checked before environment loading, driver construction
  or subprocess execution. REVIEW_PENDING blocks both target wrappers. Future
  source approval must still be followed by separately authorized execution with
  the exact fourth checksum and completed 0001 + 0002 + 0003 history. One-/two-
  migration prefixes cannot be advanced under fourth-migration approval.
- Exact full history remains an idempotent no-op; malformed, conflicting, extra,
  failed or causally reordered history is rejected. The three-/four-migration
  schemas have the same expected table inventory. No reset/resolve/retry path was
  introduced. Historical authentication-only B2/C1 safeguards are unchanged.

## Protected historical artifacts

Filesystem hashing and direct comparison against HEAD confirmed unchanged bytes:

| Artifact | SHA-256 |
| --- | --- |
| Migration 0001 | `98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840` |
| Migration 0002 | `74e056f699c2781c01f12d3195ed119074d5b0d4d04fef979c185e17d775a333` |
| Migration 0003 | `7e607ec39d1c278e12bb6db8c5895f23d69ea3e695bd72519e96a34e9c93d85e` |
| Frozen baseline 0001 | `043b3e43163c7aa05f09be3d3a3dabd5e9698418bca265c40bad9fe022dd1129` |
| Frozen baseline 0002 | `3d348c49d8756fa6d43372118f654ab4c45e8b87a9e96d86671ffaa03ec36521` |

Existing scoped .gitattributes rules already enforce LF for both new artifacts;
no attribute changes were needed.

## Offline verification

| Command/check | Observed result |
| --- | --- |
| `npm.cmd run db:migrate:create -- --name application_lifecycle` | Exit 0; generated once through the guarded offline diff. |
| `npm.cmd run db:validate` | Exit 0; Prisma schema valid. |
| Repeated Prisma schema-to-schema diff, captured in memory, wrapped and compared | Exit 0; candidate bytes and SHA-256 identical. The child used `migrate diff --from-schema` frozen 0003 `--to-schema` current schema `--script`, without datasource selection or output-file writes. |
| Node filesystem/hash verification using `verifyMigrationFiles()` and HEAD blob comparisons | Exit 0; all protected pins match; new baseline equals the prior committed schema. |
| `npm.cmd exec -- vitest run --project unit apps/api/scripts/migration-policy.test.ts apps/api/scripts/db.test.ts` | Exit 0; 149/149 tests in two files. |
| `npm.cmd exec -- vitest run --project unit apps/api/scripts apps/api/src/modules/applications tests/e2e/support` | Exit 0; 1,037/1,037 tests in 28 files, including the focused policy tests above. These totals are not additive. |
| `npm.cmd run lint` | Exit 0, including final rerun after the fixture correction. |
| `npm.cmd run typecheck` | Final exit 0. Initial exit 1 identified a full Prisma JobApplication test fixture missing archivedAt; adding only `archivedAt: null` resolved it. |
| `npm.cmd run build` | Exit 0; contracts, API and web builds. Client generation remained offline. |
| `git diff --check` and new-file whitespace inspection | Passed. |

Policy/wrapper tests use injected environment, process and database ports. They
cover hypothetical future approval without changing source approval, exact
prefixes/checksums, pending denial before resources, file tampering, immutable
baselines, unexpected SQL, overwrite refusal, failed/missing engine output and
single-attempt deployment/post-verification behavior. Real PostgreSQL behavior is
not established by these doubles.

## Changed files and remaining boundary

Modified: `apps/api/prisma/schema.prisma`; `apps/api/scripts/migration-policy.ts`
and its test; `apps/api/scripts/db.ts` and its test; and one nullable-field addition
to the full Prisma fixture in
`apps/api/src/modules/applications/edit-history.test.ts`.

New: frozen baseline 0003, migration 0004 SQL, and this report. Generated Prisma
client/build artifacts remain ignored. No contracts, API implementation,
frontend, historical migration/baseline files, PRD or historical test guards were
changed. All changes remain unstaged.

No implementation blocker remains in the offline checks. The exact candidate SQL
requires separate source review/approval; database preflight, migration execution,
preservation verification and updated integration catalog admission remain future
work. Current source intentionally rejects live chain admission while 0004 is
pending. Do not run a new schema-dependent runtime against an unmigrated database.
