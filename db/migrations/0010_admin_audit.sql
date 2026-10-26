CREATE TABLE "admin_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"actor_id" uuid,
	"actor_kind" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid NOT NULL,
	"detail" jsonb NOT NULL,
	"ip" "inet",
	CONSTRAINT "admin_audit_action_check" CHECK (action in ('role.granted', 'role.revoked', 'verification.decided', 'job.moderated', 'account.data_exported')),
	CONSTRAINT "admin_audit_actor_kind_check" CHECK (actor_kind in ('staff', 'user', 'operator', 'system')),
	CONSTRAINT "admin_audit_target_type_check" CHECK (target_type in ('user', 'verification_submission', 'job')),
	CONSTRAINT "admin_audit_detail_check" CHECK (jsonb_typeof(detail) = 'object')
);
--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "admin_audit_at_idx" ON "admin_audit" USING btree ("at","id");--> statement-breakpoint
CREATE INDEX "admin_audit_target_idx" ON "admin_audit" USING btree ("target_type","target_id");--> statement-breakpoint
CREATE INDEX "admin_audit_actor_idx" ON "admin_audit" USING btree ("actor_id","at");--> statement-breakpoint
-- Hand edit (ADR-008): append-only, with the guard from migration 0004.
CREATE TRIGGER "admin_audit_append_only" BEFORE UPDATE OR DELETE ON "admin_audit" FOR EACH ROW EXECUTE FUNCTION "append_only_guard"('actor_id');
--> statement-breakpoint
CREATE TRIGGER "admin_audit_no_truncate" BEFORE TRUNCATE ON "admin_audit" FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"('actor_id');
