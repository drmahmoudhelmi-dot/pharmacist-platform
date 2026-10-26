# ADR-005: Organizations and membership (milestone 1, step 5)

- Status: Accepted
- Date: 2026-10-26
- Deciders: principal engineer (delegated authority; product owner informed)

## Context

Jobs in step 6 belong to an employer, not to a person: a pharmacy owner posts a job, and the people the owner trusts manage it and its applications. ADR-001 (section 5, item 4) puts "pharmacy owner creates a pharmacy and invites members" in milestone 1. The skill requires every query to be scoped to the user or organization, role combinations without self-granted privileges, a tested cross-organization check on every protected operation, and an audit trail for permission changes.

Personas (owner, pharmacist, recruiter) are organization facts, not staff roles (ADR-002). A person can be a verified pharmacist, own one pharmacy and recruit for a chain at the same time.

## Decision

### Data model (module `organizations`, owns these tables)

| Table | Fields (purpose) |
|---|---|
| `organization` | `id` uuid, `kind` CHECK in `pharmacy`, `chain` (how the employer presents itself), `name` 2-120 characters, normalized (shown on jobs), `governorate_id` FK → `governorate` (area of the main branch, for job search), `address_line` optional, up to 200 characters (business address; not a home address), `created_by` FK → user ON DELETE SET NULL, timestamps |
| `organization_member` | `id` uuid (used in URLs and forms instead of the user id), `organization_id` FK ON DELETE CASCADE, `user_id` FK → user ON DELETE CASCADE, `role` CHECK in `owner`, `admin`, `recruiter`, `added_by` FK → user ON DELETE SET NULL, timestamps; UNIQUE (`organization_id`, `user_id`) |
| `organization_invitation` | `id` uuid, `organization_id` FK ON DELETE CASCADE, `email` (lowercased, the invitee's address), `role`, `status` CHECK in `pending`, `accepted`, `declined`, `revoked`, `expired`, `invited_by` FK → user ON DELETE SET NULL, `closed_by` FK → user ON DELETE SET NULL (who accepted, declined or revoked; null for expired), `locale` (email language), `expires_at`, `closed_at`, `created_at`; partial UNIQUE (`organization_id`, `email`) WHERE `status = 'pending'` |
| `organization_audit` | Append-only: `organization_id` FK ON DELETE CASCADE, `actor_id` FK → user ON DELETE SET NULL, `action`, `member_id` and `invitation_id` (no foreign keys, so the history outlives a removed member), `role`, `previous_role`, `created_at` |

Not collected: commercial register number, tax card, pharmacy licence number, phone. They have no use until organization verification exists (see "Revisit when"). An organization is never shown as verified in this step.

`governorate` belongs to the profiles module. The foreign key is the second cross-module table reference after `user` (integrity only); organizations reads the list through profiles' `listGovernorates`.

### Roles inside an organization

| Capability | owner | admin | recruiter |
|---|---|---|---|
| See the organization and own role | yes | yes | yes |
| Edit name, kind, governorate, address | yes | yes | no |
| See members (with email) and pending invitations | yes | yes | no |
| Invite | any role | recruiter only | no |
| Revoke an invitation | any | recruiter invitations | no |
| Change a member's role | yes | no | no |
| Remove a member | anyone | recruiters | no |
| Leave | yes, unless the last owner | yes | yes |
| Manage jobs and applications (step 6) | yes | yes | yes |

- The creator becomes the first owner. An organization always has at least one owner: demoting, removing or the leaving of the last owner is refused. Changes to owners lock the organization row (`FOR UPDATE`), so two owners demoting each other at the same time leave one owner (tested).
- Nobody changes their own role. Staff roles do not widen access to organizations.
- Members are identified to other members by email, only to owners and admins (they invite by email, so it is the identifier they already know). Recruiters see no member list.

### Invitations

- An owner or admin enters an email address and a role. The invitation is bound to that address: it appears on `/organizations` for the signed-in user whose verified email equals it, with Accept and Decline. There is no token in the link, so a forwarded email gives nobody else access.
- The worker emails the address (job `organization.notify`), whether or not an account exists, and the inviter's screen says the same thing in both cases: no account enumeration.
- Pending invitations expire after 7 days (checked at read and accept time; a new invitation to the same address replaces an expired one). States: `pending → accepted | declined | revoked | expired`; one function per transition, each in a transaction that locks the invitation.
- Accepting creates the membership with the invited role. Accepting when already a member keeps the current role.
- Abuse limits: at most 20 pending invitations and 30 new invitations per 24 hours per organization; at most 5 organizations created per user; at most 50 members per organization.

### Policy

`src/modules/organizations/policy.ts`: `can(actor, action, resource)` with the actor's membership (role) loaded by the service from the database, never from input. Fails closed. Every service function loads the membership with the organization id from the URL and the user id from the session, so another organization's id finds no membership and answers `notFound`.

### Audit

Every membership and invitation change writes an `organization_audit` row in the same transaction: `organization.created`, `organization.updated`, `invitation.created`, `invitation.revoked`, `invitation.accepted`, `invitation.declined`, `member.role_changed`, `member.removed`, `member.left`. The table uses the append-only trigger from migration 0004 (`append_only_guard`), with `actor_id` as the column a cascaded update may null.

### Data rights

The data export gains `organizations` (name, kind, governorate, address, own role, joined) and invitations addressed to the user. Account deletion still waits for counsel (data-protection status, question 6); when it arrives, a sole owner must hand over or close the organization first.

## Implementation notes (added after step 5 was built)

- Migration `0006_organizations`: four new tables; hand edit attaches `append_only_guard` (from 0004) to `organization_audit`. No existing table changes. Rollback: a forward migration dropping the four tables (nothing else references them).
- CHECKs: kind, role, status, locale and audit action lists; name 2-120 and address 1-200 characters; invitation email lowercased with an `@`; `closed_at` set exactly when the status is not `pending`; `expires_at` after `created_at`.
- Profiles' governorate list moved to `src/modules/profiles/governorates.ts` (re-exported by the profiles service), so organizations can read it without a circular import with profiles' data export.
- Identity gained `getEmailsOfUsers` (contact.ts) for the member list; organizations never queries `user`.
- Every write locks the organization row first (`SELECT … FOR UPDATE`), then loads the actor's membership inside the transaction. The integration test holds the organization and member rows from a separate connection while two owners demote each other, then releases them together: exactly one change wins, and it fails without the organization lock.
- Expiry is lazy: a pending invitation past `expires_at` is hidden from lists, refused on accept or revoke (and closed as `expired` then), skipped by the email job, and replaced by a new invitation to the same address. No scheduled job.
- Organization names and addresses drop control characters and invisible format characters (bidi overrides, isolates, zero-width characters), since they are shown to other users and in emails.
- Invitation spam is bounded per account by the limits: 5 organizations × 30 invitations a day. Revisit with real abuse data (a per-inviter limit or moderation of first invitations).
- The invitation email names the organization (user-provided text, HTML-escaped by the shared layout) and links to `/organizations`, never to a token. Logs carry invitation and organization ids only.
- Known limits: membership lists use no pagination (at most 50 members); an organization cannot be closed or deleted yet (waits for the retention answer); a deleted account's sole-owner organizations keep no owner (account deletion is not built; it must refuse or hand over first).

## Alternatives considered

- Better Auth's organization plugin: rejected. It adds its own endpoints for creating organizations and changing roles, while the project disables unused Better Auth endpoints (ADR-002) and keeps authorization in module policies. It also stores invitations under its own rules.
- Emailed invitation tokens: rejected for launch. Binding to the verified email needs no secret in a link, survives a forwarded email, and the invitee needs an account anyway.
- Branches as a table now: deferred. Jobs carry their own governorate in step 6; a branch table is added when chains need per-branch staff or listings.
- Requiring a verified pharmacist to create an organization: rejected. Owners of chains are often not pharmacists, and step 6 already sends a first job post through moderation when the poster is not verified.

## Consequences

- Step 6 can scope every job query by `organization_id` and authorize through this module's `can`.
- Invitations hold email addresses of people who may never sign up; they are personal data under the retention question.
- Reversibility: high. New tables only; no existing data changes.

## Revisit when

- Organization verification is wanted (pharmacy licence or commercial register, reusing the private upload pipeline from ADR-004).
- Chains need branches with their own staff.
- Counsel answers retention (invitation emails, audit rows, closing an organization).
