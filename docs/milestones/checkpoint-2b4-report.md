# Checkpoint 2B.4 — Secure Authentication API

Implemented and locally verified on **2026-10-20 (Asia/Manila)**. Scope ends at stage 2B.4; no stage 2B.5 or frontend authentication work was started. The repository contains the earlier checkpoint reports but no separate Checkpoint 2B plan file; implementation follows the architecture approved in the conversation and those reports.

## Implemented endpoints

All paths are relative to `/api/v1/auth`. Existing request admission, trusted Origin, Fetch Metadata, custom-header checks, and `Cache-Control: no-store` remain in force. POSTs require JSON, exact trusted Origin, a valid current session cookie, and its matching `X-CSRF-Token`. Method/query/media-type checks run before JSON parsing; strict shared Zod body validation and session-bound CSRF checks run before credential quotas/password work.

| Endpoint | Success | Behavior |
| --- | --- | --- |
| `GET /csrf` | 200 `{ csrfToken }` | Existing bootstrap/allocation/reuse behavior preserved |
| `POST /register` | 201 `{ user: { id, email }, csrfToken }` | Explicitly enabled development/test only; production always disabled; anonymous session required |
| `POST /login` | 200 `{ user: { id, email }, csrfToken }` | Argon2id credential verification and anonymous-session rotation |
| `GET /me` | 200 `{ user: { id, email } }` | Authenticated session required; atomic activity refresh |
| `POST /logout` | 204, no body | Authenticated session-bound CSRF required; revokes only the current session and clears its cookie |

Registration defaults to disabled and returns JSON 404 when unavailable. The production parser still refuses a true registration flag, and the HTTP gate independently checks production mode even if its configuration object were incorrectly constructed. Login/register with an already-authenticated session return 409 `ALREADY_AUTHENTICATED`; clients must log out before switching accounts.

Missing, malformed, expired, or revoked sessions are rejected without issuing or clearing cookies. Invalid session-bound CSRF returns 403. Duplicate session cookies return 400. Anonymous `/me` and logout return 401. Unsupported methods return 405 with `Allow`; HEAD `/me` cannot refresh activity. Logout accepts only an empty object or an absent body with JSON media type. Error messages contain no credentials, native error details, constraint names, password hashes, or session identifiers.

## Transactional authentication and expiration

1. HTTP preflight validates request/session/CSRF and reserves the existing bounded login or registration quotas. Rejected preflight requests do not reach password work.
2. Password hashing/verification runs **outside** transactions, using one runtime password-service instance and its existing two-operation gate. The approved Argon2id parameters are unchanged. Unknown users run the real dummy-hash verification and receive the same 401 `INVALID_CREDENTIALS` response as an incorrect password.
3. An interactive Prisma transaction locks the presented session with parameterized `SELECT ... FOR UPDATE`. It rechecks validity, ownership kind, and constant-time CSRF comparison after obtaining the lock. A missing consumed session produces 409 `SESSION_CHANGED`; expiration after password work is rejected.
4. Registration creates the user inside this transaction. Login rereads and checks the previously verified password hash under a shared user-row lock, holding the credential stable through commit.
5. Only the presented anonymous session is deleted. A newly generated authenticated session and independent CSRF token replace it. The public response is explicitly projected and validated before commit. Registration, deletion, and replacement roll back together on failure; unique account conflicts return generic 409 `ACCOUNT_UNAVAILABLE`.
6. The service resolves only after the entire transaction commits. Only then does HTTP serialize the appropriate HttpOnly cookie and public response. Session tokens appear only in the HttpOnly cookie, never JSON. Failed or losing concurrent requests issue no cookie; they cannot clear a winning authentication cookie.

Concurrent attempts using one anonymous session can perform admitted password work concurrently, but only one can consume the session and commit authentication. Duplicate registrations from different anonymous sessions rely on the existing unique email constraint, leaving the losing anonymous session intact. No operation revokes another device's authenticated session.

`/me` locks/revalidates the session and calls the existing conditional activity-refresh SQL inside its transaction. Both **24-hour idle** and **seven-day absolute** limits remain enforced, as does an earlier stored expiration. Boundaries are inclusive (`now >= deadline` is invalid). Every successful `/me` updates last activity without moving absolute expiry or issuing a cookie; bootstrap, failures, and logout do not refresh activity. Logout locks/revalidates and deletes only the current authenticated session, then clears its matching local/production cookie after commit.

