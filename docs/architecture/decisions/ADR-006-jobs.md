# ADR-006: Jobs and moderation of first posts (milestone 1, step 6a)

- Status: Accepted
- Date: 2026-10-26
- Deciders: principal engineer (delegated authority; product owner informed)

## Context

Jobs are the product's core value and its main search-engine surface (ADR-003: jobs, not people, are public). They are also a fraud target: fake jobs harvest CVs and identity documents. The skill's workflow reference fixes the job states (`draft → published → paused ⇄ published → closed`, `published → expired` on schedule), says only the owning organization's authorized members manage a job, and that publishing needs a verified poster or moderation, with the first post always moderated. Manager recruitment reuses the job model.

Step 6 is split: 6a (this ADR) delivers jobs, the moderation of first posts and the public job board; 6b delivers applications, which add CVs and applicant data and get their own ADR.

## Decision

### Data model (module `jobs`)

| Table | Fields (purpose) |
|---|---|
| `job` | `id` uuid (public URL), `organization_id` FK ON DELETE CASCADE, `status`, `title` 4-120, `category` (`pharmacist`, `pharmacy_manager`, `area_manager`, `trainee`, `other`), `employment_type` (`full_time`, `part_time`, `temporary`), `start_date` and `end_date` (required for `temporary`, the temporary-manager case), `governorate_id` FK → governorate, `area` optional ≤120 (district or street), `description` 30-4,000, `min_years_experience` 0-40, `career_stages` (subset of profiles' `student`, `graduate`, `pharmacist`), `salary_min` and `salary_max` optional, integer piasters per month, `search_text` (normalized title and area, maintained by the service), `created_by`, `updated_by` and `submitted_by` FK → user ON DELETE SET NULL (`submitted_by`: the member whose verification decided moderation, shown as the poster's badge), `submitted_at`, `published_at`, `first_published_at`, `expires_at`, `closed_at`, timestamps |
| `job_moderation_decision` | Append-only: `job_id`, `moderator_id` (SET NULL), `decision` (`approved`, `rejected`), `reason_code`, `note` ≤500 (internal), `decided_at` |
| `job_event` | Append-only history of transitions: `job_id`, `actor_id` (SET NULL; null for the system), `from_status`, `to_status`, `at` |

No contact details in a job: applicants will reach the employer through applications (6b). Moderators reject posts that put phone numbers or emails in the text.

### States and transitions (one service function each, row locked `FOR UPDATE`)

| From | Action | To | Who |
|---|---|---|---|
| — | create | `draft` | owner, admin, recruiter of the organization |
| `draft`, `rejected` | edit | same | same |
| `draft` | submit | `pending_review` if moderation is needed, else `published` | same |
| `rejected` | resubmit | `pending_review` (always) | same |
| `pending_review` | approve / reject (reason) | `published` / `rejected` | moderator (staff role `moderator` + MFA), never for an organization they belong to and never for a job they created or submitted |
| `published` | pause | `paused` | organization members |
| `paused` | resume | `published` (or `expired` if `expires_at` passed) | organization members |
| `published`, `paused` | close | `closed` | organization members |
| `published`, `paused` | expire | `expired` | daily worker job, Africa/Cairo |
| `draft` never submitted | delete | (row deleted) | organization members |

