# ApplyFlow — Product Requirements Document

## Product Summary

ApplyFlow is a personal job application management
platform that helps users organize their job search
and monitor recruitment progress.

## Target Users

- Fresh graduates
- Students
- Active job applicants
- Career changers

## MVP Features

### 1. Authentication

- Register
- Login
- Logout
- Protected routes
- Secure user sessions

Registration requires explicit local/test enablement. Public production
registration remains disabled pending email verification, password recovery and
abuse protections. Email verification and password recovery are not implemented.

### 2. Application Management

- Create job applications
- Edit application information
- Archive and restore applications
- Permanently delete applications and their associated history
- View application details

Archive hides an application from default views and analytics without permanently
deleting it. Restore returns it to active views with its existing status preserved.
Archive, restore and permanent deletion are implemented. Archived applications
remain available in an explicit Archived view and must be restored before editing.
Permanent deletion requires explicit confirmation, applies only to archived
applications and removes their associated status history.

Application fields (supported unless marked as remaining work):

- Company name (required)
- Job title (required)
- Job URL (optional)
- Location (optional)
- Employment type (optional; remaining MVP work)
- Salary information (optional; remaining MVP work)
- Application date (optional for Saved; required for every other status)
- Current status (required; defaults to Saved on creation)
- Notes (optional)

Supplied application dates must be valid calendar dates and cannot be in the
future in the configured application timezone. Returning to Saved preserves the
existing date unless the user explicitly clears it. Duplicate company/title
applications are allowed.

Users can view and edit only their own applications. Stale edits must produce a
conflict instead of overwriting newer changes. Recovery retains the draft;
uncertain saves are never automatically resubmitted. Unsaved edits require
confirmation before being discarded during in-app navigation or sign-out.

### 3. Application Status

- Saved
- Applied
- Assessment
- Interview
- Offer
- Rejected
- Withdrawn

Any status may transition to any other status, subject to the date rules above.
There is no mandatory sequence or terminal status. Rejected and Withdrawn are
application statuses, not archival or deletion operations.

### 4. Dashboard

- Application overview
- Kanban board
- Search and filtering
- Recent activities
- Basic job search analytics

Server-side company/title search and single-status filtering are implemented in
the application workspace. Search matches a case-insensitive substring and can be
combined with a status in either Active or Archived, with independent filters for
each view. Search/Enter applies draft criteria; Clear filters restores the
unfiltered view. Filters are not persisted across reloads or synchronized to URLs.
The overview, Kanban board, recent activities and basic analytics remain MVP work;
the current application list does not constitute the completed dashboard.

### 5. Activity History

- Record every actual status transition with its previous status, new status and
  recorded time, saved atomically with the application change.
- Display per-application history newest first, with access to older entries.
- Non-status edits and unchanged statuses create no history entry. Creation and
  existing records receive no synthetic history or historical backfill.
- Record important application events beyond status transitions: retained as an
  MVP requirement, with broader activity-history scope pending clarification.

## Delivery Status Through Stage 3E.4

| Area | Status |
| --- | --- |
| Authentication | Implemented: controlled local registration, login/logout, protected workspace and secure sessions. Public production registration remains disabled. |
| Application management | Implemented: creation, listing with Load more, details, editing, archive/restore, confirmed permanent deletion and version-conflict handling for the supported fields above. Employment type and salary remain MVP work. |
| Status history | Implemented: actual status transitions and per-application history with older-entry loading. General activity history is not complete. |
| Search and filtering | Implemented: server-side company/title substring search, one optional status, combined filters and independent Active/Archived criteria with pagination. |
| Dashboard | Overview, Kanban, recent activities and basic analytics remain MVP work. |

Detailed evidence is recorded in the [Stage 3B.2 acceptance report](docs/milestones/checkpoint-3b2-acceptance-report.md),
[Stage 3C.3 offline report](docs/milestones/checkpoint-3c3-offline-report.md),
[Stage 3C.4 manual browser acceptance report](docs/milestones/checkpoint-3c4-manual-browser-acceptance-report.md),
[Stage 3D.4 lifecycle acceptance report](docs/milestones/checkpoint-3d4-manual-browser-acceptance-report.md) and
[Stage 3E.4 search/filter acceptance report](docs/milestones/checkpoint-3e4-manual-browser-acceptance-report.md).
Full Review saved application conflict recovery and history pagination beyond 20
entries remain manually unverified, without observed blocking defects. The
documented unknown-history-entry navigation fallback limitation remains.
Archived and filtered pagination beyond 20 matching results, forced follow-up
refresh failures, deterministic request races and cross-account replacement remain
manually unverified. Owner isolation has PostgreSQL integration evidence, not
manual cross-account browser evidence. Full uncertain-operation recovery,
exhaustive accessibility and production-scale search performance remain unverified.
Manual acceptance does not establish automated browser coverage or production readiness.

## Non-Functional Requirements

- Responsive UI
- Accessible components
- Secure authentication
- User-specific data ownership
- Server-side input validation
- Automated unit and API tests
- Playwright E2E testing
- CI/CD integration

These remain requirements; milestone acceptance does not declare all verification
complete. Automated browser and CI/CD execution evidence must be distinguished
from offline tests and user-reported manual checks.

## Future Features

- Recruitment email integration
- Automatic status detection
- AI email classification
- Follow-up reminders
- Calendar integration
- Advanced analytics
- Real-time updates

## MVP Non-Goals

- Automatic job applications
- Job board scraping
- Automatic recruiter messaging
- Resume generation
- Multi-user collaboration

## Success Criteria

- Users can securely manage job applications.
- Users cannot access other users' data.
- Stale edits cannot silently overwrite newer saved changes.
- Application history persists correctly.
- Every actual status transition is recorded once; non-status edits add no event.
- Dashboard displays accurate information.
- Critical workflows pass automated tests.
