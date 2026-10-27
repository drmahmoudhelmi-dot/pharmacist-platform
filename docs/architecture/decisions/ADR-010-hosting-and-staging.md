# ADR-010: Hosting provider, region and the staging environment (milestone 1, step 8)

- Status: Proposed (decision reserved for the product owner, with data-protection counsel; CLAUDE.md sections 7 and 11)
- Date: 2026-10-27
- Deciders: product owner (provider, region, spending, accounts); principal engineer (technical recommendation)

## Context

ADR-001, section 4, left the hosting region open and recommended keeping the stack portable and planning for hosting in Egypt, subject to counsel and a two-week proof of the chosen provider. Step 8 (staging) needs a host. Staging holds synthetic data only, so legally it can run anywhere; but the cheapest way to prove a production provider is to run staging on it.

What changed since ADR-001 (sources at the end):

- The Executive Regulations of the Personal Data Protection Law (Law 151 of 2020) were issued by Prime Ministerial Decree 816 of 2025 in November 2025. Commentators report the compliance period ending on 31 October / 1 November 2026, a licence and permit regime run by the Personal Data Protection Center (PDPC), and DPO registration.
- Transfers of personal data outside Egypt need PDPC approval (a licence or permit) and, according to some commentators, data-subject consent and approved destinations. A transfer licence is reported to cost 50 % of the local licence fee for the same category of data.
- Huawei Cloud's Cairo region has been live since May 2024; vendor and partner material lists managed PostgreSQL (RDS for PostgreSQL) and S3-compatible object storage (OBS). As of 2026 it is reported to be the only public hyperscaler region in Egypt. AWS (only a CloudFront edge in Cairo), Microsoft Azure, Google Cloud and Oracle have no compute region in Egypt; the nearest are in the UAE, Qatar and Saudi Arabia.
- Egyptian telco clouds (Telecom Egypt IaaS, Orange Egypt Business Cloud, "hosted in Egypt") and local providers offer virtual servers and managed services, with smaller managed-service catalogues.

None of this is legal advice. Counsel must confirm what the platform needs (controller licence, sensitive-data licence for national IDs and identity documents, transfer licence if any data leaves Egypt, DPO) and whether a given provider counts as a processor inside Egypt.

## What the platform needs from a host

From CLAUDE.md, section 4 ("Production needs") and the operations reference:

| Need | Detail |
|---|---|
| Containers | Three images from one Dockerfile: `web` (Next standalone), `worker` (pg-boss jobs, sharp), `migrate` (one-shot) |
| PostgreSQL | Version 18 (or confirm the app on the provider's newest major); extensions `pg_trgm` and `pgcrypto`/`gen_random_uuid`; point-in-time recovery meeting RPO 1 h; daily backups to a separate location; our triggers need ordinary `CREATE FUNCTION` rights |
| Object storage | S3 API with presigned GET URLs reachable by browsers, bucket versioning, a lifecycle rule (expire `quarantine/` after a day), private buckets |
| Malware scanning | A clamd container with freshclam (about 1.5 GB memory) |
| Email | A transactional email provider (SMTP), with SPF, DKIM and DMARC on our domain; it receives recipient addresses and message text |
| Network | TLS, a reverse proxy or load balancer that overwrites `X-Forwarded-For`, a domain |
| Secrets | A secret store for `BETTER_AUTH_SECRET`, `NATIONAL_ID_ENCRYPTION_KEY`, `NATIONAL_ID_HASH_KEY`, database and storage credentials |
| Operations | Logs, metrics and alerts (error rate, p95 latency, job queue depth), RTO 4 h with a restore drill |

## Options

| Option | For | Against |
|---|---|---|
| A. Huawei Cloud, Cairo region (staging and production) | In-country data residency for core data; managed PostgreSQL and S3-compatible storage listed; one provider for both environments | Must verify PostgreSQL 18 (or our compatibility with its newest version), `pg_trgm`, PITR, OBS presigned URLs and versioning, support terms and pricing in a proof; smaller ecosystem and hiring pool; foreign-owned provider (counsel to advise on any implication) |
| B. Egyptian telco or local cloud (Telecom Egypt, Orange Egypt, others) | In-country residency; local support and billing in EGP | Mostly virtual servers: we would run PostgreSQL, backups and PITR ourselves (more operational risk and work); S3-compatible storage availability varies |
| C. Foreign region (AWS, Azure or Google Cloud in the UAE, Qatar, Saudi Arabia or Europe) with a PDPC transfer licence | Mature managed services and tooling; fastest to set up | Production would need a transfer licence and possibly consent; licence timing and conditions uncertain; ongoing obligations |
| D. Staging anywhere cheap (any provider, synthetic data), production decided later | Fastest start for staging | Proves nothing about the production provider; work is repeated later |

## Recommendation (for the product owner to accept or change)

1. Choose Option A for staging now and treat the staging build as the two-week proof ADR-001 asked for. Pass criteria:
   - managed PostgreSQL runs our migrations, including the triggers and `pg_trgm`, at version 18 or a version we test against;
   - point-in-time recovery and a restore drill finish within the 4-hour RTO;
   - OBS presigned URLs work from the browser, with bucket versioning and the lifecycle rule;
   - the three containers run with health checks, and the reverse proxy overwrites `X-Forwarded-For`;
   - the costs are known.
2. If the proof fails, try Option B with self-managed PostgreSQL. Use Option C for production only if counsel confirms a workable transfer licence.
3. Keep the stack portable (it already is: containers, plain PostgreSQL, S3 API, SMTP), so switching costs configuration, not code.
4. Pick a transactional email provider with counsel. It receives users' email addresses, so it is a processor; prefer one that can sign a data-processing agreement and, if possible, process in Egypt.

## What the product owner provides

- The decision on this ADR (with counsel's advice on licences, DPO and the provider).
- A provider account and a budget (spending is reserved to the product owner).
- A domain (or sub-domain) for staging, e.g. `staging.<domain>`, and DNS access.
- An email provider account.
- Who receives alerts.

## What is built without an account (this step)

- The production Dockerfile with `web`, `worker` and `migrate` targets, and `.dockerignore`.
- `docker-compose.staging.yml` with `staging.env.example`, which rehearses a staging deploy locally.
- A CI job that builds the images and smoke-tests the web image.
- `docs/operations/environment.md` (every variable and secret) and `docs/operations/staging-runbook.md` (deploy, migrate, roll back, back up, restore drill, health checks, rotating keys).

## Consequences

- Staging can go live within days of the decision and an account.
- The proof's results go into this ADR before it is accepted for production.
- Reversibility: high for staging; for production it depends on data migration between providers, which portability keeps possible.

## Sources (read 2026-10-27; verify before relying on them)

- Kennedys, "Egypt's Personal Data Protection Law – the compliance countdown has begun" (2026)
- Clyde & Co, "Egypt regulatory update on data privacy" (January 2026)
- Legal 500, "Strategic challenges and opportunities in cross-border data transfers under Egypt's personal data protection regime"
- DataGuidance, Egypt jurisdiction page (compliance by 31 October 2026)
- dsn group, "Egypt's Personal Data Protection Law: before you process, you need a licence" (transfer licence fee)
- Huawei Cloud, "Huawei Cloud Goes Live in Egypt" (May 2024)
- MomentumX, "Egypt Cloud Providers 2026" (a vendor; used only for the absence of other hyperscaler regions in Egypt)
- AABDC Egypt, "Egypt data centers and cloud infrastructure" (hyperscaler region listings)
- Telecom Egypt IaaS and Orange Egypt Business Cloud product pages
