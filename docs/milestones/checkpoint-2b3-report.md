# Checkpoint 2B.3 — CSRF bootstrap and authentication admission controls

Implemented and locally verified on **2026-10-20 (Asia/Manila)**, on `feat/authentication`. Stop point: review before stage 2B.4. This report describes executed local checks, not a hosted CI run or production deployment readiness.

## Implemented behavior

- `GET /api/v1/auth/csrf` uses the existing guarded PostgreSQL session service. New anonymous sessions have independent random session/CSRF tokens, hashed session-token storage, and a fixed 15-minute lifetime. Cookies are issued only after creation resolves following commit.
- Valid anonymous and authenticated sessions return their existing CSRF token without changing database timestamps, issuing another cookie, or consuming an allocation reservation. Expired/unknown/malformed session tokens receive a new anonymously allocated session within quota. Duplicate session cookies fail with a fixed JSON 400.
- Every auth-prefix request passes bounded request admission, exact custom-header validation, trusted-Origin validation, and Fetch Metadata checks before JSON parsing or session work. Origin must match the configured canonical origin when supplied and is mandatory for unsafe methods. Supplied `Sec-Fetch-Site` must be `same-origin`; absent metadata supports legacy/nonbrowser clients. `X-ApplyFlow-Request: 1` is mandatory. Bootstrap rejects bodies, query parameters, and methods other than GET, including HEAD and OPTIONS. No CORS permission is issued.
- Strict JSON media-type and Zod credential-validation helpers are ready for future write endpoints. Tests exercise these on a test-only route; the application exposes no credential endpoints or password work in this stage.
- Request counters use the pinned express-rate-limit middleware with a bounded custom store. Allocation and future credential admission reserve all applicable dimensions synchronously, without an intervening await or unbounded queue. Failed database creation retains its reservation, preventing repeated allocation retries from escaping quotas.
- The HTTP error handler emits safe JSON for admission/storage failures and preserves existing malformed-JSON, body-limit, health, and API-404 behavior. Auth-prefix responses use `Cache-Control: no-store`.
- Runtime startup now validates auth/database configuration and connects to the guarded database before listening. It starts the existing non-overlapping 100-row/minute expiration cleanup task and stops cleanup/disconnects on shutdown. App factories used by tests start no task. Startup errors are sanitized. Health remains liveness, not a database readiness probe.

### Limits and privacy

All windows start on the key's first admitted hit, rather than a calendar boundary. Expiration is inclusive at the boundary and is tested with injected clocks.

| Dimension | Limit | Window | Status |
| --- | --- | --- | --- |
| Auth-prefix requests/IP | 120 | 1 minute | Active; includes hostile/invalid traffic and session reuse |
| Anonymous allocations/IP | 20 | 15 minutes | Active; reserved before database creation |
| Anonymous allocations/process | 500 | 15 minutes | Active |
| Login attempts/IP | 30 | 15 minutes | Tested primitive only |
| Login attempts/normalized email + IP | 5 | 15 minutes | Tested primitive only |
| Registration attempts/IP | 5 | 1 hour | Tested primitive only |

Each counter store retains at most 5,000 keys. Expired entries are reclaimed at capacity; live entries are never evicted to admit another identity. Capacity exhaustion fails closed with JSON 503. Quota denials return JSON 429 with `Retry-After`; request counters also emit `RateLimit-*` headers. Existing valid sessions bypass allocation limits but still consume request limits.

Per-application random 256-bit HMAC secrets produce opaque keys for IPs, email/IP pairs, and the global dimension. Emails use the shared trim/lowercase ASCII contract, preserving dots and plus suffixes. No account-wide email-only limiter is introduced. IPv4-mapped IPv6 addresses are canonicalized, and native IPv6 is grouped by /56. Keys never contain raw emails or IP addresses. A sanitized request facade also prevents the pinned library's optional debug logging from printing credential-bearing URLs, raw IPs, or cookies; the actual Express routing request is unchanged. Failure messages do not reflect credentials or driver errors.

The middleware uses the direct socket address and explicitly disables proxy trust. Spoofing `X-Forwarded-For` does not provide a fresh quota.

## Files created or changed

