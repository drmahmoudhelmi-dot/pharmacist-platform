CREATE TABLE "account_suspension" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"reason_code" text NOT NULL,
	"note" text,
	"suspended_by" uuid,
	"suspended_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifted_at" timestamp with time zone,
	"lifted_by" uuid,
	"lift_reason_code" text,
	CONSTRAINT "account_suspension_reason_check" CHECK (reason_code in ('fraud_or_impersonation', 'fake_jobs', 'abuse_or_harassment', 'spam', 'terms_violation', 'other')),
	CONSTRAINT "account_suspension_lift_check" CHECK ((lifted_at is null and lift_reason_code is null) or (lifted_at is not null and lift_reason_code in ('appeal_accepted', 'issued_in_error', 'other'))),
	CONSTRAINT "account_suspension_note_check" CHECK (note is null or char_length(note) between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "job_report" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"reporter_id" uuid,
	"reason_code" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	CONSTRAINT "job_report_reason_check" CHECK (reason_code in ('fake_or_scam', 'contact_details_in_text', 'discriminatory', 'misleading', 'other')),
	CONSTRAINT "job_report_status_check" CHECK ((status = 'open' and resolved_at is null) or (status in ('actioned', 'dismissed') and resolved_at is not null)),
	CONSTRAINT "job_report_details_check" CHECK (details is null or char_length(details) between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "admin_audit" DROP CONSTRAINT "admin_audit_action_check";--> statement-breakpoint
ALTER TABLE "job" DROP CONSTRAINT "job_status_check";--> statement-breakpoint
ALTER TABLE "job" DROP CONSTRAINT "job_state_check";--> statement-breakpoint
ALTER TABLE "job_event" DROP CONSTRAINT "job_event_status_check";--> statement-breakpoint
ALTER TABLE "job_moderation_decision" DROP CONSTRAINT "job_moderation_decision_decision_check";--> statement-breakpoint
ALTER TABLE "job_moderation_decision" DROP CONSTRAINT "job_moderation_decision_reason_check";--> statement-breakpoint
ALTER TABLE "account_suspension" ADD CONSTRAINT "account_suspension_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_suspension" ADD CONSTRAINT "account_suspension_suspended_by_user_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "account_suspension" ADD CONSTRAINT "account_suspension_lifted_by_user_id_fk" FOREIGN KEY ("lifted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_report" ADD CONSTRAINT "job_report_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_report" ADD CONSTRAINT "job_report_reporter_id_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_report" ADD CONSTRAINT "job_report_resolved_by_user_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "account_suspension_active_unique" ON "account_suspension" USING btree ("user_id") WHERE "account_suspension"."lifted_at" is null;--> statement-breakpoint
CREATE INDEX "account_suspension_user_idx" ON "account_suspension" USING btree ("user_id","suspended_at");--> statement-breakpoint
CREATE INDEX "job_report_job_id_idx" ON "job_report" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "job_report_open_idx" ON "job_report" USING btree ("created_at","job_id") WHERE "job_report"."status" = 'open';--> statement-breakpoint
CREATE INDEX "job_report_reporter_idx" ON "job_report" USING btree ("reporter_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_report_open_unique" ON "job_report" USING btree ("job_id","reporter_id") WHERE "job_report"."status" = 'open';--> statement-breakpoint
ALTER TABLE "admin_audit" ADD CONSTRAINT "admin_audit_action_check" CHECK (action in ('role.granted', 'role.revoked', 'verification.decided', 'job.moderated', 'account.data_exported', 'account.suspended', 'account.reinstated', 'job.removed', 'job.reports_dismissed'));--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_status_check" CHECK (status in ('draft', 'pending_review', 'published', 'paused', 'closed', 'expired', 'rejected', 'removed'));--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_state_check" CHECK ((status in ('draft', 'rejected') or submitted_at is not null)
     and (status not in ('published', 'paused', 'closed', 'expired', 'removed') or (published_at is not null and first_published_at is not null and expires_at is not null))
     and ((status = 'closed') = (closed_at is not null)));--> statement-breakpoint
ALTER TABLE "job_event" ADD CONSTRAINT "job_event_status_check" CHECK (to_status in ('draft', 'pending_review', 'published', 'paused', 'closed', 'expired', 'rejected', 'removed') and (from_status is null or from_status in ('draft', 'pending_review', 'published', 'paused', 'closed', 'expired', 'rejected', 'removed')));--> statement-breakpoint
ALTER TABLE "job_moderation_decision" ADD CONSTRAINT "job_moderation_decision_decision_check" CHECK (decision in ('approved', 'rejected', 'removed'));--> statement-breakpoint
ALTER TABLE "job_moderation_decision" ADD CONSTRAINT "job_moderation_decision_reason_check" CHECK ((decision = 'approved' and reason_code = 'meets_guidelines') or (decision = 'rejected' and reason_code in ('incomplete', 'misleading_or_fraud', 'not_pharmacy_related', 'contact_details_in_text', 'discriminatory', 'other')) or (decision = 'removed' and reason_code in ('misleading_or_fraud', 'contact_details_in_text', 'discriminatory', 'not_pharmacy_related', 'other')));--> statement-breakpoint
-- Hand edits (ADR-009). Job transitions gain the moderator takedown
-- (published or paused -> removed); same table as TRANSITIONS in
-- src/modules/jobs/constants.ts.
CREATE OR REPLACE FUNCTION "job_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'job: organization_id is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.created_by IS DISTINCT FROM OLD.created_by AND NEW.created_by IS NOT NULL THEN
    RAISE EXCEPTION 'job: created_by is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status IN ('pending_review', 'published'))
    OR (OLD.status = 'rejected' AND NEW.status = 'pending_review')
    OR (OLD.status = 'pending_review' AND NEW.status IN ('published', 'rejected'))
    OR (OLD.status = 'published' AND NEW.status IN ('paused', 'closed', 'expired', 'removed'))
    OR (OLD.status = 'paused' AND NEW.status IN ('published', 'closed', 'expired', 'removed'))
  ) THEN
    RAISE EXCEPTION 'job: transition % -> % not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- Reports: resolved once (open -> actioned or dismissed, with resolved_at and
-- resolved_by); nothing else changes and rows are never deleted directly.
-- Cascades (job deleted, reporter or resolver account deleted) run at
-- trigger depth 2 and pass, as in append_only_guard (migration 0004).
CREATE FUNCTION "job_report_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'job_report: truncate not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF pg_trigger_depth() >= 2 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'job_report: rows are not deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status <> 'open' OR NEW.status NOT IN ('actioned', 'dismissed')
     OR NEW.resolved_at IS NULL
     OR (to_jsonb(NEW) - 'status' - 'resolved_at' - 'resolved_by')
        IS DISTINCT FROM (to_jsonb(OLD) - 'status' - 'resolved_at' - 'resolved_by') THEN
    RAISE EXCEPTION 'job_report: only an open report is resolved, once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "job_report_guard" BEFORE UPDATE OR DELETE ON "job_report" FOR EACH ROW EXECUTE FUNCTION "job_report_guard"();
--> statement-breakpoint
CREATE TRIGGER "job_report_no_truncate" BEFORE TRUNCATE ON "job_report" FOR EACH STATEMENT EXECUTE FUNCTION "job_report_guard"();
--> statement-breakpoint
-- Suspensions: lifted once (lifted_at, lifted_by, lift_reason_code); nothing
-- else changes and rows go only with the account (cascade, depth 2).
CREATE FUNCTION "account_suspension_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'account_suspension: truncate not allowed' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF pg_trigger_depth() >= 2 THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'account_suspension: rows are not deleted' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.lifted_at IS NOT NULL OR NEW.lifted_at IS NULL
     OR (to_jsonb(NEW) - 'lifted_at' - 'lifted_by' - 'lift_reason_code')
        IS DISTINCT FROM (to_jsonb(OLD) - 'lifted_at' - 'lifted_by' - 'lift_reason_code') THEN
    RAISE EXCEPTION 'account_suspension: only an active suspension is lifted, once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "account_suspension_guard" BEFORE UPDATE OR DELETE ON "account_suspension" FOR EACH ROW EXECUTE FUNCTION "account_suspension_guard"();
--> statement-breakpoint
CREATE TRIGGER "account_suspension_no_truncate" BEFORE TRUNCATE ON "account_suspension" FOR EACH STATEMENT EXECUTE FUNCTION "account_suspension_guard"();
