# Checkpoint 2B stages 1–2: authentication primitives

Implemented and locally verified on **2026-10-20 (Asia/Manila)**. Stop point: review before stage 2B.3. This is a partial checkpoint, not a completed authentication backend or production deployment readiness assessment.

## Implemented scope

- Strict shared Zod credential, public-user, CSRF, response, and error contracts. Emails are trimmed/lowercased ASCII addresses, maximum 254 characters; dots and plus suffixes remain unchanged.
- Registration passwords contain 15–128 Unicode code points; login accepts 1–128. Password case, whitespace, and Unicode normalization are preserved; malformed surrogates are rejected.
- Validated authentication configuration with one canonical origin, explicit boolean registration flag, HTTPS-only production origin, and forbidden production registration.
- Separate production runtime database configuration requiring an explicit identity/port and certificate-verified TLS, with optional validated PEM CA. Local/test/migration guards are preserved. Test processes cannot select development or production through the new runtime factory.
- Real Argon2id hashing/verifying, salted PHC storage, unknown-account dummy verification, fixed-cost profile validation, sanitized errors, and a two-operation admission limit shared by hash/verify within one password-service instance.
- Independent random session/CSRF tokens, SHA-256 session-token hashing, cookie creation/clearing/parsing, and constant-time comparison for well-formed CSRF tokens.
- Anonymous/authenticated session creation, lookup, atomic activity refresh, revocation, bounded expiration cleanup, and an opt-in non-overlapping cleanup task.

Only `argon2@0.45.1` and `cookie@2.0.1` were installed. Their seven newly installed packages are captured in the existing root lockfile. Installation audit reported zero vulnerabilities. The reviewed Argon2 install script was approved for exactly version 0.45.1 and rebuilt successfully using the existing environment. No machine configuration or build tools were installed.

The existing Express app and server are unchanged. New configuration parsers, runtime connection factory, password/session services, and cleanup timer are not wired into the HTTP server. No authentication routes, CSRF/origin middleware, email/IP rate-limit middleware, React screens, or CI changes were implemented. Supertest and express-rate-limit were not installed because their stages are not authorized yet.

## Session and cleanup policy

| Session | Enforced expiration |
| --- | --- |
| Anonymous | Fixed 15 minutes from creation, regardless of later activity or a later stored expiresAt |
| Authenticated | Earliest of 24 hours since last activity, seven days since creation, and stored expiresAt |

Expiration is inclusive at the boundary: `now >= deadline` is invalid. All decisions use injected UTC instants, independent of APP_TIMEZONE. Reads never refresh activity. Successful explicit authenticated refreshes update lastSeenAt on every call without extending absolute expiry. Conditional SQL checks every deadline before updating and uses GREATEST to prevent older concurrent timestamps replacing newer activity. Revocation deletes the presented session and cannot be undone by refresh.

Cleanup validates a batch size of 1–100. It selects expired rows using FOR UPDATE SKIP LOCKED and repeats the expiration predicate in DELETE. Authenticated idle and absolute deadlines are both enforced. Row locking prevents stale cleanup from deleting a valid in-flight refresh. Absolute expiration still applies even after recent activity. Cleanup never deletes users or active sessions.

The optional task runs at most one batch per minute, does not overlap, does not keep the process alive, and drains its running operation when stopped. Failure logging emits only a fixed message, never the underlying error. It is not started by the current application or integration harness.

Session creation accepts a guarded Prisma client or an existing Prisma transaction. A primitive called inside a transaction may return before that outer transaction commits: future authentication orchestration must await the entire transaction before issuing cookies. Registration/login rotation and HTTP delivery remain stage 2B.4 work.

Cookies are host-only, HttpOnly, SameSite=Lax, Path=/, with fixed expiry. Production uses __Host-applyflow_session and Secure; local HTTP uses applyflow_session without Secure. Clearing preserves the same attributes/name. Malformed tokens do not reach hash lookups; duplicate session cookies are rejected without reflecting their values.

