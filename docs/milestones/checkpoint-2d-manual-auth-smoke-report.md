# Stage 2D - Manual authentication smoke test report

## Result and evidence boundary

**Stage 2D: PASSED. Stage 2 final release verification: DEFERRED.**

The user completed the first manual authentication smoke test in the running
development application and confirmed all four results below. This report records
those observations; the assistant did not operate the browser, rerun the test,
inspect network traffic or connect to PostgreSQL during this documentation turn.

The manual PASS establishes the reported normal browser flows. It does not
establish complete authentication security, accessibility, automated browser
coverage or production deployment readiness.

## Repository and environment

Independently inspected before creating this report:

| Item | Result |
| --- | --- |
| Branch | `feat/authentication` |
| HEAD | `60373d168ecf8a07b705608e7c966501ceaa27c5` |
| Working tree | Clean |
| Staging area | Empty |

User-reported database targets:

- Development: `127.0.0.1:15432/applyflow_dev`.
- Test: `127.0.0.1:5433/applyflow_test`.

The user-confirmed database verification command was:

```powershell
npm.cmd run db:verify
```

The user supplied these sanitized verification records:

```json
{"target":"development","host":"127.0.0.1","port":"15432","database":"applyflow_dev","username":"applyflow_dev","tables":["Session","User","_prisma_migrations"]}
{"target":"test","host":"127.0.0.1","port":"5433","database":"applyflow_test","username":"applyflow_test","tables":["Session","User","_prisma_migrations"]}
```

These are user-provided terminal evidence of the expected database identities and
authentication tables. The assistant did not rerun the command, access PostgreSQL
or perform a separate database verification during either documentation turn.

Browser/version, detailed runtime environment, execution timestamp, database logs,
query results, HTTP traces and process exit statuses were not independently
captured here. The earlier [C1C report](checkpoint-2c3b3c1c-live-prisma-report.md)
remains separate historical evidence for the read-only Prisma inspection.

## Four user-confirmed browser results

| Check | User-observed behavior | Result |
| --- | --- | --- |
| Registration | Registration succeeded, redirected to `/app`, displayed the correct email and showed no errors. | **PASS** |
| Sign out and sign back in | Signing out redirected away from `/app`. Signing in again with the same account succeeded and displayed the correct email. | **PASS** |
| Session persistence after refresh | Refreshing `/app` preserved authentication, displayed the same email and produced no authentication errors. | **PASS** |
| Protected route after logout | After signing out, manually revisiting `/app` redirected to `/login`, hid account information and produced no errors. | **PASS** |

These are browser-observed outcomes supplied by the user. Actual registration,
login, session-verification and logout HTTP status codes were not independently
captured. No expected status code is substituted for an observed network result.
Likewise, hidden account information and redirects alone are not proof of every
server-side revocation, authorization or concurrency invariant.

## Persistent development data

Registration created a **persistent development account**. Its email, password,
password hash, cookies, raw session tokens and CSRF values are intentionally absent
from this report. Logout revokes the current session; it does not delete the User
record. Authentication bootstrap may also leave anonymous session records; their
exact counts and subsequent expiry were not inspected here.

There is **no approved manual account-cleanup procedure available**. The account
must be treated as retained development data. No deletion, direct SQL cleanup,
reset, fixture cleanup or account removal is authorized by this report.

## Disabled fixture and cleanup execution

Read-only source inspection confirms:

- `fixture-cycle.ts` still returns a fixed disabled outcome.
- The direct `fixture-child.ts` entry remains disabled.
- Exported `installedFixtureDriver()` still rejects installed activation.
- General fixture/browser E2E runtime gates remain closed; no live harness cleanup
  command or cleanup authority was activated.

This manual application test did not activate or validate the B3C2 fixture-cycle,
ownership-finalization or exact-cleanup workflow. Normal application logout is
separate from harness fixture cleanup. Earlier normal-runtime expired-session
maintenance is also separate from an approved account-cleanup procedure.

## Remaining verification and release requirements

| Area | What this smoke test did not establish |
| --- | --- |
| Automated browser regression | Repeatable guarded registration, login, refresh, logout, protected navigation/history, mobile behavior and failure scenarios. Existing offline harness work is not completed live browser coverage. |
| Session and authentication security | Exact idle/absolute expiry boundaries, rotation/fixation resistance, CSRF/Origin enforcement, malicious inputs, rate limits/cooldowns, device isolation, concurrent replacement, ambiguous mutations, interrupted requests and late-response behavior. Retain existing tests and complete the final targeted verification; this smoke adds no new evidence for those cases. |
| Accessibility | Full keyboard workflow, focus/error announcements, screen-reader behavior, password-manager interactions, native inert controls, reduced motion and narrow/mobile layout. No accessibility conformance claim is made. |
| Production HTTPS and cookies | Real HTTPS Secure/`__Host-` cookie behavior, trusted-origin/proxy configuration, TLS/database configuration and deployment-specific security checks. Development success does not establish these. Production public registration restrictions remain unchanged. |
| Database and integration | Fresh release verification of existing guarded PostgreSQL integration tests and relevant CI, actual write-failure/rollback/concurrency behavior, and any separately approved fixture ownership/cleanup, FK/cascade or interrupted-run work. Prior test reports remain historical evidence; no suite was rerun here. |
| Final release verification | Verify the final accepted commit with required lint, typecheck, tests, integration/browser checks as approved, production build and applicable hosted CI. Resolve or explicitly track remaining operational limitations before claiming Stage 2 release completion. |

Existing backend/frontend tests are not being declared absent or invalid. Their
results were not revalidated in this documentation turn. Stage 2D can pass while
these broader Stage 2 final release checks remain deferred. This report does not
authorize later infrastructure work, production deployment or Stage 3 implementation.

## Documentation checks and final Git inventory

Only AGENTS/source/report/manifest reads, read-only Git inspection, this report
creation and local content/whitespace checks were performed. No tests, builds or
live verification commands were run during this turn.

Checks cover all four PASS rows, the evidence qualification, persistent-account
consequences, disabled gates, remaining verification and explicit deferred release
status. A separate content/whitespace check covers this untracked file because
ordinary `git diff --check` does not inspect untracked report contents.

Final Git inventory:

```text
?? docs/milestones/checkpoint-2d-manual-auth-smoke-report.md
```

Branch and HEAD unchanged. No existing tracked file modified; staging area empty.
Report content/whitespace checks and `git diff --check` passed. Nothing was staged,
committed, pushed, merged or deployed.

No service was started or stopped, no database was accessed, no records were
created/deleted by the assistant, and no browser, preflight, fixture command,
migration, cleanup, dependency install, application/test/script/guard/schema/CI
change or Stage 3 implementation occurred during this documentation turn.
