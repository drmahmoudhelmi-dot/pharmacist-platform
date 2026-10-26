-- Product owner decision 2026-10-26 (ADR-005, amendment): organizations have
-- two roles, owner and recruiter. The admin role is removed. Existing admin
-- memberships and invitations become recruiter, the lower privilege, so no one
-- gains access. Only synthetic data exists (development and staging), but the
-- update is written to be safe on any data. organization_audit keeps 'admin'
-- in its history; its CHECK is unchanged.
-- Rollback: a forward migration re-adding 'admin' to both CHECKs (the former
-- admins stay recruiters; the audit trail shows who they were).
ALTER TABLE "organization_invitation" DROP CONSTRAINT "organization_invitation_role_check";--> statement-breakpoint
ALTER TABLE "organization_member" DROP CONSTRAINT "organization_member_role_check";--> statement-breakpoint
UPDATE "organization_member" SET "role" = 'recruiter', "updated_at" = now() WHERE "role" = 'admin';--> statement-breakpoint
UPDATE "organization_invitation" SET "role" = 'recruiter' WHERE "role" = 'admin';--> statement-breakpoint
ALTER TABLE "organization_invitation" ADD CONSTRAINT "organization_invitation_role_check" CHECK (role in ('owner', 'recruiter'));--> statement-breakpoint
ALTER TABLE "organization_member" ADD CONSTRAINT "organization_member_role_check" CHECK (role in ('owner', 'recruiter'));
