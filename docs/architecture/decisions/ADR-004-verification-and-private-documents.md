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

## Implementation notes (4a, added after it was built)

- Job registry `src/shared/jobs/registry.ts`: queue names, queue settings and a Zod payload schema per job; payloads carry ids only. `upload.process` retries 5 times with exponential backoff (10 s up to 5 min, 120 s expiry), then pg-boss copies it to `upload.process.dead`, whose handler deletes both possible objects and marks the upload `rejected` / `processing_failed`. An invalid payload is logged and completed, not retried.
- pg-boss lives in its own `pgboss` schema, installed and upgraded by `pnpm db:migrate` after the Drizzle migrations (also in the test harness); app and worker start with `migrate: false`. The upload row and its job are written in one transaction (pg-boss's Drizzle adapter).
- Worker health: pg-boss's own instance registry (heartbeat every 10 s; `pnpm worker:health`). Not part of `/api/ready`: the web app keeps accepting uploads while the worker is down, and pulling every web instance out of rotation for that would turn a delay into an outage.
- Magic-byte detection is a ~20-line allow-list (`detect.ts`) rather than `file-type`: three signatures, no dependency, and sharp's full decode in the worker is the real gate.
- clamd client: own INSTREAM/PING implementation over `node:net` (timeouts, 20 MB cap, unexpected replies treated as errors so they retry). The npm clients are unmaintained or wrap the binary.
- Multipart is parsed with the platform `FormData` parser behind a byte-counting stream: a declared `Content-Length` over 8 MiB + 64 KiB is refused before reading; a longer stream is cut off there. The file is held in memory (bounded) to sniff and store it.
- Admission before the body is read: 20 attempts per user per hour (Better Auth's `rate_limit` table, key `upload|user|<id>`; refused attempts count) and at most 10 uploads in `processing`, re-checked under a per-user advisory lock when the row is inserted.
- Same-origin check on `POST /api/uploads` (Origin header, else `Sec-Fetch-Site`) on top of SameSite=Lax cookies.
- Keys: `quarantine/<uuid>` (random), output `documents/<same uuid>.jpg`, so a repeated job overwrites the same object; neither key nor the client-visible upload id is derivable from the other. Clients see the upload id, status and reason code only.
- Re-encode: sharp, EXIF orientation applied, fit inside 2,400 px, alpha flattened on white, JPEG quality 85 (mozjpeg), all metadata dropped, 50-megapixel input limit against decompression bombs, `failOn: warning` (truncated files are refused).
- `issueSignedUrl` takes a `ViewAuthorizer` from the caller and calls it only for a clean upload of the expected purpose, right before presigning, so 4b's authorizer can check the reviewer role and write `document_access_log` for real views only. 4a ships `ownerMayView`; there is no view route yet.
- Integration tests run real Postgres, MinIO and clamd through Testcontainers. EICAR cannot pass the image signature check, so the infected path replaces a quarantined object with EICAR before the scan; a directly uploaded EICAR file is refused with 415.
- Known limits: presigned URLs use `S3_ENDPOINT`, which must be reachable by browsers in production (or a separate public endpoint must be added); objects of deleted accounts are not removed yet (rows cascade; deletion job waits for counsel, see Retention); a crash between storing the quarantine object and committing the row leaves an orphan, which a `quarantine/` lifecycle rule must expire.

## Implementation notes (4b, added after it was built)

- Crypto (`src/shared/crypto/field-encryption.ts`): Node `crypto` only. AES-256-GCM with a random 96-bit IV and 128-bit tag; stored as `v1.<keyId>.<iv>.<ciphertext>.<tag>` (base64url), so the format can be versioned and the key named. The key id is the first 16 hex characters of a domain-separated SHA-256 of the key (no hand-maintained ids). The owner's user id is bound as additional authenticated data, so a ciphertext copied into another user's row does not decrypt. Rotation: `NATIONAL_ID_ENCRYPTION_PREVIOUS_KEYS` keeps old keys decrypt-only; a re-encryption job is still to be written (the submission trigger forbids changing the stored ID today, so that job will come with its own reviewed migration). Uniqueness: HMAC-SHA256 under `NATIONAL_ID_HASH_KEY` with a domain string; the two keys must differ.
- Keys are not in the general env schema: only code that touches national IDs loads them (`getNationalIdKeys`), failing with the variable name. The worker never needs them. The `.env.example` values repeat one byte and are refused unless `APP_URL` is localhost.
- National ID check: Western, Eastern Arabic and Persian digits; spaces, dashes and bidi marks dropped. Age 17-90 on today's date in Africa/Cairo. Governorate codes 01-04, 11-19, 21-29, 31-35, 88, from the Wikipedia "Egyptian National Identity Card" table and two independent ID-parsing references that agree; no Civil Status Organization publication was found. Check digit not validated.
- Uniqueness: a partial unique index on the hash for `pending` and `verified`. Because a user has at most one pending submission and a verified user cannot submit again (ADR rule), only a second account can collide; a rejected or expired submission frees the ID, also for its own user. The service checks first and answers `national_id_in_use` only; the index is the backstop. Submissions are serialized per user with an advisory lock.
- `verification_document.upload_id` references `upload` with a foreign key (integrity only; reads still go through the uploads service's `findOwnUploads`). It is `DEFERRABLE INITIALLY DEFERRED` (hand edit in migration 0004): deleting a user cascades to both tables, and a non-deferred check fires mid-cascade. Each upload backs at most one document (unique), so photos are not reused across submissions.
- Append-only: triggers on `verification_decision` and `document_access_log` refuse UPDATE, DELETE and TRUNCATE from any statement. Foreign-key actions are allowed (`pg_trigger_depth() >= 2`, verified on PostgreSQL 18): cascade delete with the user's account, and nulling the reviewer/actor column when a staff account is deleted (only that column may change). A role with DDL rights could drop the triggers; production must run the app as a role without DDL (database reference). A second trigger enforces the submission state machine and keeps the owner, claims and national ID fields immutable.
- One decision per submission (unique). `decide` locks the submission `FOR UPDATE`; of two concurrent reviewers exactly one wins, the other gets `not_pending` (tested).
- Reveal of the decrypted ID is logged in `document_access_log` (action `reveal_national_id`, no document) rather than a separate table: it is access to the same identity document, by the same reviewers, under the same retention question; one table answers "who saw this person's ID". `getSubmissionForReview` returns the masked form only; the clear value needs the explicit, logged `revealNationalId`.
- Document view: `GET /api/verification/documents/<id>` (same-origin only by Fetch Metadata) runs `viewDocument`, whose `ViewAuthorizer` locks the submission (`FOR SHARE`), re-checks role, MFA, not-own and pending, and inserts the `view` row in that transaction before `issueSignedUrl` presigns; the route answers 303 to the URL with `Cache-Control: no-store` and `Referrer-Policy: no-referrer`, and the `<img>` tags carry `referrerpolicy="no-referrer"`. The CSP `img-src` gains the origin of `S3_ENDPOINT` (the 4a limit "an S3 endpoint the browser can reach" applies). Decided submissions' documents and IDs are closed even to reviewers.
- Reason codes: approve `documents_match`; reject `document_unreadable`, `document_missing_or_wrong`, `details_mismatch`, `credential_not_confirmed`, `card_expired`, `other` (database CHECK pairs them with the decision). The user sees the localized reason; the reviewer's note (up to 500 characters) stays internal and is not exported (question 9 for counsel).
- Emails: job `verification.notify` (`{submissionId, kind}`), enqueued in the same transaction as the submission or decision; the worker renders Arabic or English (the page locale at submission, stored on the row) with the shared email layout and sends through `EmailSender`. 8 retries with backoff up to 15 minutes, then `verification.notify.dead` logs the failure. A retry after an unacknowledged send can deliver twice.
- Expiry: `verification.expire`, a pg-boss schedule (`17 0 * * *`, Africa/Cairo) registered by the worker at start (the worker instance now runs with `schedule: true`; pg-boss lets one instance claim each cron pass). Marks `verified` submissions whose `card_expires_on` is before today in Cairo as `expired`. No email for expiry yet.
- Consent: the form shows a placeholder text and a visible "pending counsel wording" label (message keys `Verification.consentText` and `consentPendingBadge`); the accepted version (`draft-pending-counsel`) is stored on each submission.
- User-facing state: `getMyVerificationStatus` (latest submission; `canSubmit` for unverified, rejected, expired) and `getVerificationBadge` ("verified" only when the latest submission is verified), used by `/verification`, `/profile` and `/profiles/<id>`. The data export (`exportOwnData`) gains `verification`: status, claims, masked ID, document kinds, decision and reason code; never ciphertext, hash, key id, photos, note or reviewer.
- E2E runs no worker and no clamd: `e2e/worker-helpers.ts` (test-only) runs the real `processUpload` with a stub scanner for exactly the test's own uploads, and the real email job code against Mailpit. Integration tests use real PostgreSQL and MinIO with the same stub scanner.
- Known limits: the reviewer sees no name to compare with the card (profiles' display name is editable and unverified; a name lock or name field on the submission is a product decision for a later step); a verified student who graduates cannot submit as a pharmacist until verification expires (needs an "upgrade" rule); the queue uses offset pages; access logs and decisions are deleted with the user's account until counsel answers retention.

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
