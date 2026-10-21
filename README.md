# ApplyFlow

A calm, focused workspace for managing a job search. Milestone 1 and **Checkpoint 2A: PostgreSQL persistence foundation** are implemented and locally verified.

**Checkpoint 2B stages 1–4** add tested authentication primitives, CSRF bootstrap, bounded admission controls, and secure registration/login/logout/current-user API endpoints. See the [stages 1–2 report](docs/milestones/checkpoint-2b-primitives-report.md), [stage 3 report](docs/milestones/checkpoint-2b3-report.md), and [stage 4 verification report](docs/milestones/checkpoint-2b4-report.md). Frontend authentication screens remain unimplemented.

**Stage 2B.5 security review and local backend verification are complete.** The [Checkpoint 2B completion report](docs/milestones/checkpoint-2b-completion-report.md) records fresh checks, the corrected anonymous-logout status, remaining availability risks, and required manual verification. This does not establish production deployment readiness; frontend authentication and database-backed CI remain separate work.

The runnable preview contains a branded responsive page, an API connection check, an Express authentication API, shared validation contracts, tests, and CI. Checkpoint 2A adds isolated PostgreSQL services, guarded Prisma tooling, the approved User/Session migration, and persistence integration tests. The migration has been applied to the approved local development and test databases. Application tracking, background jobs, and deployment remain unimplemented.

## Prerequisites

- **Node.js 24.22.0 LTS**, pinned in `.nvmrc`. With an existing Node version manager, install/select the version in that file; on Windows with nvm-windows, use `nvm install 24.22.0` followed by `nvm use 24.22.0`.
- **npm 11.19.1**, the version used to generate the single root lockfile. Use npm 11; no Yarn or pnpm lockfiles.
- Git and Docker Desktop with Linux containers and the `docker compose` plugin. The API now requires the configured, already-migrated PostgreSQL development database at startup. Unit tests and builds do not require PostgreSQL.

The root engine check rejects Node versions outside major 24. TypeScript 6.0.3 is selected because it is supported by the installed TypeScript ESLint release. Dependency versions are pinned and reproducible through `package-lock.json`.

## Install and develop

Run all commands from the repository root:

```sh
node --version
npm --version
npm ci
npm run dev
```

Before running the API for the first time, follow the [Checkpoint 2A database setup](docs/milestones/checkpoint-2a-setup.md). Create the ignored environment file with `npm run db:env:init` only if it does not already exist, and start the development service with `npm run db:up`. Migration application always requires explicit SQL approval; startup and tests never apply migrations automatically.

On Windows PowerShell, use `npm.cmd` in place of `npm` if execution policy blocks `npm.ps1`. Changing the machine's execution policy is unnecessary.

Open **http://127.0.0.1:5173**. Vite proxies `/api` to **http://127.0.0.1:3000**, so the browser uses relative, same-origin requests. The initial check and **Check connection** button call `GET /api/v1/health/live`, validate the response, and display success or a retryable failure. Checks time out after eight seconds.

`npm run dev` builds shared contracts first, then watches contracts, the API, and the web app together. Contract JavaScript changes restart the API. Output is inherited rather than piped to support Windows watcher startup. Stop all three with Ctrl+C. A stopped child terminates the others.

For separate terminals, first run `npm run build -w @applyflow/contracts`, then use `npm run dev:api` and `npm run dev:web`. Run `npm run dev -w @applyflow/contracts` separately if editing shared contracts.

### API environment

The API requires a guarded database URL supplied through the ignored `apps/api/.env` or process environment. Prefer `npm run db:env:init` for local database credentials rather than the placeholders in the example. Extend an existing environment file deliberately; never overwrite it or commit real credentials. Node loads this file in development and production; existing process variables take precedence.

