ALTER TABLE "files" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "width" integer;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "height" integer;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id");--> statement-breakpoint
CREATE TABLE "message_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_version_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_version_id_message_versions_id_fk" FOREIGN KEY ("message_version_id") REFERENCES "message_versions"("id");--> statement-breakpoint
ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_file_id_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "files"("id");--> statement-breakpoint
CREATE UNIQUE INDEX "message_attachment_position" ON "message_attachments" USING btree ("message_version_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "message_attachment_file" ON "message_attachments" USING btree ("message_version_id","file_id");