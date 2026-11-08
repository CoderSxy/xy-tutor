CREATE TABLE "mistake_state_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"sequence" bigserial NOT NULL,
	"mistake_id" uuid NOT NULL,
	"assessment_id" uuid,
	"attempt_id" uuid,
	"type" text NOT NULL,
	"from_state" text NOT NULL,
	"to_state" text NOT NULL,
	"reason" text NOT NULL,
	"rule_version" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "question_relations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"origin_question_id" uuid NOT NULL,
	"origin_question_version_id" uuid NOT NULL,
	"variant_question_id" uuid NOT NULL,
	"knowledge_point" text NOT NULL,
	"verified" boolean NOT NULL,
	"evidence" jsonb NOT NULL,
	CONSTRAINT "question_relations_variant_question_id_unique" UNIQUE("variant_question_id")
);
--> statement-breakpoint
CREATE TABLE "student_mistakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"question_id" uuid NOT NULL,
	"original_attempt_id" uuid,
	"status" text DEFAULT 'pending_correction' NOT NULL,
	"due_at" timestamp with time zone,
	"consolidated_at" timestamp with time zone,
	"last_consolidated_question_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mistake_state_events" ADD CONSTRAINT "mistake_state_events_mistake_id_student_mistakes_id_fk" FOREIGN KEY ("mistake_id") REFERENCES "public"."student_mistakes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mistake_state_events" ADD CONSTRAINT "mistake_state_events_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mistake_state_events" ADD CONSTRAINT "mistake_state_events_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_relations" ADD CONSTRAINT "question_relations_origin_question_id_questions_id_fk" FOREIGN KEY ("origin_question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_relations" ADD CONSTRAINT "question_relations_origin_question_version_id_question_versions_id_fk" FOREIGN KEY ("origin_question_version_id") REFERENCES "public"."question_versions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_relations" ADD CONSTRAINT "question_relations_variant_question_id_questions_id_fk" FOREIGN KEY ("variant_question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD CONSTRAINT "student_mistakes_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD CONSTRAINT "student_mistakes_question_id_questions_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD CONSTRAINT "student_mistakes_original_attempt_id_attempts_id_fk" FOREIGN KEY ("original_attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD CONSTRAINT "student_mistakes_last_consolidated_question_id_questions_id_fk" FOREIGN KEY ("last_consolidated_question_id") REFERENCES "public"."questions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mistake_assessment_applied" ON "mistake_state_events" USING btree ("mistake_id","assessment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "student_question_mistake" ON "student_mistakes" USING btree ("student_id","question_id");