| Files | Purpose |
| --- | --- |
| [admission.ts](../../apps/api/src/modules/auth/admission.ts) | Bounded store, private keys, request/allocation/login/registration admission |
| [request.ts](../../apps/api/src/modules/auth/request.ts) | Origin, Fetch Metadata, custom-header, JSON, and credential validation helpers |
| [csrf.ts](../../apps/api/src/modules/auth/csrf.ts) | Bootstrap router and injectable composition |
| [http-error.ts](../../apps/api/src/modules/auth/http-error.ts) | Typed safe authentication HTTP errors |
| [app.ts](../../apps/api/src/app.ts) | Middleware ordering, bootstrap mount, JSON error mapping |
| [server.ts](../../apps/api/src/server.ts) | Guarded runtime database/session composition and cleanup lifecycle |
| [admission.test.ts](../../apps/api/src/modules/auth/admission.test.ts), [csrf.test.ts](../../apps/api/src/modules/auth/csrf.test.ts) | Deterministic counters/identity tests and Supertest HTTP tests |
| [csrf.integration.test.ts](../../apps/api/tests/csrf.integration.test.ts) | Guarded real-PostgreSQL HTTP integration tests |
| [API package.json](../../apps/api/package.json), [root lockfile](../../package-lock.json) | Exact approved middleware/test dependencies |
| [.env.example](../../apps/api/.env.example), [README](../../README.md), this report | Current startup requirements, HTTP policy, verification, and limitations |

The Prisma schema, migration SQL/history, database guards, password/session primitives, shared contracts, frontend, GitHub Actions configuration, and earlier milestone reports are unchanged. No new migration was introduced.

## Commands and actual results

Runtime verified: **Node v24.22.0 / npm 11.19.1 / Windows**.

| Command/check | Actual result |
| --- | --- |
| `npm.cmd install --workspace @applyflow/api --save-exact express-rate-limit@8.7.1 --ignore-scripts --cache .cache/npm --fetch-retries 0 --fetch-timeout 15000` | Exit 0; 2 packages added; audit reported 0 vulnerabilities |
| `npm.cmd install --workspace @applyflow/api --save-dev --save-exact supertest@7.3.1 @types/supertest@7.2.1 --ignore-scripts --cache .cache/npm --fetch-retries 0 --fetch-timeout 15000` | Exit 0; 24 packages added; audit reported 0 vulnerabilities |
| `npm.cmd ls express-rate-limit supertest @types/supertest` | Exit 0; exact direct versions confirmed |
| `npm.cmd run lint` | Exit 0; no errors or warnings |
| `npm.cmd run typecheck` | Exit 0 across workspaces and tooling/integration tests |
| `npm.cmd test` | Exit 0; **197 passed, 0 failed, 10 files** |
| `npm.cmd run test:integration` | Exit 0; **49 passed, 0 failed, 3 files** |
| `npm.cmd run build` | Exit 0; contracts, Prisma generation, API compilation, frontend bundle |
| Compiled server smoke check, `node --input-type=module` | Guarded `NODE_ENV=test` startup; health 200, unknown API JSON 404, headerless CSRF JSON 403; no cookies or fixture writes |
| Read-only Prisma schema/history and row-content fingerprint comparison, via `node --import tsx --input-type=module` | Both development and test matched their complete pre-work baseline |
| `git diff --check` and protected-path diff review | No whitespace errors or protected-path changes; Git reports normal LF/CRLF conversion warnings |
| Committable-file scan against local database passwords | 81 files scanned; 0 credential matches |

**246 total tests pass**, comprising the previous 164 plus **70 new unit/HTTP cases and 12 new PostgreSQL cases**. No tests were skipped or weakened. Early checks caught a literal-type inference issue, exact-optional test typing, nullable response-header indexing, and an unused four-argument error-handler parameter; these were corrected before the passing final checks.

New coverage includes hostile/absent/null/mismatched Origin; Fetch Metadata; wrong/missing custom headers; malformed/oversized JSON rejected before parsing for hostile writes; body/query/method rejection; invalid and ambiguous cookies; normalized private limiter keys; IPv4/IPv6 grouping; key-capacity failure; concurrent quota boundaries; request-window and allocation-window expiry; retained failure reservations; safe database errors; debug-log privacy; and unchanged health/404 handling.

