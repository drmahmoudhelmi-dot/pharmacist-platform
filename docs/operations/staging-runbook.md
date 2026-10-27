# Staging runbook

This runbook is for the operator of the staging environment. It follows ADR-010 (hosting and staging) and the operations reference of the architect skill. Every variable is described in [environment.md](environment.md).

Conventions:

- `<angle brackets>` mark values the operator fills in. They are never real secrets in this file.
- "Provider-specific" marks a step whose exact commands depend on the hosting provider. ADR-010 recommends Huawei Cloud, Cairo region, for staging, but the decision is reserved for the product owner and is not final.
- Commands run on the operator's machine unless stated. Container tools can be `docker` or the provider's equivalent.

## Rules

- Staging holds synthetic data only. Never type, import or copy real personal data into it.
- Never copy production data, a production backup or a production secret to staging, to a laptop or to a scratch database.
- Staging and production never share a secret, a bucket or a database.
- Production deploys, production migrations and production data operations need the explicit approval of the product owner every time.
- Spending money, opening accounts and signing contracts (provider, email, domain) are reserved to the product owner.
- Never claim regulatory compliance. Legal questions go to Egyptian counsel through the product owner.

## 1. Prerequisites

Complete these once, before the first deploy. The product owner provides the accounts, budget and domain (ADR-010, "What the product owner provides").

