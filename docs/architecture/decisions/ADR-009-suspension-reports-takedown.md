# ADR-009: Account suspension, job reports and moderator takedown (milestone 1, step 7b)

- Status: Accepted
- Date: 2026-10-26
- Deciders: principal engineer (delegated authority; product owner informed)

## Context

ADR-008 (step 7a) added the admin audit log and staff role management. The workflow reference still requires queues for reported content and flagged accounts, that admins can suspend accounts and remove content, and that every decision records reviewer, reason and time and notifies the affected user. The security reference asks for report and takedown flows with reasons and an audit trail, and for repeat-offender handling. Fake jobs that harvest CVs are the main fraud risk on the board (ADR-006); today a moderator can only act on a job before it is first published.

## Decision

### Account suspension (module `identity`)

| Table | Fields |
|---|---|
| `account_suspension` | `id`, `user_id` FK → user ON DELETE CASCADE, `reason_code`, `note` ≤500 (internal, staff only), `suspended_by` FK → user SET NULL, `suspended_at`, `lifted_at`, `lifted_by` FK SET NULL, `lift_reason_code` |

- At most one active suspension per account (partial unique index on `user_id` where `lifted_at` is null). A trigger allows only one update per row: setting `lifted_at`, `lifted_by` and `lift_reason_code` once; everything else is immutable and rows cannot be deleted (except by the account's own deletion). History is the set of rows.
- Suspension reasons: `fraud_or_impersonation`, `fake_jobs`, `abuse_or_harassment`, `spam`, `terms_violation`, `other`. Lift reasons: `appeal_accepted`, `issued_in_error`, `other`.
- Effects, in the suspending transaction: every session of the account is deleted; while active, Better Auth's session-create hook refuses any new session (password, TOTP, backup code, auto sign-in after email verification), so the account cannot act at all. The profile is hidden from other members (`/profiles/<id>` answers 404, as for a hidden profile). Organizations, jobs and applications are left as they are: a moderator removes jobs separately (below), and other members of the account's organizations keep working.
- Who: staff with role `moderator` or `super_admin` (TOTP session). Nobody suspends themselves; only a `super_admin` suspends or reinstates an account that holds any staff role.
- `/staff/accounts`: look up an account by exact email (no listing or partial search), see its suspension history, suspend with a reason and note, reinstate with a reason.
- The worker emails the account (`account.notify`: `suspended` with the localized reason, `reinstated`), never the internal note. Appeals go to support by email at launch; no in-app appeal.
- Data rights while suspended: the account cannot sign in to export its data; support handles such requests by hand (data-protection status, open question).

### Job reports (module `jobs`)

| Table | Fields |
|---|---|
| `job_report` | `id`, `job_id` FK ON DELETE CASCADE, `reporter_id` FK → user SET NULL, `reason_code`, `details` ≤500 optional, `status` (`open`, `actioned`, `dismissed`), `created_at`, `resolved_at`, `resolved_by` FK SET NULL |

- Any signed-in account with a verified email may report a job it can see on the board (`published`, not expired), except members of the job's organization. Reasons: `fake_or_scam`, `contact_details_in_text`, `discriminatory`, `misleading`, `other`. One open report per account and job; 10 reports per account per 24 hours.
- The reporter's identity and details are visible to moderators only, never to the employer. The reporter gets a confirmation on screen, no email.
- Resolution sets `status`, `resolved_at` and `resolved_by` once (trigger); reports are never deleted except with their job.
- `/staff/reports`: jobs with open reports, oldest open report first, with the count and reasons; the moderator opens the job with its reports and either dismisses them (all open reports of the job become `dismissed`) or takes the job down (they become `actioned`).

### Takedown (module `jobs`)

- New final job status `removed`, reachable from `published` and `paused` by a moderator, with a reason (`misleading_or_fraud`, `contact_details_in_text`, `discriminatory`, `not_pharmacy_related`, `other`) and an internal note. Added to `TRANSITIONS`, the `job_guard` trigger and the status check; `job_moderation_decision.decision` gains `removed`; a `job_event` row records it. Same separation of duties as approval: never for a job of an organization the moderator belongs to, nor one they created or submitted.
- A removed job disappears from the board and its public page (404). Employers still see it in their list with the reason, cannot change it, and can copy it into a new draft.
- Its applications are frozen: employers can still read them but not move them, and each applicant whose application is not final is emailed that the job was removed by moderation (`applications.notify` kind `job_removed`). The job's creator is emailed with the reason (`jobs.notify` kind `removed`).
- Repeat offenders: an organization with a job removed in the last 90 days has every submission moderated, whatever its history or the member's verification.

### Audit

New `admin_audit` actions, written with `recordAudit` inside each transaction: `account.suspended` and `account.reinstated` (target `user`, detail `{reasonCode}`), `job.removed` (target `job`, `{reasonCode}`), `job.reports_dismissed` (target `job`, `{count}`). Reports themselves are user actions recorded in `job_report`, not in the audit log.

## Alternatives considered

- Better Auth's admin plugin (`banned` fields and ban endpoints): rejected as in ADR-002; it exposes role and ban endpoints we do not want and keeps no history.
- A `suspended` flag on `user`: rejected; no history and no reason, and Better Auth owns that table.
- Removing a suspended account's jobs automatically: rejected; an organization can have other, innocent members, and a moderator decides per job.
- Reports on profiles and organizations now: deferred; jobs are the only public content and the main fraud vector. The same table shape can be reused.
- Letting employers see that a job was reported: rejected; it tells a fraudster which posts were noticed and exposes reporters to retaliation.

### Concurrency (from the review)

- Suspension is checked at three points: before Better Auth inserts a session, right after it (a suspension that committed in between deletes the new session), and on every request in `getActor`, so no session outlives a suspension.
- An employer's move locks the job (shared) before the application, the same order as a takedown (job, then its applications): a move that waited on a takedown sees the job removed and is refused.
- A report share-locks the job, so it cannot open on a job removed in the same instant.

## Consequences

- Moderators can act on live jobs and on accounts; every such action is in the audit log.
- The suspension table holds an internal note and staff ids: personal data under the retention question (data-protection status, question 6).
- One more status for jobs and their trigger; one migration.
- Reversibility: high.

## Revisit when

- Staff look-ups by email should leave no trace in URLs and access logs (today `/staff/accounts?email=`): move the lookup to a POST form.

- Reports are needed for profiles, organizations or later listings.
- Volume calls for automatic actions (for example a threshold of independent reports that pauses a job).
- An in-app appeal flow is needed.
