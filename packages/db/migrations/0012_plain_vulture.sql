CREATE TABLE "student_selections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"grade_id" uuid NOT NULL,
	"subject_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"selected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "student_selections" ADD CONSTRAINT "student_selections_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_selections" ADD CONSTRAINT "student_selections_grade_id_grades_id_fk" FOREIGN KEY ("grade_id") REFERENCES "public"."grades"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_selections" ADD CONSTRAINT "student_selections_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "student_selections" ADD CONSTRAINT "student_selections_revision_id_textbook_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."textbook_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "student_grade_subject_selection" ON "student_selections" USING btree ("student_id","grade_id","subject_id");