| Variable | Default | Policy |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `HOST` | `127.0.0.1` | Nonempty bind host; use `0.0.0.0` only when deliberately exposing the server |
| `PORT` | `3000` | Integer string between 1 and 65535 |
| `APP_TIMEZONE` | `Asia/Manila` | Timezone supported by the runtime |
| `APP_ORIGIN` | `http://127.0.0.1:5173` locally | One exact canonical trusted origin; required HTTPS origin in production |
| `ALLOW_LOCAL_REGISTRATION` | `false` | Enables registration only when explicitly true in development/test; forbidden in production |
| `DATABASE_URL` | None | Approved development target locally; separate verified TLS configuration in production |
| `TEST_DATABASE_URL` | None | Dedicated test target only when `NODE_ENV=test`; no fallback |

Environment values are validated before the server listens. If changing the API port, update Vite's proxy target in `apps/web/vite.config.ts` to match. Restart the API after editing `.env`.

**Application date policy for later milestones:** PostgreSQL `DATE` stores the application date without a time component. The API evaluates “today” in the explicit server-wide `APP_TIMEZONE`, defaulting to **Asia/Manila**, regardless of the host machine or browser timezone. Changing this setting intentionally changes that policy for all users of the instance. Dates later than that day will be rejected. Saved applications may have no application date; all other statuses require one. System event timestamps will use UTC. The foundation validates the timezone setting; it does not yet implement application date validation.

**Authentication policy:** controlled local/test account creation uses email/password and PostgreSQL-backed sessions. Production public registration stays disabled until email verification, password recovery, and abuse protections exist. Obtaining a bootstrap token does not authenticate a user. Set `ALLOW_LOCAL_REGISTRATION=true` deliberately in local/test configuration and restart the API to enable account creation; defaults remain disabled.

### CSRF bootstrap and admission controls

Use the Vite proxy and relative `/api/v1/auth/csrf` URL, with `X-ApplyFlow-Request: 1`. For a local manual check, `curl.exe -i -H "X-ApplyFlow-Request: 1" http://127.0.0.1:5173/api/v1/auth/csrf` creates a development session; use this deliberately because it writes a row. Do not put credentials or tokens in URLs. A frontend authentication flow will be added separately.

The response is `{ "csrfToken": "<64 hexadecimal characters>", "registrationEnabled": false }`, with `Cache-Control: no-store`. The required boolean reflects explicit server-side local/test registration permission; production always returns false. It is display information only: POST registration independently enforces the same policy. A new anonymous session sets a host-only HttpOnly SameSite=Lax cookie, valid for exactly 15 minutes. Reuse returns the same token without a new cookie or activity refresh; an existing valid authenticated session can also retrieve its token without refreshing activity. Production configuration uses a Secure `__Host-` cookie. There is no CORS allowlist or preflight access.

Supplied Origin must exactly match `APP_ORIGIN`; unsafe methods also require Origin. Supplied `Sec-Fetch-Site` must be `same-origin`. Legacy clients may omit Fetch Metadata; GET bootstrap may omit Origin because the required custom header plus browser same-origin policy prevents simple cross-origin bootstrap. GET bodies and query parameters are rejected, and bootstrap accepts only GET (HEAD/OPTIONS do not create sessions). Write endpoints require JSON and strict request contracts.

Every auth-prefix request consumes a 120/IP/minute quota, including rejected traffic. New anonymous allocation also reserves 20/IP/15 minutes and 500/process/15 minutes, before database creation. Existing valid sessions skip allocation quotas. Store capacity is bounded and fails closed; reservations are not refunded after a database failure. Responses include request `RateLimit-*` headers and denials include `Retry-After`. Quotas use windows starting with a key's first request, not calendar-aligned intervals.

Login admission allows 30/IP/15 minutes and 5/normalized-email+IP/15 minutes; registration allows 5/IP/hour. These limits apply after request/session/CSRF validation and before password work. Failed credential attempts, duplicate registrations, and backend failures keep their reservations. Keys are per-process HMAC digests; raw emails and IPs are not stored in limiter keys. The direct socket address is authoritative (`trust proxy=false`); forwarded headers cannot reset quotas. IPv4-mapped addresses are canonicalized and native IPv6 addresses grouped by /56. A proxy or shared NAT may aggregate legitimate clients; deployment topology and limit tuning require later review. In-memory limits reset on restart and are not shared across processes.

