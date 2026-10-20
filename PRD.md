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

### 2. Application Management

- Create job applications
- Edit application information
- Archive or delete applications
- View application details

Application fields:

- Company name
- Job title
- Job URL (optional)
- Location (optional)
- Employment type (optional)
- Salary information (optional)
- Application date
- Current status
- Notes

### 3. Application Status

- Saved
- Applied
- Assessment
- Interview
- Offer
- Rejected
- Withdrawn

### 4. Dashboard

- Application overview
- Kanban board
- Search and filtering
- Recent activities
- Basic job search analytics

### 5. Activity History

- Record important application events
- Track status changes
- Display chronological history

## Non-Functional Requirements

- Responsive UI
- Accessible components
- Secure authentication
- User-specific data ownership
- Server-side input validation
- Automated unit and API tests
- Playwright E2E testing
- CI/CD integration

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
- Application history persists correctly.
- Dashboard displays accurate information.
- Critical workflows pass automated tests.
