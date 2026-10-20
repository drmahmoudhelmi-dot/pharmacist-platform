# ADR-001: Initial architecture

- Status: Accepted
- Date: 2026-10-16 (proposed), 2026-10-20 (accepted)
- Deciders: product owner (Dr. Mahmoud Helmi), principal engineer

## Summary

Build a single TypeScript modular monolith: Next.js web app and a background worker from one codebase, PostgreSQL, S3-compatible private object storage, packaged as containers so the hosting provider and region can change without a rewrite. The product serves Egypt only. The production hosting provider and region are still open (section 4) and must be decided, with counsel's review, before real users' data is stored. The first milestone delivers registration, professional verification, jobs and applications, and the admin verification queue — nothing else.

## 1. Context

- New product, empty repository, small team, limited operating budget.
- Users: Egyptian pharmacists, students, pharmacy owners and chains. Mostly mobile, Arabic-first.
- Sensitive data from day one: national ID numbers, syndicate cards, CVs.
- Egypt's Personal Data Protection Law (151/2020) executive regulations were issued 1 November 2025; sources place the end of the grace period around 31 October 2026. Transfers of personal data outside Egypt, including to foreign cloud regions, require a licence or permit from the Personal Data Protection Centre (PDPC), with a registered DPO as a prerequisite. This must be confirmed by Egyptian counsel.
- None of AWS, Azure, Google Cloud or Oracle is confirmed to operate a public cloud region in Egypt. Huawei Cloud has operated a Cairo region since 2024; local providers and telcos offer data centres and private cloud.
- Starting targets (SKILL.md section 5): 50k users in year one, 99.5 % availability, p95 < 300 ms, RPO 1 h / RTO 4 h, OWASP ASVS Level 2.

## 2. Decision

### Application

| Concern | Choice | Reason |
|---|---|---|
| Language | TypeScript, strict mode | One language front to back; types across the server boundary |
| Web framework | Next.js (App Router), server-rendered, `output: "standalone"` | Fast mobile first paint via SSR, server actions keep logic on the server, runs in any container host (no Vercel dependency) |
| Validation | Zod schemas shared by forms and server; server is authoritative | Rule 8 and section 6 of the skill |
| Database | PostgreSQL (current stable major) | Relational integrity, exclusion constraints for shifts, `pg_trgm` and full-text for Arabic search |
| ORM / migrations | Drizzle ORM + drizzle-kit, SQL migrations committed and reviewed | Thin, SQL-transparent, explicit migrations; raw SQL available for constraints and indexes |
| Authentication | Better Auth (email/password with email verification, TOTP 2FA, sessions in Postgres) | Maintained library, no custom auth, supports MFA and organizations; data stays in our database |
| Authorization | Own policy layer: one `can(actor, action, resource)` module per business module, called from every server action and route | Ownership and state checks are business rules, not library config |
| Background jobs | pg-boss (queue in PostgreSQL), separate worker process | No Redis to run; transactional enqueue with the business write |
| File storage | S3-compatible object storage: private bucket (documents), public bucket (approved listing images) behind a CDN; signed URLs only for private files | Portable across providers |
| Image pipeline | sharp in the worker: re-encode, resize, strip metadata; ClamAV scan before visibility | Removes EXIF/GPS, blocks malicious uploads |
| i18n / RTL | next-intl, Arabic default, Tailwind CSS with logical properties only | Arabic-first with direction-aware layout |
| Email / SMS | Provider adapters behind an interface; transactional email provider for verification and notifications; SMS deferred until a feature needs it | Swap vendors without touching business code; keep personal data sent to vendors minimal |
| Payments | Deferred to milestone 3; adapter for Paymob or Fawry | Not needed to validate the core product |
| Testing | Vitest (unit + integration against real Postgres via Testcontainers), Playwright (E2E, Arabic RTL, mobile viewport) | Matches `references/testing.md` |
| Observability | Structured JSON logs (pino), error monitoring with PII scrubbing, health endpoints | Matches `references/operations.md` |
| Packaging | Docker images for `web` and `worker`; docker compose for local dev (Postgres, MinIO, Mailpit) | Same artifact locally, in staging and in production |
| CI | GitHub Actions: lint, typecheck, unit, integration, build, dependency and secret scan; E2E on main | Main stays green |
| Package manager | pnpm, lockfile committed | Reproducible installs |

### Code layout

```
src/
  app/                      Next.js routes and pages (thin: call module services)
  modules/
    identity/               users, sessions, roles, MFA
    profiles/               public and professional profiles
    verification/           submissions, review queue, decisions, document access log
    organizations/          pharmacies and chains, membership
    jobs/                   jobs, applications (also manager recruitment)
    shifts/                 milestone 2
    listings/               milestone 3
    billing/                milestone 3
    notifications/          channels, preferences, outbox
    admin/                  moderation queues, audit log
  shared/                   db client, storage, i18n, validation, logging, policy helpers
worker/                     job handlers (email, SMS, image processing, scans, expiry)
db/migrations/              SQL migrations
docs/architecture/decisions/
```

Rules: pages never query the database directly; each module exposes services and owns its tables; cross-module access goes through the other module's service, not its tables.

## 3. Alternatives considered