Runtime startup validates configuration and database identity before listening, and starts the existing bounded session cleanup task (100 expired sessions/minute, non-overlapping). Shutdown stops cleanup and disconnects Prisma. App factories used by tests start no background task. Health remains a liveness check rather than a database readiness probe. Production configuration support is not production deployment readiness.

### Authentication API

All paths below are under `/api/v1/auth`. Send `X-ApplyFlow-Request: 1` and retain the HttpOnly session cookie. POSTs require `Origin` matching `APP_ORIGIN`, `Content-Type: application/json`, and `X-CSRF-Token` from the current session. Tokens never belong in URLs. The frontend will use relative same-origin requests through Vite or the production server.

| Endpoint | Request | Success | Session policy |
| --- | --- | --- | --- |
| `GET /csrf` | No body/query | 200 `{ csrfToken, registrationEnabled }` | Bootstrap/reuse anonymous or authenticated session |
| `POST /register` | `{ email, password }` | 201 `{ user: { id, email }, csrfToken }` | Enabled local/test only; requires anonymous session and rotates it |
| `POST /login` | `{ email, password }` | 200 `{ user: { id, email }, csrfToken }` | Requires anonymous session and rotates it |
| `GET /me` | No body/query | 200 `{ user: { id, email } }` | Requires authenticated session; refreshes valid activity |
| `POST /logout` | `{}` (or empty body with JSON media type) | 204, no response body | Revokes only the current authenticated session and clears its cookie |

First retrieve `/csrf`, retain its cookie and CSRF token, then register or log in. After success, retain the replacement cookie and **new** CSRF token; the old anonymous session and token no longer authorize requests. Use the new token for logout. `/me` needs no CSRF token beyond the custom request header. Automatic HEAD fallback is disabled for `/me`; only GET refreshes activity. Already-authenticated login/register attempts return 409; logout before switching accounts. No account/session listing or logout-all endpoint is provided.

Emails are trimmed/lowercased ASCII addresses, with dots and plus suffixes preserved. Password bytes/case/whitespace are preserved; registration requires 15–128 Unicode code points, and login accepts 1–128, using the previously approved Argon2id profile. Unknown accounts perform real dummy-hash verification and share the same 401 `INVALID_CREDENTIALS` message as incorrect passwords.

Authenticated sessions enforce **24-hour idle** and **seven-day absolute** deadlines, inclusive at expiration. Each successful `/me` atomically updates last activity without extending the absolute expiry or reissuing the cookie. CSRF bootstrap and rejected requests do not refresh sessions. Logout and session replacement delete only the presented session. Session consumption is locked and revalidated inside the database transaction after password work; only one concurrent authentication request can use an anonymous session. Cookies are sent only after commit. Native password operations are limited to two concurrently in one runtime service; overload/backend failures return a sanitized 503 with no cookie.

Missing/invalid/expired/revoked sessions return 401, invalid session-bound CSRF returns 403, and a session changed by a concurrent transaction can return 409 `SESSION_CHANGED`. Disabled registration returns 404. Duplicate local/test registration returns generic 409 `ACCOUNT_UNAVAILABLE`. Retrieve `/csrf` again when retrying after a session change. Error responses never set or clear cookies, so a losing concurrent response cannot erase a winning authentication cookie; successful logout clears it. Registration account creation and session rotation roll back together on failure. Commit cannot guarantee response delivery; a lost success response may require a fresh bootstrap and login.

**Logout status contract:** after trusted-request admission, malformed JSON, invalid body shape, or ambiguous cookies return **400**. A well-formed request without a valid authenticated session returns **401**, including anonymous sessions regardless of their CSRF header. A valid authenticated logout with matching session-bound CSRF returns **204**, no response body, and a clearing cookie. Authenticated requests with bad CSRF still return 403. Other admission responses retain their specific meanings: 403 for rejected security headers, 405 for method mismatch, 413 for oversized bodies, 415 for unsupported media/encoding, and 429 for quotas. If a session disappears after valid preflight during concurrent logout, the losing transaction may return 409 `SESSION_CHANGED`; it never clears cookies.

