# CLAUDE.md

Project facts and working rules for Claude agents in this repository. Update this file when a fact changes.

## 1. Project

- Arabic-first, mobile-first web platform for Egyptian pharmacy professionals.
- Market: Egypt only. Languages: Arabic (default) and English.
- Web first: responsive, installable as a PWA. Native apps come later (ADR-001, section 8).
- Decision record: [ADR-001](docs/architecture/decisions/ADR-001-initial-architecture.md), accepted 2026-10-20.
- Milestone 1 scope: registration, profiles, verification, organizations, jobs and applications, admin, staging. Shifts, listings and billing come later.

## 2. Stack (versions from package.json)

| Area                       | Choice                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Node                       | 24 (`.nvmrc`, used by CI). `engines` says `>=22.12`.                                                                                 |
| Package manager            | pnpm 10.28.0 (`packageManager`)                                                                                                      |
| Framework                  | Next.js 16.4.2, App Router, `output: "standalone"`. Request interception lives in `src/proxy.ts` (Next 16 replaces `middleware.ts`). |
| UI                         | React 19.3.1, Tailwind CSS 4.3.3, logical CSS properties only (no left/right)                                                        |
| Language                   | TypeScript 6.0.3, strict mode. Stay on 6 until typescript-eslint supports 7 (it currently requires <6.1).                            |
| i18n                       | next-intl 4.14.9, `localePrefix: "as-needed"`. Arabic (default) at `/`, English at `/en`.                                            |
| Database                   | PostgreSQL 18 (local image `postgres:18-alpine`)                                                                                     |
| ORM                        | Drizzle ORM 0.45.4, drizzle-kit 0.31.11, pg 8.23.1                                                                                   |
| Object storage             | S3 API via `@aws-sdk/client-s3` 3.1153.0. Local: MinIO, Bitnami legacy images, local only, no updates.                               |
| Local email                | Mailpit v1.31.6 (SMTP port 1025)                                                                                                     |
| Validation                 | Zod 4.6.7                                                                                                                            |
| Logging                    | pino 10.4.0                                                                                                                          |
| Unit and integration tests | Vitest 5.0.5, Testcontainers (`@testcontainers/postgresql` 12.2.1)                                                                   |
| End-to-end tests           | Playwright 1.64.1                                                                                                                    |
| Lint and format            | ESLint 10.13.0 (`eslint-config-next` 16.4.2), Prettier 3.9.10                                                                        |

Planned in ADR-001 but not yet in package.json: Better Auth, pg-boss, sharp.

## 3. Commands

| Command                 | What it does                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------- |
| `pnpm dev`              | Start the Next.js dev server (`next dev`)                                                          |
| `pnpm build`            | Production build (`next build`)                                                                    |
| `pnpm start`            | Serve the built app (`next start`). Not the production path: the config uses standalone output.    |
| `pnpm lint`             | ESLint over the repo                                                                               |
| `pnpm format`           | Prettier, write changes                                                                            |
| `pnpm format:check`     | Prettier, check only (CI)                                                                          |
| `pnpm typecheck`        | `next typegen` then `tsc --noEmit`                                                                 |
| `pnpm test`             | Vitest unit tests                                                                                  |
| `pnpm test:integration` | Vitest integration tests (`vitest.integration.config.mts`)                                         |
| `pnpm test:e2e`         | Playwright end-to-end tests                                                                        |
| `pnpm db:generate`      | Generate a Drizzle migration from schema changes                                                   |
| `pnpm db:migrate`       | Apply migrations (`src/shared/db/migrate.ts`, reads `.env` if present)                             |
| `pnpm services:up`      | Start local Postgres, MinIO and Mailpit, wait for health                                           |
| `pnpm services:down`    | Stop local services                                                                                |
| `pnpm bootstrap`        | Local setup: create `.env` from `.env.example` if missing, start services, migrate, run `next dev` |

One-command local start, after a fresh clone: `pnpm install && pnpm bootstrap`. Docker must be running.

