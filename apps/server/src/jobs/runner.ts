import { randomUUID } from "node:crypto";
import type { JobQueue, Job } from "./queue.js";
export type JobHandler = (job: Job, signal: AbortSignal) => Promise<unknown>;
export class JobRunner {
  private busy = false;
  private timer?: ReturnType<typeof setInterval>;
  private workerId = randomUUID();
  constructor(
    private queue: JobQueue,
    private handlers: Record<string, JobHandler>,
    private canStart: () => Promise<boolean> = async () => true,
  ) {}
  async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      if (!(await this.canStart())) return;
      const job = await this.queue.claim(this.workerId, new Date());
      if (!job) return;
      const controller = new AbortController();
      const heartbeat = setInterval(() => {
        void this.queue
          .heartbeat(job.id, job.leaseToken)
          .then((ok) => {
            if (!ok) controller.abort();
          })
          .catch(() => controller.abort());
      }, 10000);
      heartbeat.unref();
      try {
        const handler = this.handlers[job.kind];
        if (!handler) throw Error("UNSUPPORTED_JOB");
        const result = await handler(job, controller.signal);
        await this.queue.finish(job.id, job.leaseToken, result);
      } catch {
        await this.queue.fail(
          job.id,
          job.leaseToken,
          controller.signal.aborted ? "INTERRUPTED" : "PROCESSING_FAILED",
        );
      } finally {
        clearInterval(heartbeat);
      }
    } finally {
      this.busy = false;
    }
  }
  start() {
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 1000);
    this.timer.unref();
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
  }
}
