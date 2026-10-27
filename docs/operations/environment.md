# Environment variables and secrets

This page lists every environment variable the platform reads, per service. It never contains real values. Placeholders and the way to generate or obtain each value are given instead.

Sources: `src/shared/config/env.ts` (validated, fails fast), `src/modules/verification/keys.ts` (national ID keys), `src/proxy.ts`, `src/shared/logging/logger.ts`, `src/shared/db/migrate.ts`, `worker/index.ts`, `worker/health.ts`, `src/modules/identity/cli/role-admin.ts`, `Dockerfile` and `staging.env.example`.

## Services

| Service | Image target | What it runs | Variables it needs |
| --- | --- | --- | --- |
| web | `web` | Next.js standalone server, port 3000 | The web table below |
| worker | `worker` | pg-boss queues and daily schedules, sharp, clamd client | The worker table below |
| migrate | `migrate` | One-shot: Drizzle migrations, then pg-boss schema and queues | `DATABASE_URL` only |

Notes that apply to all services:

- Validation runs when a variable is first used at runtime, not at build time. `next build` and the image build need no variables.
- Error messages name the offending variable, never its value.
- A value that contains spaces, quotes or angle brackets (for example `EMAIL_FROM`) must be quoted in an env file. Secret stores that take raw values need no quotes.
- Operator tools run from the `migrate` image (it has the same contents as the worker): `worker:health` and `admin:grant-role` need only `DATABASE_URL`.

## Web

