# Checkpoint 2A completion report

Verified locally on **2026-10-20 (Asia/Manila)**. Checkpoint 2A is complete and awaiting review. Checkpoint 2B has not begun.

## Scope and approval

The user explicitly approved applying `0001_init_auth` only to the isolated ApplyFlow development and test databases. The SQL was not modified. Its SHA-256 was checked before application, by both guarded scripts, by integration setup, and again during final verification:

```text
98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840
```

No resets, schema/database drops, truncation, development-data deletion, volume removal, commits, pushes, application deployment, or later-checkpoint implementation occurred.

## Actual targets

| Target | Client endpoint | Connected database | Connected user | Container |
| --- | --- | --- | --- | --- |
| Development | `127.0.0.1:15432` | `applyflow_dev` | `applyflow_dev` | `applyflow-postgres-dev-1` |
| Test | `127.0.0.1:5433` | `applyflow_test` | `applyflow_test` | `applyflow-postgres-test-1` |

Both containers were healthy. Docker inspection confirmed the loopback bindings. The server-reported addresses matched their container addresses (`172.18.0.3` development, `172.18.0.2` test); PostgreSQL listens on port 5432 internally. Those container addresses are observations, not configuration contracts. Separate credentials and named volumes remain configured. The existing host PostgreSQL service on port 5432 was untouched.

Docker inspection used approved sandbox escalation. No machine-level Docker, WSL, or PATH settings changed.

## Applied schema and repeat deployment

Both databases have the reviewed `User` and `Session` tables, 12 application columns, six valid indexes, two primary keys, and the validated session-to-user foreign key with update/delete cascades. Email and session token hashes have unique indexes. Session `userId` remains nullable. Each database has exactly one successful, non-rolled-back `0001_init_auth` migration with the approved checksum, one applied step, and no failure log.

Both IDs use Prisma `@default(uuid())` with PostgreSQL UUID columns. There is deliberately no SQL UUID default or extension dependency. Integration tests successfully created both models without explicit IDs and verified distinct UUIDv4 values. Direct SQL callers must supply UUIDs themselves.

Both guarded migration commands were run twice. Each second invocation returned `The reviewed initial migration is already applied; no changes made.` The wrapper did not invoke Prisma again after recognizing the completed migration. Catalog/history snapshots before and after repeat deployment and testing had identical fingerprints:

| Target | SHA-256 of sorted column/index/constraint metadata and complete migration history |
| --- | --- |
| Development | `c03637cac57065739535f8e3a3d99c3e96b277aa924d858ebc511c1aabba2785` |
| Test | `759ac2f86dec319ba48a01ba5a842b31667e0b631d85ab501af04d33697f080e` |

The fingerprints differ between targets because migration-history row IDs and timestamps differ. Within each target they remained unchanged. Both databases had zero User and Session rows after migration. Row counts and content fingerprints were unchanged after persistence testing; only the test database received temporary fixtures. No development fixture writes occurred.

## Commands and actual results

Runtime: Node.js **v24.22.0**, npm **11.19.1**. No dependencies were installed in this follow-up.

| Command or check | Actual result |
| --- | --- |
| `Get-FileHash -Algorithm SHA256 apps/api/prisma/migrations/0001_init_auth/migration.sql` | Approved digest matched |
| `npm.cmd run db:verify` before application | Both identities matched; empty public schemas |
| Read-only SQL identity plus Docker port/address inspection | Both approved targets confirmed |
| `npm.cmd run db:migrate:deploy -- --approved-sql-sha256 98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840` | Exit 0; applied development migration |
| `npm.cmd run db:migrate:test -- --approved-sql-sha256 98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840` | Exit 0; applied test migration |
| Same two migration commands, second invocation | Exit 0 each; no changes |
| Read-only PostgreSQL catalog and migration-history queries | Reviewed schema and completed history confirmed on both targets |
| `npm.cmd run lint` | Exit 0 |
| `npm.cmd run typecheck` | Exit 0, including integration configuration/tests |
| `npm.cmd test` | Exit 0; **60 passed, 0 failed, 3 files** |
| `npm.cmd run test:integration` | Exit 0; **15 passed, 0 failed, 1 file** |
| `npm.cmd run build` | Exit 0; contracts, compiled API, frontend |
| `git diff --check` | Exit 0; only existing LF/CRLF conversion warnings |

Total passing test cases: **75**. Integration tests ran twice successfully; repeated runs are not counted as additional distinct test cases.

Three separate negative integration-runner probes deliberately returned exit 1 during setup, before test bodies ran: a development URL substituted for the test URL, an empty test URL with no fallback, and `NODE_ENV=production`. Each emitted the expected target/environment guard error. These were successful fail-closed checks, not unresolved failures or additional passing test cases.

## Persistence test coverage and safeguards

The separate Vitest integration configuration discovers only database tests. Unit tests and existing CI remain independent of PostgreSQL. The suite verifies:

- Dedicated database/user identity and rejection of a development URL.
- Physical column types, nullability, timestamp precision/defaults, six indexes, primary keys, and cascading foreign key.
- The approved SQL digest and completed migration history before fixture writes.
- Prisma-generated UUIDs, persisted relationships, and multiple anonymous sessions.
- A committed graph read through a separate guarded test connection.
- Full rollback after an exception and after session uniqueness failure, leaving no partial parent/session state.
- Duplicate email/token-hash rejection and nonexistent-parent rejection.
- Deletion cascades that preserve an unrelated anonymous fixture and primary-key update cascades.

Setup requires `NODE_ENV=test` and a dedicated test URL; it does not override an explicitly supplied environment. URL validation occurs before connecting. Every write transaction and cleanup validates the connected database and user. Most fixtures roll back. Committed fixture cleanup requires both owned UUIDs and the random run-specific email prefix; related sessions cascade. The suite neither creates databases nor applies migrations and never performs broad table cleanup.

## Files changed in this follow-up

- [Persistence integration tests](../../apps/api/tests/persistence.integration.test.ts)
- [Integration Vitest configuration](../../vitest.integration.config.ts)
- [Root package scripts](../../package.json): added `test:integration`
- [Root TypeScript configuration](../../tsconfig.json): included integration configuration/tests
- [README](../../README.md): current persistence status and test command
- [Checkpoint setup guide](checkpoint-2a-setup.md): approval status, guarded application, test safeguards
- This completion report

The earlier Checkpoint 2A Compose, Prisma, target-guard, dependency/lockfile, and supporting configuration changes also remain uncommitted. The approved migration SQL is unchanged in this follow-up. AGENTS.md, PRD.md, DESIGN_SYSTEM.md, the Milestone 1 report, frontend/contracts, and `.github/workflows/ci.yml` were not changed.

## Remaining scope and limitations

No blocking local failures remain. Application code does not yet use persistence for authentication or tracking. Password hashing, session lifetime enforcement, transactional authentication flows, cookies, CSRF, rate limiting, and HTTP authentication integration tests remain checkpoint 2B. The test password string is an explicitly labeled persistence fixture, not an authentication implementation.

Database-backed GitHub Actions changes and React authentication screens remain checkpoint 2C. No hosted CI run was triggered or claimed for these uncommitted changes. Local container-owner credentials are not a production database-role strategy. Review Checkpoint 2A before authorizing further work.
