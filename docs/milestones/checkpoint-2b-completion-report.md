# Checkpoint 2B completion — final backend authentication security verification

Date: **2026-10-20 (Asia/Manila)**. Branch: **feat/authentication**. Runtime: **Node v24.22.0 / npm 11.19.1 / Windows**.

**Stage 2B.5 review and local verification are complete.** Fresh checks pass: **240 unit/HTTP tests and 108 PostgreSQL integration tests, 348 total**. The review reproduced and minimally fixed one low-severity logout status-contract defect. No authentication bypass, cross-device revocation defect, or sensitive JSON exposure was reproduced in the reviewed paths. Availability hardening and manual verification remain; this is not production deployment readiness or a substitute for an independent penetration test.

## Scope and method

Read AGENTS.md, PRD.md, and checkpoint reports, then inspected the actual authentication orchestration, HTTP routing/middleware order, bootstrap, rate stores, password/token/cookie/session/cleanup primitives, startup lifecycle, shared Zod contracts, Prisma schema/approved SQL, database configuration/guards/client/tooling, and test setup/cleanup. Earlier reports provided context, not proof of current correctness. Existing tests were inspected and rerun; missing targeted cases were added.

No dependencies, schema/migrations, shared contracts, database target guards/configuration, frontend, or GitHub Actions were changed. No production service was contacted. No development accounts or session fixtures were created. No infrastructure, application CRUD, or Checkpoint 2C work was introduced.

## Genuine defects and fixes

### F1 — anonymous logout could return 403 instead of the intended 401 (low severity, fixed)

**Trigger:** trusted, well-formed `POST /api/v1/auth/logout`, valid anonymous session cookie, but absent, malformed, or incorrect `X-CSRF-Token`.

**Before:** the route checked CSRF before checking whether the session was authenticated, returning 403. The transactional helper had the same ordering. The request was denied and no cookie/session mutation occurred, so this was a status-contract/client-handling defect, not an authentication bypass.

**Reproduction:** added regressions and ran `npm.cmd exec -- vitest run apps/api/src/modules/auth/routes.test.ts`. Actual result before the fix: **3 failed, 26 passed**, expected 401 but received 403.

**Minimal fix:** check `kind === 'authenticated' && userId === null` before CSRF in both [HTTP proof validation](../../apps/api/src/modules/auth/routes.ts) and [transactional session validation](../../apps/api/src/modules/auth/authentication.ts). Authenticated logout still requires matching CSRF; no Origin, Fetch Metadata, JSON, rate, cookie, expiration, or transaction checks were removed. Register/login policy is unchanged. The impact and intended change were explained before applying it.

**Verification:** focused HTTP suite passed **43/43** after adding the complete targeted HTTP coverage. New database tests also verify anonymous logout 401, transactional rejection, no state changes, malformed logout 400, and valid logout 204. Final full suites pass.

### Documentation correction

The cleanup helper still claimed that the server did not start its task. Actual startup has explicitly started it since stage 2B.3. Corrected that comment only; cleanup scheduling/SQL/locking behavior is unchanged. No speculative architecture changes were made.

## Endpoint policy audit

Every auth-prefix request passes request admission before session/password work and before JSON parsing. All endpoints require `X-ApplyFlow-Request: 1`; supplied Fetch Metadata must be `same-origin`, and a supplied Origin must exactly match configured APP_ORIGIN. Unsafe methods require Origin. Legacy clients may omit Fetch Metadata. No permissive CORS or preflight access was introduced.

| Endpoint | Session / CSRF | Body / Origin | Active limits / result |
| --- | --- | --- | --- |
| `GET /csrf` | Cookie optional; reuse valid anonymous/authenticated session; no CSRF request header required | No body/query; Origin optional but exact when present | 120 requests/IP/minute; new allocations also 20/IP/15 min and 500/process/15 min; 200 token only |
| `POST /register` | Valid anonymous cookie and matching CSRF; reject already authenticated | Strict email/password JSON; exact Origin mandatory | Request limit plus 5/IP/hour; explicit local/test enablement only; production unavailable; 201 safe user + new CSRF |
| `POST /login` | Valid anonymous cookie and matching CSRF; reject already authenticated | Strict email/password JSON; exact Origin mandatory | Request limit plus 30/IP/15 min and 5/email-IP/15 min; 200 safe user + new CSRF |
| `GET /me` | Valid authenticated cookie; no session-bound CSRF header required for GET | No body/query; optional exact Origin | Request limit; 200 safe user DTO; valid activity refreshed atomically; HEAD rejected |
| `POST /logout` | Valid authenticated cookie and matching CSRF | Empty object, or absent body with JSON media type; exact Origin mandatory | Request limit; 204 and clearing cookie only after current-session revocation commits |