The policy permits a request authorized at its post-lock validation instant to finish while time advances. Revocation cannot retract a response already authorized or delivered. The existing cleanup service, fixed 15-minute anonymous lifetime, monotonic authenticated refresh, and local/test target guards are unchanged.

## Files created or modified

| File | Change |
| --- | --- |
| [authentication.ts](../../apps/api/src/modules/auth/authentication.ts) | New transactional registration, login, current-user, and logout service |
| [routes.ts](../../apps/api/src/modules/auth/routes.ts) | New HTTP routes, CSRF preflight, registration gate, method/body policy, cookie delivery |
| [routes.test.ts](../../apps/api/src/modules/auth/routes.test.ts) | 25 new unit/HTTP cases using injected dependencies |
| [authentication.integration.test.ts](../../apps/api/tests/authentication.integration.test.ts) | 46 new real PostgreSQL/Argon2/Supertest cases |
| [csrf.ts](../../apps/api/src/modules/auth/csrf.ts) | Composes credential routes and pre-parser checks with existing bootstrap; shares one admission instance |
| [server.ts](../../apps/api/src/server.ts) | Creates one password service and supplies the guarded authentication service at runtime |
| [admission.ts](../../apps/api/src/modules/auth/admission.ts), [request.ts](../../apps/api/src/modules/auth/request.ts) | Comments updated to describe active credential routes; limiter/validation behavior unchanged |
| [.env.example](../../apps/api/.env.example), [README](../../README.md), this report | Updated endpoint, configuration, session, verification, and limitation documentation |

The optional injected authentication service permits the existing bootstrap-only app factories/tests to remain isolated; the actual server always composes the full authentication API. There is no environment flag for skipping login/logout/current-user composition. Registration remains the separately controlled feature gate.

No dependencies were installed. Package manifests/lockfile, Prisma schema/migrations, shared contracts, database guards/tooling, password/session/cookie/cleanup primitives, frontend, GitHub Actions, and earlier milestone reports are unchanged.

## Executed verification

Runtime: **Node v24.22.0 / npm 11.19.1 / Windows**. All results below are actual local execution results.

| Command/check | Actual result |
| --- | --- |
| `npm.cmd run db:verify` | Exit 0; both approved targets connected with expected database/user and public tables |
| `npm.cmd run lint` | Exit 0; no errors or warnings |
| `npm.cmd run typecheck` | Exit 0; workspaces and tooling/integration tests |
| `npm.cmd test` | Exit 0; **222 passed, 0 failed, 11 files** |
| `npm.cmd run test:integration` | Exit 0; **95 passed, 0 failed, 4 files** |
| `npm.cmd run build` | Exit 0; contracts, Prisma generation, API compilation, frontend bundle |
| Compiled runtime smoke, `node --input-type=module` | Guarded `NODE_ENV=test` startup; health 200; unknown API JSON 404; missing-session `/me`, login, logout JSON 401; disabled registration JSON 404; no cookies/writes |
| Read-only Prisma fingerprint comparison, `node --import tsx --input-type=module` | Development/test schema, migration history, row counts, and ordered row-content digests matched pre-work baseline |
| Protected-path diff review | No schema, migration, database-guard/tooling, package, frontend, shared-contract, or CI changes |
| `git diff --check` | Exit 0; normal Git LF/CRLF conversion warnings only |
| Committable-file credential scan | 86 files scanned; 0 matches for local database passwords |

**317 tests pass in total**, including all previous 246 cases and **71 new cases: 25 unit/HTTP and 46 PostgreSQL integration**. No tests were skipped or weakened. One intermediate typecheck caught an overly generic test mock whose return type became `unknown`; a typed transaction wrapper with a separate call spy corrected it. Final typechecking passes.

The PostgreSQL suite covers successful bootstrap/register/login/me/logout; real Argon2 persistence and dummy verification; normalized emails; generic invalid credentials; disabled registration; malformed/oversized/hostile requests; cross-session and missing CSRF; rate limits before password work; concurrent admission/overload; token and CSRF rotation; anonymous fixation/reuse prevention; same-session login/register/mixed races; concurrent duplicate registration; and device isolation.

Exact injected-clock tests cover anonymous, idle, absolute, and earlier stored expiry at **-1/0/+1 ms**, plus expiration during password verification and session-bound CSRF changed before transaction validation. Additional cases cover stale password-hash revalidation, real session-token uniqueness failures, database read failures, password admission failure, and failures after callback writes with complete rollback for register/login/logout/me.

