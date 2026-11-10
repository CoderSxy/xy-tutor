ALTER TABLE "agent_runs" ADD COLUMN "retry_of_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_retry_of_run_id_agent_runs_id_fk" FOREIGN KEY ("retry_of_run_id") REFERENCES "agent_runs"("id");
