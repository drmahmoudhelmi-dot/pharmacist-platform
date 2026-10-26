CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"governorate_id" smallint NOT NULL,
	"address_line" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_kind_check" CHECK (kind in ('pharmacy', 'chain')),
	CONSTRAINT "organization_name_check" CHECK (char_length(name) between 2 and 120),
	CONSTRAINT "organization_address_line_check" CHECK (char_length(address_line) between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "organization_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"member_id" uuid,
	"invitation_id" uuid,
	"role" text,
	"previous_role" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_audit_action_check" CHECK (action in ('organization.created', 'organization.updated', 'invitation.created', 'invitation.revoked', 'invitation.accepted', 'invitation.declined', 'member.role_changed', 'member.removed', 'member.left')),
	CONSTRAINT "organization_audit_role_check" CHECK ((role is null or role in ('owner', 'admin', 'recruiter')) and (previous_role is null or previous_role in ('owner', 'admin', 'recruiter')))
);
--> statement-breakpoint
CREATE TABLE "organization_invitation" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invited_by" uuid,
	"closed_by" uuid,
	"locale" text DEFAULT 'ar' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_invitation_role_check" CHECK (role in ('owner', 'admin', 'recruiter')),
	CONSTRAINT "organization_invitation_status_check" CHECK (status in ('pending', 'accepted', 'declined', 'revoked', 'expired')),
	CONSTRAINT "organization_invitation_locale_check" CHECK (locale in ('ar', 'en')),
	CONSTRAINT "organization_invitation_email_check" CHECK (email = lower(email) and char_length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+$'),
	CONSTRAINT "organization_invitation_state_check" CHECK (("organization_invitation"."status" = 'pending' and "organization_invitation"."closed_at" is null)
       or ("organization_invitation"."status" <> 'pending' and "organization_invitation"."closed_at" is not null)),
	CONSTRAINT "organization_invitation_expiry_check" CHECK ("organization_invitation"."expires_at" > "organization_invitation"."created_at")
);
--> statement-breakpoint
CREATE TABLE "organization_member" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"added_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_member_org_user_key" UNIQUE("organization_id","user_id"),
	CONSTRAINT "organization_member_role_check" CHECK (role in ('owner', 'admin', 'recruiter'))
);
--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_governorate_id_governorate_id_fk" FOREIGN KEY ("governorate_id") REFERENCES "public"."governorate"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization" ADD CONSTRAINT "organization_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_audit" ADD CONSTRAINT "organization_audit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_audit" ADD CONSTRAINT "organization_audit_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitation" ADD CONSTRAINT "organization_invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitation" ADD CONSTRAINT "organization_invitation_invited_by_user_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_invitation" ADD CONSTRAINT "organization_invitation_closed_by_user_id_fk" FOREIGN KEY ("closed_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member" ADD CONSTRAINT "organization_member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member" ADD CONSTRAINT "organization_member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_member" ADD CONSTRAINT "organization_member_added_by_user_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "organization_created_by_idx" ON "organization" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "organization_governorate_id_idx" ON "organization" USING btree ("governorate_id");--> statement-breakpoint
CREATE INDEX "organization_audit_org_created_idx" ON "organization_audit" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "organization_invitation_one_pending_idx" ON "organization_invitation" USING btree ("organization_id","email") WHERE "organization_invitation"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "organization_invitation_email_pending_idx" ON "organization_invitation" USING btree ("email") WHERE "organization_invitation"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "organization_invitation_org_created_idx" ON "organization_invitation" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "organization_member_user_id_idx" ON "organization_member" USING btree ("user_id");--> statement-breakpoint
-- Hand edit (ADR-005): organization_audit is append-only, with the guard
-- function from migration 0004. A direct UPDATE, DELETE or TRUNCATE fails;
-- the foreign-key actions PostgreSQL runs itself still work: cascade delete
-- with the organization, and nulling actor_id when that account is deleted.
CREATE TRIGGER "organization_audit_append_only" BEFORE UPDATE OR DELETE ON "organization_audit" FOR EACH ROW EXECUTE FUNCTION "append_only_guard"('actor_id');
--> statement-breakpoint
CREATE TRIGGER "organization_audit_no_truncate" BEFORE TRUNCATE ON "organization_audit" FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"('actor_id');
