# Data protection status

Tracks Egyptian data-protection obligations (Law 151 of 2020 and its executive regulations) for the pharmacist platform. This file records advice received; it is not legal advice and does not state compliance.

## Status (2026-10-20)

- Egyptian data-protection counsel is engaged. The product owner reports counsel has given general approval to proceed.
- Development and staging use synthetic data only, so work continues.
- Before real users sign up, the written answers below must be recorded here (date, counsel, summary, link to the advice).

## Questions for counsel (written answer needed before launch)

| # | Question | Why it matters | Answer |
|---|---|---|---|
| 1 | Do we need a PDPC licence or permit to process this data (national ID, syndicate card, CVs, professional data), and which type? | Possible prerequisite to launch | Pending |
| 2 | Hosting: may production run outside Egypt (e.g. AWS Europe or Gulf)? If yes, which transfer licence, timeline and conditions; if no, confirm in-country hosting is required. | Decides the hosting provider (ADR-001 section 4) | Pending |
| 3 | Vendors that receive personal data: email delivery provider, error monitoring, Have I Been Pwned (receives only a 5-character password-hash prefix), future SMS and payment providers. Which count as transfers, and what contracts are needed? | Vendor selection and contracts | Pending |
| 4 | Must we appoint and register a data protection officer, and by when? | Licence prerequisite | Pending |
| 5 | Consent and privacy notice wording in Arabic for registration and for identity verification (national ID, syndicate card). | Required screens in steps 2–4 | Pending |
| 6 | Retention periods: rejected and expired verification submissions and documents, closed accounts, applications (profile snapshots and shared phone numbers), organization invitations (invited addresses) and closed organizations, audit logs (decisions and document access log; today they are deleted with the user's account, and kept without the reviewer when a staff account is deleted). | Deletion jobs and schema | Pending |
| 7 | Breach notification: deadline, to whom, and content. | Incident runbook (launch checklist) | Pending |
| 8 | National ID handling: is our approach (field-level encryption, masked display, reviewer-only access, access log) sufficient, and may we keep a keyed hash for duplicate detection? | Step 4 design | Pending |
| 9 | Data subject rights: required response times for access, correction, export and deletion requests. Must the export include the reviewer's internal note on a verification decision (today it does not; it includes status, claims, masked ID, document kinds and reason code)? | Account features | Pending |
| 10 | Data-rights requests from suspended accounts (they cannot sign in to export): support handles them by hand. Confirm this process with counsel. | Account features | Pending |

## Data we will process (milestone 1)

| Data | Purpose | Where |
|---|---|---|
| Email, password hash, sessions | Account and sign-in | Identity tables |
| Name, phone, city, professional details | Profile and job matching | Profile tables |
| National ID number | Verify a real pharmacist; prevent duplicate accounts | `verification_submission`: AES-256-GCM ciphertext (key outside the database), HMAC-SHA256 keyed hash (duplicate check), masked form (`2**********345`) for display and export. Clear text only to a reviewer, on an explicit, logged reveal, while the submission is pending |
| Legal name in Arabic, as written on the national ID card | Professional verification: the reviewer compares it with the card photo | `verification_submission.legal_name_ar`, normalized (no diacritics or tatweel), immutable after submission. Reviewer-only (queue and submission page) and the owner's data export; never on profiles, in emails or in logs. Not field-encrypted |
| Syndicate membership number or university, card expiry date | Professional verification (unverified claims until a reviewer decides) | `verification_submission` |
| Syndicate or college card and national ID images (front, back) | Professional verification | Private object storage (re-encoded, metadata stripped), linked by `verification_document`; reviewers view them through 5-minute signed URLs while the submission is pending |
| Verification decisions (reviewer, decision, reason code, internal note, time) | Accountability for verification | `verification_decision`, append-only. The user sees the decision and a localized reason, not the note or the reviewer |
| Document views and national ID reveals (who, what, when, IP) | Audit of access to identity documents | `document_access_log`, append-only |
| Consent text version accepted with a submission | Record of consent (wording pending, question 5) | `verification_submission.consent_version` (`draft-pending-counsel` until counsel's wording is in) |
| Organizations (pharmacy or chain name, governorate, optional business address) | Employer identity for job posts (step 6) | `organization`, entered by members; unverified |
| Organization membership (user, role, who added them, when) | Who may act for an employer | `organization_member`; owners see members' emails |
| Invited email addresses, role, inviter, status and times | Inviting someone to an organization, including people without an account | `organization_invitation`; the address is emailed once by the worker. Kept after the invitation closes, pending question 6 |
| Membership and invitation changes (actor, action, member or invitation id, roles, time) | Audit of who gave whom access to an employer | `organization_audit`, append-only |
| Job posts (content entered by organization members; public once published) | Publishing vacancies on the job board | `job`. No personal data is required; moderators reject contact details in the text |
| Job moderation decisions (moderator, decision, reason code, internal note, time) | Accountability for job moderation | `job_moderation_decision`, append-only. The employer sees the reason only, not the note |
| Job history (who changed a job's status, and when) | Accountability for job status changes | `job_event`, append-only |
| Applications: profile snapshot (display name, headline, bio, career stage, years of experience, governorate, specialties, experience list) shared with the employer at apply time; phone number only if the applicant ticks it for that application; optional cover note. The employer also sees the applicant's verification badge (not stored on the application). Visible to owners and recruiters of the job's organization only. No CV files at launch | Job applications | `job_application` (jobs module) |
| Application history (who moved an application to which status, and when) | Accountability for application decisions | `application_event`, append-only |
| Admin audit log: staff and target account ids, actor kind, action codes, target type and id, detail codes, client IP. No names, emails, national IDs or notes | Audit trail for staff actions, role changes and data exports | `admin_audit`, append-only (ADR-008). Rows survive account deletion: the actor id is nulled, target ids are kept. Retention pending question 6 |
| Account suspensions: reason, internal staff note, staff ids (suspending and lifting), times, lift reason | Enforcing account suspension and keeping its history | `account_suspension`, kept for the account's life. The account is told the reason only, never the note. Retention pending question 6 |
| Job reports: reporter id, reason, optional free-text details (up to 500 characters), resolution and times | Reports of misleading or fraudulent job posts | `job_report`, deleted with the job. Visible to moderators only, never to the employer. Retention pending question 6 |
