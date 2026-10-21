# CLAUDE.md

Project facts and working rules for Claude agents in this repository. Update this file when a fact changes.

## 1. Project

- Arabic-first, mobile-first web platform for Egyptian pharmacy professionals.
- Market: Egypt only. Languages: Arabic (default) and English.
- Web first: responsive, installable as a PWA. Native apps come later (ADR-001, section 8).
- Decision records: [ADR-001](docs/architecture/decisions/ADR-001-initial-architecture.md) (architecture), [ADR-002](docs/architecture/decisions/ADR-002-identity-and-access.md) (identity), [ADR-003](docs/architecture/decisions/ADR-003-profiles.md) (profiles), [ADR-004](docs/architecture/decisions/ADR-004-verification-and-private-documents.md) (verification and private documents; 4a worker and uploads, 4b verification workflow, 4c legal name on the submission, all built), all accepted 2026-10-20.
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
| Authentication             | Better Auth 1.7.11 (Drizzle adapter, two-factor, haveibeenpwned and next-cookies plugins), `src/modules/identity/` (ADR-002)         |
| Email                      | nodemailer 10.1.7 (ships its own types) behind `EmailSender` in `src/shared/email/`                                                  |
| Logging                    | pino 10.4.0                                                                                                                          |
| Background jobs            | pg-boss 12.38.0 (own `pgboss` schema), worker process in `worker/` run with tsx (ADR-004)                                            |
| Images                     | sharp 0.35.5 (worker only: re-encode, strip metadata)                                                                                |
| Malware scanning           | clamd (`clamav/clamav:1.5.4` locally) via the INSTREAM client in `src/shared/av/clamd.ts`                                            |
| Unit and integration tests | Vitest 5.0.5, Testcontainers (`@testcontainers/postgresql` 12.2.1)                                                                   |
| End-to-end tests           | Playwright 1.64.1                                                                                                                    |
| Lint and format            | ESLint 10.13.0 (`eslint-config-next` 16.4.2), Prettier 3.9.10                                                                        |

Presigned URLs: `@aws-sdk/s3-request-presigner` 3.1153.0 (same version as the S3 client).

## 3. Commands

| Command                                 | What it does                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `pnpm dev`                              | Start the Next.js dev server (`next dev`)                                                                                |
| `pnpm build`                            | Production build (`next build`)                                                                                          |
| `pnpm start`                            | Serve the built app (`next start`). Not the production path: the config uses standalone output.                          |
| `pnpm lint`                             | ESLint over the repo                                                                                                     |
| `pnpm format`                           | Prettier, write changes                                                                                                  |
| `pnpm format:check`                     | Prettier, check only (CI)                                                                                                |
| `pnpm typecheck`                        | `next typegen` then `tsc --noEmit`                                                                                       |
| `pnpm test`                             | Vitest unit tests                                                                                                        |
| `pnpm test:integration`                 | Vitest integration tests (`vitest.integration.config.mts`)                                                               |
| `pnpm test:e2e`                         | Playwright end-to-end tests                                                                                              |
| `pnpm db:generate`                      | Generate a Drizzle migration from schema changes                                                                         |
| `pnpm db:migrate`                       | Apply migrations (`src/shared/db/migrate.ts`, reads `.env` if present), then install/upgrade pg-boss's schema and queues |
| `pnpm worker`                           | Background worker (`worker/index.ts` via tsx): runs the job queues; stops gracefully on SIGTERM                          |
| `pnpm worker:dev`                       | Same, restarting on file changes (`tsx watch`)                                                                           |
| `pnpm worker:health [--this-host]`      | Exit 0 if a live worker serves the upload queue (pg-boss instance registry), else 1                                      |
| `pnpm admin:grant-role <email> <role>`  | Operator CLI: grant a staff role (user must exist and be verified); revokes the user's sessions                          |
| `pnpm admin:revoke-role <email> <role>` | Operator CLI: revoke a staff role; revokes the user's sessions                                                           |
| `pnpm services:up`                      | Start local Postgres, MinIO, Mailpit and ClamAV, wait for health                                                         |
| `pnpm services:down`                    | Stop local services                                                                                                      |
| `pnpm bootstrap`                        | Local setup: create `.env` from `.env.example` if missing, start services, migrate, run `next dev`                       |

