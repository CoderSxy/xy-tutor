CREATE TABLE "diagnosis_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"diagnosis_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"student_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"decision" text NOT NULL,
	"corrected_code" text,
	"reason" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"expected_version" integer NOT NULL,
	"result_version" integer NOT NULL,
	"request_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"metric_version" text NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"sample_size" integer DEFAULT 0 NOT NULL,
	"versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"stale_evidence_count" integer DEFAULT 0 NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "diagnosis_reviews" ADD CONSTRAINT "diagnosis_reviews_diagnosis_id_error_diagnoses_id_fk" FOREIGN KEY ("diagnosis_id") REFERENCES "public"."error_diagnoses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnosis_reviews" ADD CONSTRAINT "diagnosis_reviews_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnosis_reviews" ADD CONSTRAINT "diagnosis_reviews_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "diagnosis_reviews" ADD CONSTRAINT "diagnosis_reviews_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_evaluations" ADD CONSTRAINT "learning_evaluations_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_evaluations" ADD CONSTRAINT "learning_evaluations_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "practice_decisions" ADD COLUMN "invalidated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "practice_decisions" ADD COLUMN "invalid_reason" text;--> statement-breakpoint
CREATE UNIQUE INDEX "diagnosis_review_request" ON "diagnosis_reviews" USING btree ("reviewer_id","student_id","request_key");--> statement-breakpoint
CREATE INDEX "diagnosis_review_attempt" ON "diagnosis_reviews" USING btree ("attempt_id","created_at");--> statement-breakpoint
CREATE INDEX "learning_evaluation_student_window" ON "learning_evaluations" USING btree ("student_id","from_date","to_date","generated_at");--> statement-breakpoint
ALTER TABLE "diagnosis_reviews" ADD CONSTRAINT "diagnosis_review_decision_check" CHECK ("diagnosis_reviews"."decision" IN ('accept','correct','insufficient'));--> statement-breakpoint
ALTER TABLE "diagnosis_reviews" ADD CONSTRAINT "diagnosis_review_corrected_code_check" CHECK ("diagnosis_reviews"."corrected_code" IS NULL OR "diagnosis_reviews"."corrected_code" IN ('execution_slip','condition_omission','concept_gap','rule_misuse','strategy_gap','expression_gap','input_issue'));--> statement-breakpoint
ALTER TABLE "diagnosis_reviews" ADD CONSTRAINT "diagnosis_review_correction_code_required" CHECK (("diagnosis_reviews"."decision" = 'correct') = ("diagnosis_reviews"."corrected_code" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "diagnosis_reviews" ADD CONSTRAINT "diagnosis_review_reason_length_check" CHECK (char_length("diagnosis_reviews"."reason") BETWEEN 1 AND 2000);--> statement-breakpoint
ALTER TABLE "diagnosis_reviews" ADD CONSTRAINT "diagnosis_review_version_check" CHECK ("diagnosis_reviews"."expected_version" > 0 AND "diagnosis_reviews"."result_version" > "diagnosis_reviews"."expected_version");--> statement-breakpoint
ALTER TABLE "learning_evaluations" ADD CONSTRAINT "learning_evaluation_window_check" CHECK ("learning_evaluations"."from_date" <= "learning_evaluations"."to_date");--> statement-breakpoint
ALTER TABLE "learning_evaluations" ADD CONSTRAINT "learning_evaluation_non_negative" CHECK ("learning_evaluations"."sample_size" >= 0 AND "learning_evaluations"."stale_evidence_count" >= 0);
