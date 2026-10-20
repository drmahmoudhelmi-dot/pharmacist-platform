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
| 6 | Retention periods: rejected verification documents, closed accounts, applications, audit logs. | Deletion jobs and schema | Pending |
| 7 | Breach notification: deadline, to whom, and content. | Incident runbook (launch checklist) | Pending |
| 8 | National ID handling: is our approach (field-level encryption, masked display, reviewer-only access, access log) sufficient, and may we keep a keyed hash for duplicate detection? | Step 4 design | Pending |
| 9 | Data subject rights: required response times for access, correction, export and deletion requests. | Account features | Pending |

## Data we will process (milestone 1)

| Data | Purpose | Where |
|---|---|---|
| Email, password hash, sessions | Account and sign-in | Identity tables |
| Name, phone, city, professional details | Profile and job matching | Profile tables |
| National ID number | Verify a real pharmacist; prevent duplicate accounts | Encrypted field, verification module |
| Syndicate card and national ID images | Professional verification | Private object storage |
| CVs and applications | Job applications | Private storage and jobs tables |
| Staff actions | Audit trail | Audit log |
