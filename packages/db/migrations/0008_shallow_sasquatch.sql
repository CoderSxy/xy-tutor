CREATE TABLE "assessments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"correctness" text NOT NULL,
	"verification" text NOT NULL,
	"hint_dependency" text NOT NULL,
	"method" text NOT NULL,
	"verifier_version" text NOT NULL,
	"reference_id" uuid,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_version_id" uuid NOT NULL,
	"answer" text NOT NULL,
	"answer_type" text NOT NULL,
	"requires_working" boolean NOT NULL,
	"verification" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assessments" ADD CONSTRAINT "assessments_reference_id_question_references_id_fk" FOREIGN KEY ("reference_id") REFERENCES "public"."question_references"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_references" ADD CONSTRAINT "question_references_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "public"."question_versions"("id") ON DELETE no action ON UPDATE no action;