## Actual local verification

Runtime: **Node v24.22.0 / npm 11.19.1 / Windows**.

| Command/check | Actual result |
| --- | --- |
| `npm.cmd run lint` | Exit 0 |
| `npm.cmd run typecheck` | Exit 0 |
| `npm.cmd test` | Exit 0; **127 passed, 0 failed, 8 files** |
| `npm.cmd run test:integration` | Exit 0; **37 passed, 0 failed, 2 files** |
| `npm.cmd run build` | Exit 0; contracts, API, frontend |
| `npm.cmd run bench:passwords` | Exit 0; approved parameters unchanged |
| Direct compiled ESM smoke check | Real Argon2 hash/verify and production cookie serialization passed |
| `npm.cmd ls argon2 cookie` | Approved direct versions present; Express retains its separate existing cookie dependency |
| Final database schema/history and data fingerprint comparison | Both targets unchanged; zero User/Session rows restored |
| `git diff --check` | Exit 0; Git emitted LF/CRLF conversion warnings only |
| Secret scan of committable files | Local database passwords absent from all 73 files |

**164 distinct test cases pass.** The original 60 unit and 15 persistence tests remain. New coverage adds 67 unit cases and 22 PostgreSQL integration cases.

An initial native-hash test caught an incorrect assumption about PHC parameter ordering. The library serializes parameters in a different order. Validation now checks the exact three approved parameter values independently of order and rejects duplicate, extra, malformed, or excessive-cost parameters. No security parameter or test expectation was weakened.

Deterministic tests cover email normalization; Unicode/password boundaries; exact cookie policy; format-safe token comparison; fixed anonymous, idle, and absolute boundaries at -1/0/+1 ms; activity monotonicity; shared hash/verify concurrency limits; overload/error admission behavior; and sanitized logging. Database tests additionally verify real password-hash persistence, hashed session storage, invalid-owner rollback, caller-owned transaction rollback, concurrent revocation/refresh, concurrent bounded cleanup, and cleanup racing an uncommitted valid refresh.

## Argon2 benchmark

Profile: **Argon2id v19, 65,536 KiB memory, three iterations, parallelism one, 16-byte random salts, 32-byte output**. Ten sequential samples per operation after warmup; CPU: AMD Ryzen 7 7735HS with Radeon Graphics.

| Operation | Minimum | Median | Sample p95 |
| --- | --- | --- | --- |
| Hash | 118.22 ms | 125.60 ms | 129.21 ms |
| Verify | 117.92 ms | 119.91 ms | 147.48 ms |
| Unknown-account dummy verify | 154.92 ms | 164.73 ms | 185.58 ms |

No password, salt, or PHC digest is printed by the benchmark, and no accounts/database writes are involved. These small local samples depend on hardware, load, and native-library behavior; they are not throughput guarantees or proof that account timing is indistinguishable. Parameters were not reduced. Unknown-account verification still performs real Argon2 work using the same profile.

## Database safety

| Target | Host | Port | Verified database/user |
| --- | --- | --- | --- |
| Development | 127.0.0.1 | 15432 | applyflow_dev / applyflow_dev |
| Test | 127.0.0.1 | 5433 | applyflow_test / applyflow_test |

Read-only schema/history and content fingerprints were captured before implementation and compared after all integration tests. Both targets matched their complete baseline. Development data was unchanged, and test fixtures were removed, restoring zero User and Session rows on both targets. No development fixture writes occurred.

The new suite requires NODE_ENV=test, the dedicated test URL, connected-identity validation, the approved SQL hash, and matching completed migration history before writes. Its clock is chosen earlier than every pre-existing session timestamp, including all expiration-boundary advances, so cleanup queries can select only its owned fixtures. Cleanup hooks use tracked session UUIDs and tracked user UUIDs plus a random email prefix. No broad cleanup or reset occurs.