| Name | Required, default | What it does | Secret | How to generate or obtain | What breaks if it is wrong |
| --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` | Required, no default | PostgreSQL connection string, for example `postgres://<user>:<password>@<host>:5432/<db>`. Add `?sslmode=require` when the provider demands TLS (provider-specific). | Yes (contains the password) | Provider-specific: create an application role with its own password in the managed database. Use a role that owns the schema objects (migrations create tables, triggers, functions). | The app cannot start requests that touch data. `/api/ready` returns 503 with `db: false`. A role without create rights makes the migrate step fail. |
| `S3_ENDPOINT` | Required, URL, no default | Base URL of the S3 API. Used by the server for reads and writes and as the host of presigned URLs that reviewers open in the browser. Its origin is added to the CSP `img-src` by `src/proxy.ts` at request time. | No (but see the browser-reachable rule below) | Provider-specific: the S3-compatible endpoint of the object storage service. Use path-style addressing (the client sets `forcePathStyle`). | If the browser cannot reach it, reviewers see broken document photos. If it differs from the host the browser uses, the presigned signature or the CSP fails. If it is unreachable from the server, uploads fail and `/api/ready` returns `storage: false`. |
| `S3_REGION` | Required, no default | Region used to sign requests. | No | Provider-specific. Many S3-compatible services accept any value such as `us-east-1`; others need their own region id. | Signature errors (403) on every storage call. |
| `S3_ACCESS_KEY_ID` | Required, no default | Access key for the storage service. | Yes | Provider-specific: create a service account limited to the two buckets (no console access, no bucket administration). | Storage calls return 403. Readiness fails. |
| `S3_SECRET_ACCESS_KEY` | Required, no default | Secret for the access key above. | Yes | Shown once when the key is created. Store it in the secret store immediately. | Same as above. |
| `S3_PRIVATE_BUCKET` | Required, no default | Bucket for quarantined uploads and clean verification documents. Must be private, with versioning on. | No (a name) | Create it in the provider console or CLI. See the runbook, prerequisites. | `/api/ready` returns 503. Uploads and document viewing fail. A public or unversioned bucket is a security and recovery failure that no check in the app detects. |
| `S3_PUBLIC_BUCKET` | Required, no default | Name of the public bucket. The current code validates it but does not read it anywhere (nothing is stored there yet). | No | Create an empty bucket, or any valid name if the provider needs none yet. | Only a missing value stops the app from starting. |
| `SMTP_HOST` | Required, no default | Host of the SMTP relay. The web app builds the sender for sign-up and reset emails. | No | Provider-specific: the transactional email provider's relay host. | Verification and reset emails are not delivered. Sign-up cannot be completed. |
| `SMTP_PORT` | Required, integer 1-65535 | Port of the relay. Port 465 uses implicit TLS. Other ports use STARTTLS when the server offers it. | No | Provider-specific, usually 587 or 465. | Connection timeouts (10 s) and failed emails. |
| `LOG_LEVEL` | Optional, `info` | One of `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`. Read by the logger directly from the environment. | No | Choose `info` for staging and production. | An unknown value may make the logger fail at start. `debug` and `trace` produce large volumes; never use them with real data. |
| `APP_URL` | Required, URL, no default | Public origin of the app, for example `https://staging.<domain>`. Better Auth uses it as base URL (plus `/api/auth`) and as the only trusted origin. Email links, the same-origin check on uploads and the secure-cookie decision follow it. Also decides whether the placeholder national ID keys are refused. | No | The DNS name given to the web service, with `https://` and no trailing path. | The browser must be able to open it. A wrong or `http://` value breaks sign-in (origin check, cookies), makes email links point at the wrong place and disables the secure cookie flag. A `localhost` value on a real host also lets placeholder national ID keys through, so never use it there. |
| `BETTER_AUTH_SECRET` | Required, at least 32 characters | Signs session cookies and tokens, encrypts TOTP secrets and keys the hashes used by the rate limiter and TOTP replay protection. | Yes | `openssl rand -base64 32` | See "BETTER_AUTH_SECRET" below. A value under 32 characters stops the app from starting. |
| `EMAIL_FROM` | Required, at least 3 characters | Sender of all emails, an RFC 5322 address, for example `"<display name>" <no-reply@<domain>>`. | No | Use an address on the domain that has SPF, DKIM and DMARC set up. | Mail is rejected or lands in spam when the domain is not authorized at the provider. |
| `AUTH_BREACHED_PASSWORD_CHECK` | Optional, `true` | `true` or `false` (other strings fail validation). Turns the Have I Been Pwned range check on sign-up and password reset on or off. | No | Leave it unset or `true` outside tests and offline rehearsals. | `false` accepts passwords known from breaches. With `true`, the host needs outbound HTTPS to the Have I Been Pwned API. |
| `NATIONAL_ID_ENCRYPTION_KEY` | Required where national IDs are handled (verification), no default | AES-256-GCM key that encrypts the national ID number. 32 bytes, base64. Loaded on first use, not at start. | Yes, the most sensitive one | `openssl rand -base64 32` | See "National ID keys" below. A missing or malformed key fails the verification request with the variable name in the log. |
| `NATIONAL_ID_HASH_KEY` | Required where national IDs are handled, no default | HMAC-SHA256 key behind the one-account-per-national-ID check. 32 bytes, base64, different from the encryption key. | Yes | `openssl rand -base64 32` | See below. Never change it. |
| `NATIONAL_ID_ENCRYPTION_PREVIOUS_KEYS` | Optional, empty | Comma-separated older encryption keys. They decrypt only. Used during a rotation. | Yes | Previous values of `NATIONAL_ID_ENCRYPTION_KEY`. | A key missing from the list makes the rows it encrypted unreadable. |
| `NODE_ENV` | Set by the image (`production`) | Next.js mode. Also decides whether the CSP allows development scripts. | No | Do not set it. | Do not override it. |
| `PORT`, `HOSTNAME` | Set by the image (`3000`, `0.0.0.0`) | Where the standalone server listens. The container health check reads `PORT`. | No | Change only if the platform requires another port. | A mismatch with the platform's port mapping makes every health check fail. |
| `NEXT_TELEMETRY_DISABLED` | Set by the image (`1`) | Disables Next.js telemetry. | No | Do not change. | None. |

Notes for the web service:

- The web service does not need `CLAMAV_HOST` or `CLAMAV_PORT`.
- The client IP for rate limits and the audit log comes from the `X-Forwarded-For` request header, not from a variable. See "Proxy requirement" below.

## Worker

The worker validates the same base variables as the web service plus ClamAV. It never loads the national ID keys and must not receive them.

