CREATE INDEX "attempts_student_time" ON "attempts" USING btree ("student_id","created_at","id");--> statement-breakpoint
CREATE INDEX "assessments_attempt_latest" ON "assessments" USING btree ("attempt_id","created_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "evidence_invalidations_student_version" ON "evidence_invalidations" USING btree ("student_id","evidence_version_id");--> statement-breakpoint
CREATE INDEX "knowledge_observations_student_time" ON "knowledge_observations" USING btree ("student_id","created_at","id");--> statement-breakpoint
CREATE INDEX "materials_student_time" ON "materials" USING btree ("student_id","created_at","id");--> statement-breakpoint
CREATE INDEX "learning_tasks_student_time" ON "learning_tasks" USING btree ("student_id","created_at","id");--> statement-breakpoint
CREATE INDEX "hints_task_question" ON "hints" USING btree ("task_id","question_version_id");
