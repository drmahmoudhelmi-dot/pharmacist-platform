-- Product owner decision 2026-10-26 (ADR-005, amendment): organizations have
-- two roles, owner and recruiter. The admin role is removed. Existing admin
-- memberships and invitations become recruiter, the lower privilege, so no one
-- gains access. Only synthetic data exists (development and staging), but the
-- update is written to be safe on any data. organization_audit keeps 'admin'
-- in its history; its CHECK is unchanged.
-- No organization_audit row is written for the conversion (the audit table is
-- append-only and records user actions): the last audited role of a former
-- admin reads 'admin'; this migration is the record of the change.
-- Rollback: a forward migration re-adding 'admin' to both CHECKs (the former
-- admins stay recruiters).
ALTER TABLE "organization_invitation" DROP CONSTRAINT "organization_invitation_role_check";--> statement-breakpoint
ALTER TABLE "organization_member" DROP CONSTRAINT "organization_member_role_check";--> statement-breakpoint
UPDATE "organization_member" SET "role" = 'recruiter', "updated_at" = now() WHERE "role" = 'admin';--> statement-breakpoint
-- Pending invitations would grant the role, so they become recruiter. Closed
-- invitations are history; the CHECK cannot hold both, so they are rewritten
-- too (their status and timestamps are unchanged).
UPDATE "organization_invitation" SET "role" = 'recruiter' WHERE "role" = 'admin';--> statement-breakpoint
ALTER TABLE "organization_invitation" ADD CONSTRAINT "organization_invitation_role_check" CHECK (role in ('owner', 'recruiter'));--> statement-breakpoint
ALTER TABLE "organization_member" ADD CONSTRAINT "organization_member_role_check" CHECK (role in ('owner', 'recruiter'));