| Name | Required, default | What it does | Secret | How to generate or obtain | What breaks if it is wrong |
| --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` | Required | Same database as the web service. pg-boss keeps its queues in the `pgboss` schema of this database. | Yes | As for web. | The worker exits at start (it retries the connection five times first). Jobs are not processed, so uploads stay `processing` and no emails leave. |
| `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PRIVATE_BUCKET`, `S3_PUBLIC_BUCKET` | Required | Same values as web. The worker reads quarantined files, writes the re-encoded JPEG under `documents/` and deletes the quarantine object. | Keys: yes | As for web. | Uploads end as `processing_failed` after the retries and land in `upload.process.dead`. |
| `SMTP_HOST`, `SMTP_PORT`, `EMAIL_FROM` | Required | The worker sends all notification emails (verification, organization invitations, applications, jobs, account). | No | As for web. | Notification jobs retry, then go to their dead-letter queue. Users get no emails. |
| `APP_URL` | Required | Base for links inside emails. A trailing slash is removed. | No | Same value as web. | Email links point at the wrong place. |
| `BETTER_AUTH_SECRET` | Required (the shared schema demands it, 32 characters or more) | The worker does not use it for sessions, but it must be present and valid. | Yes | Use the same value as web. | The worker refuses to start. |
| `AUTH_BREACHED_PASSWORD_CHECK` | Optional, `true` | Validated only. | No | Same value as web. | Only an invalid string stops start-up. |
| `LOG_LEVEL` | Optional, `info` | As for web. | No | As for web. | As for web. |
| `CLAMAV_HOST` | Required, no default | Host of the clamd service. | No | The service name or address of the clamd container. | The scan fails, uploads retry and end as `processing_failed`. The worker still starts, and its health check still passes. |
| `CLAMAV_PORT` | Required, integer 1-65535 | clamd TCP port, normally 3310. | No | Default clamd port. | As above. |
| `NODE_ENV` | Set by the image (`production`) | Runtime mode. | No | Do not set. | None. |

Worker health check (set by the image): `node_modules/.bin/tsx worker/health.ts --this-host`. It needs only `DATABASE_URL`.

## Migrate

| Name | Required, default | What it does | Secret | How to generate or obtain | What breaks if it is wrong |
| --- | --- | --- | --- | --- | --- |
| `DATABASE_URL` | Required | Database to migrate. Drizzle migrations run first in schema `public`, then pg-boss installs or upgrades its `pgboss` schema and creates the queues. Both steps are idempotent. | Yes | As for web. Use a role that may create tables, functions, triggers and the `pg_trgm` extension. | Exit code 1 with a message. The release must stop: do not start the new web or worker. |

Other variables are not needed by migrate. The image runs `node_modules/.bin/tsx src/shared/db/migrate.ts` in the working directory `/app`, where the `db/migrations` folder lives.

## Operator tools

| Tool | Command in the `migrate` image | Needs |
| --- | --- | --- |
| Grant or revoke a staff role | `node_modules/.bin/tsx src/modules/identity/cli/role-admin.ts grant <email> <role>` (or `revoke`) | `DATABASE_URL` |
| Worker health | `node_modules/.bin/tsx worker/health.ts [--this-host]` | `DATABASE_URL` |

The `pnpm` scripts in `package.json` wrap the same commands. The images do not contain pnpm, so inside a container use the `tsx` commands above. On a machine with the repository checked out, `pnpm admin:grant-role` reads `.env` if it exists.

## National ID keys

Two independent keys protect the national ID number (ADR-004, 4b). Both are 32 random bytes in base64 (44 characters, ending with `=`).

| Rule | Detail |
| --- | --- |
| Format | Base64 or base64url text that decodes to exactly 32 bytes. Generate with `openssl rand -base64 32`. |
| Two different keys | `NATIONAL_ID_HASH_KEY` must differ from `NATIONAL_ID_ENCRYPTION_KEY` and from every previous key. The app refuses to load otherwise. |
| No placeholders | A key whose 32 bytes are all the same byte (the `.env.example` values) is refused unless `APP_URL` is localhost. |
| Where they live | The web service only. The worker and migrate must not receive them. |
| Stored format | Ciphertext is `v1.<keyId>.<iv>.<ciphertext>.<tag>`. The key id names the key that encrypted the value, so a rotation can keep older rows readable. |
| Binding | The ciphertext is bound to its owner (user id). A value copied into another user's row does not decrypt. |

Encryption key rotation (details in the runbook, "Rotating secrets"):

1. Generate a new key.
2. Put the old key into `NATIONAL_ID_ENCRYPTION_PREVIOUS_KEYS` (append it to the list if one exists).
3. Put the new key into `NATIONAL_ID_ENCRYPTION_KEY`.
4. Redeploy the web service. New values use the new key. Old values stay readable.
5. Remove an old key from the list only after every row that it encrypted has been re-encrypted. No re-encryption script exists today (see the follow-up list in the runbook), so do not remove old keys.

Hash key:

- Never change `NATIONAL_ID_HASH_KEY`. The duplicate check compares stored HMACs. A new key makes every old hash unmatchable, so one national ID could be registered again under another account.
- A change is possible only with a tool that recomputes every hash from the decrypted national IDs. No such tool exists today.
- If the hash key leaks, treat it as an incident and plan the re-hash with the product owner.

Backup and loss:

- Losing the encryption key makes every stored national ID permanently unreadable. Reviewers could not reveal IDs, and the data export would lose them.
- The database backup does not contain the keys. Keep a separate encrypted backup of the encryption key (and of the hash key and any previous keys). See "Secrets handling".

## BETTER_AUTH_SECRET

One secret has four jobs, so rotating it has four effects:

| Use | Effect of changing the value |
| --- | --- |
| Signs session cookies and tokens | Every signed-in user is signed out. Pending verification and reset links stop working. |
| Encrypts TOTP secrets | Stored TOTP secrets can no longer be decrypted. Every staff member and every user with two-step verification would lock out of the second step. Recovery means resetting two-step verification for each account by hand. |
| Keys the hashes of rate-limit identifiers | Existing limiter rows no longer match. Limits restart from zero for a short window. |
| Keys TOTP replay protection | Claims made in the last 90 seconds are lost. Low impact. |

The TOTP effect makes this secret effectively never rotated without a written plan. A plan needs a way to re-encrypt the TOTP secrets under the new secret, or an agreed reset of two-step verification for all accounts. No tool exists for either today. Treat the secret like the national ID encryption key: back it up separately and encrypted.

If the secret leaks, rotate it anyway. Sign everyone out, reset staff two-step verification and tell the product owner.

## APP_URL and S3_ENDPOINT

| Variable | Who must reach it | Why |
| --- | --- | --- |
| `APP_URL` | Browsers | It is the public site address. Cookies, the origin check and email links depend on it. |
| `S3_ENDPOINT` | Browsers and the web and worker containers, under the same name | Reviewers open 5-minute presigned URLs that start with this endpoint. A signature is bound to the host, so an internal name for the server and a different public name for the browser does not work. |

- Use TLS (`https://`) for both on staging and production.
- The image CSP adds the origin of `S3_ENDPOINT` to `img-src`. The proxy reads the variable at request time, so a change needs a restart of the web service, not a rebuild.
- The storage bucket may also need a CORS or network rule for the reviewer's origin (provider-specific). Verify it by opening a document photo as a reviewer.

