# Core business workflows

Implement every workflow as an explicit state machine: a status column, a single server-side function per transition that checks actor, permission, current state and preconditions, and writes an audit or history row. Use only the states the approved workflow needs. Document the transition table next to the code.

## Jobs

States: `draft → published → paused ⇄ published → closed`; `published → expired` by scheduled job at `expires_at`.

- Only the owning organization's authorized members create, edit, publish, pause or close.
- Publishing requires a verified poster or passes through moderation (first post always does).
- Every published job has an `expires_at`; a scheduled job expires overdue posts and notifies the owner.
- Expired and closed jobs remain visible to applicants in their history but reject new applications on the server.

## Applications

States: `submitted → under_review → shortlisted → accepted | rejected`; `submitted | under_review | shortlisted → withdrawn` by the applicant.

- Unique constraint on (job, applicant) enforces the duplicate policy; a withdrawn application may be resubmitted only if the policy says so.
- Employers see only applications to their own jobs and only the profile fields the applicant shared.
- The applicant sees status changes; the employer cannot see other employers' interactions.

## Shifts and coverage requests

Define before building: availability, booking or application status, confirmation rules, cancellation rules and deadlines, time conflicts, start and end time, expiry, and notifications.

States (booking): `requested → confirmed → completed`; `requested → declined | expired`; `confirmed → cancelled_by_pharmacy | cancelled_by_pharmacist` with reason and timestamp.

- Times in `timestamptz`, displayed in `Africa/Cairo` (see `database.md`).
- A pharmacist cannot hold two confirmed shifts that overlap: enforce with an exclusion constraint, not only application code.
- Concurrent booking of the same shift: lock the shift row (`SELECT … FOR UPDATE`) or use a conditional update, so exactly one confirmation wins.
- Unconfirmed requests expire automatically before the shift start.
- Late cancellations are recorded for reliability signals; do not build ratings or penalties until approved.

## Manager recruitment

Permanent and temporary manager requests follow the job and application model with extra required fields (licence requirements, period for temporary roles). Reuse the job module rather than building a parallel one.

## Pharmacy sale and rental listings

States: `draft → pending_review → published → paused ⇄ published → sold | rented | withdrawn`; `published → expired` at `expires_at`; `pending_review | published → rejected | removed` by moderation with reason.

- Separate three things in data and UI: what the user claims, the moderation state, and anything independently verified (e.g. licence checked by staff).
- Only the owner edits; edits to key fields of a published listing return it to review.
- Images go through the upload pipeline (re-encode, strip metadata, scan). Confidential documents (licence, contract, financials) are private, shared only with explicit owner approval and logged.
- Contact details revealed only to verified users, with the reveal logged.
- Reporting, takedown and repeat-offender handling with audit trail.
- Never display financial claims (turnover, profit) as facts; label them as stated by the seller.

## Messaging

- Messages only between parties with a legitimate relationship (applicant and employer for a job, interested buyer and listing owner).
- Rate-limit new conversations; allow block and report; retain per the retention policy.
- No attachments to identity documents through chat.

## Subscriptions

States: `trialing → active → past_due → canceled | expired`; `active → canceled` (at period end) by the user.

- State changes only from verified provider webhooks or audited admin action.
- Entitlements are checked on the server at use time from the current subscription, not cached in the client.
- Every change writes a subscription event row (who or what, old state, new state, provider reference).
- Grace period for `past_due` is a configured value, not a magic number.
- No real charges or live plan changes without explicit authorization.

## Moderation and administration

- Queues for: verification requests, first listings and jobs, reported content, flagged accounts.
- Every decision records reviewer, reason, timestamp and notifies the affected user.
- Admins can suspend accounts and remove content; deletion of user data follows the privacy workflow.

## Notifications

- One notification service with channels (in-app, email, SMS, WhatsApp later) and per-user preferences.
- Sent from background jobs with idempotency keys, retries and a dead-letter record.
- SMS used sparingly (cost and abuse); transactional messages only unless marketing consent exists.
