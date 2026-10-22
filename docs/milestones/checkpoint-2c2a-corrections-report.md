# Stage 2C.2A — Targeted audit corrections

## Outcome and scope

The abandoned-waiter and externally recovered-entry reproductions are corrected. The final sequential verification passes **380 tests in 16 files**, with no failures or skips: **334 Node unit/HTTP tests and 46 jsdom component tests**. This adds **10 store cases and 18 component cases** to the earlier 352-test implementation result. Earlier reports remain historical snapshots.

Work began with the existing uncommitted 2C.2A implementation on `feat/authentication`, HEAD `d1d826e77ab00fcda1b971ec3cac6161e458c751`, Node **24.22.0**, npm **11.19.1**. No dependencies were installed or updated during this correction pass. No later-stage UI, backend/database work, commits, pushes, merges, or deployment occurred.

## Root causes and corrections

### Verification waiter ownership

Previously, each provider constructed a separate integration with a subscription waiting for store idle. Component cleanup ignored callback results but could not detach that subscription. Repeated visits during a stalled mutation accumulated abandoned integrations; each issued a fresh read when the mutation settled.

`createAuthIntegration` now returns one integration per store through a WeakMap. Each mounted route boundary explicitly retains a consumer inside its effect and releases it during cleanup. The last release removes and rejects any unstarted waiter and cancels its scheduled start. Cleanup is idempotent. Other active consumers retain the shared waiter; StrictMode replay can establish a new demand without reviving an abandoned task.

Once verification has been dispatched to the accepted store, cleanup never aborts it, disposes the store, or releases its lock. A remounted consumer can share that in-flight read. A completed task cannot erase a newer pending task. The public welcome page still creates no authentication demand on a fresh visit.

### Authoritative read freshness

The old public snapshot could not distinguish an anonymous session with valid proof from successful logout with proof cleared. It also had no way to establish that a successful external read was newer than a failed route entry. The narrow store extension was separately approved before implementation.

The store now exposes `verifiedReadId: number | null`. A successful current-generation CSRF-plus-me verification creates a private generation candidate. Only settlement of the coordinated operation can publish a new monotonic receipt, with live proof and known session status still valid. A current receipt may remain visible while another read is busy; it is not a new receipt, and pending-operation checks still prevent admission/interaction.

Invalidation, failure that clears proof, suspension, and disposal clear the current receipt and candidate. If a successful read replaces proof or user identity, it clears the old receipt before publishing the new receipt at settlement. Mutation dispatch clears both the public receipt and private candidate; an added generation/proof check prevents reentrant invalidation during that notification from admitting a stale POST. Login/register/logout success cannot issue a receipt on its own. Cached bootstrap and joining a pending mutation cannot manufacture freshness. Real bounded post-mutation read reconciliation may issue a receipt because it actually verified the session. That receipt does not resolve an ambiguous registration outcome.

The receipt counter is not reset on invalidation. Generation checks prevent stale reads from becoming candidates; reentrant invalidation can immediately invalidate a published receipt, but its identifier is never reused. No credentials, tokens, cookies, session identifiers, or private generation values are exposed through this metadata.

### Route recovery and interaction

Each history entry captures its initial receipt baseline. Admission requires a newer non-null live receipt, the appropriate live session status/capability, and the existing pending-operation checks. A successful external read can therefore recover a failed entry without another request. An invalidation signal or cached pre-entry status cannot do so. Local errors are associated with the snapshot in which they occurred, preventing an earlier error from overriding newer store state.

Queued verification also checks its receipt baseline when the store becomes idle. A real completed reconciliation can satisfy the waiter without repeating its read; plain mutation completion cannot. Foreground checks and explicit recovery capture the current receipt as their baseline, so the optional 30-second coalescing interval never substitutes for required verification or blocks explicit recovery. New consumers joining an unstarted waiter raise its required baseline when needed.

Guest DOM remains retained through background checks and recoverable outages. Pending controls are now inert as well as disabled; unknown content remains hidden/inert. No production forms or submit handlers were added. Test-only forms demonstrate both normal interaction blocking and live store admission after deliberately bypassing DOM disabling programmatically. Registration capability revocation removes registration interaction and the service independently rejects submission before a registration POST.

## Exact correction files and code paths

| File | Correction |
| --- | --- |
| `apps/web/src/lib/auth/store.ts` | AuthState receipt; generation candidate; receipt publication in operation settlement; invalidation/disposal and mutation-dispatch handling |
| `apps/web/src/lib/auth/store.test.ts` | Ten direct receipt regression cases |
| `apps/web/src/features/auth/use-auth.ts` | Shared integration cache, consumer retain/release, waiter subscription cleanup, request sharing, receipt-aware queued verification |
| `apps/web/src/features/auth/auth-route.tsx` | Entry baseline, consumer ownership effect, live freshness admission, snapshot-bound failures, pending inert state |
| `apps/web/src/test/auth-fixtures.ts` | Idempotent subscription accounting and held-lock accounting for deterministic assertions |
| `apps/web/src/features/auth/auth-corrections.test.tsx` | Eighteen new component regression cases; forms exist only in this test file |
| `README.md` | Current receipt and ownership behavior; link to this report |
| `docs/milestones/checkpoint-2c2a-corrections-report.md` | This report |

