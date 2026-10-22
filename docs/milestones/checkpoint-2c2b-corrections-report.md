# Stage 2C.2B — Targeted Audit Corrections

Date: 2026-10-21 (Asia/Manila). Implemented only the three authorized audit corrections; awaiting review. No Stage 2C.3 work or Git commit occurred.

## Starting state

Branch `feat/authentication`, HEAD `a224d49`. The audited Stage 2C.2B implementation was already present as six modified tracked files and nine new files. Those changes were preserved. AGENTS.md, relevant product/design documentation, actual store transitions/consumers, operation ownership, route markup, fixtures, and existing regressions were inspected before the corrections.

## Corrections and invariants

### Read-only versus mutation uncertainty

Root cause: `unavailable()` used one boolean both to indicate an indeterminate session read and to introduce persistent `outcomeUncertain`. A network failure in bootstrap, `/me`, or mutation preflight could therefore imply an unresolved account-creation attempt even when no authentication POST had been dispatched. Successful anonymous verification preserved that flag, stranding registration.

The smallest correction keeps the existing public AuthState shape and changes the private helper's reason to `'read' | 'mutation' | null`:

- Read network/protocol failures can still publish `status: uncertain`, null user/capability/receipt, and a sanitized error. They do not create persistent mutation ambiguity.
- `outcomeUncertain` now specifically preserves authentication-mutation ambiguity. A read failure ORs in no new mutation flag and never clears an existing one.
- A successful authoritative read restores anonymous/authenticated status normally. When only a read failed, registration becomes eligible under all the existing admission checks.
- Dispatched ambiguous authentication mutations and failed post-mutation reconciliation retain the established conservative behavior. Successful anonymous reads cannot clear that ambiguity. Explicit login recovery and the existing confirmed-mutation clearing rules remain intact.
- Failed or stale reads cannot issue receipts or grant admission. Generation checks, proof handling, monotonic receipt publication, locks, cooldowns, and mutation retry behavior are unchanged.

No additive public field, backend/shared contract, browser persistence, or sensitive identifier was introduced. The route's read-only notice now describes unverified session state without suggesting account creation was attempted. Genuine mutation ambiguity retains the existing protective notice and registration restriction.

### Synchronous invocation exceptions

Root cause: the page hook set local pending ownership before invoking a coordinator dependency, without catching a synchronous throw. Such a throw escaped before settlement handlers were installed and permanently blocked later attempts for that page lifetime.

Invocation is now caught and converted to a new sanitized network/unknown-outcome failure handled by the existing lifetime-fenced settlement path. The original exception is discarded, not logged or placed in state. Local ownership settles without assuming server success or rejection and without replaying a mutation.

Accepted handoff remains tied to the store's existing synchronous busy transition: a pre-handoff throw leaves the password intact; a throw after actual accepted work clears it. In the latter case the real store remains busy and its request retains its lock; live route admission blocks duplicate submissions. The synthetic fault does not manufacture a receipt, abort the real request, or initiate an automatic recovery read. After work settles without fresh proof, explicit Check session remains necessary.

The production coordinator still returns promises through its existing async mutation function. This correction hardens the invocation boundary without changing that interface. StrictMode, per-history-entry ownership, stale callbacks, and singleton preservation remain covered by existing tests.

### Waiting announcements during busy work

Root cause: the whole route, including progress/status messages, was marked aria-busy, allowing assistive technologies to defer the very waiting updates intended to explain pending work.

Only guarded form/workspace content is now inside the aria-busy subtree. Feedback, uncertainty notices, checking/recovery text, and the eight-second status message are outside it. Disabled/inert/hidden interaction gating and focus behavior remain unchanged. Countdown ticks retain no live-region role. No actual screen-reader verification is claimed.

## Exact files changed in this correction pass

| File | Change |
| --- | --- |
| `apps/web/src/lib/auth/store.ts` | Private uncertainty classification; public flag comment; mutation ambiguity preserved independently of read failures |
| `apps/web/src/lib/auth/store.test.ts` | Five direct store regressions |
| `apps/web/src/features/auth/use-auth-operation.ts` | Synchronous invocation exception handling through sanitized settlement |
| `apps/web/src/features/auth/auth-route.tsx` | Read-only notice and narrowed aria-busy subtree |
| `apps/web/src/features/auth/auth-audit-corrections.test.tsx` | Eleven new deterministic component regressions |
| `README.md` | Current uncertainty, synchronous-fault, and announcement behavior; report link |
| `docs/milestones/checkpoint-2c2b-report.md` | Mark original results as the initial implementation and link to this correction report |
| `docs/milestones/checkpoint-2c2b-corrections-report.md` | This report |

