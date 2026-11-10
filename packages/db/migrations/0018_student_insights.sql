CREATE TABLE "student_learning_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"actor_id" uuid,
	"event_type" text NOT NULL,
	"source_type" text NOT NULL,
	"source_id" uuid NOT NULL,
	"task_id" uuid,
	"revision_id" uuid,
	"occurred_at" timestamp with time zone NOT NULL,
	"source_origin" text DEFAULT 'live' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_learning_events_event_type_check" CHECK ("event_type" IN ('answer_submitted','learning_message_sent','material_submitted')),
	CONSTRAINT "student_learning_events_source_type_check" CHECK ("source_type" IN ('attempt','message','material')),
	CONSTRAINT "student_learning_events_origin_check" CHECK ("source_origin" IN ('live','historical_inferred'))
);
--> statement-breakpoint
ALTER TABLE "student_learning_events" ADD CONSTRAINT "student_learning_events_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "student_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_learning_events" ADD CONSTRAINT "student_learning_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_learning_events" ADD CONSTRAINT "student_learning_events_task_id_learning_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "learning_tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_learning_events" ADD CONSTRAINT "student_learning_events_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "student_learning_events_source_unique" ON "student_learning_events" USING btree ("student_id","event_type","source_type","source_id");--> statement-breakpoint
CREATE INDEX "student_learning_events_student_time" ON "student_learning_events" USING btree ("student_id","occurred_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "student_learning_events_time_student" ON "student_learning_events" USING btree ("occurred_at","student_id");--> statement-breakpoint
CREATE INDEX "student_learning_events_student_revision_time" ON "student_learning_events" USING btree ("student_id","revision_id","occurred_at");
--> statement-breakpoint
CREATE TABLE "student_daily_visits" (
	"student_id" uuid NOT NULL,
	"local_date" date NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_daily_visits_student_id_local_date_timezone_pk" PRIMARY KEY("student_id","local_date","timezone")
);
--> statement-breakpoint
ALTER TABLE "student_daily_visits" ADD CONSTRAINT "student_daily_visits_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "student_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "student_daily_visits_date_student" ON "student_daily_visits" USING btree ("local_date","student_id");
--> statement-breakpoint
CREATE TABLE "student_insight_backfills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version" text NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"last_source_cursor" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_insight_backfills_version_unique" UNIQUE("version")
);
--> statement-breakpoint
CREATE TABLE "student_insight_collection_state" (
	"id" integer PRIMARY KEY NOT NULL,
	"learning_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"visits_started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "student_insight_collection_state_singleton" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE "student_insight_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"requested_by" uuid NOT NULL,
	"from_date" date NOT NULL,
	"to_date" date NOT NULL,
	"timezone" text DEFAULT 'Asia/Shanghai' NOT NULL,
	"revision_id" uuid,
	"metric_version" text NOT NULL,
	"prompt_version" text NOT NULL,
	"snapshot_hash" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"evidence_catalog" jsonb NOT NULL,
	"content" jsonb,
	"status" text DEFAULT 'queued' NOT NULL,
	"job_id" uuid,
	"generation" integer DEFAULT 1 NOT NULL,
	"model" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "student_insight_reports_status_check" CHECK ("status" IN ('queued','running','completed','failed'))
);
--> statement-breakpoint
ALTER TABLE "student_insight_reports" ADD CONSTRAINT "student_insight_reports_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "student_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_insight_reports" ADD CONSTRAINT "student_insight_reports_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_insight_reports" ADD CONSTRAINT "student_insight_reports_revision_id_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_insight_reports" ADD CONSTRAINT "student_insight_reports_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "student_insight_reports_history" ON "student_insight_reports" USING btree ("student_id","created_at" DESC NULLS LAST,"id");--> statement-breakpoint
CREATE INDEX "student_insight_reports_active" ON "student_insight_reports" USING btree ("student_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "student_insight_reports_snapshot_unique" ON "student_insight_reports" USING btree ("student_id","metric_version","prompt_version","snapshot_hash",(COALESCE("revision_id", '00000000-0000-0000-0000-000000000000'::uuid)));
