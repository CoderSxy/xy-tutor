CREATE TABLE "learning_profile_baselines" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "bucket_key" text NOT NULL,
  "window_start" timestamp with time zone NOT NULL,
  "window_end" timestamp with time zone NOT NULL,
  "median_ms" integer NOT NULL,
  "sample_ids" jsonb NOT NULL,
  "as_of" timestamp with time zone NOT NULL,
  "policy_version" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "learning_profile_baseline_median_check" CHECK ("median_ms" > 0)
);
--> statement-breakpoint
ALTER TABLE "learning_profile_baselines" ADD CONSTRAINT "learning_profile_baselines_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "learning_profile_baselines" ADD CONSTRAINT "learning_profile_baselines_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "learning_profile_baseline_student_skill" ON "learning_profile_baselines" USING btree ("student_id","skill_id","bucket_key","as_of");
--> statement-breakpoint
CREATE TABLE "learning_profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "training_band" text DEFAULT 'repair' NOT NULL,
  "band_entered_at" timestamp with time zone DEFAULT now() NOT NULL,
  "consumed_promotion_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "stale" boolean DEFAULT false NOT NULL,
  "knowledge_stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "hint_stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "efficiency" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "baseline_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "learning_profile_training_band_check" CHECK ("training_band" IN ('repair','consolidation','advance')),
  CONSTRAINT "learning_profile_version_check" CHECK ("version" > 0)
);
--> statement-breakpoint
ALTER TABLE "learning_profiles" ADD CONSTRAINT "learning_profiles_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "learning_profiles" ADD CONSTRAINT "learning_profiles_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "learning_profiles" ADD CONSTRAINT "learning_profiles_baseline_id_learning_profile_baselines_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."learning_profile_baselines"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "learning_profile_student_skill" ON "learning_profiles" USING btree ("student_id","skill_id");
--> statement-breakpoint
CREATE TABLE "learning_profile_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "profile_id" uuid NOT NULL,
  "attempt_id" uuid NOT NULL,
  "question_version_id" uuid NOT NULL,
  "assessment_id" uuid,
  "band" text NOT NULL,
  "independent_correct" boolean NOT NULL,
  "determinable" boolean NOT NULL,
  "attempt_at" timestamp with time zone NOT NULL,
  "consumed_by_version" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "learning_profile_evidence_band_check" CHECK ("band" IN ('repair','consolidation','advance'))
);
--> statement-breakpoint
ALTER TABLE "learning_profile_evidence" ADD CONSTRAINT "learning_profile_evidence_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "learning_profile_evidence" ADD CONSTRAINT "learning_profile_evidence_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "learning_profile_evidence" ADD CONSTRAINT "learning_profile_evidence_profile_id_learning_profiles_id_fk" FOREIGN KEY ("profile_id") REFERENCES "public"."learning_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "learning_profile_evidence" ADD CONSTRAINT "learning_profile_evidence_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "learning_profile_evidence" ADD CONSTRAINT "learning_profile_evidence_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "public"."question_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "learning_profile_evidence_version" ON "learning_profile_evidence" USING btree ("student_id","skill_id","question_version_id");
--> statement-breakpoint
CREATE INDEX "learning_profile_evidence_profile" ON "learning_profile_evidence" USING btree ("profile_id","attempt_at");
--> statement-breakpoint
CREATE TABLE "learning_habits" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "anchor_code" text NOT NULL,
  "observation" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "independent_check_count" integer DEFAULT 0 NOT NULL,
  "successful_correction_count" integer DEFAULT 0 NOT NULL,
  "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "learning_habit_count_check" CHECK ("independent_check_count" >= 0 AND "successful_correction_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "learning_habits" ADD CONSTRAINT "learning_habits_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "learning_habits" ADD CONSTRAINT "learning_habits_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "learning_habit_anchor" ON "learning_habits" USING btree ("student_id","skill_id","anchor_code");
