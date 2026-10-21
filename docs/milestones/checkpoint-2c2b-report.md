# Stage 2C.2B — Authentication Forms, Minimal Workspace, and Accessibility

Date: 2026-10-21 (Asia/Manila). Status: implemented and locally verified; awaiting review. Stage 2C.3 has not begun.

This records the initial implementation verification. The subsequent audit found three issues; see [targeted corrections and current verification](checkpoint-2c2b-corrections-report.md). Counts and statements below describe the initial implementation before those corrections.

## Baseline and scope

Before editing, the actual branch was `feat/authentication`, HEAD was `a224d49b7402db25b30232aa9336f4f9aaebb2fa`, and `git status --short --untracked-files=all` was empty. The accepted 2C.1/2C.2A source and reports were present. Their historical statements about uncommitted work describe their original reporting time; both foundations are committed in this baseline. Runtime: Node v24.22.0 and npm 11.19.1.

AGENTS.md, PRD.md, DESIGN_SYSTEM.md, accepted reports, current route guards/integration, transport, store, receipt behavior, shared contracts, components, fixtures, and testing configuration informed the implementation. No dependency or manifest/lockfile changes were needed.

## Files changed

Modified:

- `apps/web/src/App.tsx`: replace route placeholders with authentication/workspace pages.
- `apps/web/src/features/auth/auth-route.tsx`: additive live submission admission, feedback outside guarded children, operation-aware pending state, and recovery/uncertainty copy. Cooldown countdowns no longer announce every second.
- `apps/web/src/features/auth/route-shell.tsx`: stack the existing header at narrow widths.
- `apps/web/src/features/auth/auth-route.test.tsx`: replace obsolete placeholder assertions with real form/workspace expectations; explicitly check that email is absent before verification and present only afterward.
- `apps/web/src/features/auth/auth-corrections.test.tsx`: update workspace heading expectations only; preserve accepted receipt/lifecycle regressions and request counts.
- `README.md`: current UI behavior, accepted commit history, credential lifetime, compatibility limitation, and report link.

Added under `apps/web/src/features/auth/`:

- `auth-admission.ts`: route-owned context exposing rendered availability and a live submission check.
- `auth-page.tsx`: login/registration page ownership per history entry.
- `auth-form.tsx`: native uncontrolled forms and shared strict Zod validation.
- `password-field.tsx`: labeled native field, password-manager autocomplete, visibility control, helper/error associations.
- `auth-feedback.tsx`: application-authored feedback from sanitized failure metadata and cooldown deadlines.
- `use-auth-operation.ts`: duplicate prevention, acceptance detection, lifetime fences, and bounded receipt-aware outcome verification.
- `workspace-page.tsx`: protected verified email, coordinated logout, and honest future-work messaging.
- `auth-ui.test.tsx`: 41 new deterministic component regressions.

Also added: `docs/milestones/checkpoint-2c2b-report.md` (this report). Total: six modified tracked files and nine new files, all uncommitted.

## Credential handling

Submission prevents native navigation, consults live admission, reads native FormData, and validates only the email/password request through the existing strict Zod schema. Schema email normalization is unchanged. Password strings retain their spaces, Unicode, astral code points, and combining sequences. No native min/max length is added because native length semantics differ from the shared code-point validation. Native form fallback uses POST rather than putting credentials in a query string.

Local invalid submissions keep the password and focus a linked validation summary. Once a valid request is handed to the coordinator, its existing synchronous busy transition confirms accepted ownership and the native password is cleared immediately. Rejected admission without that transition retains it. Accepted ownership is not a claim that the POST reached the server: a later coordinator preflight can reject without sending it. Password controls are cleared on unmount, including capability revocation and navigation. No credentials are retained in UI/global state, route state, URLs, storage, broadcasts, or logs. Transient request arguments remain owned by the existing coordinator for their required lifetime.

Native `username`, `current-password`, and `new-password` autocomplete and paste remain available. Actual password-manager save/autofill behavior still needs browser testing, especially with immediate password clearing.

**Existing compatibility limitation:** API schemas accept CR/LF within passwords, while native HTML password/text controls remove line breaks. An API-created password containing line breaks cannot be entered faithfully in these controls. A deterministic native-field regression documents this; contracts and backend behavior were not changed. Alignment requires separate approval. Other whitespace and Unicode are not normalized.

## Admission, ordering, and uncertainty

The route context separates presentation availability from submission authorization. Each submission checks the live store: active boundary, no foreground/operation verification pending, no busy operation/cooldown, receipt newer than this history entry's baseline and equal to the rendered receipt, appropriate live session status, and explicit registration capability without unresolved uncertainty. Stale callbacks fail after invalidation, newer receipts, capability revocation, or unmount. The backend remains independently authoritative.

Page operation ownership lives above temporarily hidden/unmounted guard children and is keyed to the history entry. StrictMode cleanup invalidates an owner rather than disposing the singleton. Duplicate submissions are rejected synchronously. Old completions do not alter newer page feedback or initiate verification after abandonment. Already-dispatched requests and their locks settle normally.

Definite outcomes use at most one receipt-aware verification demand, reusing a newer coordinator reconciliation receipt. A mutation response alone cannot admit protected content or establish a redirect. Pending page ownership also covers the gap between mutation settlement and its verification, preventing premature recovery controls. Mandatory destination route-entry verification remains intact. Ambiguous failures and 429 do not start an additional UI reconciliation/retry cycle. Expiring the countdown sends no request.

Uncertain registration stays blocked after an anonymous session read; explicit login remains available with fresh anonymous proof. Verified authenticated sessions remain accessible with an uncertainty notice. Sanitized 400/401/403/404/409/429/503, protocol, and network feedback never displays arbitrary server text. In particular, a malformed protocol response with status 400 is described conservatively rather than as proven rejection.