Real PostgreSQL tests verify hashed anonymous persistence, reuse immediately before expiry without refresh, replacement at/after expiry, authenticated-session CSRF retrieval without refresh, 20 successful concurrent allocations from 25 requests, reuse when allocation quota is full, absence of cookie/response before an explicit transaction commits, and absence of partial rows/cookies after rollback. A test process cannot select development.

## Database safety evidence

| Target | Connected host/port | Database / user | Before → after |
| --- | --- | --- | --- |
| Development | `127.0.0.1:15432` | `applyflow_dev / applyflow_dev` | User 0 → 0; Session 0 → 0; content/schema/history fingerprints identical |
| Test | `127.0.0.1:5433` | `applyflow_test / applyflow_test` | User 0 → 0; Session 0 → 0; content/schema/history fingerprints identical |

Only run-owned fixture IDs were deleted from the test database. Each suite uses the existing mandatory test-target guard, verified connected identity, approved SQL hash, and single completed migration before writes. Cleanup checks the connected identity inside its transaction and restricts user deletion by owned UUID and random per-run email prefix; session deletion is restricted to owned UUIDs. No development writes, resets, broad cleanup, schema changes, migration application, or Docker/volume/system changes occurred. The compiled smoke check targeted test, rejected bootstrap before allocation, and stopped its own child process.

Read-only SHA-256 fingerprints of ordered public columns, indexes, constraints, and migration history were unchanged:

```text
Development: a2fa70b62ff202b1ef88d0304efa7d47636b554414652746047f65ff9a5cdac8
Test:        fafb53d3919e5774d55fc5fdb80efe27fc1119b048f58906635f0db6522fbeeb
Migration:   98fab302c1f9d6a053d549bdbb9aec2bece4e24322fb1292948647ed693ac840
```

The before/after audit used row-count and ordered JSON-content digests for User and Session as well as the schema/history fingerprints; counts alone were not the comparison.

## Limitations and review points

- This implements bootstrap and admission only. No register, login, logout, authenticated `/me`, session rotation orchestration, or mutating-endpoint CSRF-token enforcement was added. Stage 2B.4 must combine these existing checks with validated session-bound CSRF tokens before credential admission or password work. Obtaining a bootstrap token does not authenticate anyone.
- Process-local counters reset on restart and do not coordinate across instances. This remains the approved single-process modular monolith design. Saturation of request-key capacity or global allocation quota can deny legitimate newcomers; failure is deliberately closed. NAT/proxy aggregation and limit tuning require review before exposure. No Redis or other infrastructure was introduced.
- Origin and Fetch Metadata are browser defenses, not proof of identity: nonbrowser clients can supply headers. The fallback without metadata relies on the custom header, exact supplied Origin checking, browser same-origin policy, and absence of permissive CORS. Same-origin XSS remains outside these defenses. The policy follows the [OWASP CSRF guidance](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html); store configuration and behavior were checked against the pinned library and its [official configuration documentation](https://express-rate-limit.mintlify.app/reference/configuration).
- Concurrent first bootstrap requests without a shared cookie can create distinct anonymous sessions within quota. The future browser client should serialize bootstrap and share its result; no unauthenticated global singleton session or IP-bound session was introduced.
- Existing valid sessions require a database lookup before they can bypass allocation quotas. Request admission still limits those reads. Database outages return sanitized 503 without issuing fallback cookies; reservations made before failed creation remain consumed. Connection/session storage and trusted server time remain security assumptions.
- Runtime now requires the database before listening. Health is still liveness and may remain 200 during a later database outage. Explicit readiness/operational monitoring is not implemented.
- Unit tests exercise production cookie configuration, and production bundles compile. No production PostgreSQL/TLS connection, HTTPS browser cookie round trip, browser UI, reverse proxy, live hosted CI, or deployment was verified. Compiled server smoke checks ran only on the dedicated test database. Manual Windows Ctrl+C/shutdown behavior and deployment-specific proxy/certificate behavior remain review items. Production configuration support is not deployment readiness.
- No React or GitHub Actions changes were made. Hosted database-backed CI belongs to checkpoint 2C. No password-cost settings were changed or re-benchmarked; this stage invokes no password work.

Git status shows **6 modified files and 8 new files**, all **uncommitted** for review. No commits, pushes, deployments, credential endpoints, or stage 2B.4 work were performed. Stop here until the user approves continuing.
