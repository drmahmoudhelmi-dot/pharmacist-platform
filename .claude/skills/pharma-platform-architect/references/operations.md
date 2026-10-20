# Performance, operations and deployment

## Performance and scalability

Optimize for measured usage against the targets in SKILL.md section 5, not imagined scale.

- Identify likely bottlenecks first and how to measure them.
- Review query patterns and indexes, pagination, N+1 queries, image sizes and formats, unnecessary requests, bundle size, slow third-party calls, and work that belongs in background jobs.
- Move slow or retryable work (emails, SMS, image processing, malware scans, reconciliation, expiry) to a job queue.
- Use a CDN for static assets and public listing images.
- Cache only with a clear invalidation rule. Never let a shared cache serve private or user-specific data.
- Every performance change states its expected benefit and how it will be measured.
- Scale vertically and with read replicas before splitting the monolith. Revisit only when a module meets its documented extraction criteria.

## Observability

- Structured JSON logs with request/correlation IDs, user ID (not personal details) and outcome.
- Error monitoring with source maps; scrub personal data before sending.
- Health and readiness endpoints.
- Metrics and alerts for: error rate, p95 latency, job queue depth and failures, database connections and slow queries, webhook failures, reconciliation mismatches, SMS volume and spend, storage growth.
- For each critical workflow, document how an operator discovers, diagnoses and recovers from a failure.
- Document scheduled jobs and external dependencies with owners.

Never log passwords, tokens, OTPs, national IDs, document contents or unnecessary personal data.

## Backups and recovery

- Automated daily backups plus point-in-time recovery for PostgreSQL, meeting the RPO.
- Object storage versioning for private documents.
- Backups encrypted and stored in a separate account or location.
- A restore drill before launch and at least quarterly, with the measured restore time recorded against the RTO.

## Environments

- Local, staging and production at minimum. Staging mirrors production configuration with sandbox payment, SMS and email providers and anonymized or synthetic data. Never copy production personal data to lower environments.
- Infrastructure and configuration defined in code where practical.

## CI/CD

Pipeline on every pull request: install from lockfile, lint, type check, unit and integration tests, build, dependency and secret scan. On merge to main: deploy to staging, run migrations, run smoke and end-to-end tests. Production deploys are explicit, approved and reversible.

- Migrations run in the pipeline, compatible with the previous app version (expand/contract).
- Zero-downtime deploys where the platform supports them; feature flags for risky releases.
- One-command rollback for the application; forward-fix plan for data changes.

## Deployment readiness checklist

Before recommending a production deploy, confirm and report each item:

- [ ] All checks in CI green on the exact commit
- [ ] Migrations reviewed, tested on staging, backup verified
- [ ] Environment variables and secrets configured in the target environment
- [ ] Payment, SMS and email providers in the correct mode (sandbox vs live) and webhooks registered
- [ ] Monitoring and alerts active for the changed area
- [ ] Rollback steps written and feasible
- [ ] Privacy-impacting changes reviewed; legal sign-off where required

## Launch readiness (first production release)

In addition to the checklist:

- [ ] Hosting region decision recorded and legal review of data protection obligations completed
- [ ] Privacy policy, terms of use and consent texts in Arabic, reviewed by counsel
- [ ] Admin MFA enforced; admin roles assigned on least privilege
- [ ] Penetration test or ZAP baseline on staging with findings resolved or accepted in writing
- [ ] Load test against targets passed
- [ ] Restore drill completed within RTO
- [ ] Incident response contact list and runbook for: data breach, payment outage, SMS abuse, account takeover, fraudulent listing
- [ ] Moderation staffed for verification and first-listing queues

Never deploy to production, run production migrations or change live payment configuration without explicit authorization.