## Workspace and logout

The workspace displays only the freshly verified safe email, a single sign-out action, and text explaining that tracking belongs to a later milestone. No statistics, application records, or unfinished controls are present.

Logout uses the existing coordinator, duplicate prevention, and receipt-aware current-session confirmation. Protected information is removed while verification is pending. Fresh anonymous proof redirects to sign-in; there is no optimistic signed-out success toast. A replacement authenticated session remains in the workspace with truthful feedback rather than claiming sign-out. Failed or ambiguous outcomes preserve sanitized feedback above protected children and expose explicit recovery when proof is unavailable. Failed confirmation never proves logout; another mutation requires fresh live admission. Other-device isolation remains the existing backend policy, unchanged here.

## Design and accessibility

The warm background, Manrope/Inter typography, green controls, copper accent, existing Button, visible focus styles, skip navigation, and reduced-motion rules are reused. Forms are left-aligned within the existing editorial shell. The mobile header stacks, fields use available width with no fixed minimum, and email can wrap anywhere. The layout is intended for 320px and wider; jsdom does not verify physical layout.

Forms have persistent labels, required/autocomplete metadata, aria-invalid/describedby relationships, a deliberately focused validation summary, trusted alerts/status messages, and a keyboard-operable non-submit password toggle with aria-pressed/controls. Unknown content is hidden/inert; pending guest controls are disabled/inert. Background checks retain draft nodes and do not move focus. Countdown numbers are not live-announced every second.

Numerically checked palette contrast: body text/warm background 14.10:1, muted text/warm background 5.82:1, green/warm background 7.32:1, white/green button 7.84:1, input border/white field 3.08:1. This calculation is not a substitute for browser/assistive-technology review.

## Test evidence and corrections during development

The 41 new tests cover local validation and focus, server field names, metadata, native autofill values without React change events, exact Unicode/space preservation, code-point lengths, accepted versus rejected handoff, preflight failure, detached control clearing, duplicate submits, keyboard visibility, native CR/LF behavior, retained editing/focus, capability revocation, registration uncertainty and login recovery, successful registration, live/stale receipt admission, conservative HTTP/protocol/network feedback, pending request ownership, same-path history navigation, cooldowns, eight-second waiting, and public-output/storage privacy.

Workspace cases cover fresh safe information, logout duplicates, anonymous confirmation gating, replacement sessions, abandoned logout, failed/ambiguous outcomes, failed confirmation, explicit recovery, and reuse of completed reconciliation without another read. All 46 accepted component regressions remain present; only obsolete placeholder expectations changed.

Development found and corrected:

- Initial lint rejected reading admission refs/time during render. Presentation now derives from subscribed state, while event-time checks use an additive context; no lint rule was disabled.
- Two new failed-verification recovery tests exposed recovery controls appearing between mutation settlement and follow-up verification. The page-owned pending phase now spans that interval. Both tests pass without relaxing assertions.
- Review of same-path history transitions led to explicit per-entry page ownership and a regression preventing obsolete pending labels/feedback.
- Protocol error feedback now prioritizes uncertainty over status-400 rejection copy, with a regression.

## Executed verification

Commands ran sequentially, avoiding generated-output collisions:

| Command | Actual result |
| --- | --- |
| `npm.cmd exec -- vitest run --project web-components` | Exit 0; **87 tests passed, 3 files**, no failures/skips |
| `npm.cmd run lint` | Exit 0; no errors/warnings |
| `npm.cmd run typecheck` | Exit 0; root and all workspaces |
| `npm.cmd test` | Exit 0; **421 tests passed, 17 files**, no failures/skips: 334 existing Node/HTTP + 87 components |
| `npm.cmd run build` | Exit 0; contracts/API/frontend; 216 Vite modules transformed |
| `git diff --check` | Exit 0; no whitespace errors (Git's LF-to-CRLF normalization notices only) |
| `git status --short --untracked-files=all` | Exit 0; six modified tracked files and nine new files, all uncommitted |

Existing scripts generated ignored contract/Prisma/build artifacts offline; no database connection, migration, or PostgreSQL integration test was run. The integration suite is separate and unchanged.

## Remaining limits and review boundary

- These are deterministic mocked-transport/jsdom tests using the real client store, not real-browser or live PostgreSQL authentication evidence.
- Manually verify desktop/mobile/320px overflow, real keyboard/inert behavior, screen-reader announcement timing, native autofill/password-manager save, visibility toggling, contrast in rendered states, reduced motion, and focus behavior across hidden/restored content.
- Stage 2C.3 must verify real cookies, browser Origin/Fetch Metadata, Web Locks/BroadcastChannel, tab races, BFCache/reload, history, expiry, and real same-origin authentication flows with isolated data. No Playwright harness was added.
- Accepted pre-admission detection depends on the existing store's synchronous busy transition; direct regression coverage records that interface assumption.
- Cookie-changing operations still retain locks until the underlying request settles, potentially indefinitely. The eight-second message is informational. Browser close/reload cannot prove a server mutation rolled back.
- Existing database query/lock timeout hardening remains a separate operational concern. Production registration stays disabled by unchanged backend policy; this work does not establish deployment readiness.

Backend authentication, contracts, accepted store/coordination/receipt implementation, Prisma/schema/migrations/guards, dependency manifests/lockfile, CI, and integration configuration are unchanged. No database operations, installs, Playwright, application CRUD/analytics/AI, production access, commit, push, merge, or deployment occurred. Stop after Stage 2C.2B and await review.