- Moderation is needed when the organization has never had a published job, or when the submitting member is not a verified pharmacist or student (verification module's badge). Otherwise the job publishes immediately.
- Content can be edited only in `draft` and `rejected`. A published job is paused or closed, not edited, so nothing reaches the public board without the rules above. A copy-to-new-draft action covers corrections.
- Publishing sets `expires_at` to 30 days after publication. `closed` and `expired` are final.
- A database trigger enforces the transition table as well (like the verification submission guard), so a bug in the service cannot jump states.

### Public board

- `/jobs` lists published, unexpired jobs, newest first, with keyset pagination (published_at, id), filters for governorate, category and employment type, and a text search over `search_text` (title and area) with the Arabic normalization in the database reference (diacritics and tatweel removed, alef forms unified, ة → ه, ى → ي, Eastern digits to Western) on both sides, served by a `pg_trgm` GIN index.
- `/jobs/<id>` shows a published, unexpired job to anyone, signed in or not; anything else is 404 for everyone. Members see their jobs in any status at `/manage/jobs/<id>`.
- Each job shows the organization's name, kind and governorate, the note that the organization is not reviewed by the platform, and whether the poster is a verified member (the verification badge, nothing else about the person).

### Notifications

The worker emails the job's creator when a moderator approves or rejects (with the localized reason) and when the job expires (job `jobs.notify`). If the creator is no longer a member of the organization, the email is skipped.

### Authorization

Organizations' policy has `jobs.manage` (owner and recruiter, ADR-005 amendment). The jobs module asks the organizations service for the caller's role inside the job's transaction and decides with its own `can`. Moderation uses identity's `moderation.access`.

## Implementation notes (added after 6a was built)

- Migration `0008_jobs` creates `pg_trgm`, the three tables, a GIN trigram index on `search_text`, the `job_guard` trigger (the transition table above; `organization_id` and `created_by` immutable, except `created_by` nulled by the account cascade) and the append-only guard from 0004 on `job_moderation_decision` and `job_event`. New tables only. Rollback: a forward migration dropping them.
- Search covers title and area, not the organization's name: the name lives in the organizations module and can change, and copying it into jobs would need a write from organizations into jobs. Revisit with search usage data.
- Organizations exposes `getRoleInOrganization` (read inside the job's transaction) and `getPublicOrganizations` (name, kind, governorate only) for jobs.
- `submitJob` re-validates a temporary job's period at submit time. `copyJob` re-creates the content as a new draft through `createJob`, so the same validation and the open-jobs limit apply.
- Only a draft that was never submitted can be deleted. Anything a moderator has seen stays with its decisions and history, so an employer cannot erase a fraud rejection.
- A rejected job always goes back to review on resubmission, whoever submits it (the trigger allows `rejected → pending_review` only).
- Moderators never see or decide jobs they created or submitted, even after leaving the organization; their queue leaves those out, and jobs of organizations they belong to.
- `copyJob` copies the content as stored, even a temporary period that has started; `submitJob` then refuses with the stale date as a field error, so the employer sets new dates first.
- Notices skip a creator who is no longer a member of the organization. Resuming a paused job after its expiry sends the same expiry email as the daily pass. A retry after an unacknowledged SMTP send can deliver an email twice.
- The board and the moderation queue read posters' verification in one query per page (`getVerifiedUserIds`).
- The expiry pass works in batches of 200 with `FOR UPDATE SKIP LOCKED`, so a second worker instance does not double-process; each expired job gets a `job_event` row and a `jobs.notify` email job in the same transaction. Pages also hide jobs past `expires_at` before the pass runs.
- Two moderators deciding at once: the job row is locked and must still be `pending_review`, so exactly one decision is stored (tested).
- Emails go to the job's creator in Arabic (no language preference is stored yet) with a link to `/manage/jobs/<id>`. If the creator's account is gone or unverified, the email is skipped.
- Known limits: no per-moderator audit view yet (step 7); the board's text search uses `ILIKE` on the trigram index, without relevance ranking; salary is shown as entered, as the employer's claim.

## Alternatives considered

- Editing published jobs with re-review on key fields: rejected for launch; the listings workflow does this, but for jobs pause, close and copy is simpler and safe.
- Moderating every job: rejected; delays verified employers. Revisit if fraud appears.
- A search engine: not needed at the year-one target (database reference).
- Salary as free text: rejected; breaks filters and invites inconsistent claims.

## Consequences

- Fraud control at launch rests on first-post moderation and the verified-poster rule. Moderators need the staff area (step 7 adds the audit log and broader queues).
- `pg_trgm` becomes a required extension (available in standard PostgreSQL packages and the managed offerings considered in ADR-001).
- Reversibility: high; new tables only.

## Revisit when

- Applications (6b) need to be shown per job.
- Fraud or moderation load data suggests a different rule.
- Employers ask to edit published jobs.
