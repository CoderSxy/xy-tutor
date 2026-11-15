ALTER TABLE "question_versions" ADD COLUMN "question_type" text DEFAULT 'legacy' NOT NULL;
--> statement-breakpoint
ALTER TABLE "question_versions" ADD COLUMN "presentation" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "question_versions" ADD COLUMN "answer_spec" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "question_versions" ADD COLUMN "language_status" text DEFAULT 'unchecked' NOT NULL;
--> statement-breakpoint
ALTER TABLE "question_versions" ADD COLUMN "language_policy_version" text;
--> statement-breakpoint
ALTER TABLE "attempts" ADD COLUMN "answer_payload" jsonb;
--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD COLUMN "origin_category" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD COLUMN "origin_detail" text DEFAULT 'unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD COLUMN "origin_task_id" uuid;
--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD COLUMN "origin_conversation_id" uuid;
--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD COLUMN "origin_message_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD COLUMN "origin_question_version_id" uuid;
--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD COLUMN "provenance" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD COLUMN "lifecycle" text DEFAULT 'active' NOT NULL;
--> statement-breakpoint
CREATE TABLE "practice_sets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"mode" text DEFAULT 'step' NOT NULL,
	"strategy" text DEFAULT 'mixed' NOT NULL,
	"exam_profile_id" text,
	"exam_profile_version" text,
	"policy_version" text DEFAULT 'mixed-v1' NOT NULL,
	"seed" text DEFAULT '' NOT NULL,
	"scope_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"blueprint" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"generation_status" text DEFAULT 'preparing' NOT NULL,
	"submission_status" text DEFAULT 'open' NOT NULL,
	"previous_set_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_set_mode_check" CHECK ("practice_sets"."mode" IN ('step','batch')),
	CONSTRAINT "practice_set_strategy_check" CHECK ("practice_sets"."strategy" IN ('mixed','exam')),
	CONSTRAINT "practice_set_generation_check" CHECK ("practice_sets"."generation_status" IN ('awaiting_scope','preparing','ready','insufficient_pool','failed')),
	CONSTRAINT "practice_set_submission_check" CHECK ("practice_sets"."submission_status" IN ('open','grading','needs_review','completed')),
	CONSTRAINT "practice_set_version_check" CHECK ("practice_sets"."version" > 0),
	CONSTRAINT "practice_set_exam_profile_required" CHECK ("practice_sets"."strategy" <> 'exam' OR "practice_sets"."exam_profile_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "practice_set_slots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"set_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"question_type" text NOT NULL,
	"task_item_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"reason_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_set_slot_position_check" CHECK ("practice_set_slots"."position" BETWEEN 0 AND 4),
	CONSTRAINT "practice_set_slot_type_check" CHECK ("practice_set_slots"."question_type" IN ('single_choice','multiple_choice','fill_blank','worked','legacy')),
	CONSTRAINT "practice_set_slot_state_check" CHECK ("practice_set_slots"."state" IN ('pending','bound','failed'))
);
--> statement-breakpoint
CREATE TABLE "practice_answer_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"task_item_id" uuid NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_answer_draft_version_check" CHECK ("practice_answer_drafts"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "practice_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"set_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"state" text DEFAULT 'grading' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_submission_state_check" CHECK ("practice_submissions"."state" IN ('grading','needs_review','completed'))
);
--> statement-breakpoint
CREATE TABLE "practice_submission_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"submission_id" uuid NOT NULL,
	"task_item_id" uuid NOT NULL,
	"attempt_id" uuid,
	"state" text DEFAULT 'submitted' NOT NULL,
	"grading_state" text DEFAULT 'queued' NOT NULL,
	"mistake_sync_state" text DEFAULT 'not_required' NOT NULL,
	"latest_assessment_id" uuid,
	"reason_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "practice_submission_item_state_check" CHECK ("practice_submission_items"."state" IN ('submitted','skipped')),
	CONSTRAINT "practice_submission_item_grading_check" CHECK ("practice_submission_items"."grading_state" IN ('none','queued','running','verified','pending','failed')),
	CONSTRAINT "practice_submission_item_sync_check" CHECK ("practice_submission_items"."mistake_sync_state" IN ('not_required','queued','synced','failed'))
);
--> statement-breakpoint
CREATE TABLE "practice_set_continuations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"previous_set_id" uuid NOT NULL,
	"request_key" text NOT NULL,
	"payload_hash" text NOT NULL,
	"new_set_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "student_practice_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"mode" text,
	"strategy" text DEFAULT 'mixed' NOT NULL,
	"exam_profile_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_practice_preference_mode_check" CHECK ("student_practice_preferences"."mode" IS NULL OR "student_practice_preferences"."mode" IN ('step','batch')),
	CONSTRAINT "student_practice_preference_strategy_check" CHECK ("student_practice_preferences"."strategy" IN ('mixed','exam')),
	CONSTRAINT "student_practice_preference_version_check" CHECK ("student_practice_preferences"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "question_localizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"question_version_id" uuid NOT NULL,
	"policy_version" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "question_localization_status_check" CHECK ("question_localizations"."status" IN ('pending','ready','failed'))
);
--> statement-breakpoint
ALTER TABLE "practice_sets" ADD CONSTRAINT "practice_sets_task_id_learning_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."learning_tasks"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_sets" ADD CONSTRAINT "practice_sets_previous_set_id_practice_sets_id_fk" FOREIGN KEY ("previous_set_id") REFERENCES "public"."practice_sets"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_set_slots" ADD CONSTRAINT "practice_set_slots_set_id_practice_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."practice_sets"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_set_slots" ADD CONSTRAINT "practice_set_slots_task_item_id_task_items_id_fk" FOREIGN KEY ("task_item_id") REFERENCES "public"."task_items"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_answer_drafts" ADD CONSTRAINT "practice_answer_drafts_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_answer_drafts" ADD CONSTRAINT "practice_answer_drafts_task_item_id_task_items_id_fk" FOREIGN KEY ("task_item_id") REFERENCES "public"."task_items"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_submissions" ADD CONSTRAINT "practice_submissions_set_id_practice_sets_id_fk" FOREIGN KEY ("set_id") REFERENCES "public"."practice_sets"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_submission_items" ADD CONSTRAINT "practice_submission_items_submission_id_practice_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."practice_submissions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_submission_items" ADD CONSTRAINT "practice_submission_items_task_item_id_task_items_id_fk" FOREIGN KEY ("task_item_id") REFERENCES "public"."task_items"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_submission_items" ADD CONSTRAINT "practice_submission_items_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_submission_items" ADD CONSTRAINT "practice_submission_items_latest_assessment_id_assessments_id_fk" FOREIGN KEY ("latest_assessment_id") REFERENCES "public"."assessments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_set_continuations" ADD CONSTRAINT "practice_set_continuations_previous_set_id_practice_sets_id_fk" FOREIGN KEY ("previous_set_id") REFERENCES "public"."practice_sets"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_set_continuations" ADD CONSTRAINT "practice_set_continuations_new_set_id_practice_sets_id_fk" FOREIGN KEY ("new_set_id") REFERENCES "public"."practice_sets"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_practice_preferences" ADD CONSTRAINT "student_practice_preferences_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "question_localizations" ADD CONSTRAINT "question_localizations_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "public"."question_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD CONSTRAINT "student_mistakes_origin_task_id_learning_tasks_id_fk" FOREIGN KEY ("origin_task_id") REFERENCES "public"."learning_tasks"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD CONSTRAINT "student_mistakes_origin_conversation_id_conversations_id_fk" FOREIGN KEY ("origin_conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD CONSTRAINT "student_mistakes_origin_message_version_id_message_versions_id_fk" FOREIGN KEY ("origin_message_version_id") REFERENCES "public"."message_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD CONSTRAINT "student_mistakes_origin_question_version_id_question_versions_id_fk" FOREIGN KEY ("origin_question_version_id") REFERENCES "public"."question_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_set_task_unique" ON "practice_sets" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX "practice_set_previous" ON "practice_sets" USING btree ("previous_set_id");
--> statement-breakpoint
CREATE INDEX "practice_set_generation" ON "practice_sets" USING btree ("generation_status");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_set_slot_position" ON "practice_set_slots" USING btree ("set_id","position");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_set_slot_item" ON "practice_set_slots" USING btree ("task_item_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_answer_draft_item" ON "practice_answer_drafts" USING btree ("student_id","task_item_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_submission_request" ON "practice_submissions" USING btree ("set_id","request_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_submission_item_unique" ON "practice_submission_items" USING btree ("submission_id","task_item_id");
--> statement-breakpoint
CREATE INDEX "practice_submission_item_attempt" ON "practice_submission_items" USING btree ("attempt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_set_continuation_previous" ON "practice_set_continuations" USING btree ("previous_set_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_set_continuation_new" ON "practice_set_continuations" USING btree ("new_set_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "student_practice_preference_student" ON "student_practice_preferences" USING btree ("student_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "question_localization_version_policy" ON "question_localizations" USING btree ("question_version_id","policy_version");
--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD CONSTRAINT "student_mistake_origin_category_check" CHECK ("student_mistakes"."origin_category" IN ('uploaded','learning','unknown'));
--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD CONSTRAINT "student_mistake_origin_detail_check" CHECK ("student_mistakes"."origin_detail" IN ('material_import','daily_practice','knowledge_consolidation','free_question','mistake_review','unknown'));
--> statement-breakpoint
ALTER TABLE "student_mistakes" ADD CONSTRAINT "student_mistake_lifecycle_check" CHECK ("student_mistakes"."lifecycle" IN ('active','revoked'));
--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_version_type_check" CHECK ("question_versions"."question_type" IN ('single_choice','multiple_choice','fill_blank','worked','legacy'));
--> statement-breakpoint
ALTER TABLE "question_versions" ADD CONSTRAINT "question_version_language_status_check" CHECK ("question_versions"."language_status" IN ('unchecked','accepted','repair_required'));