| Alternative | Why not now |
|---|---|
| Separate SPA (React/Vite) + API (NestJS) | Two deployables and an API contract to maintain for a small team; SSR helps mobile on slow networks. Revisit if native mobile apps need a public API (a versioned API module can be added to the monolith). |
| Laravel or Django | Both strong choices; TypeScript chosen for one language across UI and server and for the team's likely hiring pool. Reversible only at high cost, so this is the main decision to challenge now. |
| Supabase / Firebase | Fast start, but couples auth, storage and data to one vendor and region, which conflicts with the open hosting-region question. |
| Prisma | Good, but heavier runtime and less direct SQL control for constraints, partial and trigram indexes. |
| Redis-based queue (BullMQ) | Extra service to run; pg-boss is sufficient at the target scale. Revisit if job volume degrades database performance. |
| Microservices / Kubernetes | Not justified by team size or load (skill section 5). |
| Dedicated search engine | Postgres trigram and full-text with Arabic normalization meets year-one targets. |

## 4. Hosting region (open)

| Option | Pros | Cons |
|---|---|---|
| A. In Egypt: Huawei Cloud Cairo region or a local provider/telco cloud | Avoids cross-border transfer licensing for core data; low latency for users | Smaller managed-service catalogue and ecosystem; confirm managed PostgreSQL with PITR, S3-compatible storage, backups and support terms before committing |
| B. Foreign region (e.g. AWS or Azure in Europe or the Gulf) with a PDPC transfer licence | Mature managed services, tooling, hiring pool | Licence and DPO registration before launch; licence timeline and conditions uncertain; ongoing obligations |
| C. Hybrid: identity documents and national IDs in Egypt, application elsewhere | Limits what crosses the border | Two environments, more complexity, and most profile and application data is still personal data, so a licence is likely still needed |

Recommendation: keep the stack portable (containers, plain PostgreSQL, S3 API) and plan for Option A for production, subject to counsel's advice and a two-week proof of the chosen Egyptian provider (managed Postgres with point-in-time recovery, object storage, backups, restore drill). Use Option B only if counsel confirms the licence route is quick and the Egyptian provider fails the proof. Whatever the choice, third-party services (email, SMS, error monitoring, analytics) still receive some personal data and must be listed for counsel; send them the minimum.

Development and staging use synthetic data only, so they can run anywhere while this is decided.

## 5. First milestone (M1)

In scope:

1. Registration and login by email (any provider, including Gmail) with email verification, admin MFA, Arabic RTL UI.
2. Profiles: public profile and private professional details.
3. Verification: submit syndicate card and national ID, reviewer queue, approve or reject with reason, verification states, document access log.
4. Organizations: pharmacy owner creates a pharmacy and invites members.
5. Jobs (including manager roles) and applications with the state machines in `references/business-workflows.md`.
6. Admin: verification queue, job moderation for first posts, audit log.
7. CI, staging environment, backups, error monitoring.

Out of scope for M1: shifts (M2), sale and rental listings (M3), subscriptions and payments (M3), messaging (M2), analytics beyond basic counts, native apps.

## 6. Consequences

- Positive: one deployable codebase, low operating cost, provider-portable, strong data integrity, all critical logic server-side and testable.
- Negative: Next.js upgrades need care; self-hosting means we run the worker, backups and monitoring ourselves; an in-country provider may need more operational work than a hyperscaler.
- Security: identity data isolated in the verification module with field-level encryption and private storage; every server action passes the policy layer; admin MFA from day one.
- Reversibility: hosting provider and region — high (containers, standard Postgres and S3). ORM and auth library — medium. Language and framework — low; challenge now if at all.

## 7. Revisit when

- Counsel's advice changes the hosting options.
- A module needs independent scaling or a separate team (extraction criteria: sustained load that affects other modules, or a different release cadence).
- Native mobile apps are approved (add a versioned public API).
- pg-boss job volume or search latency misses the targets in measured production data.

## 8. Product owner decisions (2026-10-20)

| Decision | Choice |
|---|---|
| Market | Egypt only. No other countries, currencies or languages beyond Arabic (default) and English are planned. |
| Stack | TypeScript / Next.js, as in section 2 |
| Platform | Web first: mobile-first responsive site, installable as a PWA. Native apps later, when shift alerts need reliable push, repeat usage is proven, or users ask for an app; then one cross-platform app (e.g. React Native/Expo) over a versioned API. |
| Registration | Email (any provider, including Gmail) with email verification. "Sign in with Google" can be added in step 2 if wanted. Phone OTP is not used at launch, so no SMS provider is needed yet. |
| Starting targets | 50,000 users in year one, 99.5 % monthly availability, p95 < 300 ms, RPO 1 h / RTO 4 h, OWASP ASVS Level 2 |
| Data-protection counsel | Engage now, before any real user data is collected (PDPL grace period reported to end around 31 Oct 2026) |
| Hosting region | Open. Candidates: AWS or another established cloud (Option B, needs a PDPC cross-border transfer licence and a registered DPO), or Huawei Cloud Cairo / a local provider or telco cloud after the two-week proof (Option A). Decide with counsel before real users sign up; record the choice in a later ADR. |

Development and staging use synthetic data only and are not bound by the hosting decision.