One-command local start, after a fresh clone: `pnpm install && pnpm bootstrap`. Docker must be running.

| Local service  | Address                                            |
| -------------- | -------------------------------------------------- |
| App            | http://localhost:3000 (`APP_URL`)                  |
| Mailpit UI     | http://localhost:8025                              |
| MinIO console  | http://localhost:9001 (S3 API on port 9000)        |
| PostgreSQL     | localhost:5432                                     |
| ClamAV (clamd) | localhost:3310 (about 1-1.5 GB memory)             |
| Health         | `/api/health` (liveness), `/api/ready` (readiness) |

## 4. Local notes

- `.env` is git-ignored. `.env.example` holds local-only placeholders. Never put real credentials in any committed file.
- Environment variables (validated in `src/shared/config/env.ts`): `DATABASE_URL`, `S3_*`, `SMTP_HOST`, `SMTP_PORT`, `LOG_LEVEL`, `APP_URL` (public origin; Better Auth's base URL is `APP_URL` + `/api/auth`, and email links use it), `BETTER_AUTH_SECRET` (min 32 chars; signs sessions and tokens, encrypts TOTP secrets, keys limiter hashes), `EMAIL_FROM`, `AUTH_BREACHED_PASSWORD_CHECK` (Have I Been Pwned check; defaults to `true`, `false` in `.env.example` and tests so they need no network). The worker also needs `CLAMAV_HOST` and `CLAMAV_PORT` (`parseWorkerEnv`); the web app does not.
- Uploads (ADR-004, 4a): `POST /api/uploads` (multipart: one `file` and `purpose=verification_document`; signed in, verified email, same origin) answers 202 `{id, status}`; `GET /api/uploads/<id>` gives the owner `{id, status, rejectReason}` (404 for anyone else). Limits: 8 MiB, JPEG/PNG/WebP detected by magic bytes, 20 attempts per user per hour, 10 uploads in `processing` per user. Files wait under `quarantine/` in the private bucket until the worker's `upload.process` job scans them with clamd, re-encodes them to JPEG (max 2,400 px, no metadata) under `documents/` and marks them `clean`; otherwise `rejected` (`infected`, `undecodable`, `processing_failed`). Without a running worker, uploads stay `processing`; locally run `pnpm worker` in a second terminal (`pnpm bootstrap` starts only the web app). Clean files are viewed only through `issueSignedUrl` (5-minute presigned GET, caller-supplied authorizer); the only view route is the reviewer's `/api/verification/documents/<id>` (below).
- Jobs: queues and payload schemas are declared in `src/shared/jobs/registry.ts`; `enqueue(boss, name, payload, { tx })` creates the job in the caller's Drizzle transaction. Failed jobs retry with backoff, then go to the queue's dead-letter queue (`upload.process.dead` marks the upload `processing_failed`). `/api/ready` does not check the worker (web readiness must not depend on it); use `pnpm worker:health`.
- Production needs, besides the web app: the worker process (`pnpm worker` or the same image with that command) with `pnpm worker:health --this-host` as its health check; a clamd service with freshclam on (about 1.5 GB memory); versioning on the private bucket; a lifecycle rule expiring `quarantine/` objects after a day (orphans from crashes); and an S3 endpoint the browser can reach, because presigned URLs use `S3_ENDPOINT`.
- Verification (ADR-004, 4b): `/verification` is the user's page (status card; request form when unverified, rejected or expired: credential type, legal name in Arabic as on the national ID (normalized, at least three words, immutable, reviewer-only), national ID, syndicate number or university, optional card expiry, three photos through `POST /api/uploads`, consent placeholder). `/staff/verification` is the reviewer queue (pending, oldest first, legal names, masked IDs) and `/staff/verification/<id>` one submission: reveal the national ID (logged), photos through `GET /api/verification/documents/<id>` (logs a `view` in `document_access_log`, then 303 to a 5-minute signed URL; `no-store`, `no-referrer`; 404 to anyone but a reviewer on a pending submission), approve or reject with a reason code and an internal note. Reviewers need role `verification_reviewer`, TOTP and a TOTP session, and never see their own submission. Profiles show the verified badge only when the latest submission is `verified`; the data export includes verification status, legal name and masked ID. The worker sends the received/verified/rejected emails (`verification.notify`) and runs `verification.expire` daily at 00:17 Africa/Cairo (pg-boss schedule registered at worker start). Local reviewer: sign up, verify the email, turn on TOTP on `/account`, `pnpm admin:grant-role you@example.test verification_reviewer`, sign in again with the code; submit as another user (with `pnpm worker` running so photos become clean).
- National ID keys (web app only, loaded where used, fail fast with the variable name): `NATIONAL_ID_ENCRYPTION_KEY` (AES-256-GCM, 32 bytes base64), `NATIONAL_ID_HASH_KEY` (HMAC-SHA256 for the uniqueness check, 32 bytes base64, must differ), optional `NATIONAL_ID_ENCRYPTION_PREVIOUS_KEYS` (comma-separated, decrypt-only during rotation). `.env.example` has repeated-byte placeholders that are refused unless `APP_URL` is localhost. Production: generate with `openssl rand -base64 32` into the host's secret store, back them up separately from the database (losing the encryption key loses every stored national ID), never change the hash key without re-hashing every row. The image CSP (`img-src`) includes the origin of `S3_ENDPOINT` so reviewers' browsers can load signed URLs.
- Profiles (ADR-003): `/profile` is the owner's edit page, `/profiles/<id>` the member view (signed-in members only; hidden or missing profiles both answer 404). `/api/account/export` (GET, signed in) returns the caller's data as a JSON attachment. Migration `0002_profiles` seeds the 27 governorates.
- Staff roles: `support`, `moderator`, `verification_reviewer`, `billing`, `super_admin`. First super admin locally: sign up in the app, open the link from Mailpit (http://localhost:8025), sign in, turn on two-step verification on `/account`, then run `pnpm admin:grant-role you@example.test super_admin` and sign in again with the TOTP code. `/staff` needs a staff role, TOTP enabled and a session that passed TOTP.
- Rate limits use the client IP from `X-Forwarded-For`. Next passes a client-supplied value through, so production must run behind a proxy that overwrites that header (or set Better Auth `advanced.ipAddress` for the chosen host). Per-email limits apply regardless.
- Integration tests start their own Postgres, MinIO and clamd with Testcontainers (`tests/integration/helpers/`); the EICAR test file is assembled at runtime. E2E does not run the worker or clamd: `e2e/uploads.spec.ts` covers the upload API, and `e2e/verification.spec.ts` runs the worker's own code in the test process through `e2e/worker-helpers.ts` (stub scanner, processes only the test's uploads, sends queued verification emails to Mailpit).
- E2E tests need the local services and migrations (`pnpm services:up && pnpm db:migrate`); `e2e/global-setup.ts` clears the local `rate_limit` table first because every request comes from 127.0.0.1. `e2e/profiles.spec.ts` sends its own `X-Forwarded-For` address per browser context so it does not share the 127.0.0.1 sign-up budget with `e2e/identity.spec.ts`. Shared journey steps live in `e2e/helpers.ts`.
- `AGENTS.md` (repo root) warns that this Next.js version has breaking changes. Read the relevant guide in `node_modules/next/dist/docs/` before writing Next code. `next dev` regenerates it, so it is committed on purpose.
- `playwright.config.ts` takes the Chromium executable path from `PW_CHROMIUM_PATH`. In the Claude cloud sandbox use `PW_CHROMIUM_PATH=/opt/pw-browsers/chromium-1194/chrome-linux/chrome` and never run `playwright install`; CI installs its own Chromium.
- In the Claude cloud sandbox the Docker daemon may not be running; start it with `dockerd &` before `pnpm bootstrap` or integration tests.
- `docker compose up --wait` treats the one-shot `minio-init` exit as success only because `mailpit` depends on it; keep that dependency. On a cold start `minio-init` can fail once because MinIO's health check passes during its own setup restart; rerun `pnpm services:up`.
- CI (`.github/workflows/ci.yml`): `checks` (lint, format check, typecheck, unit tests, build), `integration`, `security` (`pnpm audit --prod --audit-level high`, gitleaks), and `e2e` on every PR and push to `main` (starts the compose services except ClamAV and migrates first).

## 5. Layout and module rules

- Pages and routes stay thin. They call module services and never query the database.
- Each module in `src/modules/` owns its tables and exposes services. Other modules call those services, never the tables.
- Every server action and route checks authorization through the module's policy, `can(actor, action, resource)`. Hiding a button is not authorization.
- Modules: identity, profiles, verification, organizations, jobs, notifications, admin (milestone 1); shifts (2); listings, billing (3). Directories appear when a module gets its first real code; `identity` (ADR-002), `profiles` (ADR-003), `uploads` (ADR-004, private files for verification and later modules) and `verification` (ADR-004, 4b) exist so far.
- A module that needs another module's data calls that module's service (e.g. profiles' data export calls `identity/export.ts` and `verification/service.ts`); foreign keys to `user`, and `verification_document.upload_id` to `upload` (integrity only: verification reads uploads through the uploads service), are the only cross-module table references.

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

Each step ends with passing tests, an Opus review of the diff, and a merged PR. The next step starts after the merge.

## 9. Ground rules

- Use the `pharma-platform-architect` skill (`.claude/skills/pharma-platform-architect/`). Read its reference file for an area before changing that area.
- Plan first. Schema, auth, roles, verification, payments, file storage and data deletion get a detailed plan recorded as an ADR before implementation (see section 11).
- Nothing counts as working until it is tested. Report only the commands you actually ran, with their results.
- Check `git status` before editing. Never overwrite or discard uncommitted changes.
- No real personal data outside production.
- No production deploy without explicit approval.
- Never log personal data. The logger (`src/shared/logging/logger.ts`) redacts `password`, `token`, `otp`, `nationalId`, `legalName`, `legalNameAr`, `email`, `phone`, and authorization and cookie headers. Redaction is a backstop, not permission to log these fields.

## 10. Model selection for Claude agents

| Work                                                                                                                        | Model  |
| --------------------------------------------------------------------------------------------------------------------------- | ------ |
| Lookups, docs, simple text                                                                                                  | Haiku  |
| Routine, well-specified implementation: scaffolding, config, CI, UI, helpers and their tests                                | Sonnet |
| High-risk work: schema, auth, roles, verification, file storage, payments, security. Also review of every diff before a PR. | Opus   |

## 11. Governance (set by the product owner, 2026-10-20)

Claude leads and manages the project with delegated authority:

- Claude decides architecture and high-risk designs, records them in an ADR, and informs the product owner. The product owner may object at any time.
- Claude merges its own PRs into `main` once CI is green and the Opus review is done.
- Claude reports progress to the product owner at the end of each step: what shipped, decisions made, risks, and anything needed from them.

Still reserved for the product owner (explicit approval every time):

- Any production deploy, production migration or production data operation.
- Spending money, opening paid accounts, signing contracts (hosting, email, SMS, payments).
- Legal matters: counsel, privacy policy and terms, PDPC licences, compliance statements.
- Creating credentials only they can create (Google OAuth client, provider accounts, domain).
- Anything involving real users' personal data.
