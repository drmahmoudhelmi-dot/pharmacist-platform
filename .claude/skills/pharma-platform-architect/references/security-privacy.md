# Security and privacy

Baseline: OWASP ASVS Level 2. Treat every item below as a requirement to implement and test, not a suggestion.

## Authentication

- Use the framework's or a proven provider's authentication. No custom auth or crypto.
- Passwords hashed with Argon2id or bcrypt via the library default; breached-password check where available.
- Mandatory multi-factor authentication for every admin, moderator and verification reviewer.
- Secure, HttpOnly, SameSite cookies; session rotation on login and privilege change; server-side session revocation; logout everywhere.
- Rate-limit login, registration, password reset and OTP endpoints per IP, per account and per phone number.
- SMS OTP is a cost and fraud target (SMS pumping): cap sends per phone and per IP per hour, set a daily spend ceiling with the SMS provider, block premium and non-Egyptian ranges unless needed, and alert on spikes.

## Authorization

For every sensitive operation check: authenticated identity, role and permission, resource ownership or authorized relationship (e.g. member of the pharmacy organization), resource status, and allowed state transition.

- Never trust client-supplied owner IDs, roles, subscription states or verification statuses.
- Scope every query by the current user or organization at the data-access layer, so a missing check fails closed.
- Support role combinations (a pharmacist can also own a pharmacy) without letting users grant themselves privileges.
- Admin access is least-privilege and split by duty: support, moderation, verification review, billing, super-admin. Every admin action is audited.
- Test access across users and organizations for every protected endpoint.

## Personal data and Egyptian law

The platform handles national IDs, syndicate cards, CVs, applications and business records.

- Egypt's Personal Data Protection Law No. 151 of 2020 applies; its executive regulations were issued by Ministerial Decree 816 of 2025 (November 2025) with a one-year compliance grace period. Check the current status with the Personal Data Protection Centre (PDPC) before stating obligations.
- Points that need qualified legal review before launch: processing of sensitive data and any licence or permit it requires; cross-border transfer if data is hosted or processed outside Egypt (cloud region, email, SMS, analytics and error-monitoring vendors all count); appointment of a data protection officer; consent wording; breach notification duties; retention periods.
- Collect only what a documented purpose needs. Record the purpose per field.
- Separate tables or modules for: authentication identity, public profile, professional credentials, verification status, verification decisions, admin audit history.
- Provide user flows for consent, access to own data, correction, export and account deletion, with documented exceptions (audit and financial records kept for legal periods, anonymized where possible).
- Do not collect pharmacy customer or patient records in this product without a separately reviewed requirement.
- Never claim compliance from code review alone.

## Identity and professional verification

- National ID: validate the 14-digit format (century digit, YYMMDD birth date, governorate code, sequence, check digit) and that the birth date is plausible. Encrypt at field level with a key held outside the database (KMS or platform secret), store a keyed hash for uniqueness lookups, and display masked (`2**********345`).
- Syndicate membership number and card: store as submitted, treat as an unverified claim.
- Verification states: `unverified`, `pending`, `verified`, `rejected`, `expired`. Only the verification-reviewer role can move to `verified` or `rejected`, always with a reason, reviewer ID and timestamp.
- Document submission is not proof. Show users and counterparties the actual state, never a badge the workflow has not granted.
- Log every view and download of an identity document (who, when, which document).
- Same rule for pharmacy licences and commercial claims on listings: unverified until an authorized review confirms them.

## File uploads and storage

- Private bucket for identity and business documents; public bucket only for approved listing images.
- Access to private files only through short-lived signed URLs (minutes) issued after an authorization check. Never store or return permanent URLs.
- Allow-list types by inspecting file content (magic bytes), not extension or client MIME type. Enforce size and count limits.
- Re-encode images server-side and strip all metadata. Pharmacy photos carry GPS coordinates and device data in EXIF.
- Malware-scan uploads before they become visible to anyone but the uploader.
- Random object keys; never derive paths from user input.

## Abuse and fraud

Sale and rental listings and job posts are fraud targets (fake pharmacies, advance-fee scams, identity harvesting through fake jobs).

- Hide contact details from unverified users; reveal on request and log the reveal.
- First listing or job post from a new account goes to a moderation queue.
- Report, block and takedown flows with reasons and audit trail.
- Rate-limit messaging, applications and listing creation; detect duplicate listings and mass messaging.
- Show the poster's verification state clearly on every listing and job.

## Payments

- Use a hosted checkout or tokenization from the provider (e.g. Paymob, Fawry). Never touch or store raw card data.
- Verify every webhook with the provider's documented signature (HMAC) and reject unsigned or stale events.
- Process webhooks idempotently keyed on the provider's event or transaction ID.
- Subscription state changes only from verified provider events or audited admin action, never from the client.
- Daily reconciliation job compares provider records with local payments and subscriptions and alerts on mismatches.
- Subscription revenue may require tax documents through the Egyptian Tax Authority e-receipt (B2C) or e-invoice (B2B) systems; confirm with the accountant and design the billing module to emit them.

## Application security checklist

- Parameterized queries or ORM only; no string-built SQL.
- Output encoding by default; no unsanitized HTML from users. Sanitize any rich text with an allow-list.
- CSRF protection on cookie-authenticated mutations.
- Security headers: CSP, HSTS, X-Content-Type-Options, frame-ancestors, Referrer-Policy.
- No internal exceptions or stack traces in responses.
- SSRF protection on any server-side URL fetch.
- Dependency scanning in CI; lockfile committed; review new dependencies.

## Secrets

- Secrets live in the hosting platform's secret store or a secrets manager. Never in the repo, never in `.env` files committed to Git, never in logs or error reports.
- Separate credentials per environment. Production credentials are not used locally.
- Rotate keys on staff changes and after any suspected exposure.

## Audit log

Append-only record of: admin and moderator actions, verification decisions, role changes, document access, subscription and payment changes, listing takedowns, data exports and deletions. Store actor, action, target, before/after where relevant, IP and timestamp. Do not store document contents or full IDs in the log.
