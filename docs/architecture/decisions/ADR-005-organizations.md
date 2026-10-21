# ADR-005: Organizations (milestone 1, step 5)

- Status: Accepted
- Date: 2026-10-21
- Deciders: principal engineer (delegated authority; product owner informed)

## Context

Pharmacies and chains post jobs (step 6). A pharmacy has an owner and staff who recruit on its behalf. The skill requires that members act only within their organization, that every query is scoped by organization at the data-access layer, that role combinations work (a pharmacist can also own a pharmacy) without self-granted privileges, and that business claims (such as a pharmacy licence) stay unverified until an authorized review.

## Decision

### Data model (module `organizations`)

| Table | Fields | Notes |
|---|---|---|
| `organization` | `id` uuid, `kind` CHECK `pharmacy` / `chain`, `name_ar` (required), `name_en` (optional), `governorate_id` FK, `address_line` (optional, business address), `branch_count` (chains, optional), `licence_number` (optional claim), `verification_status` CHECK `unverified` / `pending` / `verified` / `rejected` (default `unverified`), `created_by` FK user, timestamps | Business record, not personal data beyond the creator link |
| `organization_member` | `organization_id` FK CASCADE, `user_id` FK CASCADE, `role` CHECK `owner` / `manager` / `recruiter`, `added_by`, timestamps; UNIQUE (organization, user) | At least one owner per organization (enforced in the service, inside a transaction with a row lock) |
| `organization_invitation` | `id`, `organization_id`, `email_hash` (HMAC of the normalized email, so invitations never store raw addresses at rest), `role` (manager or recruiter; never owner), `token_hash` (SHA-256 of a random 32-byte token sent by email), `invited_by`, `expires_at` (7 days), `accepted_at`, `revoked_at` | Single use; the accepting user's verified email must match the hash |

Limits: a user may create at most 3 organizations; an organization at most 50 members and 50 open invitations.

### Roles and actions

| Action | Owner | Manager | Recruiter |
|---|---|---|---|
| Edit organization details | yes | yes | no |
| Invite / remove members | yes (any role but owner) | yes (recruiters only) | no |
| Transfer ownership | yes (to an existing member) | no | no |
| Post and manage jobs (step 6) | yes | yes | yes |
| Delete organization | yes (only with no open jobs) | no | no |

Organization roles are separate from staff roles (ADR-002). Staff roles never grant organization rights, and organization roles never grant staff rights.

### Rules

- Every organization query goes through the module's services with the actor's membership resolved server-side; `organization_id` from input is checked against membership on every call (fails closed).
- Creating an organization needs a verified email. It starts `unverified`; the pharmacy's verification badge appears only after review. Licence review reuses the step-4 document pipeline and reviewer queue in a later step (organization licence document kind); until then organizations are visibly unverified, and step 6 sends every job from an unverified organization's first post to moderation.
- Invitations go by email through the worker; accepting requires signing in with the invited address (verified). Responses never reveal whether an invited email has an account.
- Leaving or removal revokes access immediately (checks read membership per request).
- Public organization page (signed-in members only, like profiles): name, kind, governorate, verification state, open jobs (step 6). Address and licence number are visible to members of the organization and staff only.

## Alternatives considered

- Single owner column on the organization: rejected; chains need several managers and recruiters.
- Invitations by user id only: rejected; owners invite colleagues who may not have signed up yet.
- Storing invitation emails in clear: rejected; a keyed hash is enough to match on acceptance.

## Consequences

- Step 6 jobs belong to an organization and inherit its membership checks.
- Licence verification is a known gap until the follow-up; the UI states it plainly.
- Reversibility: high; new tables only.

## Revisit when

- Licence verification is built (organization documents in the reviewer queue).
- Chains need branch-level structure (branches as child organizations).
