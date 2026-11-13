ALTER TABLE "question_templates" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "question_templates" ADD COLUMN "status" text DEFAULT 'pending_review' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_templates" ADD COLUMN "approved_by" uuid;--> statement-breakpoint
ALTER TABLE "question_templates" ADD COLUMN "approved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "question_templates" ADD CONSTRAINT "question_templates_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_templates" ADD CONSTRAINT "question_templates_status_check" CHECK ("status" IN ('pending_review','approved','rejected'));--> statement-breakpoint
ALTER TABLE "question_templates" ADD CONSTRAINT "question_templates_approval_consistency" CHECK (("status" = 'approved') = ("approved_at" IS NOT NULL AND "approved_by" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "question_templates" ADD CONSTRAINT "question_templates_version_check" CHECK ("version" > 0);--> statement-breakpoint
ALTER TABLE "question_generation_runs" ADD COLUMN "student_id" uuid;--> statement-breakpoint
ALTER TABLE "question_generation_runs" ADD COLUMN "visibility" text DEFAULT 'owner_only' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_generation_runs" ADD COLUMN "request_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_generation_runs" ADD COLUMN "dedupe_key" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "question_generation_runs" ADD COLUMN "result_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "question_generation_runs" ADD COLUMN "knowledge_evidence" jsonb;--> statement-breakpoint
ALTER TABLE "question_generation_runs" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "question_generation_runs" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "question_generation_runs" ALTER COLUMN "request_key" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "question_generation_runs" ALTER COLUMN "dedupe_key" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "question_generation_runs" ADD CONSTRAINT "question_generation_runs_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_generation_runs" ADD CONSTRAINT "question_generation_runs_result_entry_id_question_bank_entries_id_fk" FOREIGN KEY ("result_entry_id") REFERENCES "public"."question_bank_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_generation_runs" ADD CONSTRAINT "question_generation_runs_visibility_check" CHECK ("visibility" IN ('shared','owner_only'));--> statement-breakpoint
ALTER TABLE "question_generation_runs" ADD CONSTRAINT "question_generation_runs_owner_required" CHECK ("visibility" <> 'owner_only' OR "student_id" IS NOT NULL);--> statement-breakpoint
CREATE UNIQUE INDEX "question_generation_runs_dedupe_unique" ON "question_generation_runs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "question_generation_runs_student_skill" ON "question_generation_runs" USING btree ("student_id","skill_id","created_at");
