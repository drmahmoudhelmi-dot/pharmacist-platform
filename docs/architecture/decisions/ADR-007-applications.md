# ADR-007: Applications (milestone 1, step 6b)

- Status: Accepted
- Date: 2026-10-26
- Deciders: principal engineer (delegated authority; product owner informed)

## Context

Step 6a published jobs. Applications are where a pharmacist's personal data reaches an employer, so the design is about what is shared, with whom, and for how long. The workflow reference fixes the states (`submitted → under_review → shortlisted → accepted | rejected`; withdrawal by the applicant before a final decision), a unique application per job and applicant, and that employers see only applications to their own jobs and only what the applicant shared. Job posts are a known vector for harvesting CVs and identity documents (security reference, abuse and fraud).

## Decision

### What an application shares

- No CV file at launch. The applicant's platform profile is the CV: it is structured (career stage, years, specialties, governorate, experience), already validated, and needs no file pipeline. ADR-004 refuses PDFs, the usual CV format, because they cannot be re-encoded safely. Revisit when employers ask for files.
- At apply time the service stores a snapshot of the applicant's public profile fields (display name, headline, bio, career stage, years of experience, governorate, specialties, experience list) on the application. The employer sees the snapshot, never the live profile: later edits, hiding the profile or deleting experience do not change what was shared, and nothing more becomes visible.
- The phone number from the private professional details is shared only if the applicant ticks "share my phone with this employer" for this application; it is copied into the application then. Email addresses are never shown to employers.
- An optional cover note up to 1,000 characters.
- The employer sees the applicant's current verification badge (the verification module's state), not documents or identity data.

### Rules

- Who may apply: a signed-in user with a verified email and a saved profile, to a `published` job that has not expired, and not to a job of an organization they belong to. Verification is not required to apply; employers see the badge.
- One application per job and applicant (unique). A withdrawn application cannot be resubmitted (the workflow default; keeps employers from being spammed).
- Limit: 30 applications per applicant per 24 hours.
- States: `submitted → under_review → shortlisted → accepted | rejected`; `submitted`, `under_review` → `rejected` too; `submitted | under_review | shortlisted → withdrawn` by the applicant. `accepted`, `rejected`, `withdrawn` are final. One service function per transition, the application row locked; a trigger enforces the table.
- Employer actions need `jobs.manage` in the job's organization (owner or recruiter, organizations policy). Applications to closed or expired jobs stay visible and can still be decided; new applications are refused.
- Every change writes an append-only `application_event` (actor, from, to, time).

### Notifications

The worker emails the applicant when an application is shortlisted, accepted or rejected (`applications.notify`), in Arabic, without the employer's internal reasoning. Employers see new applications on the job's page; there is no per-application email to employers at launch (noise), revisit with a daily digest.

### Data rights

The applicant's data export includes their applications (job title, organization name, status, dates, what they shared). An application's snapshot is personal data under the retention question (data-protection status, question 6); nothing is deleted automatically in this step.

## Alternatives considered

- Live profile instead of a snapshot: rejected; employers would see later changes and a hidden profile's data, which the applicant did not agree to share with them.
- PDF CV upload: deferred (see above).
- Requiring verified applicants: rejected for launch; verification takes days and would block students and new graduates. The badge informs the employer instead.

## Consequences

- Employers compare applicants on the same structured fields, which also helps search later.
- Applications hold personal data copied from profiles; deletion must cover them when account deletion arrives.
- Reversibility: high; new tables only.

## Revisit when

- Employers ask for CV files or attachments.
- Counsel answers retention (snapshots of rejected or withdrawn applications).
- Messaging between applicant and employer is approved (milestone 2).
