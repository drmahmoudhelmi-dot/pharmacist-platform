# ADR-004: Professional verification and private documents (milestone 1, step 4)

- Status: Accepted
- Date: 2026-10-20
- Deciders: principal engineer (delegated authority; product owner informed)

## Context

The platform's trust rests on knowing that a user is a real pharmacist or pharmacy student. Users submit their national ID number and photos of their national ID and syndicate (or student) card; a verification reviewer approves or rejects. This is the most sensitive data the product holds. The skill requires field-level encryption with a key outside the database, a keyed hash for uniqueness, masked display, private storage with short-lived signed URLs, content-based type checks, re-encoding with metadata stripped, malware scanning before anyone else sees a file, a log of every document view, and reviewer-only decisions with reason, reviewer and time.

Delivered in two pull requests: 4a (background worker and private upload pipeline) and 4b (verification workflow and reviewer queue).

## Decision

### 4a. Worker and upload pipeline

| Concern | Choice |
|---|---|
| Background jobs | pg-boss (queue in PostgreSQL, ADR-001) in a separate `worker` process from the same codebase (`pnpm worker`). Jobs are idempotent and retried with backoff; failures land in a dead-letter state and are logged with ids only. |
| Accepted files | Images only at launch: JPEG, PNG, WebP, detected from content (magic bytes), never from extension or client MIME type. Max 8 MB each. PDFs are not accepted (cannot be safely re-encoded); phones produce photos. |
| Upload path | The browser posts the file to an authenticated server route; the server checks size and type, stores it under a random key in the private bucket's `quarantine/` prefix, records an `upload` row (`processing`), and enqueues a job. Object keys are random UUIDs, never derived from user input. |
| Processing job | ClamAV scan (clamd service; local compose service, production service on the chosen host) → on clean, re-encode with sharp to JPEG (max 2,400 px on the long side, all metadata stripped, orientation applied) → store under `documents/` → delete the quarantine object → mark `clean`. Infected or undecodable files are deleted and marked `rejected` with a reason code. |
| Access | Private objects are read only through presigned GET URLs valid for 5 minutes, issued after an authorization check. Permanent URLs are never stored or returned. |
| Storage | The public bucket is untouched by this step. Private-bucket versioning is a production requirement (operations reference), configured with the host. |

### 4b. Verification workflow

| Concern | Choice |
|---|---|
| Tables (module `verification`) | `verification_submission` (status, credential type, claims, encrypted national ID), `verification_document` (links a submission to clean uploads by kind), `verification_decision` (append-only: reviewer, decision, reason code, note, time), `document_access_log` (append-only: document, actor, action, time, IP). |
| Credential types | `pharmacist` (national ID front and back + syndicate card + syndicate membership number) and `student` (national ID front and back + student card + university). |
| States | `pending` → `verified` or `rejected` (reviewer only); `verified` → `expired` (worker job when the card expiry date the user entered passes, if given). No submission row = unverified. At most one `pending` submission per user (partial unique index). After `rejected` or `expired` the user may submit again. |
| National ID | Format check: 14 digits, century digit 2 or 3, valid YYMMDD birth date (age 17–90), governorate code from the official list. The final check digit is not validated: no official algorithm is published. Encrypted with AES-256-GCM (Node `crypto`, random 96-bit IV, key id stored for rotation) using `NATIONAL_ID_ENCRYPTION_KEY` from the secret store; uniqueness via HMAC-SHA256 with a separate `NATIONAL_ID_HASH_KEY`; displayed masked (`2**********345`). The plaintext is decrypted only for a reviewer viewing a pending submission and is never logged or exported. |
| Uniqueness | The same national ID cannot back two verified or pending submissions from different users (enforced with the hash; message says "already used", nothing more). |
| Reviewer | Role `verification_reviewer` with staff MFA (ADR-002). Cannot review their own submission. Queue at `/staff/verification`, oldest first. Decisions require a reason code; rejections also show the user a localized reason. Every document view goes through a route that writes `document_access_log` before issuing the signed URL. |
| User-facing state | Profiles and (later) jobs show the real state from the latest submission: verified badge only for `verified`. Submission is not proof. |
| Notifications | User gets an email on submission received, verified and rejected (through the worker). |
| Retention | Documents and ciphertext of rejected submissions are kept until counsel answers question 6 (data-protection status); then a deletion job is added. Nothing is deleted automatically in this step. |

## Alternatives considered

- Presigned direct-to-bucket uploads: rejected for launch; the server cannot inspect content before the object exists, and quarantine plus the job already gives the same safety with simpler permissions. Revisit if upload volume strains the app servers.
- Database `pgcrypto` encryption: rejected; the key would travel with queries into the database, while the skill requires a key held outside it.
- Accepting PDFs: rejected; cannot be re-encoded safely and can carry active content.
- Third-party KYC provider: rejected for now; sends identity documents to a vendor (cross-border question) and costs per check. Revisit after counsel's answer.

## Consequences

- Security: a database dump alone does not reveal national IDs; documents are never public; every view is attributable.
- Operations: a worker process and a ClamAV service must run in every environment; key rotation needs a re-encryption job (key id column supports it).
- Cost: ClamAV needs about 1–2 GB of memory on the host.
- Reversibility: medium; new tables and objects only, but encrypted data depends on keeping the keys.

## Revisit when

- Counsel answers retention (add deletion job) or allows a KYC vendor.
- A pharmacy licence verification is needed for organizations (step 5 may reuse this pipeline).
- Upload volume justifies direct-to-bucket uploads.
