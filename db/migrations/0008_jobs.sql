-- Hand edit (ADR-006): trigram matching for the job board's search.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE TABLE "job" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"title" text NOT NULL,
	"category" text NOT NULL,
	"employment_type" text NOT NULL,
	"start_date" date,
	"end_date" date,
	"governorate_id" smallint NOT NULL,
	"area" text,
	"description" text NOT NULL,
	"min_years_experience" smallint DEFAULT 0 NOT NULL,
	"career_stages" text[] NOT NULL,
	"salary_min" integer,
	"salary_max" integer,
	"search_text" text NOT NULL,
	"created_by" uuid,
	"updated_by" uuid,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"first_published_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_status_check" CHECK (status in ('draft', 'pending_review', 'published', 'paused', 'closed', 'expired', 'rejected')),
	CONSTRAINT "job_category_check" CHECK (category in ('pharmacist', 'pharmacy_manager', 'area_manager', 'trainee', 'other')),
	CONSTRAINT "job_employment_type_check" CHECK (employment_type in ('full_time', 'part_time', 'temporary')),
	CONSTRAINT "job_title_check" CHECK (char_length(title) between 4 and 120),
	CONSTRAINT "job_area_check" CHECK (char_length(area) between 1 and 120),
	CONSTRAINT "job_description_check" CHECK (char_length(description) between 30 and 4000),
	CONSTRAINT "job_min_years_check" CHECK (min_years_experience between 0 and 40),
	CONSTRAINT "job_career_stages_check" CHECK (cardinality(career_stages) between 1 and 3 and career_stages <@ array['student', 'graduate', 'pharmacist']::text[]),
	CONSTRAINT "job_salary_check" CHECK ((salary_min is null or salary_min > 0) and (salary_max is null or salary_max > 0) and (salary_min is null or salary_max is null or salary_max >= salary_min)),
	CONSTRAINT "job_period_check" CHECK ((employment_type = 'temporary' and start_date is not null and end_date is not null and end_date >= start_date) or (employment_type <> 'temporary' and start_date is null and end_date is null)),
	CONSTRAINT "job_state_check" CHECK ((status in ('draft', 'rejected') or submitted_at is not null)
     and (status not in ('published', 'paused', 'closed', 'expired') or (published_at is not null and first_published_at is not null and expires_at is not null))
     and ((status = 'closed') = (closed_at is not null)))
);
--> statement-breakpoint
CREATE TABLE "job_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"actor_id" uuid,
	"from_status" text,
	"to_status" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_event_status_check" CHECK (to_status in ('draft', 'pending_review', 'published', 'paused', 'closed', 'expired', 'rejected') and (from_status is null or from_status in ('draft', 'pending_review', 'published', 'paused', 'closed', 'expired', 'rejected')))
);
--> statement-breakpoint
CREATE TABLE "job_moderation_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"moderator_id" uuid,
	"decision" text NOT NULL,
	"reason_code" text NOT NULL,
	"note" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_moderation_decision_decision_check" CHECK (decision in ('approved', 'rejected')),
	CONSTRAINT "job_moderation_decision_reason_check" CHECK ((decision = 'approved' and reason_code = 'meets_guidelines') or (decision = 'rejected' and reason_code in ('incomplete', 'misleading_or_fraud', 'not_pharmacy_related', 'contact_details_in_text', 'discriminatory', 'other'))),
	CONSTRAINT "job_moderation_decision_note_check" CHECK (char_length(note) between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_governorate_id_governorate_id_fk" FOREIGN KEY ("governorate_id") REFERENCES "public"."governorate"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job" ADD CONSTRAINT "job_submitted_by_user_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_event" ADD CONSTRAINT "job_event_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_event" ADD CONSTRAINT "job_event_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_moderation_decision" ADD CONSTRAINT "job_moderation_decision_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_moderation_decision" ADD CONSTRAINT "job_moderation_decision_moderator_id_user_id_fk" FOREIGN KEY ("moderator_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_organization_id_idx" ON "job" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "job_board_idx" ON "job" USING btree ("published_at","id") WHERE "job"."status" = 'published';--> statement-breakpoint
CREATE INDEX "job_review_queue_idx" ON "job" USING btree ("submitted_at") WHERE "job"."status" = 'pending_review';--> statement-breakpoint
CREATE INDEX "job_governorate_id_idx" ON "job" USING btree ("governorate_id");--> statement-breakpoint
CREATE INDEX "job_expires_at_idx" ON "job" USING btree ("expires_at") WHERE "job"."status" in ('published', 'paused');--> statement-breakpoint
CREATE INDEX "job_event_job_id_idx" ON "job_event" USING btree ("job_id","at");--> statement-breakpoint
CREATE INDEX "job_moderation_decision_job_id_idx" ON "job_moderation_decision" USING btree ("job_id");
--> statement-breakpoint
-- Hand edits (ADR-006). Search: trigram index on the normalized search text.
CREATE INDEX "job_search_text_trgm_idx" ON "job" USING gin ("search_text" gin_trgm_ops);
--> statement-breakpoint
-- Status transitions, enforced in the database as well as in the service
-- (src/modules/jobs/constants.ts, TRANSITIONS). The organization and the
-- creator never change after insert.
CREATE FUNCTION "job_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
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
    OR (OLD.status = 'published' AND NEW.status IN ('paused', 'closed', 'expired'))
    OR (OLD.status = 'paused' AND NEW.status IN ('published', 'closed', 'expired'))
  ) THEN
    RAISE EXCEPTION 'job: transition % -> % not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "job_guard" BEFORE UPDATE ON "job" FOR EACH ROW EXECUTE FUNCTION "job_guard"();
--> statement-breakpoint
-- Append-only history, with the guard function from migration 0004.
CREATE TRIGGER "job_moderation_decision_append_only" BEFORE UPDATE OR DELETE ON "job_moderation_decision" FOR EACH ROW EXECUTE FUNCTION "append_only_guard"('moderator_id');
--> statement-breakpoint
CREATE TRIGGER "job_moderation_decision_no_truncate" BEFORE TRUNCATE ON "job_moderation_decision" FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"('moderator_id');
--> statement-breakpoint
CREATE TRIGGER "job_event_append_only" BEFORE UPDATE OR DELETE ON "job_event" FOR EACH ROW EXECUTE FUNCTION "append_only_guard"('actor_id');
--> statement-breakpoint
CREATE TRIGGER "job_event_no_truncate" BEFORE TRUNCATE ON "job_event" FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"('actor_id');