## Proxy requirement (X-Forwarded-For)

Rate limits, the TOTP session checks, the document access log and the admin audit log use the first entry of `X-Forwarded-For`. Next passes a client-supplied value through. The reverse proxy in front of the web service must overwrite the header with the real client address, not append to it. Otherwise a client can choose its own address, evade per-IP limits and falsify the audit log. Per-email limits apply in any case. Check this after every proxy change (runbook, smoke checks).

## ClamAV

| Item | Detail |
| --- | --- |
| Variables | `CLAMAV_HOST`, `CLAMAV_PORT` on the worker only. |
| Image | `clamav/clamav:1.5.4` (local and staging rehearsal). |
| Memory | About 1.5 GB. Signatures load in 20 to 60 seconds; allow a start period of 180 seconds. |
| Signature updates | `CLAMAV_NO_FRESHCLAMD=true` turns freshclam off. Use it only for offline rehearsals. On staging and production leave it unset or `false` so signatures update. |
| Network | clamd has no authentication. Expose port 3310 only to the worker, never to the internet. |
| Failure mode | If clamd is down or slow, scans fail, uploads retry, then end in `upload.process.dead` and are marked `processing_failed`. Users must upload again. |
| Freshness | Stale signatures do not break anything visibly. Monitor them (runbook, monitoring). |

