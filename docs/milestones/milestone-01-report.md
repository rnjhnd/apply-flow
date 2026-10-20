# Milestone 1 verification report

Verification date: **20 October 2026 (Asia/Manila)**.

**The foundation passes the requested local checks.** This report records repository inspection, freshly executed commands, HTTP assertions, and browser interaction—not README claims. It is a historical snapshot of the verification session, not a guarantee about later repository changes.

## 1. Implemented functionality

- npm workspaces for the React frontend, Express API, and shared Zod contracts.
- Strict TypeScript, ESLint, shared scripts, and one root lockfile.
- Express environment validation, Helmet, bounded JSON parsing, JSON errors, and liveness endpoint.
- Responsive frontend with design tokens, bundled fonts, customized shadcn Button, and working API status/retry controls.
- Vite development proxy and production frontend serving through Express.
- Foundation unit tests and GitHub Actions configuration.

Authentication, database persistence, application CRUD, and other milestones remain unimplemented.

## 2. Important files

| Area | Important files |
| --- | --- |
| Workspace/tooling | [package.json](../../package.json), root lockfile, `.nvmrc`, `.npmrc`, TypeScript configs, ESLint/Vitest configs |
| API | [app.ts](../../apps/api/src/app.ts), `server.ts`, `config/env.ts`, `.env.example` |
| Frontend | [App.tsx](../../apps/web/src/App.tsx), `styles.css`, `components/ui/button.tsx`, `lib/api.ts`, `vite.config.ts` |
| Contracts | [health.ts](../../packages/contracts/src/health.ts), public exports |
| Tests | `apps/api/src/config/env.test.ts`, `packages/contracts/src/health.test.ts` |
| CI/documentation | [ci.yml](../../.github/workflows/ci.yml), [README.md](../../README.md), font/component license notices |
| Modified existing file | `.gitignore` |

`AGENTS.md`, `PRD.md`, and `DESIGN_SYSTEM.md` were confirmed unchanged.

## 3. Fresh command results

Environment: **Node v24.22.0**, **npm 11.19.1**, Windows PowerShell.

| Command | Result | Exit code |
| --- | --- | ---: |
| `npm.cmd run lint` | PASS; zero warnings | 0 |
| `npm.cmd run typecheck` | PASS; all workspaces and Vitest configuration | 0 |
| `npm.cmd test` | PASS; **25 tests across 2 files** | 0 |
| `npm.cmd run build` | PASS; contracts, compiled API, frontend bundle | 0 |

Test breakdown: **18 environment tests + 7 health-contract tests**. No test failures were reported. Runtime checks below are separate from those 25 tests.

## 4. Development and production verification

### Development — PASS after clearing stale optimizer state

Started `npm.cmd run dev` and verified both:

- Express: `http://127.0.0.1:3000/api/v1/health/live`
- Through Vite: `http://127.0.0.1:5173/api/v1/health/live`

Both returned HTTP **200**, `application/json; charset=utf-8`, and:

```json
{"status":"ok","service":"applyflow-api"}
```

The browser displayed **“API available.”** Clicking the button and activating it with Enter updated the check timestamp.

Initially, development rendered blank because optimized React dependencies returned **504 “Outdated Optimize Dep.”** Running `npm.cmd run dev -w @applyflow/web -- --force` refreshed the cache. A subsequent ordinary `npm.cmd run dev` restart passed without that flag. No application-code changes were made; the underlying cause of the stale cache was not established.

### Production — PASS

Started `npm.cmd start` with `NODE_ENV=production` and port `3001`:

- `/` returned HTTP **200**, `text/html; charset=utf-8`.
- Referenced JavaScript and CSS assets returned HTTP **200**.
- The browser rendered the frontend and successfully checked the API.
- `/api/v1/unknown`, even with `Accept: text/html`, returned HTTP **404**, `application/json; charset=utf-8`:

```json
{"code":"NOT_FOUND","message":"The requested resource was not found."}
```

The development and production verification servers were stopped after the checks.

## 5. CI status and remaining limitations

The workflow exists and contains real installation, lint, typecheck, test, and build steps. It uses `.nvmrc`, pinned action SHAs, read-only permissions, and cancellation of superseded runs.

**Locally verified:** workflow contents and the four requested check commands on Windows.

**Not verified:** an actual hosted GitHub Actions run, Linux runner behavior, or formal workflow-linter validation. No hosted run was initiated. The installation step was not rerun during this verification session.

Remaining manual coverage includes mobile layouts, full keyboard navigation, screen-reader announcements, reduced-motion behavior, and offline/error recovery. Desktop rendering and basic retry/Enter activation were verified.

## 6. Git status at verification time

The working tree was **not clean**:

- **1 modified tracked file:** `.gitignore`.
- **38 untracked files**, including the foundation implementation and CI workflow.
- `git diff --check` passed.
- Exactly one project lockfile existed, at the repository root.

These counts describe the verification snapshot **before this report was saved**. This report adds another untracked file until committed.

No application code was modified during verification. Build/cache artifacts were regenerated. No commits, pushes, deployments, or Milestone 2 work occurred.
