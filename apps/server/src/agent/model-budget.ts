type Priority = "interactive" | "background";
type Waiter = {
  priority: Priority;
  resolve: (release: () => void) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
  abort: () => void;
};
export class ModelBudget {
  private active = 0;
  private queue: Waiter[] = [];
  constructor(private max = 2) {
    if (!Number.isInteger(max) || max < 1)
      throw Error("Invalid model concurrency");
  }
  async acquire(priority: Priority, signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        priority,
        resolve,
        reject,
        signal,
        abort: () => {
          this.queue = this.queue.filter((w) => w !== waiter);
          reject(new DOMException("Aborted", "AbortError"));
        },
      };
      this.queue.push(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.drain();
    });
  }
  private drain() {
    while (this.active < this.max && this.queue.length) {
      const index = this.queue.findIndex((w) => w.priority === "interactive");
      const waiter = this.queue.splice(index < 0 ? 0 : index, 1)[0]!;
      waiter.signal?.removeEventListener("abort", waiter.abort);
      if (waiter.signal?.aborted) {
        waiter.reject(new DOMException("Aborted", "AbortError"));
        continue;
      }
      this.active++;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.active--;
        this.drain();
      });
    }
  }
  async withPermit<T>(priority: Priority, run: () => Promise<T>): Promise<T> {
    const release = await this.acquire(priority);
    try {
      return await run();
    } finally {
      release();
    }
  }
}
