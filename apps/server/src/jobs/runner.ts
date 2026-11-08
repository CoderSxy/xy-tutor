const safeErrorCodes = new Set([
  "PDF_PAGE_LIMIT",
  "FILE_SIZE_LIMIT",
  "PDF_PARSE_FAILED",
  "PARSE_OUTPUT_LIMIT",
  "IMAGE_PIXEL_LIMIT",
  "OCR_IMAGE_LIMIT",
  "OCR_UNAVAILABLE",
  "OSS_NOT_CONFIGURED",
  "INVALID_TEXTBOOK_FILE",
]);
import { randomUUID } from "node:crypto";
import type { JobQueue, Job } from "./queue.js";
export type JobHandler = (job: Job, signal: AbortSignal) => Promise<unknown>;
export class JobRunner {
  private busy = false;
  private stopping = false;
  private drain?: Promise<void>;
  private controller?: AbortController;
  private timer?: ReturnType<typeof setInterval>;
  private workerId = randomUUID();
  constructor(
    private queue: JobQueue,
    private handlers: Record<string, JobHandler>,
    private canStart: () => Promise<boolean> = async () => true,
  ) {}
  async tick(): Promise<void> {
    if (this.busy || this.stopping) return;
    this.busy = true;
    let drained!: () => void;
    this.drain = new Promise<void>((resolve) => {
      drained = resolve;
    });
    try {
      if (!(await this.canStart())) return;
      const job = await this.queue.claim(this.workerId, new Date());
      if (!job) return;
      const controller = new AbortController();
      this.controller = controller;
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
      } catch (error) {
        const code =
          error instanceof Error && safeErrorCodes.has(error.message)
            ? error.message
            : "PROCESSING_FAILED";
        await this.queue.fail(
          job.id,
          job.leaseToken,
          controller.signal.aborted ? "INTERRUPTED" : code,
        );
      } finally {
        clearInterval(heartbeat);
      }
    } finally {
      this.busy = false;
      this.controller = undefined;
      drained();
    }
  }
  start() {
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, 1000);
    this.timer.unref();
  }
  async stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.controller?.abort();
    await this.drain;
  }
}
