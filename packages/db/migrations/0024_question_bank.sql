CREATE TABLE "skills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "code" text NOT NULL,
  "name" text NOT NULL,
  "status" text DEFAULT 'active' NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skills_status_check" CHECK ("status" IN ('active','withdrawn'))
);
--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "skills_code_unique" ON "skills" USING btree ("code");
--> statement-breakpoint
CREATE TABLE "skill_content_links" (
  "skill_id" uuid NOT NULL,
  "knowledge_item_id" uuid NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_content_links_pk" PRIMARY KEY ("skill_id","knowledge_item_id")
);
--> statement-breakpoint
ALTER TABLE "skill_content_links" ADD CONSTRAINT "skill_content_links_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_content_links" ADD CONSTRAINT "skill_content_links_knowledge_item_id_knowledge_items_id_fk" FOREIGN KEY ("knowledge_item_id") REFERENCES "public"."knowledge_items"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_content_links" ADD CONSTRAINT "skill_content_links_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "skill_content_links_item" ON "skill_content_links" USING btree ("knowledge_item_id");
--> statement-breakpoint
CREATE TABLE "skill_prerequisites" (
  "skill_id" uuid NOT NULL,
  "prerequisite_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "skill_prerequisites_pk" PRIMARY KEY ("skill_id","prerequisite_id"),
  CONSTRAINT "skill_prerequisites_not_self" CHECK ("skill_id" <> "prerequisite_id")
);
--> statement-breakpoint
ALTER TABLE "skill_prerequisites" ADD CONSTRAINT "skill_prerequisites_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "skill_prerequisites" ADD CONSTRAINT "skill_prerequisites_prerequisite_id_skills_id_fk" FOREIGN KEY ("prerequisite_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "skill_prerequisites_prerequisite" ON "skill_prerequisites" USING btree ("prerequisite_id");
--> statement-breakpoint
CREATE TABLE "question_bank_entries" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "question_version_id" uuid NOT NULL,
  "difficulty_band" text NOT NULL,
  "complexity_band" integer NOT NULL,
  "visibility" text NOT NULL,
  "owner_id" uuid,
  "source_type" text NOT NULL,
  "source_ref" text,
  "template_family" text,
  "content_fingerprint" text NOT NULL,
  "status" text DEFAULT 'draft' NOT NULL,
  "version" integer DEFAULT 1 NOT NULL,
  "published_at" timestamp with time zone,
  "withdrawn_reason" text,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "question_bank_entry_visibility_check" CHECK ("visibility" IN ('shared','owner_only')),
  CONSTRAINT "question_bank_entry_owner_required" CHECK ("visibility" <> 'owner_only' OR "owner_id" IS NOT NULL),
  CONSTRAINT "question_bank_entry_status_check" CHECK ("status" IN ('draft','checking','pending_review','published','rejected','withdrawn')),
  CONSTRAINT "question_bank_entry_published_consistency" CHECK (("status" = 'published') = ("published_at" IS NOT NULL)),
  CONSTRAINT "question_bank_entry_complexity_check" CHECK ("complexity_band" BETWEEN 1 AND 3 AND "version" > 0)
);
--> statement-breakpoint
ALTER TABLE "question_bank_entries" ADD CONSTRAINT "question_bank_entries_question_version_id_question_versions_id_fk" FOREIGN KEY ("question_version_id") REFERENCES "public"."question_versions"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "question_bank_entries" ADD CONSTRAINT "question_bank_entries_owner_id_student_profiles_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."student_profiles"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "question_bank_entries" ADD CONSTRAINT "question_bank_entries_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "question_bank_entry_version_unique" ON "question_bank_entries" USING btree ("question_version_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "question_bank_entry_shared_fingerprint" ON "question_bank_entries" USING btree ("content_fingerprint") WHERE "question_bank_entries"."visibility" = 'shared';
--> statement-breakpoint
CREATE UNIQUE INDEX "question_bank_entry_owner_fingerprint" ON "question_bank_entries" USING btree ("owner_id","content_fingerprint") WHERE "question_bank_entries"."visibility" = 'owner_only';
--> statement-breakpoint
CREATE INDEX "question_bank_entry_difficulty" ON "question_bank_entries" USING btree ("difficulty_band");
--> statement-breakpoint
CREATE TABLE "question_skill_links" (
  "entry_id" uuid NOT NULL,
  "skill_id" uuid NOT NULL,
  "is_primary" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "question_skill_links_pk" PRIMARY KEY ("entry_id","skill_id")
);
--> statement-breakpoint
ALTER TABLE "question_skill_links" ADD CONSTRAINT "question_skill_links_entry_id_question_bank_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."question_bank_entries"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "question_skill_links" ADD CONSTRAINT "question_skill_links_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "question_skill_links_primary" ON "question_skill_links" USING btree ("entry_id") WHERE "question_skill_links"."is_primary";
--> statement-breakpoint
CREATE INDEX "question_skill_links_skill" ON "question_skill_links" USING btree ("skill_id","entry_id");
--> statement-breakpoint
CREATE TABLE "question_templates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "family" text NOT NULL,
  "skill_id" uuid,
  "difficulty_band" text NOT NULL,
  "params" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "question_templates_difficulty_check" CHECK ("difficulty_band" IN ('easy','medium','challenge'))
);
--> statement-breakpoint
ALTER TABLE "question_templates" ADD CONSTRAINT "question_templates_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "question_templates" ADD CONSTRAINT "question_templates_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "question_templates_family_unique" ON "question_templates" USING btree ("family");
--> statement-breakpoint
CREATE TABLE "question_generation_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "skill_id" uuid NOT NULL,
  "template_id" uuid,
  "status" text DEFAULT 'queued' NOT NULL,
  "requested_by" uuid NOT NULL,
  "params" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "question_generation_runs_status_check" CHECK ("status" IN ('queued','running','succeeded','failed'))
);
--> statement-breakpoint
ALTER TABLE "question_generation_runs" ADD CONSTRAINT "question_generation_runs_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "question_generation_runs" ADD CONSTRAINT "question_generation_runs_template_id_question_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."question_templates"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "question_generation_runs" ADD CONSTRAINT "question_generation_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "knowledge_items" DROP CONSTRAINT "knowledge_items_status_check";
--> statement-breakpoint
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_status_check" CHECK ("status" IN ('pending_review','published','discarded','withdrawn'));
