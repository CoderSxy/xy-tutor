CREATE TABLE "tutoring_episodes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "student_id" uuid NOT NULL,
  "task_id" uuid NOT NULL,
  "question_version_id" uuid NOT NULL,
  "request_key" text NOT NULL,
  "state" text DEFAULT 'active' NOT NULL,
  "teaching_state" text DEFAULT 'awaiting_evidence' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "lease_epoch" integer DEFAULT 1 NOT NULL,
  "lease_expires_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seq" integer DEFAULT 0 NOT NULL,
  "exposure" text DEFAULT 'none' NOT NULL,
  "prior_exposure" boolean DEFAULT false NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "ended_at" timestamp with time zone,
  "first_submitted_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tutoring_episode_state_check" CHECK ("state" IN ('active', 'paused', 'finished')),
  CONSTRAINT "tutoring_episode_exposure_check" CHECK ("exposure" IN ('none', 'guided', 'solution_exposed', 'unknown')),
  CONSTRAINT "tutoring_episode_teaching_state_check" CHECK ("teaching_state" IN ('awaiting_evidence','self_check','focused_check','micro_probe','explanation','independent_check','scheduled_review')),
  CONSTRAINT "tutoring_episode_positive_counters" CHECK ("version" > 0 AND "lease_epoch" > 0 AND "last_seq" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tutoring_episodes" ADD CONSTRAINT "tutoring_episodes_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tutoring_episodes" ADD CONSTRAINT "tutoring_episodes_task_id_learning_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."learning_tasks"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tutoring_episodes" ADD CONSTRAINT "tutoring_episodes_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "public"."question_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "tutoring_episode_request_key" ON "tutoring_episodes" USING btree ("student_id","request_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "tutoring_episode_active_lease" ON "tutoring_episodes" USING btree ("student_id") WHERE "tutoring_episodes"."state" IN ('active', 'paused');
--> statement-breakpoint
CREATE INDEX "tutoring_episode_student_task_time" ON "tutoring_episodes" USING btree ("student_id","task_id","created_at");
--> statement-breakpoint
CREATE INDEX "tutoring_episode_question" ON "tutoring_episodes" USING btree ("student_id","question_version_id");
--> statement-breakpoint
CREATE TABLE "timing_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "episode_id" uuid NOT NULL,
  "event_id" uuid NOT NULL,
  "seq" integer NOT NULL,
  "segment_id" uuid NOT NULL,
  "lease_epoch" integer NOT NULL,
  "kind" text NOT NULL,
  "cumulative_active_ms" integer NOT NULL,
  "accepted_ms" integer NOT NULL,
  "phase" text NOT NULL,
  "payload_hash" text NOT NULL,
  "received_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "timing_event_kind_check" CHECK ("kind" IN ('start','checkpoint','pause','resume','finish')),
  CONSTRAINT "timing_event_phase_check" CHECK ("phase" IN ('initial','self_check','post_hint')),
  CONSTRAINT "timing_event_non_negative" CHECK ("cumulative_active_ms" >= 0 AND "accepted_ms" >= 0 AND "seq" > 0 AND "lease_epoch" > 0)
);
--> statement-breakpoint
ALTER TABLE "timing_events" ADD CONSTRAINT "timing_events_episode_id_tutoring_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."tutoring_episodes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "timing_event_key" ON "timing_events" USING btree ("episode_id","event_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "timing_event_seq" ON "timing_events" USING btree ("episode_id","seq");
--> statement-breakpoint
CREATE INDEX "timing_event_episode_time" ON "timing_events" USING btree ("episode_id","received_at");
--> statement-breakpoint
CREATE TABLE "timing_segments" (
  "id" uuid PRIMARY KEY NOT NULL,
  "episode_id" uuid NOT NULL,
  "phase" text NOT NULL,
  "start_at" timestamp with time zone NOT NULL,
  "end_at" timestamp with time zone,
  "accepted_ms" integer DEFAULT 0 NOT NULL,
  "quality" text DEFAULT 'reliable' NOT NULL,
  "reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "timing_segment_phase_check" CHECK ("phase" IN ('initial','self_check','post_hint')),
  CONSTRAINT "timing_segment_quality_check" CHECK ("quality" IN ('reliable','partial','unusable')),
  CONSTRAINT "timing_segment_accepted_ms" CHECK ("accepted_ms" >= 0)
);
--> statement-breakpoint
ALTER TABLE "timing_segments" ADD CONSTRAINT "timing_segments_episode_id_tutoring_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."tutoring_episodes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "timing_segment_episode" ON "timing_segments" USING btree ("episode_id","start_at");
--> statement-breakpoint
CREATE TABLE "attempt_timing_snapshots" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "attempt_id" uuid NOT NULL,
  "episode_id" uuid,
  "version" integer DEFAULT 1 NOT NULL,
  "first_attempt_ms" integer,
  "self_check_ms" integer,
  "post_hint_ms" integer,
  "total_active_ms" integer,
  "wall_ms" integer,
  "quality" text DEFAULT 'missing' NOT NULL,
  "reason_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "first_submitted_at" timestamp with time zone,
  "evidence_boundary" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "attempt_timing_snapshot_quality_check" CHECK ("quality" IN ('reliable','partial','unusable','missing')),
  CONSTRAINT "attempt_timing_snapshot_non_negative" CHECK (("first_attempt_ms" IS NULL OR "first_attempt_ms" >= 0) AND ("self_check_ms" IS NULL OR "self_check_ms" >= 0) AND ("post_hint_ms" IS NULL OR "post_hint_ms" >= 0) AND ("total_active_ms" IS NULL OR "total_active_ms" >= 0) AND ("wall_ms" IS NULL OR "wall_ms" >= 0))
);
--> statement-breakpoint
ALTER TABLE "attempt_timing_snapshots" ADD CONSTRAINT "attempt_timing_snapshots_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attempt_timing_snapshots" ADD CONSTRAINT "attempt_timing_snapshots_episode_id_tutoring_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."tutoring_episodes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "attempt_timing_snapshot_version" ON "attempt_timing_snapshots" USING btree ("attempt_id","version");
--> statement-breakpoint
CREATE INDEX "attempt_timing_snapshot_episode" ON "attempt_timing_snapshots" USING btree ("episode_id");
--> statement-breakpoint
CREATE TABLE "attempt_process_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "attempt_id" uuid NOT NULL,
  "message_version_id" uuid,
  "file_id" uuid,
  "kind" text NOT NULL,
  "content" text,
  "content_hash" text NOT NULL,
  "step_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attempt_process_evidence" ADD CONSTRAINT "attempt_process_evidence_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attempt_process_evidence" ADD CONSTRAINT "attempt_process_evidence_message_version_id_message_versions_id_fk" FOREIGN KEY ("message_version_id") REFERENCES "public"."message_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attempt_process_evidence" ADD CONSTRAINT "attempt_process_evidence_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "attempt_process_evidence_attempt" ON "attempt_process_evidence" USING btree ("attempt_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "attempt_process_evidence_source" ON "attempt_process_evidence" USING btree ("attempt_id","kind","content_hash");
