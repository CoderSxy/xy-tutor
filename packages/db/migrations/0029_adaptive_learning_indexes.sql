CREATE INDEX "timing_event_created_at" ON "timing_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "question_reference_version_time" ON "question_references" USING btree ("question_version_id","created_at");