Commit-timing tests hold real PostgreSQL transactions open after authentication/logout work, confirm that other connections still see the original committed rows, and observe the **raw HTTP response event** to assert no response headers/cookies have arrived. Register/login success cookies and logout clearing cookies arrive only after releasing the transaction and committing. These tests verify commit ordering and rollback behavior; they do not simulate every network/driver failure during COMMIT.

## Database isolation evidence

| Target | Host/port | Actual database / username | Before → after |
| --- | --- | --- | --- |
| Development | `127.0.0.1:15432` | `applyflow_dev / applyflow_dev` | User 0 → 0; Session 0 → 0; all fingerprints identical |
| Test | `127.0.0.1:5433` | `applyflow_test / applyflow_test` | User 0 → 0; Session 0 → 0; all fingerprints identical |

The new suite fails closed unless `NODE_ENV=test`, the dedicated target guard, connected identity, approved migration checksum, and single completed migration all match before writes. It explicitly verifies that a test process cannot select development.

Anonymous fixture UUIDs are tracked at creation. Registration chooses user UUIDs internally, so cleanup discovers only users in the suite's cryptographically random per-run email namespace and then their sessions. It collects those owned UUIDs, verifies the connected identity inside the cleanup transaction, deletes only those session UUIDs, and deletes only owned user UUIDs still matching the namespace. No broad deletion, development write, reset, migration, or volume operation occurred. Existing suites retain their own guards/fixture cleanup. The compiled smoke used only the test database and failed requests before session allocation; its child process was stopped.

Unchanged SHA-256 fingerprints of ordered public columns, indexes, constraints, and migration history:

```text
Development: a2fa70b62ff202b1ef88d0304efa7d47636b554414652746047f65ff9a5cdac8
Test:        fafb53d3919e5774d55fc5fdb80efe27fc1119b048f58906635f0db6522fbeeb
Migration:   98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840
```

User/Session row-content digests and counts were compared separately; counts alone were not the evidence. No new migration was generated or applied.

## Security assumptions and remaining verification

- No unresolved local check failures remain. This is a local implementation report, not production deployment readiness or an independent security audit. Production registration stays disabled; email verification, password recovery, and broader abuse readiness remain outside this stage.
- Existing process-local request/allocation/email-IP limits and the two-operation native password gate remain bounded and fail closed. They reset on restart and do not coordinate across processes. Distributed abuse, NAT aggregation, and deployment-specific proxy trust require later review; no infrastructure was added.
- Incorrect and unknown accounts have the same response and both perform real verification. No new timing-distribution study proves account timing indistinguishable. Explicitly enabled local/test registration still reveals success versus account-unavailable status; public production registration remains unavailable.
- Authentication transactions are short because native password work happens first. They use database row locks and the existing unique/foreign-key constraints. Conflicts, timeouts, corrupt hash profiles, overload, or storage failures return sanitized errors and issue no cookie; no automatic retry can consume a session twice.
- Atomic commit cannot guarantee that the browser receives the response. A committed registration or login with a lost response may require bootstrap/login recovery; it must not trigger automatic destructive compensation. A future client should serialize bootstrap and authentication mutations, use the new CSRF token after rotation, and avoid racing a successful logout's clearing response against a subsequent login.
- `/me` is the current protected activity entry point. Future protected routes must explicitly reuse authenticated validation/atomic activity refresh. No application CRUD or broader authorization surface was added.
- Browser same-origin policy, trusted server clocks, protected database access, secure randomness, and absence of same-origin XSS remain assumptions. CSRF tokens do not protect against XSS. Existing no-CORS and production cookie policy are preserved.
- Production-cookie serialization/gating is covered by unit/HTTP tests. **HTTPS browser round trips, reverse-proxy behavior, deployment TLS/certificates, manual Windows Ctrl+C shutdown, and hosted CI were not verified.** No React authentication screens or CI changes were made. Manual browser checks belong with the separately approved client work.

Security references consulted: [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html), [OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html), and [Prisma 7 transaction documentation](https://docs.prisma.io/docs/orm/v7/prisma-client/queries/transactions). The existing pinned versions and security parameters were retained.

Git status on **feat/authentication** contains **6 modified and 5 new files**, all uncommitted for review. No commit, push, deployment, schema change, migration execution, machine configuration change, or later-stage implementation was performed. Stop here before stage 2B.5.
