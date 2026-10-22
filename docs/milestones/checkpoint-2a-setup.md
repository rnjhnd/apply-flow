# Checkpoint 2A — PostgreSQL and Prisma setup

Status: **Checkpoint 2A locally verified**. The user approved the unchanged initial SQL on 2026-10-20, and it was applied only to the approved isolated development and test databases. Checkpoint 2B has not begun. New migration targets still require explicit approval before applying SQL or running persistence tests.

The existing frontend and health API do not use the database yet. There are no authentication endpoints, registration, password hashing, or frontend authentication changes in this checkpoint.

## Local services and secrets

| Service | Database / user | Host port | Storage |
| --- | --- | --- | --- |
| `postgres-dev` | `applyflow_dev` | `127.0.0.1:15432` | `applyflow_postgres_dev_data` |
| `postgres-test` | `applyflow_test` | `127.0.0.1:5433` | `applyflow_postgres_test_data` |

Both use `postgres:17-bookworm`, UTC configuration, and independent passwords/volumes. Container port 5432 is internal to each service. The test profile is enabled explicitly by its wrapper. Startup uses `--no-recreate`; stopping retains both containers and named volumes. No volume deletion command is provided.

The user approved development host port 15432 after discovery of an existing local PostgreSQL process on 5432. That existing installation is left untouched; test remains on host port 5433.

Initialize local configuration from the repository root:

```powershell
npm.cmd run db:env:init
```

This creates ignored `apps/api/.env` with separate cryptographically random 32-byte hexadecimal passwords and matching connection URLs. It refuses to overwrite an existing file or compete with inherited database configuration. Values are never printed. Existing users should deliberately extend their local environment using the example instead of overwriting it.

`DATABASE_URL` is exclusively for development; `TEST_DATABASE_URL` is exclusively for tests. Compose also consumes `POSTGRES_DEV_PASSWORD` and `POSTGRES_TEST_PASSWORD`, and its wrapper verifies they match the respective URLs and are distinct. Existing process variables take precedence over the local environment file.

Local container-owner credentials are suitable only for these loopback-bound development/test services. Production needs separately provisioned migration/runtime roles; production targeting is unsupported by this checkpoint's tooling.

## Commands and side effects

| Root command | Side effects |
| --- | --- |
| `db:env:init` | Creates a local ignored environment file; never overwrites it |
| `db:compose:validate` | Quiet Compose validation; no expanded credential output |
| `db:up` | Starts/initializes only development PostgreSQL and its named storage |
| `db:test:up` | Starts/initializes only test PostgreSQL and its separate named storage |
| `db:stop` | Stops both services; retains containers and volumes |
| `db:validate` | Offline Prisma schema validation |
| `db:generate` | Offline server-only TypeScript client generation |
| `db:verify` | Read-only database/user identity and public-table checks against both targets |
| `db:migrate:create -- --name init_auth` | Generates the initial SQL file without connecting to either database |
| `db:migrate:deploy -- --approved-sql-sha256 <approved digest>` | After explicit SQL approval only: guarded application to development |
| `db:migrate:test -- --approved-sql-sha256 <approved digest>` | After explicit SQL approval only: guarded application to the dedicated test database |
| `test:integration` | Generates the client offline, then runs PostgreSQL tests only against the already-migrated test database |

The last two commands fail before connecting unless supplied with the exact approved SQL SHA-256. A digest is an integrity guard, not authorization: the user must first explicitly approve that SQL. No command is invoked automatically by install, development, build, or unit-test scripts to apply migrations or seed data.

The initial-only generator refuses existing migrations and writes [the review SQL](../../apps/api/prisma/migrations/0001_init_auth/migration.sql). It uses `migrate diff --from-empty --to-schema ... --script`, never `migrate dev`, and requires no shadow database. It prints the complete SQL and its SHA-256, then stops. Failed generation is not automatically retried by deleting its output directory.

## Target and write safeguards

