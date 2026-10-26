# ADR-008: Admin audit log, staff role management and TOTP replay protection (milestone 1, step 7a)

- Status: Accepted
- Date: 2026-10-26
- Deciders: principal engineer (delegated authority; product owner informed)

## Context

Staff can already review verifications (ADR-004) and moderate jobs (ADR-006), and each workflow keeps its own decision table. ADR-002 left three things for step 7: role changes are only logged, not audited; roles are granted with an operator command line; and a TOTP code can be reused within its 30-second window. The security reference requires an append-only audit record of admin and moderator actions, verification decisions, role changes, document access, data exports and takedowns, with actor, action, target, before and after where relevant, IP and time, and no document contents or full IDs.

Step 7 is split: 7a (this ADR) adds the audit log, role management and replay protection; 7b adds account suspension, reports of jobs and moderator takedowns, which write to the same log.

## Decision

### Audit log (module `admin`)

| Column | Purpose |
|---|---|
| `id`, `at` | Identity and time (`at` in milliseconds, matching the viewer's keyset cursor) |
| `actor_id` FK → user ON DELETE SET NULL, `actor_kind` (`staff`, `user`, `operator`, `system`) | Who: a staff member in the app, a member acting on their own account (data export), the operator command line, or a background job |
| `action` | From a fixed list: `role.granted`, `role.revoked`, `verification.decided`, `job.moderated`, `account.data_exported`; 7b adds suspension, report and takedown actions |
| `target_type`, `target_id` | What: `user`, `verification_submission`, `job` and its id |
| `detail` jsonb | Small, per-action, validated by a Zod schema; codes and ids only (role name, decision and reason code). Never names, emails, national IDs, notes or document contents |
| `ip` | Client IP when the action came from a request |

- Append-only with the `append_only_guard` trigger from migration 0004 (`actor_id` is the column a cascaded update may null). Rows survive the target's deletion; they reference targets by id only.
- Written by the module that performs the action, inside that action's transaction, through one leaf function `recordAudit(tx, entry)` in `src/modules/admin/audit.ts`. It imports nothing but its own schema, so identity, verification and jobs can call it without import cycles. If the action rolls back, so does the audit row.
- The workflow tables stay (verification decisions, document access log, job moderation decisions): they hold the workflow's own data. The audit log is the single place to answer "what did staff do", and links to them by target id.

### Staff role management

- `/staff/roles` for `super_admin` (with TOTP, as every staff page): the list of staff accounts (email, roles, when and by whom granted), a form to grant a role to an existing verified account by email, and revoke buttons.
- Rules: nobody changes their own roles (separation of duties; a super admin cannot grant themselves review or moderation); at least one `super_admin` always remains; every change revokes the target's sessions (as today) and writes `role.granted` or `role.revoked`.
- The command line stays for bootstrapping the first super admin and for emergencies. It writes the same audit rows with `actor_kind = operator`, and the self-change and last-super-admin rules do not apply to it (an operator with database access can recover a locked-out platform). Role changes take a transaction-scoped advisory lock and, for staff, re-check under it that the actor is still a super admin, so a request in flight from a just-revoked super admin is refused and two super admins revoking each other cannot both succeed.

### Audit viewer

`/staff/audit` for `super_admin`: newest first, keyset pages of 50, filters by action, target type and target id, and actor email. Shows the actor's email (staff accounts), the action, target and detail codes. Read-only.

### TOTP replay protection

A TOTP code that has been accepted cannot be accepted again while it is still valid (backup codes are already single use). After a successful `/two-factor/verify-totp`, the code is claimed under a keyed hash of the code for 90 seconds (its 30-second step plus the one step of drift Better Auth accepts either side); a later request with the same code in that period is refused before Better Auth checks it. The claim is taken atomically before the check, so two concurrent requests cannot both pass, and released only when Better Auth itself refuses the code, so a wrong attempt does not spend a code the owner still needs. The key is not bound to the user, because the pending two-factor sign-in has no user in the request; two users entering the same six digits in the same 90 seconds would make the second wait for the next code. With a few dozen staff that collision is negligible and fails safe.

## Alternatives considered

- Separate audit table per module: rejected; "what did this staff member do" would need a union of every module's tables.
- Audit written asynchronously through the job queue: rejected; a crash between action and audit would lose the record. Same transaction is simpler and exact.
- Better Auth's admin plugin for roles: rejected in ADR-002 and still; it exposes role endpoints and a single role per user.
- Binding replay protection to the user through the two-factor cookie: rejected; it depends on Better Auth internals that change between versions.

## Consequences

- Every staff action leaves one audit row with the same shape; step 7b and later modules reuse it.
- The audit log holds staff and target ids and IPs: personal data under the retention question (data-protection status, question 6).
- Reversibility: high; one new table and hooks.

## Revisit when

- Staff count grows enough that TOTP code collisions matter (bind the key to the user then).
- Counsel answers retention for audit records.
- A SIEM or external log archive is chosen for production.