--> statement-breakpoint
CREATE TABLE "error_diagnoses" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "attempt_id" uuid NOT NULL,
  "assessment_id" uuid,
  "question_version_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "primary_code" text,
  "summary" text DEFAULT '' NOT NULL,
  "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "rule_version" text NOT NULL,
  "model_version" text,
  "created_by" uuid,
  "invalidated_at" timestamp with time zone,
  "invalid_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "error_diagnosis_status_check" CHECK ("status" IN ('pending','needs_probe','confirmed','unsupported','invalidated')),
  CONSTRAINT "error_diagnosis_primary_code_check" CHECK ("primary_code" IS NULL OR "primary_code" IN ('execution_slip','condition_omission','concept_gap','rule_misuse','strategy_gap','expression_gap','input_issue'))
);
--> statement-breakpoint
ALTER TABLE "error_diagnoses" ADD CONSTRAINT "error_diagnoses_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "error_diagnoses" ADD CONSTRAINT "error_diagnoses_assessment_id_assessments_id_fk" FOREIGN KEY ("assessment_id") REFERENCES "public"."assessments"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "error_diagnoses" ADD CONSTRAINT "error_diagnoses_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "public"."question_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "error_diagnoses" ADD CONSTRAINT "error_diagnoses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "error_diagnosis_version" ON "error_diagnoses" USING btree ("attempt_id","version");
--> statement-breakpoint
CREATE INDEX "error_diagnosis_attempt" ON "error_diagnoses" USING btree ("attempt_id","created_at");
--> statement-breakpoint
CREATE INDEX "error_diagnosis_question" ON "error_diagnoses" USING btree ("question_version_id");
--> statement-breakpoint
CREATE TABLE "diagnosis_candidates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "diagnosis_id" uuid NOT NULL,
  "code" text NOT NULL,
  "skill_id" uuid,
  "status" text DEFAULT 'hypothesis' NOT NULL,
  "earliest_error" jsonb,
  "supports" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "contradicts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "probe" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "diagnosis_candidate_code_check" CHECK ("code" IN ('execution_slip','condition_omission','concept_gap','rule_misuse','strategy_gap','expression_gap','input_issue')),
  CONSTRAINT "diagnosis_candidate_status_check" CHECK ("status" IN ('hypothesis','supported','confirmed','rejected'))
);
--> statement-breakpoint
ALTER TABLE "diagnosis_candidates" ADD CONSTRAINT "diagnosis_candidates_diagnosis_id_error_diagnoses_id_fk" FOREIGN KEY ("diagnosis_id") REFERENCES "public"."error_diagnoses"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "diagnosis_candidate_diagnosis" ON "diagnosis_candidates" USING btree ("diagnosis_id");
--> statement-breakpoint
CREATE TABLE "tutoring_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "episode_id" uuid NOT NULL,
  "version" integer NOT NULL,
  "state" text NOT NULL,
  "exposure" text NOT NULL,
  "failed_checks" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tutoring_state_state_check" CHECK ("state" IN ('awaiting_evidence','self_check','focused_check','micro_probe','explanation','independent_check','scheduled_review')),
  CONSTRAINT "tutoring_state_exposure_check" CHECK ("exposure" IN ('none','guided','solution_exposed','unknown')),
  CONSTRAINT "tutoring_state_failed_checks" CHECK ("failed_checks" >= 0)
);
--> statement-breakpoint
ALTER TABLE "tutoring_states" ADD CONSTRAINT "tutoring_states_episode_id_tutoring_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."tutoring_episodes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "tutoring_state_version" ON "tutoring_states" USING btree ("episode_id","version");
--> statement-breakpoint
CREATE TABLE "tutoring_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "episode_id" uuid NOT NULL,
  "request_key" text NOT NULL,
  "payload_hash" text NOT NULL,
  "kind" text NOT NULL,
  "state_version" integer NOT NULL,
  "state" text NOT NULL,
  "exposure" text NOT NULL,
  "display_status" text DEFAULT 'created' NOT NULL,
  "content" text DEFAULT '' NOT NULL,
  "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "hint_id" uuid,
  "message_version_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tutoring_action_kind_check" CHECK ("kind" IN ('request_hint','request_probe','request_example','request_explanation','acknowledge_display','pause','resume')),
  CONSTRAINT "tutoring_action_display_status_check" CHECK ("display_status" IN ('created','sent','acknowledged','unknown')),
  CONSTRAINT "tutoring_action_exposure_check" CHECK ("exposure" IN ('none','guided','solution_exposed','unknown'))
);
--> statement-breakpoint
ALTER TABLE "tutoring_actions" ADD CONSTRAINT "tutoring_actions_episode_id_tutoring_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."tutoring_episodes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tutoring_actions" ADD CONSTRAINT "tutoring_actions_hint_id_hints_id_fk" FOREIGN KEY ("hint_id") REFERENCES "public"."hints"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "tutoring_actions" ADD CONSTRAINT "tutoring_actions_message_version_id_message_versions_id_fk" FOREIGN KEY ("message_version_id") REFERENCES "public"."message_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "tutoring_action_request_key" ON "tutoring_actions" USING btree ("episode_id","request_key");
--> statement-breakpoint
CREATE INDEX "tutoring_action_episode_time" ON "tutoring_actions" USING btree ("episode_id","created_at");
--> statement-breakpoint
CREATE TABLE "self_check_outcomes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "episode_id" uuid NOT NULL,
  "round_no" integer NOT NULL,
  "action_id" uuid,
  "before_attempt_id" uuid,
  "after_attempt_id" uuid,
  "outcome" text NOT NULL,
  "evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "self_check_outcome_check" CHECK ("outcome" IN ('resolved','unresolved','exited'))
);
--> statement-breakpoint
ALTER TABLE "self_check_outcomes" ADD CONSTRAINT "self_check_outcomes_episode_id_tutoring_episodes_id_fk" FOREIGN KEY ("episode_id") REFERENCES "public"."tutoring_episodes"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "self_check_outcomes" ADD CONSTRAINT "self_check_outcomes_action_id_tutoring_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."tutoring_actions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "self_check_outcomes" ADD CONSTRAINT "self_check_outcomes_before_attempt_id_attempts_id_fk" FOREIGN KEY ("before_attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "self_check_outcomes" ADD CONSTRAINT "self_check_outcomes_after_attempt_id_attempts_id_fk" FOREIGN KEY ("after_attempt_id") REFERENCES "public"."attempts"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "self_check_outcome_round" ON "self_check_outcomes" USING btree ("episode_id","round_no");