- URLs must specify the approved username, database, and explicit port on `127.0.0.1` or `localhost`. No test-to-development fallback is allowed.
- Only the optional `schema=public` connection parameter is accepted. Unknown or duplicate options, fragments, placeholder passwords, and malformed encodings are rejected.
- Test processes cannot select development. Test-data writes must additionally use `requireTestDatabaseTarget` with `NODE_ENV=test`.
- The client connects and verifies `current_database()` and `current_user()` before it is returned to write-capable callers. Connection/query errors are reported without credentials.
- Migration children discard inherited `PG*` overrides. Connection pool options explicitly select the public schema, a five-connection maximum, and a five-second connection timeout.
- The migration wrapper verifies the SQL digest, limits migration history to the approved initial migration, and rejects unexpected tables/history. It connects first, so Prisma cannot implicitly create a missing database.
- Normalized email storage will be enforced by checkpoint 2B's validation/service layer; the database's initial email uniqueness constraint compares stored values.

The persistence integration runner is separate from `npm test` and does not create databases or apply migrations. Its setup requires `NODE_ENV=test`, a valid dedicated `TEST_DATABASE_URL`, the unchanged approved SQL hash, and exactly one successfully applied matching migration before any fixture writes. Vitest defaults to test mode; an explicitly supplied different environment fails closed. No development URL is required by the suite.

Before write transactions and cleanup, the suite checks both the URL target and connected database/user identity. Most fixtures are rolled back; the committed-persistence test tracks its own UUID and a random per-run email prefix. Cleanup deletes only matching owned fixture IDs in the test database, with related sessions removed by the reviewed foreign key. No broad table cleanup or development writes occur. Unit tests still exercise target guards without opening a database connection.

Do not run database resets, schema/database drops, `TRUNCATE`, `db push`, or volume deletion. Unexpected existing state requires review, never automatic recovery. Do not stop other PostgreSQL installations or modify host networking to resolve a port conflict.

## Original verification before SQL generation

```powershell
npm.cmd ls prisma @prisma/client @prisma/adapter-pg
npm.cmd run db:compose:validate
npm.cmd run db:up
npm.cmd run db:test:up
npm.cmd run db:validate
npm.cmd run db:generate
npm.cmd run db:verify
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
```

Generated Prisma code is ignored. API TypeScript enables relative import rewriting so the generator's `.ts` imports work with `tsx` and become `.js` in compiled ESM. Prisma configuration and script files are typechecked. Existing CI can generate/build without a database; database-backed workflow changes are deferred to 2C.

Prisma 7.10.1's schema engine requires datasource metadata even for an empty-to-schema diff. Offline commands therefore receive the inert URL `postgresql://offline:offline@127.0.0.1:1/offline`, rather than either real database's credentials. The diff still compares only the empty model and schema file; it does not use `--from-config-datasource` or `--to-config-datasource`. Live migration URLs are selected only by the guarded wrapper. Missing or empty SQL output is treated as a failure even if the CLI exits successfully.

The following initial-only generation step has already been completed and approved. Do not regenerate or modify the reviewed migration:

```powershell
npm.cmd run db:migrate:create -- --name init_auth
```

## Approved SQL application and verification

Approved migration: `0001_init_auth`. Approved SHA-256:

```text
98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840
```

Both models use Prisma `@default(uuid())`: UUIDs are generated by Prisma, not a PostgreSQL column default. Direct SQL inserts must supply UUIDs explicitly. The integration suite creates both models without supplying IDs and verifies generated UUIDs and their relationship.

For the approved local targets, the guarded application commands are:

```powershell
npm.cmd run db:migrate:deploy -- --approved-sql-sha256 98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840
npm.cmd run db:migrate:test -- --approved-sql-sha256 98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840
npm.cmd run db:verify
npm.cmd run lint
npm.cmd run typecheck
npm.cmd test
npm.cmd run test:integration
npm.cmd run build
```

The first two commands were each executed twice. The second invocation reported the migration already applied and made no changes. Read-only catalog/history fingerprints remained identical; development row counts and content fingerprints remained unchanged throughout persistence testing. Test fixtures were removed, returning test data to its baseline.

See the [completion report](checkpoint-2a-report.md) for actual results. Local checks do not constitute a hosted GitHub Actions run; database-backed CI remains deferred to 2C. Authentication behavior, session expiration, CSRF, and HTTP endpoints remain out of scope until 2B.
