CREATE TABLE "experience" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"employer_name" text NOT NULL,
	"start_month" date NOT NULL,
	"end_month" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "experience_months_check" CHECK (extract(day from start_month) = 1 and (end_month is null or extract(day from end_month) = 1) and start_month >= date '1960-01-01'),
	CONSTRAINT "experience_end_after_start_check" CHECK (end_month is null or end_month >= start_month),
	CONSTRAINT "experience_title_check" CHECK (char_length(title) between 1 and 120),
	CONSTRAINT "experience_employer_name_check" CHECK (char_length(employer_name) between 1 and 120)
);
--> statement-breakpoint
CREATE TABLE "governorate" (
	"id" smallint PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name_ar" text NOT NULL,
	"name_en" text NOT NULL,
	CONSTRAINT "governorate_code_unique" UNIQUE("code"),
	CONSTRAINT "governorate_name_ar_unique" UNIQUE("name_ar"),
	CONSTRAINT "governorate_name_en_unique" UNIQUE("name_en"),
	CONSTRAINT "governorate_code_check" CHECK ("governorate"."code" ~ '^EG-[A-Z]{1,3}$')
);
--> statement-breakpoint
CREATE TABLE "professional_details" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"phone_e164" text,
	"university" text,
	"graduation_year" smallint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "professional_details_phone_check" CHECK (phone_e164 ~ '^\+201[0125][0-9]{8}$'),
	CONSTRAINT "professional_details_university_check" CHECK (char_length(university) <= 120),
	CONSTRAINT "professional_details_graduation_year_check" CHECK (graduation_year between 1960 and 2100)
);
--> statement-breakpoint
CREATE TABLE "profile" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"display_name" text NOT NULL,
	"headline" text,
	"bio" text,
	"career_stage" text NOT NULL,
	"years_experience" smallint DEFAULT 0 NOT NULL,
	"governorate_id" smallint,
	"specialties" text[] DEFAULT '{}'::text[] NOT NULL,
	"open_to_work" boolean DEFAULT false NOT NULL,
	"visibility" text DEFAULT 'members' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profile_user_id_unique" UNIQUE("user_id"),
	CONSTRAINT "profile_career_stage_check" CHECK (career_stage in ('student', 'graduate', 'pharmacist')),
	CONSTRAINT "profile_visibility_check" CHECK (visibility in ('members', 'hidden')),
	CONSTRAINT "profile_years_experience_check" CHECK (years_experience between 0 and 60),
	CONSTRAINT "profile_specialties_check" CHECK (specialties <@ array['community', 'hospital', 'clinical', 'industry', 'medical_rep', 'regulatory', 'other']::text[] and cardinality(specialties) <= 7),
	CONSTRAINT "profile_display_name_check" CHECK (char_length(display_name) between 2 and 80),
	CONSTRAINT "profile_headline_check" CHECK (char_length(headline) <= 120),
	CONSTRAINT "profile_bio_check" CHECK (char_length(bio) <= 1000)
);
--> statement-breakpoint
ALTER TABLE "experience" ADD CONSTRAINT "experience_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "professional_details" ADD CONSTRAINT "professional_details_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profile" ADD CONSTRAINT "profile_governorate_id_governorate_id_fk" FOREIGN KEY ("governorate_id") REFERENCES "public"."governorate"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "experience_user_id_idx" ON "experience" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "profile_search_idx" ON "profile" USING btree ("governorate_id","career_stage","open_to_work");--> statement-breakpoint
-- Reference data (ADR-003): Egypt's 27 governorates. Codes are ISO 3166-2:EG;
-- ids follow CAPMAS order and are stable (profiles reference them).
INSERT INTO "governorate" ("id", "code", "name_ar", "name_en") VALUES
	(1, 'EG-C', 'القاهرة', 'Cairo'),
	(2, 'EG-ALX', 'الإسكندرية', 'Alexandria'),
	(3, 'EG-PTS', 'بورسعيد', 'Port Said'),
	(4, 'EG-SUZ', 'السويس', 'Suez'),
	(5, 'EG-DT', 'دمياط', 'Damietta'),
	(6, 'EG-DK', 'الدقهلية', 'Dakahlia'),
	(7, 'EG-SHR', 'الشرقية', 'Sharqia'),
	(8, 'EG-KB', 'القليوبية', 'Qalyubia'),
	(9, 'EG-KFS', 'كفر الشيخ', 'Kafr El Sheikh'),
	(10, 'EG-GH', 'الغربية', 'Gharbia'),
	(11, 'EG-MNF', 'المنوفية', 'Monufia'),
	(12, 'EG-BH', 'البحيرة', 'Beheira'),
	(13, 'EG-IS', 'الإسماعيلية', 'Ismailia'),
	(14, 'EG-GZ', 'الجيزة', 'Giza'),
	(15, 'EG-BNS', 'بني سويف', 'Beni Suef'),
	(16, 'EG-FYM', 'الفيوم', 'Faiyum'),
	(17, 'EG-MN', 'المنيا', 'Minya'),
	(18, 'EG-AST', 'أسيوط', 'Asyut'),
	(19, 'EG-SHG', 'سوهاج', 'Sohag'),
	(20, 'EG-KN', 'قنا', 'Qena'),
	(21, 'EG-ASN', 'أسوان', 'Aswan'),
	(22, 'EG-LX', 'الأقصر', 'Luxor'),
	(23, 'EG-BA', 'البحر الأحمر', 'Red Sea'),
	(24, 'EG-WAD', 'الوادي الجديد', 'New Valley'),
	(25, 'EG-MT', 'مطروح', 'Matrouh'),
	(26, 'EG-SIN', 'شمال سيناء', 'North Sinai'),
	(27, 'EG-JS', 'جنوب سيناء', 'South Sinai');
