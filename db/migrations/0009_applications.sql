CREATE TABLE "application_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"application_id" uuid NOT NULL,
	"actor_id" uuid,
	"from_status" text,
	"to_status" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "application_event_status_check" CHECK (to_status in ('submitted', 'under_review', 'shortlisted', 'accepted', 'rejected', 'withdrawn') and (from_status is null or from_status in ('submitted', 'under_review', 'shortlisted', 'accepted', 'rejected', 'withdrawn')))
);
--> statement-breakpoint
CREATE TABLE "job_application" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"applicant_id" uuid NOT NULL,
	"status" text DEFAULT 'submitted' NOT NULL,
	"profile_snapshot" jsonb NOT NULL,
	"phone_e164" text,
	"cover_note" text,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "job_application_job_applicant_key" UNIQUE("job_id","applicant_id"),
	CONSTRAINT "job_application_status_check" CHECK (status in ('submitted', 'under_review', 'shortlisted', 'accepted', 'rejected', 'withdrawn')),
	CONSTRAINT "job_application_phone_check" CHECK (phone_e164 ~ '^\+201[0125][0-9]{8}$'),
	CONSTRAINT "job_application_cover_note_check" CHECK (char_length(cover_note) between 1 and 1000),
	CONSTRAINT "job_application_snapshot_check" CHECK (jsonb_typeof(profile_snapshot) = 'object'),
	CONSTRAINT "job_application_state_check" CHECK (((status in ('accepted', 'rejected')) = (decided_at is not null)) and ((status = 'withdrawn') = (withdrawn_at is not null)))
);
--> statement-breakpoint
ALTER TABLE "application_event" ADD CONSTRAINT "application_event_application_id_job_application_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."job_application"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "application_event" ADD CONSTRAINT "application_event_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_application" ADD CONSTRAINT "job_application_job_id_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_application" ADD CONSTRAINT "job_application_applicant_id_user_id_fk" FOREIGN KEY ("applicant_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "application_event_application_idx" ON "application_event" USING btree ("application_id","at");--> statement-breakpoint
CREATE INDEX "job_application_applicant_idx" ON "job_application" USING btree ("applicant_id","submitted_at");--> statement-breakpoint
CREATE INDEX "job_application_job_idx" ON "job_application" USING btree ("job_id","submitted_at");--> statement-breakpoint
-- Hand edits (ADR-007). Status transitions (src/modules/jobs/constants.ts,
-- APPLICATION_TRANSITIONS) and immutability of what the applicant shared.
CREATE FUNCTION "job_application_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.job_id IS DISTINCT FROM OLD.job_id
     OR NEW.applicant_id IS DISTINCT FROM OLD.applicant_id
     OR NEW.profile_snapshot IS DISTINCT FROM OLD.profile_snapshot
     OR NEW.phone_e164 IS DISTINCT FROM OLD.phone_e164
     OR NEW.cover_note IS DISTINCT FROM OLD.cover_note
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'job_application: shared content is immutable' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'submitted' AND NEW.status IN ('under_review', 'rejected', 'withdrawn'))
    OR (OLD.status = 'under_review' AND NEW.status IN ('shortlisted', 'rejected', 'withdrawn'))
    OR (OLD.status = 'shortlisted' AND NEW.status IN ('accepted', 'rejected', 'withdrawn'))
  ) THEN
    RAISE EXCEPTION 'job_application: transition % -> % not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "job_application_guard" BEFORE UPDATE ON "job_application" FOR EACH ROW EXECUTE FUNCTION "job_application_guard"();
--> statement-breakpoint
CREATE TRIGGER "application_event_append_only" BEFORE UPDATE OR DELETE ON "application_event" FOR EACH ROW EXECUTE FUNCTION "append_only_guard"('actor_id');
--> statement-breakpoint
CREATE TRIGGER "application_event_no_truncate" BEFORE TRUNCATE ON "application_event" FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"('actor_id');
