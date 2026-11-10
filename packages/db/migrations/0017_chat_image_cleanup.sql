ALTER TABLE "files" ADD COLUMN "source_key" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "sealed_key" text;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "cleanup_error" text;--> statement-breakpoint
UPDATE "files" SET "source_key"="object_key" WHERE "purpose"='conversation_image' AND "status" IN ('prepared','rejected');--> statement-breakpoint
UPDATE "files" SET "sealed_key"="object_key" WHERE "purpose"='conversation_image' AND "status"='ready';--> statement-breakpoint
CREATE INDEX "files_cleanup_lookup" ON "files" USING btree ("purpose","status","created_at");