Other original Stage 2C.2B files remain in the working tree and were not changed by this correction pass.

## Regression results

Five new direct store cases:

- Initial CSRF or `/me` network failure: uncertain session with no mutation flag/receipt; successful anonymous recovery issues receipt 1 without any authentication POST.
- Failed registration preflight: no register POST and no invented mutation ambiguity; successful recovery issues a newer receipt.
- Genuine ambiguous registration followed by either CSRF or `/me` read failure and anonymous recovery: mutation ambiguity remains true, receipts invalidate/reissue monotonically, and registration POST count stays one.

Eleven new component cases:

- Two initial-read recovery cases reproduce the original audit sequence, restore the Create account action, and admit exactly one later deliberate registration attempt.
- Two genuine-registration cases retain disabled/live submission rejection after later read outages and anonymous recovery, while explicit login remains available.
- Failed and repeatedly invalidated recovery cases never display an admitted registration form or issue a receipt; subsequent healthy explicit recovery succeeds.
- A synchronous pre-handoff throw containing a sensitive test value produces only sanitized feedback, retains the password, logs nothing, sends no POST, and permits a later explicit attempt.
- A synchronous throw after accepted real work clears the password, retains the held lock, blocks duplication, and requires fresh proof after settlement. It sends no extra recovery request.
- Bootstrap, retained-guest background verification, and mutation waiting cases put the eight-second status outside every aria-busy=true ancestor. Work remains busy/locked until settlement; background controls remain disabled/inert and focus stays unchanged in jsdom.

All pre-existing regressions remain passing without changed assertions, including ambiguous registration across successful reads, confirmed explicit login reconciliation, stale generations, receipt ordering, unmount/remount ownership, logout isolation, cooldowns, and mutation request counts.

## Actual verification

Focused development checks passed before the final sequence:

- `npm.cmd exec -- vitest run --project web-components`: 98 passed in four files.
- `npm.cmd exec -- vitest run --project unit apps/web/src/lib/auth/store.test.ts`: 59 passed in one file.

Final checks ran sequentially, awaiting each command's completion:

| Command | Actual result |
| --- | --- |
| `npm.cmd exec -- vitest run --project web-components` | Exit 0; **98 passed**, four files |
| `npm.cmd run lint` | Exit 0; no errors or warnings |
| `npm.cmd run typecheck` | Exit 0; root and all workspaces |
| `npm.cmd test` | Exit 0; **437 passed**, 18 files: 339 Node/HTTP + 98 components |
| `npm.cmd run build` | Exit 0; contracts/API/frontend; 216 Vite modules transformed |
| `git diff --check` | Exit 0; no whitespace errors; Git's LF-to-CRLF normalization notices only |
| `git status --short --untracked-files=all` | Exit 0; eight modified tracked files and eleven new files, including original 2C.2B work; all uncommitted |

No failures/skips occurred in these correction checks. Sixteen tests were added to the initial 421-test implementation. Existing scripts generated ignored Prisma/contract/build artifacts offline; no database connection, migration, reset, or integration-database write occurred.

## Remaining limits and scope

These are deterministic unit/component results, not browser, screen-reader, password-manager, or live database evidence. Real announcement delivery, inert behavior, focus restoration, mobile layout, cookies, tab races, BFCache/reload, and browser session flows remain Stage 2C.3/manual testing. The documented native-field CR/LF password limitation remains unchanged.

The indefinite-request/held-lock operational risk remains separate. No request is aborted and no lock is released early. Backend query/lock deadline hardening is not part of these corrections.

Backend routes/policy, contracts, Prisma/schema/migrations/guards/databases, transport/cookies, browser coordination, receipt algorithm, dependencies/lockfile, CI, and integration configuration were not modified. No installs, browser E2E/Playwright, application CRUD/analytics/AI, production connection, commit, push, merge, or deployment occurred. Stop after these corrections and await review.
