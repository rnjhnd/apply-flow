# Stage 3C.4 - Manual browser acceptance report

## Result and evidence boundary

Stage 3C.4 manual browser acceptance is complete, with the nonblocking verification
limits below. Browser outcomes are user-reported observations from the development
environment. This documentation pass did not repeat browser checks, execute tests,
or access a database. No automated browser execution is claimed.

Repository baseline verified for this report: branch `feat/job-applications`, HEAD
`9d492bbdb47ce82229220dc1493c9c219206b776`, initially clean working tree.

## Development login and environment correction

The initial login failure occurred while the running API was connected to port
`5433`, rather than the intended development endpoint. The earlier read-only
investigation observed that runtime connection; it did not establish the running
process's exact inherited environment values.

The user subsequently confirmed successful login after explicitly setting
`NODE_ENV=development` and verifying the API connection to
`127.0.0.1:15432/applyflow_dev` as `applyflow_dev`. This resolves the observed
endpoint mismatch; it is not evidence of a password or migration defect.

## Verified manual observations

| Check | Observed result |
| --- | --- |
| Development login | Passed after the API database connection correction. |
| Notes persistence | Saved Notes edits remained after refresh. |
| Status transition | Applied to Interview created a status-history entry. |
| Non-status edit | Notes-only edits created no additional status-history entries. |
| Concurrent editing | Editing the same application in two tabs produced a stale-version conflict in the second tab. |
| Conflict options | Review saved application and Discard draft recovery options were displayed. Full review recovery was not verified. |
| Dirty-draft protection | Switching applications, Back/Forward navigation and attempted sign-out protected unsaved changes. |
| Skip to content | Preserved the draft without prompting. |
| Confirmed discard | Closed the editor; reopening showed the previously saved application values. |
| Cancelled navigation | Preserved the draft and expected workspace state. |
| Mobile viewport | User reported passing mobile viewport testing; dimensions were not recorded. |

## Remaining manual verification limits

- The complete **Review saved application** conflict-recovery behavior was not
  explicitly verified. Observing its option does not establish that recovery path.
- **History pagination beyond 20 entries** was not exercised in the browser.

These are unverified manual paths, not observed blocking defects. The confirmed
discard observation above does not establish every conflict-recovery interaction.
The checks do not establish exhaustive accessibility or browser coverage. The
unknown-history-entry fallback limitation documented in the
[Stage 3C.3 report](checkpoint-3c3-offline-report.md) remains: cancellation can
preserve the draft and accepted URL without preserving the exact history slot or
stack. The manual navigation results do not establish every foreign-entry,
rapid-traversal or back-forward-cache edge case.

## Previously recorded automated evidence

The prior Stage 3C.2 PostgreSQL integration run passed 11/11 tests, as recorded in
the earlier execution and post-test verification evidence. This is separate from
the browser observations above; no integration suite was rerun for this report.

The [Stage 3C.3 offline report](checkpoint-3c3-offline-report.md) records the final
131/131 focused frontend tests, 1,708/1,708 offline regression tests, and passing
lint, typecheck and build. Mocked controller/component checks and jsdom navigation
coverage do not substitute for the two unverified manual paths above.

This change records acceptance evidence only. Application source, tests,
migrations and database records were not changed; no migration, seed or cleanup
was performed. No further implementation or database operation is authorized by
this report.
