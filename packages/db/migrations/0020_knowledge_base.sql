CREATE TABLE "knowledge_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid NOT NULL,
	"text_content" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "knowledge_batches" ADD CONSTRAINT "knowledge_batches_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "knowledge_batch_files" (
	"batch_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "knowledge_batch_files_batch_id_file_id_unique" UNIQUE("batch_id","file_id"),
	CONSTRAINT "knowledge_batch_files_batch_id_position_unique" UNIQUE("batch_id","position")
);
--> statement-breakpoint
ALTER TABLE "knowledge_batch_files" ADD CONSTRAINT "knowledge_batch_files_batch_id_knowledge_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."knowledge_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_batch_files" ADD CONSTRAINT "knowledge_batch_files_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE TABLE "knowledge_parse_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"extra_prompt" text,
	"model" text,
	"status" text NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "knowledge_parse_runs_status_check" CHECK ("status" IN ('queued','processing','succeeded','failed'))
);
--> statement-breakpoint
ALTER TABLE "knowledge_parse_runs" ADD CONSTRAINT "knowledge_parse_runs_batch_id_knowledge_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."knowledge_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_parse_runs_batch_created" ON "knowledge_parse_runs" USING btree ("batch_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE TABLE "knowledge_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"parse_run_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"status" text NOT NULL,
	"replaces_item_id" uuid,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_items_status_check" CHECK ("status" IN ('pending_review','published','discarded'))
);
--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_batch_id_knowledge_batches_id_fk" FOREIGN KEY ("batch_id") REFERENCES "public"."knowledge_batches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_parse_run_id_knowledge_parse_runs_id_fk" FOREIGN KEY ("parse_run_id") REFERENCES "public"."knowledge_parse_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_replaces_item_id_knowledge_items_id_fk" FOREIGN KEY ("replaces_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "knowledge_items_status_updated" ON "knowledge_items" USING btree ("status","updated_at" DESC NULLS LAST);
