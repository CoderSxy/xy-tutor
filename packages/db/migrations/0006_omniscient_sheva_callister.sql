CREATE TABLE "learning_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"student_id" uuid NOT NULL,
	"revision_id" uuid NOT NULL,
	"entry_key" text NOT NULL,
	"conversation_id" uuid NOT NULL
);
--> statement-breakpoint
ALTER TABLE "learning_entries" ADD CONSTRAINT "learning_entries_student_id_student_profiles_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."student_profiles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_entries" ADD CONSTRAINT "learning_entries_revision_id_textbook_revisions_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."textbook_revisions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_entries" ADD CONSTRAINT "learning_entries_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "student_learning_entry" ON "learning_entries" USING btree ("student_id","revision_id","entry_key");