Credentials are validated/normalized before credential admission. Session/CSRF preflight precedes expensive password work. Failed credential/backend attempts retain quota reservations. Invalid anonymous bootstrap requests never allocate sessions. Runtime always supplies the authentication service; existing bootstrap-only test compositions intentionally omit it and cannot be used as evidence that runtime routes exist. The startup code was separately inspected for full composition.

### Intentional logout status contract and precedence

| Case | Status / effect |
| --- | --- |
| Malformed JSON, invalid body fields/types, ambiguous session cookies after admission | **400**, no state change or cookie |
| Well-formed admitted request with missing, malformed-token, unknown, expired, revoked, or anonymous session | **401**, no cookie; anonymous status is independent of CSRF header presence/value |
| Authenticated session but missing, malformed, duplicate, or mismatched CSRF | **403**, no revocation or cookie |
| Valid authenticated session, valid CSRF, empty JSON request | **204**, no body/content type; current session revoked and cookie cleared after commit |
| Session deleted after valid preflight during a concurrent request | **409 SESSION_CHANGED** may replace 401; losing response never clears cookies |

Earlier admission retains priority: hostile/missing security headers can return 403 even if no session exists; unsupported method is 405, oversized JSON is 413, unsupported media/encoding is 415, quotas are 429, and storage/admission failure is sanitized 503. The 400 contract applies to malformed request syntax/shape, not every rejected request. Logout is intentionally not an unconditional/idempotent 204 endpoint.

## Transaction, concurrency, expiration, and privacy findings

- Registration/password work happens outside the transaction under the existing two-operation native gate. User creation, anonymous-session deletion, and authenticated replacement happen in one transaction. A real session-token uniqueness failure rolls everything back. A duplicate email conflict rolls back without consuming the losing anonymous session.
- Login performs real verification for known and unknown users, then locks/revalidates the anonymous session and rereads the verified hash under `FOR SHARE` on the user. The new regression holds the login transaction open and attempts a conflicting fixture-only password UPDATE with transaction-local `lock_timeout='200ms'`. PostgreSQL rejects it due to lock timeout, proving the shared lock blocks credential mutation through commit. Hash/owner state remains unchanged. No persistent setting was changed.
- Row locking permits only one concurrent login/register/mixed request to consume an anonymous session. Login/register generate both a fresh opaque token and fresh CSRF token; old proof/cookie does not authenticate. Other-device sessions are left intact.
- Cookie delivery follows the resolved **outer transaction**, not merely its callback. Existing real commit-gate tests observe raw HTTP response headers while holding transactions open and confirm no success/clearing cookies arrive before commit. Callback failure and actual constraint failure are tested; exhaustive network failure during COMMIT is not simulated.
- `/me` and logout revalidate after locking, so a valid preflight does not authorize an expired session later. New tests advance the injected clock to the exact idle deadline between preflight and transaction validation; neither activity nor revocation occurs. Existing fresh -1/0/+1 ms tests enforce anonymous fixed 15 minutes, authenticated 24-hour idle/seven-day absolute expiry, and an earlier stored expiration.
- `/me` uses conditional SQL with `GREATEST(lastSeenAt, now)` and all expiration predicates. It refreshes only valid activity and never extends absolute lifetime or issues a cookie. Failures/bootstrap do not refresh. Revocation cannot recreate rows.
- Concurrent logout produces one 204; the other response is 401 or 409 depending on preflight timing, without a clearing cookie. `/me` racing logout cannot resurrect the session. Another device remains valid.
- Cleanup uses bounded 1–100-row batches, expiration rechecks, and `FOR UPDATE SKIP LOCKED`. New PostgreSQL coverage proves it can delete a different expired row while skipping an in-flight valid refresh and preserving an active second device. The earlier suite's clock anchor is earlier than all pre-existing timestamps, so global cleanup predicates can select only this run's fixtures. Scheduler non-overlap, draining stop, error redaction, and refresh/cleanup races are freshly tested.
- Argon2id remains v19, 65,536 KiB, three iterations, parallelism one, 16-byte random salt and 32-byte output. Tests freshly verify real hashes, salt uniqueness, preserved password bytes/Unicode, dummy verification, corrupt/excess-cost PHC rejection, two-operation admission, and slot release after errors. No parameter reduction, rehash policy change, or new benchmark claim is made.
- Session tokens use 32 random bytes and SHA-256 storage. Format-checked CSRF comparison is timing-safe. Public user DTOs are projected to id/email, validated, and never serialize records or hashes. Raw session tokens are delivered only in HttpOnly cookies. Production uses Secure `__Host-` cookies; matching clearing attributes, local cookie policy, and rejection of the insecure cookie name in production mode are tested without a production connection.
- Reviewed application log sites emit fixed errors or startup host/port metadata. Limiter keys are per-process HMAC digests of canonical IP/normalized email, never raw identifiers. Pinned limiter debug logging receives a sanitized facade. A new injected secret-bearing session-preflight error yields only fixed JSON 503 and no error-log calls. Third-party debug configurations, proxy access logs, and production log pipelines were not exhaustively exercised.