The provider's existing factory call now receives the shared integration; no provider source change was necessary. Earlier route/welcome/configuration/dependency files remain part of the pre-existing uncommitted implementation.

## Regression evidence

| Scenario | Actual passing result |
| --- | --- |
| Pending login or logout; three mount/unmount visits; no active consumer at settlement | Zero remaining subscriptions after each unmount; CSRF/me counts stay at two (initial read and mutation preflight); mutation called once; no abandoned follow-up request |
| Same visits followed by a surviving consumer | One shared additional read, three total CSRF/me calls; one React subscription after settling, zero after unmount |
| Two active consumers; one leaves during pending login | One shared waiter remains, one additional verification, then complete cleanup |
| Dispatched read; unmount/remount under StrictMode | One CSRF/me pair, lock remains held until response settlement, no store disposal |
| Consumer unmounts before scheduled verification starts | Zero HTTP calls and zero subscriptions |
| Pending login/logout with valid post-mutation reconciliation | Its receipt satisfies the waiter; three total CSRF/me calls, no redundant fourth read |
| Initial 503; external successful anonymous/authenticated verification | Admission only after a newer receipt; two total CSRF calls, no extra recovery read |
| Failed or repeatedly invalidated external verification | No receipt/admission or protected child mount; explicit recovery remains available |
| Cached pre-entry receipt or plain login success followed by cached bootstrap | Cannot admit protected content or redirect without a new actual verification |
| Unknown/invalidated guest controls | Normal keyboard navigation excludes them; programmatic submission still encounters live stale-session admission |
| Background verification | Disabled/inert controls prevent normal submission; programmatic bypass is rejected as busy without a login POST |
| Registration capability revoked | Form subtree removed; live service admission rejects registration before POST |

Direct store cases also cover publication only at coordinated settlement, cached bootstrap, all three mutation kinds, receipt monotonicity, proof replacement, suspension/failure/disposal, repeated stale-generation rejection, reentrant invalidation at publication and dispatch, and preservation of uncertainty after actual reconciliation. All original 2C.1 and 2C.2A tests still pass without weakened assertions.

## Final sequential verification

| Command | Actual final result |
| --- | --- |
| `npm.cmd exec -- vitest run --project web-components` | Exit 0: **46 passed in 2 files** |
| `npm.cmd run lint` | Exit 0: no errors or warnings |
| `npm.cmd run typecheck` | Exit 0: root and all workspaces |
| `npm.cmd test` | Exit 0: **380 passed in 16 files**, no failures/skips |
| `npm.cmd run build` | Exit 0: contracts, API, and frontend production builds; 209 frontend modules transformed |
| `git diff --check` | Exit 0: no whitespace errors; Git reports existing LF-to-CRLF normalization notices |
| `git status --short --untracked-files=all` | Exit 0: **10 modified tracked files and 12 new files**, all uncommitted, including the earlier 2C.2A work |

During development, two new assertions initially used jsdom's missing native `.inert` property. They now assert the actual rendered inert attribute; keyboard exclusion and disabled/submission behavior are separately exercised. No inert polyfill or simulated browser-support claim was introduced. Lint also identified a callback dependency, corrected with a stable useCallback and complete effect dependencies. The final sequence passed without generated-output collisions.

No PostgreSQL integration run was required or performed for these client-only changes. Existing check/build scripts generate ignored Prisma client artifacts without connecting to databases or applying migrations. Backend files, Prisma schema/migrations, database guards/tooling/configuration, contracts, transport/cookie code, browser coordination adapter, integration configuration, manifests/lockfile, and CI were not changed by this correction pass. No database data, fixtures, migration history, or production services were accessed.

## Remaining limits and review boundary

These results are deterministic unit/component evidence, not real-browser verification. jsdom does not implement native inert behavior fully. Browser keyboard/focus behavior, actual Web Locks and BroadcastChannel, BFCache/reload ordering, cookies, mobile layout, and assistive technology still require 2C.3/manual testing. Full form validation, password-manager support, credential feedback, complete form submission UX, workspace content, and logout UI remain 2C.2B work.

Cookie-changing operations still retain their locks if the underlying request stalls indefinitely. The approved eight-second indicator remains informational. Backend database query/lock deadlines remain a separate operational follow-up. Browser document crashes/reloads cannot prove that an already-committed server mutation rolled back.

No authentication mutations are replayed, no browser storage or credential logging was introduced, and no backend, database, migration, Playwright, CI, application CRUD, or deployment work occurred. No commit, push, or merge was made. Stop after the Stage 2C.2A corrections and await review.