### Client authentication foundation (Stage 2C.1)

`apps/web/src/lib/auth` provides typed same-origin transport, a lazy module-level store, and cross-tab coordination. Stage 2C.1 and its audit corrections were accepted and committed in `d1d826e`; Stage 2C.2A was accepted and committed in `a224d49`. Statements about uncommitted changes in those historical reports describe their original reporting time. Stage 2C.2B adds authentication forms and a minimal workspace using that accepted foundation.

The store exposes `getSnapshot`, `subscribe`, `bootstrap`, `revalidate`, `login`, `register`, and `logout`. `getAuthStore()` returns the browser singleton; component unsubscribe/remount must not dispose it. Snapshots contain user/display state, safe failure codes/field names, `retryAt`, `busy`, an eight-second `waiting` flag, and `outcomeUncertain`. The approved 2C.2A correction adds a non-secret `verifiedReadId`: a monotonic receipt for completed current-generation reads, cleared on proof invalidation or mutation dispatch. Cached bootstrap and mutation success cannot issue a receipt. CSRF proof stays private in memory; neither tokens nor credentials enter browser storage or broadcast messages. Consumers must handle rejected operation promises with the safe `AuthFailure` fields and keep protected content hidden outside `authenticated` state. Read reconciliation cannot establish that an ambiguously delivered registration failed to create an account; the uncertainty flag remains until a later successful explicit authentication operation.

### Routing and React integration (Stage 2C.2A)

The public `/` welcome page retains its health check and defers authentication initialization until an authentication route is visited. `/login` and `/register` use guest-only boundaries; `/app` uses a protected boundary. Registration requires an explicit server-derived capability; a disabled direct `/register` visit explains the restriction and links to sign-in. The backend independently authorizes registration. Unknown paths display an accessible not-found page.

React uses `useSyncExternalStore` with the existing singleton. Each authentication-route entry verifies the actual session before redirecting or admitting protected content. Verification waits for pending mutations to settle, then reads fresh state; ordinary component cleanup does not dispose the singleton or abort requests. Visible-document focus/visibility events optionally revalidate at most once per 30 seconds. Explicit **Check session** recovery bypasses that coalescing interval while respecting pending operations and server cooldowns. Cooldown expiration itself sends no request. Existing guest DOM is retained, disabled during checks, and hidden/inert when verification fails; background checks do not erase future form input.

Route boundaries own retained consumers of one verification integration per store. Cleanup removes abandoned, unstarted waiters; already-dispatched work finishes under its existing lock and can be shared by a remounted consumer. Each history entry captures a receipt baseline. A newer valid receipt can satisfy failed-entry or queued recovery without another HTTP read; an invalidation message, cached snapshot, or plain mutation completion cannot. Pending guest controls are also inert. See the [targeted corrections report](docs/milestones/checkpoint-2c2a-corrections-report.md) for lifecycle, receipt, and test-only form admission regressions.

The eight-second waiting message is informational and never releases a lock or retries a mutation. Unsupported coordination remains fail-closed. jsdom component tests complement the existing Node unit/HTTP tests; they do not establish real-browser cookie, Web Locks, BFCache, accessibility, or mobile behavior. See the [Stage 2C.2A verification report](docs/milestones/checkpoint-2c2a-report.md). Playwright remains Stage 2C.3 work.

All cookie-changing requests and their reconciliation hold one exclusive same-origin Web Lock. BroadcastChannel carries only the literal `invalidate`, never a response or proof. Unsupported or insecure coordination fails closed. Page exit discards proof without initiating another allocation; BFCache restoration requests fresh state. The store coalesces bootstrap across StrictMode-style remounts and never retries authentication mutations. Mutation preflight rechecks the current session after acquiring the lock, rejecting stale intent even when the replacement belongs to the same user. The raw transport is internal to coordinated flows; application components should call the store.