The Prisma schema, original SQL, migration history, and migration scripts are unchanged. Approved SQL SHA-256:

```text
98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840
```

## Security assumptions and remaining work

- Production configuration support is **not production deployment readiness**. No production connection, TLS handshake, Linux native-addon run, hosted CI run, proxy topology, certificate provisioning, or browser cookie behavior was verified in this stage.
- The future server composition must validate both authentication and database settings, create one password-service instance per process, inject only guarded database clients, and start/stop cleanup with the database lifecycle. No request header may supply clocks, tokens, configuration, or test dependencies.
- The two-operation password gate bounds concurrent native work within that instance; it does not implement IP/email quotas or promise a total process-memory limit. There is no unbounded work queue. Unexpected/corrupt PHC profiles fail closed; a future cost upgrade must explicitly preserve supported old profiles or arrange rehashing.
- Email/IP limiter implementation and key-privacy tests belong to 2B.3. Keys must use an opaque keyed digest of canonical IP plus normalized email, not raw emails. No such keys/stores exist yet. Current helpers never log credentials; cleanup logging and password error redaction are tested with secret-bearing failures.
- Anonymous allocation quotas, origin validation, and HTTP CSRF enforcement are not active yet because no authentication endpoint is exposed. A CSRF comparison helper alone is not the full CSRF defense.
- Revocation and activity updates do not resurrect rows. A previously admitted request may finish while revocation/expiration occurs. Trusted server clocks, protected database access, and cryptographically secure randomness remain assumptions.
- Normalized email handling is a contract/service obligation; the unchanged PostgreSQL email uniqueness index compares stored values. No registration service has been implemented yet.
- HTTPS routing, deployment-specific proxy trust, production role permissions, operational timeouts/monitoring, email verification, password recovery, and registration-abuse readiness remain separately reviewable work.

## Files changed

| Group | Files |
| --- | --- |
| Shared contracts | [auth.ts](../../packages/contracts/src/auth.ts), [auth.test.ts](../../packages/contracts/src/auth.test.ts), [index.ts](../../packages/contracts/src/index.ts) |
| Configuration | [auth.ts](../../apps/api/src/config/auth.ts), [auth.test.ts](../../apps/api/src/config/auth.test.ts), [production-database.ts](../../apps/api/src/config/production-database.ts), [.env.example](../../apps/api/.env.example) |
| Database connection | [client.ts](../../apps/api/src/db/client.ts) |
| Session helpers | [sessions.ts](../../apps/api/src/modules/auth/sessions.ts), [tokens.ts](../../apps/api/src/modules/auth/tokens.ts), [cookies.ts](../../apps/api/src/modules/auth/cookies.ts), [cleanup.ts](../../apps/api/src/modules/auth/cleanup.ts) |
| Password helper | [passwords.ts](../../apps/api/src/modules/auth/passwords.ts) |
| Unit tests | [passwords.test.ts](../../apps/api/src/modules/auth/passwords.test.ts), [sessions.test.ts](../../apps/api/src/modules/auth/sessions.test.ts), [tokens-cookies.test.ts](../../apps/api/src/modules/auth/tokens-cookies.test.ts) |
| Database tests | [sessions.integration.test.ts](../../apps/api/tests/sessions.integration.test.ts) |
| Benchmark | [benchmark-passwords.ts](../../apps/api/scripts/benchmark-passwords.ts) |
| Packages/scripts | [root package.json](../../package.json), [API package.json](../../apps/api/package.json), [root lockfile](../../package-lock.json) |
| Documentation | [README](../../README.md), this report |

Existing local/test target-validation code, Prisma schema/migrations, Express app/server, frontend, GitHub Actions, and earlier milestone reports remain unchanged. The working changes comprise seven modified and sixteen new files; all remain uncommitted.

No commits, pushes, deployments, migrations, resets, development-data deletion, or volume operations were performed. Review stages 2B.1–2B.2 before authorizing 2B.3.
