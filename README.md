# ApplyFlow

A calm, focused workspace for managing a job search. This repository currently implements **Milestone 1: Foundation** only.

The runnable preview contains a branded responsive page, an API connection check, a minimal Express server, shared validation contracts, unit tests, and CI. Authentication, application tracking, database persistence, background jobs, and deployment are not implemented.

## Prerequisites

- **Node.js 24.22.0 LTS**, pinned in `.nvmrc`. With an existing Node version manager, install/select the version in that file; on Windows with nvm-windows, use `nvm install 24.22.0` followed by `nvm use 24.22.0`.
- **npm 11.19.1**, the version used to generate the single root lockfile. Use npm 11; no Yarn or pnpm lockfiles.
- Git. No database, Docker, credentials, or external service is needed for this milestone.

The root engine check rejects Node versions outside major 24. TypeScript 6.0.3 is selected because it is supported by the installed TypeScript ESLint release. Dependency versions are pinned and reproducible through `package-lock.json`.

## Install and develop

Run all commands from the repository root:

```sh
node --version
npm --version
npm ci
npm run dev
```

On Windows PowerShell, use `npm.cmd` in place of `npm` if execution policy blocks `npm.ps1`. Changing the machine's execution policy is unnecessary.

Open **http://127.0.0.1:5173**. Vite proxies `/api` to **http://127.0.0.1:3000**, so the browser uses relative, same-origin requests. The initial check and **Check connection** button call `GET /api/v1/health/live`, validate the response, and display success or a retryable failure. Checks time out after eight seconds.

`npm run dev` builds shared contracts first, then watches contracts, the API, and the web app together. Contract JavaScript changes restart the API. Output is inherited rather than piped to support Windows watcher startup. Stop all three with Ctrl+C. A stopped child terminates the others.

For separate terminals, first run `npm run build -w @applyflow/contracts`, then use `npm run dev:api` and `npm run dev:web`. Run `npm run dev -w @applyflow/contracts` separately if editing shared contracts.

### Optional API environment

Defaults work without an `.env` file. To customize them, copy `apps/api/.env.example` to `apps/api/.env`. Node loads this file in development and production; existing process variables take precedence. Never commit real environment files.

| Variable | Default | Policy |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test`, or `production` |
| `HOST` | `127.0.0.1` | Nonempty bind host; use `0.0.0.0` only when deliberately exposing the server |
| `PORT` | `3000` | Integer string between 1 and 65535 |
| `APP_TIMEZONE` | `Asia/Manila` | Timezone supported by the runtime |

Environment values are validated before the server listens. If changing the API port, update Vite's proxy target in `apps/web/vite.config.ts` to match. Restart the API after editing `.env`.

**Application date policy for later milestones:** PostgreSQL `DATE` stores the application date without a time component. The API evaluates “today” in the explicit server-wide `APP_TIMEZONE`, defaulting to **Asia/Manila**, regardless of the host machine or browser timezone. Changing this setting intentionally changes that policy for all users of the instance. Dates later than that day will be rejected. Saved applications may have no application date; all other statuses require one. System event timestamps will use UTC. The foundation validates the timezone setting; it does not yet implement application date validation.

**Authentication policy for later milestones:** controlled local/test account creation will use email/password and PostgreSQL-backed sessions. Production public registration stays disabled until email verification, password recovery, and abuse protections exist. No registration or authentication endpoints exist in this milestone.

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
| `npm run typecheck` | Build contract declarations, then check all workspaces and the Vitest configuration |
| `npm test` | Run foundation unit tests once; discovering no tests fails |
| `npm run test:watch` | Interactive Vitest watch mode |
| `npm run build` | Build contracts, compile the API, and bundle the frontend |
| `npm start` | Run the compiled API; set `NODE_ENV=production` to serve the built frontend |

Contracts use an incremental watcher to avoid unnecessary startup emissions; explicit builds force fresh output. Generated files, build caches, dependencies, local environment files, and test artifacts are ignored. npm allows only the pinned esbuild installation script recorded in the root package's `allowScripts` policy.

## Production build and local verification

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run build
```

Start the compiled server under the production environment. PowerShell:

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

Vitest tests the real environment parser and health response schema, including invalid values, boundary ports, unexpected fields, and configuration defaults. API integration tests with PostgreSQL and Supertest, frontend interaction tests, and Playwright workflows will be added when those features become functional.

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

No commits, pushes, deployments, database migrations, authentication, or later-milestone features are part of this foundation implementation.
