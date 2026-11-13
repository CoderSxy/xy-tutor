CREATE TABLE "practice_decisions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "request_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "policy_version" text NOT NULL,
  "profile_version" integer NOT NULL,
  "status" text NOT NULL,
  "goal" text NOT NULL,
  "difficulty" text,
  "entry_id" uuid,
  "question_version_id" uuid,
  "skill_id" uuid,
  "baseline_id" uuid,
  "explanation" text NOT NULL,
  "reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "candidate_snapshot" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "recent_window" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "practice_decision_status_check" CHECK ("status" IN ('selected','insufficient_pool','awaiting_diagnosis')),
  CONSTRAINT "practice_decision_goal_check" CHECK ("goal" IN ('diagnostic','repair','transfer','review')),
  CONSTRAINT "practice_decision_difficulty_check" CHECK ("difficulty" IS NULL OR "difficulty" IN ('easy','medium','challenge')),
  CONSTRAINT "practice_decision_version_check" CHECK ("profile_version" > 0),
  CONSTRAINT "practice_decision_selected_question_check" CHECK (("status" = 'selected') = ("question_version_id" IS NOT NULL))
);
--> statement-breakpoint
ALTER TABLE "practice_decisions" ADD CONSTRAINT "practice_decisions_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_decisions" ADD CONSTRAINT "practice_decisions_task_id_learning_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."learning_tasks"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_decisions" ADD CONSTRAINT "practice_decisions_entry_id_question_bank_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."question_bank_entries"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_decisions" ADD CONSTRAINT "practice_decisions_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "public"."question_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_decisions" ADD CONSTRAINT "practice_decisions_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "practice_decisions" ADD CONSTRAINT "practice_decisions_baseline_id_learning_profile_baselines_id_fk" FOREIGN KEY ("baseline_id") REFERENCES "public"."learning_profile_baselines"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "practice_decision_request" ON "practice_decisions" USING btree ("student_id","task_id","request_key");
--> statement-breakpoint
CREATE INDEX "practice_decision_student_created" ON "practice_decisions" USING btree ("student_id","created_at");
--> statement-breakpoint
CREATE INDEX "practice_decision_student_question" ON "practice_decisions" USING btree ("student_id","question_version_id");