| # | Item | Requirement | Check |
| --- | --- | --- | --- |
| 1 | Provider decision | ADR-010 accepted (Option A for staging, or the product owner's choice). Provider account and budget exist. | The ADR status is Accepted. |
| 2 | Domain and DNS | A sub-domain such as `staging.<domain>` with DNS access. | `dig +short staging.<domain>` returns the load balancer address (after step 3). |
| 3 | TLS and reverse proxy | TLS certificate for the sub-domain. A proxy or load balancer that terminates TLS, forwards to the web service on port 3000 and overwrites `X-Forwarded-For` with the real client address (replace, never append). Redirects http to https. Provider-specific. | See the proxy check in section 4. |
| 4 | Managed PostgreSQL | Version 18 (or a version the tests were run against). Extension `pg_trgm` allowed. An application role that can create tables, functions and triggers. Automated daily backups and point-in-time recovery (PITR) with at least 7 days of retention. Provider-specific. | `select version();` and `create extension if not exists pg_trgm;` succeed. |
| 5 | Object storage | S3 API reachable by browsers over TLS (presigned URLs). Path-style addressing. Two buckets: private (versioning on, no public access) and public. A service account limited to those buckets. Provider-specific. | See "Bucket setup" below. |
| 6 | Quarantine lifecycle rule | On the private bucket: expire objects with prefix `quarantine/` after 1 day. Also expire noncurrent versions of `quarantine/` objects after 1 day. Provider-specific. | The rule shows in the console or in `get-bucket-lifecycle-configuration`. |
| 7 | clamd | A clamd service with freshclam on, about 1.5 GB of memory, port 3310 reachable from the worker only. Image `clamav/clamav:1.5.4`, `CLAMAV_NO_FRESHCLAMD` unset or `false`. | `docker exec <clamav> clamdcheck.sh` exits 0. |
| 8 | SMTP | A transactional email provider in sandbox or test mode. SPF, DKIM and DMARC records on the sending domain. Note: the code has no SMTP user or password variable (follow-up F2), so the relay must accept the platform's network or work without authentication until that is built. | The provider's domain verification shows SPF, DKIM and DMARC as passing. |
| 9 | Container registry | A private registry the hosts can pull from. Provider-specific. | `docker login <registry>` succeeds. |
| 10 | Secret store | A place for the secrets listed in environment.md, with per-service access. | See "Secrets handling" in environment.md. |
| 11 | Run places | Three run targets: web (always on), worker (always on, stop grace 40 s or more), migrate (one-off task). Health checks as in section 4. | Provider-specific. |
| 12 | Alert recipients | The product owner names who receives alerts (ADR-010). | A named list exists. |

Bucket setup (S3 API commands; the AWS CLI works with any S3-compatible service when `--endpoint-url` is set; provider-specific details may differ):

```bash
export AWS_ACCESS_KEY_ID=<admin-access-key>        # an administrative key, only for this one-off setup
export AWS_SECRET_ACCESS_KEY=<admin-secret>        # taken from the secret store, never typed into shared history
export ENDPOINT=<s3-endpoint>
export PRIVATE_BUCKET=<private-bucket>
export PUBLIC_BUCKET=<public-bucket>

aws --endpoint-url "$ENDPOINT" s3api create-bucket --bucket "$PRIVATE_BUCKET"
aws --endpoint-url "$ENDPOINT" s3api create-bucket --bucket "$PUBLIC_BUCKET"
aws --endpoint-url "$ENDPOINT" s3api put-bucket-versioning --bucket "$PRIVATE_BUCKET" \
  --versioning-configuration Status=Enabled
aws --endpoint-url "$ENDPOINT" s3api put-public-access-block --bucket "$PRIVATE_BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
cat > lifecycle.json <<'JSON'
{
  "Rules": [
    {
      "ID": "expire-quarantine",
      "Status": "Enabled",
      "Filter": { "Prefix": "quarantine/" },
      "Expiration": { "Days": 1 },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 1 }
    }
  ]
}
JSON
aws --endpoint-url "$ENDPOINT" s3api put-bucket-lifecycle-configuration \
  --bucket "$PRIVATE_BUCKET" --lifecycle-configuration file://lifecycle.json
aws --endpoint-url "$ENDPOINT" s3api get-bucket-versioning --bucket "$PRIVATE_BUCKET"
```

Then create a service account (provider-specific) with read, write, delete and list rights on the two buckets only. Its key pair becomes `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` in the secret store. Delete the administrative key from the shell and the console when the setup is done.

Generate the application secrets (on the operator's machine, straight into the secret store):

```bash
openssl rand -base64 32   # BETTER_AUTH_SECRET
openssl rand -base64 32   # NATIONAL_ID_ENCRYPTION_KEY
openssl rand -base64 32   # NATIONAL_ID_HASH_KEY (a different value from the line above)
```

Make the separate encrypted backup of the two national ID keys now (environment.md, "Secrets handling").

## 2. First deploy

Run the numbered steps in order. Stop at the first failure.

### 2.1 Build and push the images

All three images come from one Dockerfile. Tag them with the git SHA of the commit that CI passed on, never with `latest`.

```bash
git fetch origin
git checkout <commit-that-passed-ci>
export GIT_SHA=$(git rev-parse --short=12 HEAD)
export REGISTRY=<registry>/<namespace>

docker build --target web     -t "$REGISTRY/pharma-web:$GIT_SHA"     .
docker build --target worker  -t "$REGISTRY/pharma-worker:$GIT_SHA"  .
docker build --target migrate -t "$REGISTRY/pharma-migrate:$GIT_SHA" .

docker push "$REGISTRY/pharma-web:$GIT_SHA"
docker push "$REGISTRY/pharma-worker:$GIT_SHA"
docker push "$REGISTRY/pharma-migrate:$GIT_SHA"
```

Record the SHA in the deploy log. Rollback needs the previous SHA.

### 2.2 Put the configuration in the secret store

Set every variable for each service from environment.md. Use `https://staging.<domain>` for `APP_URL`. Set `S3_ENDPOINT` to the https endpoint that browsers can open. Leave `AUTH_BREACHED_PASSWORD_CHECK` unset (true). Do not give the worker or migrate the national ID keys.

### 2.3 Check the backup before touching the database

Confirm in the provider console that automated backups and PITR are on and that the latest recovery point is less than an hour old. On the first deploy the database is empty, so this only proves the setting is on.

### 2.4 Run the migrate step as a release step

Run migrate as a one-off task with the new image, before web and worker start. The task needs only `DATABASE_URL`.

```bash
docker run --rm -e DATABASE_URL "$REGISTRY/pharma-migrate:$GIT_SHA"
```

On a platform, run the same image as a one-off task or pre-deploy job (provider-specific). Expected output: `Migrations applied.` and exit code 0. A non-zero exit means: do not start web or worker, read the message, fix forward (section 6).

Check the result:

```bash
psql "$DATABASE_URL" -c "select count(*) from drizzle.__drizzle_migrations;"
psql "$DATABASE_URL" -c "select name from pgboss.queue order by name;"
```

The queue list must show `upload.process`, `verification.notify`, `organization.notify`, `applications.notify`, `account.notify`, `jobs.notify`, `jobs.expire`, `verification.expire` and the matching `.dead` queues. (The exact table and schema names belong to the pg-boss version in `package.json`; if a query fails, use `\dt pgboss.*` to find them.)

### 2.5 Start the worker, then the web service

For the first deploy, the order of web and worker does not matter after migrate. Start the web service first, so that the health checks of the platform can be confirmed early.

```bash
# provider-specific: create or update the services with these images and the secrets
#   web:    $REGISTRY/pharma-web:$GIT_SHA     (port 3000)
#   worker: $REGISTRY/pharma-worker:$GIT_SHA  (stop grace period of 40 s or more)
```

### 2.6 Check health

| Check | Command | Expected |
| --- | --- | --- |
| Liveness | `curl -fsS https://staging.<domain>/api/health` | HTTP 200 |
| Readiness | `curl -fsS https://staging.<domain>/api/ready` | HTTP 200 and `{"status":"ok","checks":{"db":true,"storage":true}}` |
| Worker | In the worker container: `node_modules/.bin/tsx worker/health.ts --this-host` | Prints `{"liveWorkers":1}` (or more), exit code 0 |
| Worker (from anywhere with the database URL) | Same command in the migrate image: `docker run --rm -e DATABASE_URL "$REGISTRY/pharma-migrate:$GIT_SHA" node_modules/.bin/tsx worker/health.ts` | Exit code 0 |

Notes:

- The images contain `tsx` but not `pnpm`. `pnpm worker:health --this-host` is the same command for a checkout of the repository.
- `/api/ready` does not check the worker, clamd or SMTP. The worker health check covers the worker only. Test clamd and SMTP with the smoke checks in section 4.
- The web image has a built-in container health check on `/api/health`. The worker image has one on the command above. Use them as the platform health checks.
- The worker registers its daily schedules at start: `verification.expire` at 00:17 and `jobs.expire` at 00:23, Africa/Cairo.

### 2.7 Run the smoke checks

Run section 4 once after the first deploy.

## 3. Creating the first super admin on staging

Use synthetic accounts only: an address on a test domain or a mailbox owned by the team, never a real user's.

1. Open `https://staging.<domain>` and sign up with a synthetic email and a strong password.
2. Open the verification link from the email (sent by the worker through the SMTP provider; in a rehearsal, from Mailpit at port 8025).
3. Sign in and turn on two-step verification (TOTP) on `/account`. Save the recovery codes in the team vault.
4. Grant the role with the operator command. It needs `DATABASE_URL`. It revokes the user's sessions and writes to the admin audit log as an operator action.

```bash
docker run --rm -e DATABASE_URL "$REGISTRY/pharma-migrate:$GIT_SHA" \
  node_modules/.bin/tsx src/modules/identity/cli/role-admin.ts grant <synthetic-email> super_admin
```

From a checkout the equivalent is `pnpm admin:grant-role <synthetic-email> super_admin`.

5. Sign in again with the TOTP code. `/staff` now opens.
6. Create further staff through `/staff/roles` (role `super_admin`). Other roles: `support`, `moderator`, `verification_reviewer`, `billing`.
7. For a reviewer test, sign up a second synthetic account, submit a verification request with synthetic images (the worker must be running), and review it as a `verification_reviewer`. Reviewers never see their own submission.

Revoking: `... role-admin.ts revoke <email> <role>`. The operator command may remove the last super admin; use it carefully (it is the recovery path).

## 4. Smoke checks

Run after every deploy.

| # | Check | How | Expected |
| --- | --- | --- | --- |
| 1 | Liveness and readiness | The two `curl` commands in section 2.6 | 200 and `ok` |
| 2 | Worker | `worker/health.ts --this-host` in the worker | `liveWorkers` 1 or more |
| 3 | Pages | Open `/`, `/en`, `/jobs` in a browser, phone width | The pages render, Arabic is the default, RTL |
| 4 | Security headers | `curl -sI https://staging.<domain>/ \| grep -i -E 'content-security-policy\|strict-transport'` | A CSP with a nonce and the origin of `S3_ENDPOINT` in `img-src`; HSTS |
| 5 | Proxy overwrites X-Forwarded-For | See below | The logged address is the real one, not the client's value |
| 6 | Sign-up and email | Sign up a synthetic account | The email arrives (SPF, DKIM pass in the headers) |
| 7 | Upload and scan | Submit a verification request with three synthetic photos | Each upload goes from `processing` to `clean` within a minute |
| 8 | Reviewer view | As a reviewer, open a photo | The image loads (proves the presigned URL, CORS and CSP) |
| 9 | Scan path | Upload the EICAR test string saved as an image only if a safe test file is available; otherwise rely on the integration suite | The upload ends `rejected` with reason `infected` |
| 10 | Admin audit | `/staff/audit` as a super admin | The latest role grant is listed |

Proxy check for X-Forwarded-For: send a request with a made-up header and look at what the app records.

```bash
curl -s -o /dev/null -H 'X-Forwarded-For: 203.0.113.99' https://staging.<domain>/api/health
```

Then trigger an audited action from your own address (for example a role grant) and read the IP on `/staff/audit`. It must be your real address, not `203.0.113.99`. If the made-up value appears, the proxy appends instead of overwriting: fix the proxy before anything else (rate limits and audit rows are wrong until then).

## 5. Routine deploy

### 5.1 Rules for migrations: expand and contract

A migration runs while the previous app version is still serving. So every migration must work with both the old and the new code.

| Phase | Allowed in one release | Notes |
| --- | --- | --- |
| Expand | Add tables, add nullable columns or columns with defaults, add indexes, add triggers that old code satisfies | Safe for the old version. Ship this release first. |
| Migrate data | Backfill in batches, by a job or a script, not inside a long lock | Check lock times on staging. |
| Switch | Deploy code that uses the new structure | A later release. |
| Contract | Drop old columns, tables and constraints | Only after no running version reads them. A release after the switch. |

Never rename or drop a column that the running version reads. Never add a `NOT NULL` column without a default. Triggers (`job_guard`, `job_application_guard`) and append-only tables need extra care: test the migration on staging against a copy of the staging data.

### 5.2 Steps

1. Confirm CI is green on the exact commit (checks, integration, security, e2e, image jobs).
2. Read the migrations in the diff (`db/migrations/`). Confirm they follow the expand and contract rule.
3. Confirm the backup: the latest PITR recovery point is under an hour old. For a risky migration, also take a manual snapshot (provider-specific) and note its name.
4. Build and push the three images with the new SHA (section 2.1). Note the previous SHA for rollback.
5. Run migrate with the new image (section 2.4). Stop if it fails.
6. Deploy the web service with the new image. Wait until the health check passes.
7. Deploy the worker with the new image. The platform sends SIGTERM to the old worker, which stops fetching and gives running jobs up to 30 seconds to finish. Unfinished jobs retry later.
8. Run the smoke checks (section 4).
9. Write the deploy log entry: date, SHA, previous SHA, migration names, who ran it, smoke results.

Why this order: migrate first, because the new code expects the new structure; web second, so that users get the new pages; worker last, because the old worker stays valid for queued jobs until the new one takes over and job payload schemas must stay compatible across the two versions (a payload change needs the expand and contract approach too).

### 5.3 End-to-end suite against staging

The Playwright suite cannot run against a remote staging today. What stands in the way:

| Obstacle | Where |
| --- | --- |
| `baseURL` is fixed to `http://localhost:3000` | `playwright.config.ts` |
| The `webServer` block starts `pnpm start` locally | `playwright.config.ts` |
| `global-setup.ts` connects to the database with `DATABASE_URL` to clear `rate_limit` rows | `e2e/global-setup.ts` |
| The suite reads emails from Mailpit (`MAILPIT_URL`, default `http://localhost:8025`), which staging does not run when a real provider is used | `e2e/mailpit.ts` |
| `e2e/verification.spec.ts` runs the worker's code in the test process with direct database and storage access | `e2e/worker-helpers.ts` |
| Every request would come from one address and use up per-IP limits on a shared environment | rate limits |

What the suite would need (future work, F4): a `BASE_URL` environment variable for `baseURL`; a way to skip the `webServer` block when `BASE_URL` is set; an option to skip or scope the global setup; a mail source (a staging mailbox API or a test relay such as Mailpit as the staging SMTP); and a subset of specs that need no direct database access. Until then, run the suite in CI or locally against the rehearsal stack, and use the manual smoke checks on staging.

Rehearse a deploy locally before the first real one:

```bash
cp staging.env.example staging.env
docker compose -f docker-compose.staging.yml --env-file staging.env up -d --build --wait
```

The rehearsal runs migrate, web, worker, Postgres 18, MinIO, Mailpit and clamd with placeholder values. It proves the images, not the provider.

## 6. Rollback

### 6.1 Application

Redeploy the previous image tags. Images are immutable and tagged with the SHA.

1. Find the previous SHA in the deploy log.
2. Redeploy web with `pharma-web:<previous-sha>`, then the worker with `pharma-worker:<previous-sha>`. Provider-specific command or console action.
3. Do not run the migrate step again with the old image: it would find nothing to undo and would not remove anything.
4. Run the smoke checks.

This is safe because every migration follows the expand and contract rule, so the previous code works against the newer structure. If a release broke that rule, rollback of the code may fail: fix forward.

### 6.2 Data

The platform uses forward-fix, not down-migrations. Reasons:

- Drizzle generates forward migrations only. There are no down scripts to run.
- A down-migration that drops a column or table destroys the data written since the deploy. Rolling back code does not need it.
- Triggers and append-only tables (audit logs, job events, application events) must never lose rows.
- A down-migration is untested code that runs in the worst moment.

If a migration corrupted or lost data:

1. Stop the damage: scale web and worker down, or put the proxy in maintenance mode.
2. Decide with the product owner whether a forward fix is enough.
3. Write a new migration that repairs the structure or data. Test it on a restored copy of the database (section 7), then on staging, then apply it.
4. If data is lost, restore to a point in time before the deploy into a new database, copy back the affected rows or switch to it (section 7). Rows written after the point in time are lost: say so to the product owner.

## 7. Backups and the restore drill

### 7.1 Settings

| Item | Setting | Target |
| --- | --- | --- |
| PostgreSQL PITR | Continuous log archiving on, retention of 7 days or more, recovery point at most 1 hour old | RPO 1 hour |
| Daily backup | Automatic, retained 14 days or more (production: per counsel and the retention decisions in `docs/privacy/data-protection-status.md`), stored outside the database instance's own disk, in another location or account | Survives loss of the instance |
| Backup encryption | Encrypted at rest with a key the provider or the team controls. Provider-specific | Required |
| Object storage | Versioning on the private bucket. A copy of the bucket contents in a second location is a production decision to be made with the product owner | Document recovery |
| Keys | Separate encrypted backup of the national ID keys and of `BETTER_AUTH_SECRET` | A restored database is useless without them |
| Recovery time | A restore into service within 4 hours | RTO 4 hours |

The pg-boss tables live in the same database (schema `pgboss`), so a restore brings queues back with the data.

### 7.2 Restore into a scratch database

Do this at least once before the first production launch, then every quarter and after any change of provider or backup setup. A restore always goes to a new, scratch database, never over the live one.

1. Note the start time. The clock runs against the 4-hour RTO.
2. Choose the target time: the latest recovery point, or a time just before a known event.
3. In the provider console or CLI, restore the database to that time as a new instance (provider-specific). Name it `scratch-<yyyymmdd>`. Note the instance size and the data size.
4. Wait until the instance accepts connections. Note the time.
5. Create a connection string for the scratch instance. Export it only in your shell, from the secret store:

```bash
export SCRATCH_DATABASE_URL=<scratch-connection-string>
psql "$SCRATCH_DATABASE_URL" -c "select now(), pg_is_in_recovery();"
```

6. Compare row counts with the live database (staging holds synthetic data, so counts are not sensitive). Run the same query on both and compare the results:

```bash
for url in "$DATABASE_URL" "$SCRATCH_DATABASE_URL"; do
  psql "$url" -At -c "
    select 'user', count(*) from \"user\"
    union all select 'session', count(*) from session
    union all select 'upload', count(*) from upload
    union all select 'verification_submission', count(*) from verification_submission
    union all select 'organization', count(*) from organization
    union all select 'job', count(*) from job
    union all select 'job_application', count(*) from job_application
    union all select 'admin_audit', count(*) from admin_audit
    order by 1;"
done
```

If a table name differs (check `\dt public.*`), adjust the list. Counts on the scratch copy may be lower than the live ones by the rows written after the target time.

7. Verify the schema with the migrate image. It is idempotent: on a correct restore it applies nothing and exits 0.

```bash
docker run --rm -e DATABASE_URL="$SCRATCH_DATABASE_URL" "$REGISTRY/pharma-migrate:$GIT_SHA"
```

Expected: `Migrations applied.` and no change in the count of `drizzle.__drizzle_migrations`. If it applies migrations, the restore point is older than the last deploy; note that.

8. Verify that the national ID keys from the separate backup decrypt a sample row. Start a throwaway web container against the scratch database with the backed-up keys, sign in as a synthetic reviewer, and reveal one national ID on a synthetic submission (the reveal is logged). Delete the container afterwards. Production restores must keep this container inside the same trust zone as production.
9. Note the end time.
10. Delete the scratch instance, any container and any local file that held a connection string.

### 7.3 Measure and record

Elapsed time = end of step 9 minus start of step 1. Compare with 4 hours (240 minutes). Include the time a human needs to find the credentials and the runbook. Record the result in the table "Restore drill log" at the end. A drill that exceeds the RTO, or that cannot decrypt a sample, is a finding: open a follow-up and repeat.

## 8. Object storage

### 8.1 Settings

- Versioning stays on for the private bucket. Never suspend it.
- The `quarantine/` lifecycle rule expires orphans after one day. Check it still exists after any provider change.
- Clean documents live under `documents/`. A delete in the app (or by mistake) creates a delete marker, and older versions remain.
- Presigned URLs live five minutes.

### 8.2 Restoring a deleted document object

1. Find the object key. The upload row holds it: `select id, status, <key column> from upload where id = '<upload-id>';` (check the column name with `\d upload`).
2. List the versions:

```bash
aws --endpoint-url "$ENDPOINT" s3api list-object-versions \
  --bucket "$PRIVATE_BUCKET" --prefix "documents/<key>"
```

3. If the newest entry is a delete marker (it appears under `DeleteMarkers` with `IsLatest: true`), remove the marker. The previous version becomes current again:

```bash
aws --endpoint-url "$ENDPOINT" s3api delete-object \
  --bucket "$PRIVATE_BUCKET" --key "documents/<key>" --version-id <delete-marker-version-id>
```

4. If the current version is a wrong overwrite, copy the good version over it:

```bash
aws --endpoint-url "$ENDPOINT" s3api copy-object \
  --bucket "$PRIVATE_BUCKET" --key "documents/<key>" \
  --copy-source "$PRIVATE_BUCKET/documents/<key>?versionId=<good-version-id>"
```

5. Check that a reviewer can open the photo.

Limits: this restores only objects whose versions still exist. Do not delete versions by hand. Objects that never reached `documents/` (still in `quarantine/`) are not recoverable after the lifecycle rule runs, by design; the user uploads again.

Whenever the database is restored to an earlier point, `upload` rows and objects can disagree (rows without an object, or objects without a row). The `quarantine/` rule cleans orphans over time. A reconciliation tool does not exist (follow-up F6).

## 9. Rotating secrets

| Secret | Procedure | Effect on users |
| --- | --- | --- |
| `NATIONAL_ID_ENCRYPTION_KEY` | See below | None, when done in order |
| `NATIONAL_ID_HASH_KEY` | Do not rotate. See environment.md | Rotation breaks the duplicate check |
| `BETTER_AUTH_SECRET` | Do not rotate without a plan. See environment.md | Sign-out for all; two-step verification locked for all |
| Storage keys | Below | None, when done in order |
| SMTP credentials | Below | None, when done in order |
| Database password | Below | A short restart |

### 9.1 National ID encryption key

Today the app supports the first half of a rotation. A re-encryption script does not exist.

What works today:

1. Generate a new key: `openssl rand -base64 32`. Store it in the secret store under a new version.
2. Back up the new key in the separate encrypted backup. Keep the old one.
3. Set `NATIONAL_ID_ENCRYPTION_PREVIOUS_KEYS` to the old key (append if a list exists, comma-separated, no spaces needed).
4. Set `NATIONAL_ID_ENCRYPTION_KEY` to the new key.
5. Deploy the web service only (section 5.2, step 6). Check that a reviewer can still reveal an existing national ID, and that a new submission works.
6. New values are written with the new key. Old values stay readable through the previous keys.

What is missing: a re-encryption script that reads every `verification_submission` national ID ciphertext, decrypts with the keyring, encrypts with the current key (the ciphertext carries the key id) and writes it back in batches, with a dry run and a count of rows still on old keys. Until it exists (follow-up F1):

- Never remove a key from `NATIONAL_ID_ENCRYPTION_PREVIOUS_KEYS` while any row still uses it.
- Rotate only for a reason (suspected exposure, a person with access leaving). A key from a confirmed leak cannot be fully retired without the script.
- Count the rows by key id with SQL: `select split_part(<national id ciphertext column>, '.', 2) as key_id, count(*) from verification_submission group by 1;` (find the column with `\d verification_submission`). The key id is not the key.

### 9.2 Storage credentials

1. Create a second access key for the service account (provider-specific).
2. Put the new pair into the secret store.
3. Redeploy the web service and the worker. Check `/api/ready` and an upload.
4. Disable the old key, wait a day, then delete it.

### 9.3 SMTP credentials

The code reads no SMTP credentials today (follow-up F2). When support exists, the procedure is the same as for storage: create a new credential at the provider, update the store, redeploy web and worker, send a test email, then revoke the old credential. A leaked credential is revoked at the provider first.

### 9.4 Database password

1. Create a new password for the application role (or a second role). Provider-specific.
2. Update `DATABASE_URL` in the secret store for web, worker and migrate.
3. Redeploy web, then worker.
4. Retire the old password.

## 10. Monitoring and alerts

Logs are structured JSON (pino) on standard output. Collect them from the containers (provider-specific). The platform has no metrics endpoint today (follow-up F5), so most signals come from the provider's monitoring, the load balancer and SQL queries.

| Signal | How to measure | Alert when |
| --- | --- | --- |
| Error rate | Proxy or load balancer 5xx ratio; error-level log lines | 5xx above 1 percent for 5 minutes |
| p95 latency | Proxy or load balancer latency percentiles on core pages and APIs | Above 300 ms for 15 minutes (the target) |
| Availability | An external probe on `/api/health` and `/api/ready` every minute | Two failures in a row. Readiness 503 means the database or storage is down |
| Worker health | The worker container health check (`worker/health.ts --this-host`); a probe in the migrate image without `--this-host` | No live worker for 2 minutes. While it is down, uploads stay `processing` and no emails leave |
| Job queue depth | SQL on pg-boss: count of `created` jobs per queue | Oldest `created` job older than 10 minutes; depth growing for 15 minutes |
| Dead-letter queues | SQL: count of jobs in `upload.process.dead`, `verification.notify.dead`, `organization.notify.dead`, `applications.notify.dead`, `account.notify.dead`, `jobs.notify.dead` | Any new job (the count must stay 0 or be handled) |
| Failed schedules | `verification.expire` and `jobs.expire` run daily at 00:17 and 00:23 Cairo time | No completed run in 26 hours |
| Database connections | Provider metric for connections | Above 80 percent of the limit. Note: web pools, worker pool (5) and pg-boss share the limit |
| Database disk and CPU | Provider metrics | Disk above 80 percent; CPU above 80 percent for 15 minutes |
| Backups | Provider backup status; PITR recovery point age | Last recovery point older than 1 hour; a failed backup |
| Storage growth | Bucket size and object count (provider metric or a periodic `aws s3 ls --summarize`) | Growth above the planned rate; `quarantine/` object count growing (the lifecycle rule or the worker is failing) |
| ClamAV signature freshness | `docker exec <clamav> clamdscan --version` prints the signature database date; or the freshclam log | Signatures older than 2 days, or freshclam errors |
| clamd availability | A TCP check on port 3310 from the worker host | Down for 2 minutes |
| Memory | clamd and worker container memory | Above 85 percent. clamd needs about 1.5 GB |
| Email | Provider bounce and complaint rates; DMARC reports | Bounce above 5 percent; any DMARC failure |
| Certificates | Days until the TLS certificate expires | Under 14 days |
| Security | Spikes of 403 on `/api/auth`; repeated `ACCOUNT_SUSPENDED` | Unusual volume |

Example SQL for the queue signals (verify the table and column names against the installed pg-boss version with `\dt pgboss.*` and `\d pgboss.job` before building alerts):

```sql
select name, state, count(*), min(created_on) as oldest
from pgboss.job
where state in ('created', 'retry', 'active', 'failed')
group by name, state
order by name, state;
```

For every alert write down who is told and the first action. Until the product owner names the recipients (section 1, item 12), alerts have no owner: that is a launch blocker for production.

## 11. Incident pointers

These are pointers, not a full incident plan. Write the full plan with the product owner before production.

| Incident | First actions |
| --- | --- |
| Suspected personal data breach | 1. Contain: rotate the affected credential, revoke sessions, take the service offline if needed. 2. Preserve logs and the admin audit log (`/staff/audit`); do not delete anything. 3. Tell the product owner at once. 4. The product owner tells Egyptian counsel and decides who else is told. The notification duty and its deadline towards the Personal Data Protection Center (PDPC) and the affected people are to be confirmed with counsel; do not assume a deadline and do not send notices on your own. 5. Record a timeline: what, when, who found it, what data, how many people. Staging holds synthetic data only, so a staging incident is a security finding, not a breach of personal data. |
| Account takeover of a staff account | 1. Revoke the roles and sessions with the operator command: `node_modules/.bin/tsx src/modules/identity/cli/role-admin.ts revoke <email> <role>` for each role (from the migrate image, `DATABASE_URL` set). Every change revokes all of the user's sessions. 2. A super admin can also suspend the account at `/staff/accounts`; a staff account can be suspended by a super admin only. 3. Review `/staff/audit` for that actor's actions (role changes, `verification.decided`, `job.moderated`, `account.data_exported`) and the `document_access_log` for document views. 4. Reset the person's password and two-step verification once the cause is known. 5. If documents or national IDs were viewed, treat it as a possible breach (row above). |
| Fraudulent or scam job post | A moderator opens `/staff/reports` (jobs with open reports) or `/staff/jobs/<id>`, takes the job down with a reason and an internal note (status `removed`), which closes the reports, freezes the applications and emails the creator and applicants. If the employer's account is abusive, suspend it at `/staff/accounts`. An organization with a removal in the last 90 days has every submission moderated. |
| Worker down | Uploads stay `processing`; no verification, invitation, application or job emails leave; daily expiry does not run. Queued jobs wait in the database and run when a worker returns. Steps: check the worker health command and container logs, then the database, storage and clamd; restart the worker; confirm `liveWorkers` is 1 or more; then watch the dead-letter queues. Users with uploads stuck `processing` for a long time can upload again (limit: 10 in `processing` per user). |
| clamd down | The worker retries scans, then marks uploads `processing_failed`. Restore clamd, tell affected users to upload again. |
| Database down | `/api/ready` returns 503. Check the provider status; restore from PITR if the instance is lost (section 7). |
| Bad deploy | Roll back the application (section 6.1). |
| Lost national ID key | Restore it from the separate encrypted backup. Without it the stored IDs are gone: ask the product owner and counsel how users re-verify. |
| Wrong `X-Forwarded-For` handling | Fix the proxy; note that audit rows and rate limits from the affected period carry untrusted addresses. |

## 12. Deployment readiness checklist

From the operations reference, adapted to this platform. Confirm and report each item for the exact commit. For production, the product owner must approve in writing before anything runs.

- [ ] CI green on the exact commit: `checks`, `integration`, `security`, `e2e`, `image`
- [ ] Opus review of the diff done (CLAUDE.md section 10)
- [ ] Migrations reviewed, expand and contract respected, tested on staging, rollback of the application feasible
- [ ] Backup verified: PITR recovery point under an hour old, manual snapshot taken for risky migrations
- [ ] Restore drill completed within the 4-hour RTO (required before production, quarterly after)
- [ ] All variables and secrets set in the target environment (environment.md), no secret in the repo or image
- [ ] National ID keys real, different from each other, separately backed up; the worker does not hold them
- [ ] `APP_URL` and `S3_ENDPOINT` are https and reachable from browsers; the proxy overwrites `X-Forwarded-For`
- [ ] Private bucket private and versioned; the `quarantine/` lifecycle rule active
- [ ] clamd running with signatures current; worker health passing
- [ ] Email provider in the right mode (sandbox for staging, live for production); SPF, DKIM and DMARC passing; `AUTH_BREACHED_PASSWORD_CHECK` is true
- [ ] No payment or SMS provider in this milestone (nothing to configure)
- [ ] Monitoring and alerts active for the changed area; alert recipients named
- [ ] Rollback steps written and the previous image tag recorded
- [ ] Privacy-impacting changes reviewed; legal sign-off where required
- [ ] Production only: hosting region decision recorded in an ADR and counsel's review of data protection duties completed (licences, DPO, transfers); privacy policy and terms reviewed by counsel; admin MFA enforced and roles on least privilege; penetration test or ZAP baseline on staging resolved; load test against the targets passed; incident contact list written; moderation staffed; product owner approval recorded

## 13. Follow-up work found while writing this runbook

| # | Gap | Why an operator needs it |
| --- | --- | --- |
| F1 | No re-encryption script for national IDs, and none to re-hash after a hash key change | A key rotation cannot be completed or a leaked key retired |
| F2 | No SMTP username or password (and no forced TLS) in the configuration | Most email providers require authenticated relays |
| F3 | No tool to delete an account and its data on request, or retention jobs (open question 6 in `docs/privacy/data-protection-status.md`) | Data subject rights and retention |
| F4 | No way to run the end-to-end suite against a remote URL | Automated checks on staging |
| F5 | No metrics endpoint or queue-depth reporting in the app | Alerting on queues and dead letters needs SQL probes today |
| F6 | No reconciliation of `upload` rows and storage objects after a restore | Consistency after a point-in-time restore |
| F7 | `S3_PUBLIC_BUCKET` is required but unused | A needless setup step |
| F8 | No deploy pipeline in CI (images are built and smoke-tested but not pushed) | Reproducible deploys; needs the product owner's approval of registry and credentials |
| F9 | No script that sets up the buckets (versioning, lifecycle) on a real provider; only the compose rehearsal does it | The commands in section 1 are manual |
| F10 | No TOTP re-encryption path for a `BETTER_AUTH_SECRET` rotation | Rotation would lock out two-step verification |

## Restore drill log

Add one row for each drill. Times are measured from the start of the restore (step 1) to the verified end (step 9). The target is 240 minutes.

| Date | Environment | Operator | Recovery point restored | Data size | Time to instance ready (min) | Total time (min) | Within 4 h RTO | Migrate check | Row counts match | National ID decrypt check | Findings and follow-ups |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| | | | | | | | | | | | |
