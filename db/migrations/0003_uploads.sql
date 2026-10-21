CREATE TABLE "upload" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'processing' NOT NULL,
	"reject_reason" text,
	"quarantine_key" text NOT NULL,
	"object_key" text,
	"content_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "upload_quarantine_key_unique" UNIQUE("quarantine_key"),
	CONSTRAINT "upload_object_key_unique" UNIQUE("object_key"),
	CONSTRAINT "upload_purpose_check" CHECK (purpose in ('verification_document')),
	CONSTRAINT "upload_status_check" CHECK (status in ('processing', 'clean', 'rejected')),
	CONSTRAINT "upload_reject_reason_check" CHECK (reject_reason in ('infected', 'undecodable', 'processing_failed')),
	CONSTRAINT "upload_content_type_check" CHECK (content_type in ('image/jpeg', 'image/png', 'image/webp')),
	CONSTRAINT "upload_byte_size_check" CHECK (byte_size between 1 and 8388608),
	CONSTRAINT "upload_sha256_check" CHECK ("upload"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "upload_quarantine_key_check" CHECK ("upload"."quarantine_key" ~ '^quarantine/[0-9a-f-]{36}$'),
	CONSTRAINT "upload_object_key_check" CHECK ("upload"."object_key" ~ '^documents/[0-9a-f-]{36}\.jpg$'),
	CONSTRAINT "upload_state_check" CHECK (("upload"."status" = 'processing' and "upload"."object_key" is null and "upload"."sha256" is null and "upload"."reject_reason" is null)
       or ("upload"."status" = 'clean' and "upload"."object_key" is not null and "upload"."sha256" is not null and "upload"."reject_reason" is null)
       or ("upload"."status" = 'rejected' and "upload"."object_key" is null and "upload"."sha256" is null and "upload"."reject_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "upload" ADD CONSTRAINT "upload_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "upload_user_id_status_idx" ON "upload" USING btree ("user_id","status");