## Rate-limit / denial-of-service review and remaining risks

These are operational risks and follow-up proposals, separate from the fixed F1 contract defect.

1. **Process-local quotas:** store memory is bounded to 5,000 keys per store, expired keys are reclaimed without evicting live entries, and capacity exhaustion fails closed. However, restarts reset quotas and instances do not coordinate. Distributed attacks, NAT/shared-proxy quotas, and saturation can deny legitimate users. IPv6 /56 grouping and direct socket IP (`trust proxy=false`) avoid easy forwarded-header/address-rotation bypass but need deployment-specific review. No Redis or replacement architecture was added.
2. **Allocation pressure:** new-session quota exhaustion returns 429. New HTTP regression proves existing valid-session bootstrap and health still work under exhausted global allocation budget. Request-key capacity exhaustion occurs earlier and can still deny a new IP even with a valid cookie. Allocation reservations are not refunded after database errors. Fixed windows can permit bursts around boundaries; quotas are not load/throughput guarantees.
3. **Query and lock deadlines need explicit operational policy:** read-only `SHOW` on both local targets reports `statement_timeout=0`, `lock_timeout=0`, isolation `read committed`. Runtime adapter config has a five-connection pool, 5-second connection timeout, and 30-second idle timeout, but no explicit statement/query/lock deadline. A connection timeout does not establish an execution deadline for an already-running query. Prisma transaction handling is not a universal deadline for standalone lookup/cleanup queries. A paused/blocked database can retain requests/resources and complicate shutdown. **Proposed minimal follow-up, requiring review:** choose bounded statement/lock and relevant driver/query timeouts in the existing runtime adapter configuration; add blocked-query, 503/rollback, pool-recovery, and cleanup-stop tests. Values should align with measured workload and transaction budgets. No runtime/role/database settings were changed here; no production target was queried.
4. **Bounds do not cover the whole process:** counter caps and two-operation password admission do not bound all open sockets, slow request bodies, pending application requests, SQL queue memory, or total CPU. Health intentionally remains outside auth quotas and is liveness, not readiness. Cleanup's row batch cap does not guarantee bounded scan cost on a large session table. Load testing, operational timeouts, monitoring, and deployment-edge limits remain unverified.
5. **Response ordering and uncertain delivery:** atomic commit cannot guarantee cookie delivery. A lost success response may leave a committed account/session without a client cookie. A future client must serialize bootstrap/auth mutations and avoid racing an old successful logout clearing response against a later login. Already authorized requests can complete around revocation; failed/stale responses never clear cookies. No destructive compensation or new endpoint was introduced.
6. **Limited public exposure:** local/test duplicate registration can distinguish success from account-unavailable; public production registration stays disabled pending email verification, password recovery, and abuse readiness. Dummy verification/generic login errors reduce enumeration differences but do not establish statistically indistinguishable timing. Trusted clocks, protected database access, secure randomness, HTTPS and absence of same-origin XSS remain assumptions.

## Fresh commands and actual results

| Command/check | Result |
| --- | --- |
| `node --version`, `npm.cmd --version` | v24.22.0 / 11.19.1 |
| `npm.cmd run db:verify` | Exit 0; both approved database/user identities and public tables |
| Focused routes suite before F1 fix | Exit 1; **3 failed / 26 passed**; genuine status regression reproduced |
| `npm.cmd exec -- vitest run apps/api/src/modules/auth/routes.test.ts` after fix/targeted tests | Exit 0; **43 passed** |
| `npm.cmd run lint` | Exit 0; no errors or warnings |
| `npm.cmd run typecheck` | Exit 0; strict workspaces/tooling/integration checks |
| `npm.cmd test` | Exit 0; **240 passed, 0 failed, 11 files** |
| `npm.cmd run test:integration` | Exit 0; **108 passed, 0 failed, 4 files** |
| `npm.cmd run build` | Exit 0; contracts, offline client generation, API and frontend production builds |
| Read-only before/after schema/history and row-content audit | Both local targets identical |
| `git diff --check`, protected-path diff and secret review | No unrelated/protected changes or whitespace errors; 87 committable files scanned, 0 local credential matches |