| Local service | Address                                            |
| ------------- | -------------------------------------------------- |
| App           | http://localhost:3000 (`APP_URL`)                  |
| Mailpit UI    | http://localhost:8025                              |
| MinIO console | http://localhost:9001 (S3 API on port 9000)        |
| PostgreSQL    | localhost:5432                                     |
| Health        | `/api/health` (liveness), `/api/ready` (readiness) |

## 4. Local notes

- `.env` is git-ignored. `.env.example` holds local-only placeholders. Never put real credentials in any committed file.
- `AGENTS.md` (repo root) warns that this Next.js version has breaking changes. Read the relevant guide in `node_modules/next/dist/docs/` before writing Next code. `next dev` regenerates it, so it is committed on purpose.
- `playwright.config.ts` takes the Chromium executable path from `PW_CHROMIUM_PATH`. In the Claude cloud sandbox use `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` and never run `playwright install`; CI installs its own Chromium.
- In the Claude cloud sandbox the Docker daemon may not be running; start it with `dockerd &` before `pnpm bootstrap` or integration tests.
- `docker compose up --wait` treats the one-shot `minio-init` exit as success only because `mailpit` depends on it; keep that dependency.
- CI (`.github/workflows/ci.yml`): `checks` (lint, format check, typecheck, unit tests, build), `integration`, `security` (`pnpm audit --prod --audit-level high`, gitleaks), and `e2e` on pushes to `main` only.

## 5. Layout and module rules

- Pages and routes stay thin. They call module services and never query the database.
- Each module in `src/modules/` owns its tables and exposes services. Other modules call those services, never the tables.
- Every server action and route checks authorization through the module's policy, `can(actor, action, resource)`. Hiding a button is not authorization.
- Modules: identity, profiles, verification, organizations, jobs, notifications, admin (milestone 1); shifts (2); listings, billing (3). Directories appear when a module gets its first real code.

## 6. Targets

| Target                                     | Value              |
| ------------------------------------------ | ------------------ |
| Registered users, year one                 | 50,000             |
| Availability                               | 99.5 % monthly     |
| p95 response, core pages and APIs          | under 300 ms       |
| Recovery point / recovery time (RPO / RTO) | 1 h / 4 h          |
| Security baseline                          | OWASP ASVS Level 2 |

## 7. Decisions in force

- Registration: email with verification, any provider including Gmail. No phone OTP at launch, so no SMS provider.
- Hosting provider and region: OPEN. Decide with Egyptian data-protection counsel before any real user signs up. Options are in ADR-001, section 4. Record the choice in a new ADR.
- Data-protection counsel: engage now. The PDPL grace period is reported to end around 31 October 2026.
- Development and staging use synthetic data only.
- Never claim regulatory compliance without qualified Egyptian legal review.

## 8. Milestone 1 build order

1. Foundation, 2. Identity, 3. Profiles, 4. Verification, 5. Organizations, 6. Jobs and applications, 7. Admin, 8. Staging.

Each step ends with passing tests and a PR reviewed by the product owner. The next step starts only after that review.

## 9. Ground rules

- Use the `pharma-platform-architect` skill (`.claude/skills/pharma-platform-architect/`). Read its reference file for an area before changing that area.
- Plan first. Schema, auth, roles, verification, payments, file storage, data deletion and anything touching production need a detailed plan and the product owner's approval before implementation.
- Nothing counts as working until it is tested. Report only the commands you actually ran, with their results.
- Check `git status` before editing. Never overwrite or discard uncommitted changes.
- No real personal data outside production.
- No production deploy without explicit approval.
- Never log personal data. The logger (`src/shared/logging/logger.ts`) redacts `password`, `token`, `otp`, `nationalId`, `email`, `phone`, and authorization and cookie headers. Redaction is a backstop, not permission to log these fields.

## 10. Model selection for Claude agents

| Work                                                                                                                        | Model  |
| --------------------------------------------------------------------------------------------------------------------------- | ------ |
| Lookups, docs, simple text                                                                                                  | Haiku  |
| Routine, well-specified implementation: scaffolding, config, CI, UI, helpers and their tests                                | Sonnet |
| High-risk work: schema, auth, roles, verification, file storage, payments, security. Also review of every diff before a PR. | Opus   |