## SMTP

| Item | Detail |
| --- | --- |
| Variables | `SMTP_HOST`, `SMTP_PORT`, `EMAIL_FROM` on web and worker. |
| Transport | Port 465 implicit TLS. Other ports: STARTTLS when the server offers it. Timeouts: 10 s connect, 10 s greeting, 20 s socket. |
| Authentication | The code has no SMTP user or password variable. A relay that requires authentication does not work yet. See the follow-up list in the runbook. |
| Domain | SPF, DKIM and DMARC on the sending domain, set at the DNS provider and the email provider (provider-specific). |
| Staging | Use a sandbox account or a relay that accepts only listed recipients. Rehearsals use Mailpit, which keeps all mail locally. |
| Privacy | The provider receives recipient addresses and message text. It is a processor; counsel must confirm the agreement. |

## Secrets handling

| Topic | Rule |
| --- | --- |
| Where secrets live | In the host's secret store only. Never in an image, a Dockerfile, a compose file in the repo, CI logs, tickets or chat. Never in the repository: `staging.env.example` and `.env.example` hold placeholders only. |
| Which values are secrets | `DATABASE_URL`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `BETTER_AUTH_SECRET`, `NATIONAL_ID_ENCRYPTION_KEY`, `NATIONAL_ID_HASH_KEY`, `NATIONAL_ID_ENCRYPTION_PREVIOUS_KEYS`, and any SMTP credential added later. |
| How they reach containers | The platform injects them as environment variables at start, from the secret store (provider-specific: for example a secret reference in the service definition). Each service gets only what it needs: no national ID keys for the worker or migrate, no ClamAV variables for the web service. A local file such as `staging.env` exists only for the local rehearsal, is git-ignored and holds throwaway values. |
| Images | The same image runs on every environment. No secret is baked in; `next build` needs none. The `.dockerignore` excludes `.env` files. |
| Who may read them | Production: the product owner and the named operators, by role in the secret store, with access logging on. Staging: the operators. Developers and agents never need production values. CI holds no deploy secrets until a deploy pipeline is approved. |
| Creating them | Generate on the operator's machine or in the secret store with `openssl rand -base64 32`. Do not generate in a shared terminal that records history, and never paste a secret into an AI chat. |
| Separate backup of the national ID keys | Keep an encrypted copy of `NATIONAL_ID_ENCRYPTION_KEY` (and the hash key and previous keys) in a different place and account from the database and its backups, for example an encrypted file in a second vault with two named holders. Test that the copy opens. Update it at every rotation. A restore drill checks that a restored database can decrypt a sample row with the backed-up key. |
| Rotation | Follow the runbook. Rotate at once if a value appears in a log, a repository, a ticket or a chat. Rotate storage and SMTP credentials when a person with access leaves. |
| Different per environment | Staging and production never share a secret. A staging key must never decrypt production data, and production data never goes to staging. |
| Detection | CI runs gitleaks on every pull request. The logger redacts known fields, but that is a backstop. |

## Checklist before the first start of a service

- Every required variable for the service is set from the secret store.
- `APP_URL` and `S3_ENDPOINT` are `https://` and open in a browser.
- National ID keys are real random values, different from each other, with a separate encrypted backup.
- `AUTH_BREACHED_PASSWORD_CHECK` is unset or `true`.
- `CLAMAV_NO_FRESHCLAMD` is unset or `false` for the clamd service.
- The worker does not hold the national ID keys.
