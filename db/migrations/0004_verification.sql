CREATE TABLE "document_access_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"document_id" uuid,
	"actor_id" uuid,
	"action" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" "inet",
	CONSTRAINT "document_access_log_action_check" CHECK (action in ('view', 'reveal_national_id')),
	CONSTRAINT "document_access_log_target_check" CHECK (("document_access_log"."action" = 'view') = ("document_access_log"."document_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "verification_decision" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"reviewer_id" uuid,
	"decision" text NOT NULL,
	"reason_code" text NOT NULL,
	"note" text,
	"decided_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_decision_submission_id_unique" UNIQUE("submission_id"),
	CONSTRAINT "verification_decision_decision_check" CHECK (decision in ('verified', 'rejected')),
	CONSTRAINT "verification_decision_reason_check" CHECK ((decision = 'verified' and reason_code in ('documents_match'))
       or (decision = 'rejected' and reason_code in ('document_unreadable', 'document_missing_or_wrong', 'details_mismatch', 'credential_not_confirmed', 'card_expired', 'other'))),
	CONSTRAINT "verification_decision_note_check" CHECK (char_length(note) between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "verification_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"upload_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_document_submission_kind_unique" UNIQUE("submission_id","kind"),
	CONSTRAINT "verification_document_upload_unique" UNIQUE("upload_id"),
	CONSTRAINT "verification_document_kind_check" CHECK (kind in ('national_id_front', 'national_id_back', 'syndicate_card', 'student_card'))
);
--> statement-breakpoint
CREATE TABLE "verification_submission" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_type" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"syndicate_number" text,
	"university" text,
	"card_expires_on" date,
	"national_id_ciphertext" text NOT NULL,
	"national_id_hash" text NOT NULL,
	"national_id_masked" text NOT NULL,
	"key_id" text NOT NULL,
	"consent_version" text NOT NULL,
	"locale" text DEFAULT 'ar' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "verification_submission_credential_type_check" CHECK (credential_type in ('pharmacist', 'student')),
	CONSTRAINT "verification_submission_status_check" CHECK (status in ('pending', 'verified', 'rejected', 'expired')),
	CONSTRAINT "verification_submission_locale_check" CHECK (locale in ('ar', 'en')),
	CONSTRAINT "verification_submission_claims_check" CHECK (("verification_submission"."credential_type" = 'pharmacist' and "verification_submission"."syndicate_number" is not null and "verification_submission"."university" is null)
       or ("verification_submission"."credential_type" = 'student' and "verification_submission"."university" is not null and "verification_submission"."syndicate_number" is null)),
	CONSTRAINT "verification_submission_syndicate_number_check" CHECK (syndicate_number ~ '^[0-9]{1,12}$'),
	CONSTRAINT "verification_submission_university_check" CHECK (char_length(university) between 2 and 120),
	CONSTRAINT "verification_submission_national_id_masked_check" CHECK ("verification_submission"."national_id_masked" ~ '^[23][*]{10}[0-9]{3}$'),
	CONSTRAINT "verification_submission_national_id_hash_check" CHECK ("verification_submission"."national_id_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "verification_submission_national_id_ciphertext_check" CHECK ("verification_submission"."national_id_ciphertext" ~ '^v1[.][0-9a-f]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]+$'),
	CONSTRAINT "verification_submission_key_id_check" CHECK ("verification_submission"."key_id" ~ '^[0-9a-f]{16}$'),
	CONSTRAINT "verification_submission_consent_version_check" CHECK (char_length("verification_submission"."consent_version") between 1 and 64),
	CONSTRAINT "verification_submission_state_check" CHECK (("verification_submission"."status" = 'pending' and "verification_submission"."decided_at" is null and "verification_submission"."expired_at" is null)
       or ("verification_submission"."status" in ('verified', 'rejected') and "verification_submission"."decided_at" is not null and "verification_submission"."expired_at" is null)
       or ("verification_submission"."status" = 'expired' and "verification_submission"."decided_at" is not null and "verification_submission"."expired_at" is not null and "verification_submission"."card_expires_on" is not null))
);
--> statement-breakpoint
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_submission_id_verification_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."verification_submission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_document_id_verification_document_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."verification_document"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_access_log" ADD CONSTRAINT "document_access_log_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_decision" ADD CONSTRAINT "verification_decision_submission_id_verification_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."verification_submission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_decision" ADD CONSTRAINT "verification_decision_reviewer_id_user_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_document" ADD CONSTRAINT "verification_document_submission_id_verification_submission_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."verification_submission"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verification_document" ADD CONSTRAINT "verification_document_upload_id_upload_id_fk" FOREIGN KEY ("upload_id") REFERENCES "public"."upload"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "verification_submission" ADD CONSTRAINT "verification_submission_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "document_access_log_submission_id_idx" ON "document_access_log" USING btree ("submission_id","at");--> statement-breakpoint
CREATE INDEX "document_access_log_document_id_idx" ON "document_access_log" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_access_log_actor_id_idx" ON "document_access_log" USING btree ("actor_id","at");--> statement-breakpoint
CREATE INDEX "verification_submission_user_id_idx" ON "verification_submission" USING btree ("user_id","submitted_at");--> statement-breakpoint
CREATE INDEX "verification_submission_queue_idx" ON "verification_submission" USING btree ("submitted_at") WHERE "verification_submission"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "verification_submission_one_pending_idx" ON "verification_submission" USING btree ("user_id") WHERE "verification_submission"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "verification_submission_national_id_active_idx" ON "verification_submission" USING btree ("national_id_hash") WHERE "verification_submission"."status" in ('pending', 'verified');--> statement-breakpoint
-- Hand-written below this line (drizzle-kit does not model triggers), plus one
-- edit above: the upload foreign key of verification_document is DEFERRABLE
-- INITIALLY DEFERRED. Deleting a user cascades to both `upload` and (through
-- the submission) `verification_document`; a non-deferred check fires while
-- the cascade is half done. Deferred to commit, deleting a user works and
-- deleting an upload that a document still uses is still refused.
--
-- Append-only audit tables (ADR-004, 4b). Rows of verification_decision and
-- document_access_log can be inserted, never changed or removed by a statement.
-- The only exceptions are the foreign-key actions PostgreSQL runs itself: a
-- cascade delete when the submission (or the user owning it) is deleted, and
-- ON DELETE SET NULL of the reviewer/actor column when a staff account is
-- deleted. Those run inside the referential-integrity trigger, so
-- pg_trigger_depth() is 2 there and 1 for a direct statement (verified on
-- PostgreSQL 18). Applies to every role, including the table owner; only a
-- role that can drop the trigger (DDL) or set session_replication_role can
-- bypass it, which the application role must not be able to do in production.
CREATE FUNCTION "append_only_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  nullable_ref text := TG_ARGV[0];
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF pg_trigger_depth() < 2 THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  -- A cascaded UPDATE may only null the one reference column (ON DELETE SET NULL).
  IF (to_jsonb(NEW) - nullable_ref) IS DISTINCT FROM (to_jsonb(OLD) - nullable_ref)
     OR (to_jsonb(NEW) ->> nullable_ref) IS NOT NULL THEN
    RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "verification_decision_append_only" BEFORE UPDATE OR DELETE ON "verification_decision" FOR EACH ROW EXECUTE FUNCTION "append_only_guard"('reviewer_id');
--> statement-breakpoint
CREATE TRIGGER "verification_decision_no_truncate" BEFORE TRUNCATE ON "verification_decision" FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"('reviewer_id');
--> statement-breakpoint
CREATE TRIGGER "document_access_log_append_only" BEFORE UPDATE OR DELETE ON "document_access_log" FOR EACH ROW EXECUTE FUNCTION "append_only_guard"('actor_id');
--> statement-breakpoint
CREATE TRIGGER "document_access_log_no_truncate" BEFORE TRUNCATE ON "document_access_log" FOR EACH STATEMENT EXECUTE FUNCTION "append_only_guard"('actor_id');
--> statement-breakpoint
-- Submission state machine, enforced in the database as well as in the
-- service: pending → verified | rejected, verified → expired, nothing else.
-- The owner, the credential claims and the national ID fields never change
-- after insert (a key-rotation job would re-encrypt with a dedicated,
-- reviewed migration that replaces this function).
CREATE FUNCTION "verification_submission_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.credential_type IS DISTINCT FROM OLD.credential_type
     OR NEW.syndicate_number IS DISTINCT FROM OLD.syndicate_number
     OR NEW.university IS DISTINCT FROM OLD.university
     OR NEW.card_expires_on IS DISTINCT FROM OLD.card_expires_on
     OR NEW.national_id_ciphertext IS DISTINCT FROM OLD.national_id_ciphertext
     OR NEW.national_id_hash IS DISTINCT FROM OLD.national_id_hash
     OR NEW.national_id_masked IS DISTINCT FROM OLD.national_id_masked
     OR NEW.key_id IS DISTINCT FROM OLD.key_id
     OR NEW.consent_version IS DISTINCT FROM OLD.consent_version
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
    RAISE EXCEPTION 'verification_submission: immutable column changed' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'pending' AND NEW.status IN ('verified', 'rejected'))
    OR (OLD.status = 'verified' AND NEW.status = 'expired')
  ) THEN
    RAISE EXCEPTION 'verification_submission: transition % -> % not allowed', OLD.status, NEW.status USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "verification_submission_guard" BEFORE UPDATE ON "verification_submission" FOR EACH ROW EXECUTE FUNCTION "verification_submission_guard"();
