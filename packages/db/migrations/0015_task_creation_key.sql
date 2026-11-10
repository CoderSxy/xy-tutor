ALTER TABLE "learning_tasks" ADD COLUMN "creation_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "learning_task_creation_key" ON "learning_tasks" USING btree ("student_id","creation_key") WHERE "learning_tasks"."creation_key" IS NOT NULL;
