# ADR-002: Identity and access (milestone 1, step 2)

- Status: Accepted
- Date: 2026-10-20
- Deciders: principal engineer (delegated authority from the product owner, who is informed)

## Context

ADR-001 chose Better Auth with sessions in PostgreSQL. The product owner decided registration is by email (any provider, including Gmail) with verification, no phone OTP at launch. The skill requires OWASP ASVS Level 2, mandatory MFA for staff, rate limits on login, registration and reset, server-side sessions with revocation, and roles split by duty that users can never grant themselves.

## Decision

| Concern | Choice |
|---|---|
| Library | Better Auth 1.7 with the Drizzle adapter; its tables (`user`, `session`, `account`, `verification`, `two_factor`, `rate_limit`) live in the `identity` module. No custom crypto or password hashing. |
| Sign-up | Email + password. Password 10–128 characters, no composition rules. Breached-password check (Have I Been Pwned k-anonymity: only a 5-character hash prefix leaves the server), switchable by env and off in tests. |
| Email verification | Required before the first sign-in. Link token valid 24 h; it is a stateless signed token (Better Auth), so it is not strictly single use, but once the address is verified a reused link changes nothing. Handed to SMTP through an `EmailSender` interface without waiting for delivery (Mailpit locally), so response time does not reveal whether an email is registered; failures are logged with the user id only. Moves to the job queue when the worker arrives. |
| Password reset | Email link valid 1 h, single use; all other sessions revoked on reset. |
| Account enumeration | Sign-up, sign-in and reset responses do not reveal whether an email is registered. |
| Sessions | Database sessions, HttpOnly, Secure in production, SameSite=Lax cookies; 30-day expiry with daily refresh; rotated on sign-in and on privilege change; "sign out everywhere" revokes all sessions. |
| Staff roles | Own table `user_role` (user, role, granted_by, granted_at), unique per user and role, `CHECK` on allowed values: `support`, `moderator`, `verification_reviewer`, `billing`, `super_admin`. Regular users have no row. Roles are never accepted from client input; they are granted only by `pnpm admin:grant-role <email> <role>` (operator CLI, logged) until the admin UI arrives in step 7. |
| Personas | Pharmacist, student, owner and similar are profile and organization facts (steps 3 and 5), not auth roles. |
| Staff MFA | TOTP via the Better Auth two-factor plugin, with backup codes. Any user holding a staff role cannot reach staff areas or staff actions until TOTP is enabled and the current session passed it. |
| Authorization | `src/modules/identity/policy.ts`: `getActor()` resolves the session server-side, and `can(actor, action, resource?)` is called from every protected server action and route. Fails closed: unknown action → denied. |
| Rate limits | Better Auth limiter with database storage (safe with several app instances): sign-in 5 per 15 min, sign-up 3 per hour, reset and verification resend 3 per hour, per IP. Plus per-email limits for sign-in and reset, so one account cannot be hammered from many IPs. |
| Google sign-in | Deferred. It needs a Google Cloud OAuth client the product owner must create; the design keeps room for it (Better Auth social provider). |

## Implementation notes (added after step 2 was built)

- Staff MFA is tracked per session with `session.mfa_verified_at`, set only by TOTP or backup-code verification. Password-only and trusted-device sessions never satisfy staff MFA.
- Duplicate sign-ups get the same response as new ones; the owner receives an "account already exists" email.
- Per-email limits reuse the `rate_limit` table keyed by an HMAC of the normalized email (no raw addresses stored): sign-in 10 per 15 min, sign-up, reset and resend 3 per hour.
- Unused Better Auth endpoints (update user, change email or password, social sign-in, account linking and others) are disabled and return 404. Users change their password through reset.
- Origin and CSRF checks are pinned on in every environment (Better Auth disables them under `NODE_ENV=test`).
- `super_admin` only manages roles; it is not a superset of the other duties.
- Security headers include a nonce-based CSP without `unsafe-eval` or inline scripts in production, so pages render per request.

## Known limitations and conditions before production

- The client IP comes from `X-Forwarded-For`. In production the app must sit behind a proxy that overwrites that header (or Better Auth's `advanced.ipAddress` must be configured for the host); otherwise per-IP limits can be bypassed. Per-email limits still hold. Belongs in the hosting ADR.
- A TOTP code can be reused within its 30-second window (no replay protection in Better Auth). Acceptable while staff are few; revisit before the admin UI in step 7.
- Passwords are hashed with scrypt (Better Auth default, OWASP-accepted) rather than Argon2id or bcrypt.
- The verify-email page verifies on load, so a mail scanner that opens links can verify an address. Low impact: only the mailbox owner's scanner sees the link.
- Production needs an email provider (sender domain, SMTP credentials with authentication) and outbound access to `api.pwnedpasswords.com`.
- Role changes are logged but not yet written to an audit table (step 7).

## Alternatives considered

- Better Auth's admin plugin for roles: rejected; it models one role string per user and exposes role-changing endpoints, while we need several duty roles per user and no role API before the audited admin UI.
- Hosted identity (Auth0, Clerk, Cognito): rejected; puts identity data with a foreign vendor while hosting and the PDPL transfer question are open.
- Magic links only: rejected for launch; depends entirely on email deliverability in Egypt, and users expect passwords.

## Consequences

- Security: staff cannot act without MFA; roles cannot be self-granted; all checks are server-side and tested across users.
- Privacy: email addresses are personal data; the email provider and HIBP must be listed for counsel. Logs carry user IDs only.
- Cost: no SMS spend at launch.
- Reversibility: medium. Better Auth tables are plain Postgres; moving libraries means migrating sessions (users sign in again) but not passwords if the hash format is kept.

## Revisit when

- Google sign-in is wanted (OAuth client available).
- Phone verification becomes a requirement (e.g. shifts in milestone 2).
- The worker exists: move email sends to the outbox.
