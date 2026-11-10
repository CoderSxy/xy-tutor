CREATE TABLE "chapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "textbook_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"page_id" uuid NOT NULL,
	"chapter_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"text" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "curriculum_editions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "curriculum_editions_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "grades" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "grades_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "textbook_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"revision_id" uuid NOT NULL,
	"page_index" integer NOT NULL,
	"printed_page_label" text,
	"text" text NOT NULL,
	"status" text NOT NULL,
	"excluded" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "textbook_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"textbook_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"revision_no" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"page_count" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subjects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "subjects_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "textbooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"edition_id" uuid NOT NULL,
	"grade_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"term" text NOT NULL,
	"publication_year" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "chapters" ADD CONSTRAINT "chapters_revision_id_textbook_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."textbook_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "textbook_chunks" ADD CONSTRAINT "textbook_chunks_revision_id_textbook_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."textbook_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "textbook_chunks" ADD CONSTRAINT "textbook_chunks_page_id_textbook_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."textbook_pages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "textbook_chunks" ADD CONSTRAINT "textbook_chunks_chapter_id_chapters_id_fk" FOREIGN KEY ("chapter_id") REFERENCES "public"."chapters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "textbook_pages" ADD CONSTRAINT "textbook_pages_revision_id_textbook_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."textbook_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "textbook_revisions" ADD CONSTRAINT "textbook_revisions_textbook_id_textbooks_id_fk" FOREIGN KEY ("textbook_id") REFERENCES "public"."textbooks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "textbook_revisions" ADD CONSTRAINT "textbook_revisions_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."files"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "textbooks" ADD CONSTRAINT "textbooks_edition_id_curriculum_editions_id_fk" FOREIGN KEY ("edition_id") REFERENCES "public"."curriculum_editions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "textbooks" ADD CONSTRAINT "textbooks_grade_id_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."grades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "textbooks" ADD CONSTRAINT "textbooks_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "revision_chapter_name" ON "chapters" USING btree ("revision_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "page_chunk_position" ON "textbook_chunks" USING btree ("page_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "revision_page_index" ON "textbook_pages" USING btree ("revision_id","page_index");--> statement-breakpoint
CREATE UNIQUE INDEX "textbook_revision_number" ON "textbook_revisions" USING btree ("textbook_id","revision_no");--> statement-breakpoint
CREATE UNIQUE INDEX "textbook_identity" ON "textbooks" USING btree ("edition_id","grade_id","subject_id","term","publication_year");