Invalidation removes private proof and exposes `unavailable` (or `uncertain` when an outcome remains unresolved), rather than leaving an idle `initializing` snapshot. If cooldown or a pending failed mutation blocks verification, the missing proof preserves the need for a fresh `bootstrap()`/`revalidate()`; consumers offer explicit recovery after `retryAt`, without automatically replaying a mutation or scheduling repeated reads. Broadcast invalidation never changes document suspension: only pagehide suspends and a persisted pageshow resumes/revalidates. A definitively successful explicit mutation clears prior uncertainty after required reconciliation succeeds for the current generation; ordinary reads and failed reconciliation cannot clear ambiguous outcomes.

### Authentication forms and minimal workspace (Stage 2C.2B)

Login and conditionally available registration use native uncontrolled fields, `FormData`, and the shared strict Zod schemas. Email normalization comes from the schema; passwords are never trimmed, normalized, truncated, or placed in React/global state, storage, URLs, or logs. Local validation keeps the password. Accepted coordinator ownership clears the native password immediately, even if its later security preflight prevents a POST. A pre-admission rejection retains it. Leaving the form clears the detached password control. Standard `username`, `current-password`, and `new-password` autocomplete remains enabled.

**Password compatibility limitation:** the existing API schemas permit CR/LF inside passwords, but standard native HTML password/text fields remove line breaks. Such API-created passwords cannot be reproduced through these fields. No backend contract or browser-field workaround was introduced. Other spaces, Unicode, and combining sequences are preserved; code-point length validation comes from Zod, without native UTF-16 `maxlength`. Contract alignment requires separate approval. See the [HTML password input specification](https://html.spec.whatwg.org/multipage/input.html#password-state-(type=password)).

Every mutation checks live route admission as well as the accepted coordinator: a current receipt newer than the route baseline, matching rendered receipt, correct session, no pending verification/cooldown, and explicit registration capability without unresolved uncertainty. Page-level operation ownership survives temporary protected-child unmounting and ends with that history entry. Cleanup fences old callbacks without aborting requests or disposing the singleton. Pending feedback covers mutation settlement and its authoritative verification. Synchronous coordinator invocation faults produce sanitized unknown-outcome feedback and settle local ownership; the live store still gates any work it already accepted and retains its lock. Password clearing continues to depend on accepted ownership, rather than the exception alone. A completed coordinator reconciliation is reused; mutations are never replayed, and ambiguous failures/cooldowns do not trigger an additional automatic UI recovery read.

Unresolved account-creation uncertainty blocks registration while allowing explicit sign-in with freshly verified anonymous proof. Read-only failures may expose `status: uncertain` but do not introduce `outcomeUncertain`: that existing flag now specifically preserves authentication-mutation ambiguity. Successful authoritative reads resolve read-only uncertainty while retaining any earlier mutation ambiguity. This includes failures in CSRF/session reads and mutation preflight before a POST was dispatched. Failed or stale recovery still cannot issue proof or admit a form. Verified authenticated access remains available with an uncertainty notice. Logout hides protected information while pending and checks the actual current session; only authoritative anonymous proof redirects to sign-in. It does not show an optimistic signed-out success toast. A replacement authenticated session remains visible with truthful feedback. Failed verification keeps recovery available and never proves logout.

Forms use visible labels, linked errors, a focused validation summary, a keyboard-operable visibility toggle, and safe status/error copy. Progress/status feedback is outside the guarded content's `aria-busy` subtree so waiting announcements can be delivered while work continues; countdown ticks have no live-region role. The existing Manrope/Inter typography, warm background, forest-green controls, copper accent, focus styles, and reduced-motion behavior are preserved. The header stacks on narrow screens; forms have no fixed minimum width. `/app` shows only verified email, sign-out, and honest future-work text—no application data or unfinished controls. See the [Stage 2C.2B report](docs/milestones/checkpoint-2c2b-report.md) and [targeted audit corrections](docs/milestones/checkpoint-2c2b-corrections-report.md) for test evidence and browser verification limits.

Requests use required custom headers, same-origin credentials, no-store, and reject redirects; browsers supply Origin/Fetch Metadata. Only cookie-free `/me` reads have an eight-second abort timeout. Bootstrap and mutations expose a waiting flag after eight seconds but retain their lock until completion. A hung database/request can therefore retain the lock indefinitely: bounded database query/lock deadlines remain a separately reviewed backend follow-up. Read-only recovery is bounded and can itself allocate an anonymous session through GET `/csrf`; it never replays a POST. Rate-limit cooldowns do not trigger automatic retries.

Browser coordination is cooperative and cannot guarantee cookie ordering across a crashed/closed/reloaded document when the server may already have committed. A replacement document starts from server bootstrap; it cannot infer rollback from a lost response or revoke a previously committed operation. Same-origin XSS can bypass these browser controls. Real multi-tab, navigation, HTTPS cookie, and assistive-technology verification remain for later UI/browser stages. Production registration restrictions and existing database guards are unchanged.

## Workspace responsibilities

```text
apps/web            React + Vite; Tailwind tokens, shadcn Button, connection UI
apps/api            Express app, startup, environment validation, HTTP handling
packages/contracts  Browser-safe Zod contracts and exported TypeScript types
.github/workflows    Pull request / main-branch CI; no deployment
```

This is a modular monolith with npm workspaces. Feature modules will be added as their milestones begin. The frontend imports the public contracts package, never API internals. Contracts are compiled to ESM JavaScript and declaration files before application builds. Node-targeted TypeScript uses NodeNext resolution and `.js` relative imports; the frontend uses bundler resolution.

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Build contracts and run all development watchers |
| `npm run dev:web` | Run only Vite on port 5173 |
| `npm run dev:api` | Run only the API through `tsx watch` |
| `npm run lint` | Read-only ESLint check; warnings fail |
| `npm run typecheck` | Generate Prisma and contract declarations, then check workspaces and tooling configurations |
| `npm test` | Run unit tests once; discovering no tests fails |
| `npm run test:integration` | Run guarded PostgreSQL persistence tests against the dedicated, already-migrated test database |
| `npm run test:watch` | Interactive Vitest watch mode |
| `npm run bench:passwords` | Measure the approved Argon2id profile locally without a database or account creation |
| `npm run build` | Build contracts, generate Prisma, compile the API, and bundle the frontend |
| `npm start` | Run the compiled API; set `NODE_ENV=production` to serve the built frontend |

Contracts use an incremental watcher to avoid unnecessary startup emissions; explicit builds force fresh output. Generated files, build caches, dependencies, local environment files, and test artifacts are ignored. npm allows only the pinned esbuild, Prisma CLI version-check, Prisma engine-download, and reviewed Argon2 native installation scripts recorded in the root package's `allowScripts` policy.

The Argon2 approval is restricted to version 0.45.1. Test commands prepare shared contract output and the ignored Prisma client before running; neither preparation step connects to a database or applies migrations. Unit tests remain independent of a running PostgreSQL service.

### PostgreSQL / Prisma persistence foundation

See [Checkpoint 2A setup and SQL approval](docs/milestones/checkpoint-2a-setup.md) for database commands, target restrictions, and the mandatory SQL approval gate. Prisma CLI, client, and PostgreSQL adapter are pinned to **7.10.1**. Client generation and the existing build/check commands remain offline and do not run migrations.

The initial SQL was explicitly approved and applied to the isolated local databases. New targets still require target validation and explicit SQL approval before migration. Persistence tests never apply migrations or reset databases. Docker tooling may need execution outside the agent sandbox; no Docker, WSL, or machine PATH changes are required. See the [Checkpoint 2A completion report](docs/milestones/checkpoint-2a-report.md) for executed checks and scope limitations.

## Production build and local verification

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Production-mode startup also requires an explicit HTTPS `APP_ORIGIN`, production database identity, and certificate-verified database TLS as validated by the existing runtime configuration parser. Local Docker credentials do not satisfy that configuration. This stage does not provision production infrastructure or validate deployment readiness. With separately supplied runtime configuration, start the compiled server under the production environment. PowerShell:

```powershell
$env:NODE_ENV = 'production'
npm.cmd start
```

POSIX shells:

```sh
NODE_ENV=production npm start
```

Open **http://127.0.0.1:3000**. Express serves both the compiled frontend and `/api` under this origin. No Vite process is needed. The server fails clearly if the frontend build is missing. API modules do not open a port when imported; the startup module owns listening and shutdown.

In another PowerShell terminal:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/v1/health/live
Invoke-WebRequest http://127.0.0.1:3000/ -Headers @{ Accept = 'text/html' }
curl.exe -i http://127.0.0.1:3000/api/v1/unknown
```

Liveness returns:

```json
{ "status": "ok", "service": "applyflow-api" }
```

Unknown API routes return JSON `404` errors, including when HTML is requested. Non-API GET/HEAD navigation requests explicitly accepting HTML receive the SPA fallback. Missing asset/file requests return `404`. Hashed assets are immutable; HTML is revalidated. Liveness indicates that the process responds, not database readiness.

HTTP errors use `{ "code": "...", "message": "..." }`. Invalid JSON returns `400`, JSON bodies larger than 16 KB return `413`, unsupported encodings return `415`, and unexpected failures return a generic `500` without stack traces. Helmet sets security headers and Express's identifying header is disabled. No CORS middleware is needed for this same-origin architecture.

When returning to development in the same PowerShell terminal, clear the production override with `Remove-Item Env:NODE_ENV` before running `npm.cmd run dev`.

## Tests and CI

Vitest tests contracts, configuration, database guards, password/session primitives, request validation, bounded admission, and auth/CSRF HTTP handling with Supertest. Unit tests use injected dependencies and need no database. The separate PostgreSQL suite verifies persistence, real Argon2-backed authentication, concurrent registration/session consumption, exact expiration boundaries, transaction rollback, committed cookie delivery, logout isolation, and fixture isolation. It fails closed outside the dedicated test target and cleans up only its own fixtures. Database-backed CI and React authentication screens belong to checkpoint 2C.

GitHub Actions runs on pull requests and pushes to `main`, using `.nvmrc`, the root lockfile, read-only repository permissions, and pinned checkout/setup-node actions. It runs `npm ci`, lint, typecheck, unit tests, and the production build. Superseded branch runs are cancelled. It does not push or deploy.

### Manual UI checklist

- Inspect desktop (for example 1440 px), mobile (390 px), and narrow (320 px) layouts for overflow, wrapping, and readable text.
- Tab to the skip link and connection button; verify visible focus and keyboard activation.
- Verify that connection results are announced by a screen reader without moving focus.
- With API and Vite running in separate terminals, stop the API, retry, and verify the unavailable message. Restart it and retry successfully.
- Confirm checking state prevents duplicate clicks and that reduced-motion preferences are respected.
- Check production developer tools for JavaScript errors, CSP violations, and failed font/asset requests.

The palette and font choices follow `DESIGN_SYSTEM.md`. Text/button color pairs meet WCAG AA contrast numerically; copper is decorative rather than body text. Fonts are bundled locally; their SIL Open Font License notices and the shadcn/ui MIT notice are retained under `apps/web/public/licenses` and copied into the frontend build.

## Product and engineering references

- [AGENTS.md](AGENTS.md): development workflow and restrictions.
- [PRD.md](PRD.md): product scope and future milestones.
- [DESIGN_SYSTEM.md](DESIGN_SYSTEM.md): visual direction and accessibility requirements.

The initial database migration was explicitly approved and applied locally. No migrations, authentication, later-checkpoint features, commits, pushes, or deployments are performed automatically by this setup.
