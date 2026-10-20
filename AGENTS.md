# ApplyFlow — Codex Development Instructions

## Project Overview

ApplyFlow is a full-stack job application management
platform for students, graduates, and job seekers.

The initial version is a personal job application tracker.
Advanced automation and AI will be added later.

## Technology Stack

- Frontend: React + Vite + TypeScript
- Styling: Tailwind CSS + shadcn/ui
- Backend: Express.js + TypeScript
- Database: PostgreSQL
- ORM: Prisma
- Validation: Zod
- Testing: Vitest, Supertest, Playwright
- CI/CD: GitHub Actions
- Background Jobs (later): Redis + BullMQ
- AI Integration (later): LLM API or Ollama

## Development Principles

1. Follow PRD.md for product requirements.
2. Follow DESIGN_SYSTEM.md for frontend design.
3. Use TypeScript strict mode.
4. Prefer maintainable, modular architecture.
5. Avoid unnecessary dependencies and abstractions.
6. Validate all external inputs.
7. Enforce authentication and authorization.
8. Write tests for important business logic.
9. Implement one feature at a time.

## Codex Workflow

1. Read the relevant documentation.
2. Inspect existing code.
3. Propose a plan before major changes.
4. Implement only the approved scope.
5. Run linting, type checking, and tests.
6. Review changes for bugs and security risks.
7. Explain significant implementation decisions.
8. Report any failures or unverified behavior.

## Restrictions

- Do not change the agreed stack without approval.
- Do not implement unrelated features.
- Do not commit secrets or credentials.
- Do not run destructive database commands
  without explicit approval.
- Do not push or deploy without approval.
- Do not weaken tests just to make them pass.

## Portfolio Goals

Demonstrate:

- Full-stack engineering
- REST API development
- Database design
- Security and authorization
- Automated testing
- CI/CD practices
- Responsive and accessible UI/UX