**348 final tests pass**, including all original 317. Added **18 unit/HTTP and 13 PostgreSQL regression cases**. No assertion was weakened and no test was skipped. The deliberate lock-timeout error is an expected test assertion, not a failed verification command. The initial three regression failures are resolved. Hosted GitHub Actions was not run or modified.

## Database isolation and migration evidence

| Target | Validated host/port | Connected database / username | User / Session counts before → after |
| --- | --- | --- | --- |
| Development | `127.0.0.1:15432` | `applyflow_dev / applyflow_dev` | 0 / 0 → 0 / 0 |
| Test | `127.0.0.1:5433` | `applyflow_test / applyflow_test` | 0 / 0 → 0 / 0 |

Compared ordered row-content digests as well as counts, plus ordered public columns, indexes, constraints, and complete migration-history fingerprints. Both targets matched their pre-review baseline:

```text
Development schema/history: a2fa70b62ff202b1ef88d0304efa7d47636b554414652746047f65ff9a5cdac8
Test schema/history:        fafb53d3919e5774d55fc5fdb80efe27fc1119b048f58906635f0db6522fbeeb
Approved migration SQL:     98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840
```

Integration setup requires NODE_ENV=test, the dedicated target guard, verified connected identity, unchanged SQL checksum, and matching completed migration before writes. Cleanup rechecks identity in its transaction and restricts deletion to tracked fixture UUIDs and the random run-owned email namespace; sessions belonging to those run-owned users are tracked before removal. Cleanup-logic tests additionally isolate their expiration clock from all pre-existing rows. No development fixture writes, migrations, resets, broad cleanup, volume deletion, or system configuration changes occurred. The timeout regression uses SET LOCAL inside one test transaction only; subsequent SHOW confirms persistent settings unchanged.

## Manual verification and limitations

- Exercise HTTPS cookie acceptance/clearing and browser behavior through the intended same-origin proxy: HttpOnly, Secure, SameSite=Lax, host-only scope, and __Host prefix. Unit serialization is not browser/TLS proof.
- Verify real browser Origin/Fetch Metadata behavior, CSRF rotation/retry, multiple tabs, back navigation, expired/revoked sessions, and serialized logout/login. Authentication screens and browser E2E work remain outside this checkpoint.
- Verify deployment proxy IP trust and NAT behavior, load/slow-client/database-stall recovery, query budgets, real shutdown/Ctrl+C behavior, and operational readiness signals before exposure. No production connection, deployment TLS handshake, network-fault COMMIT simulation, exhaustive fuzzing, timing-distribution study, or penetration test was performed.
- Hosted CI/database-backed pipeline work remains separate; GitHub Actions was untouched. Do not infer hosted results from local commands.

Security guidance was cross-checked with [OWASP session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), [OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), and [PostgreSQL 17 row-lock semantics](https://www.postgresql.org/docs/17/explicit-locking.html). Findings and test counts above come from this repository and execution session.

## Changed files and stop point

| File | Change |
| --- | --- |
| [routes.ts](../../apps/api/src/modules/auth/routes.ts) | Minimal anonymous logout 401 precedence fix |
| [authentication.ts](../../apps/api/src/modules/auth/authentication.ts) | Same invariant inside transactional validation |
| [cleanup.ts](../../apps/api/src/modules/auth/cleanup.ts) | Correct stale comment; no behavior change |
| [routes.test.ts](../../apps/api/src/modules/auth/routes.test.ts) | 18 targeted HTTP regressions |
| [authentication.integration.test.ts](../../apps/api/tests/authentication.integration.test.ts) | 12 targeted database-backed regressions |
| [sessions.integration.test.ts](../../apps/api/tests/sessions.integration.test.ts) | Cleanup/refresh/second-device regression |
| [README](../../README.md), this report | Explicit status contract, findings, verification, and follow-ups |

Seven modified files and one new report remain **uncommitted** for review. Earlier reports are preserved as historical snapshots. No commit, push, merge, deployment, migration, frontend authentication, CI change, or later milestone work was performed. Stop here and wait for user review; timeout hardening remains a proposal, not an implemented change.
