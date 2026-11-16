/**
 * AsyncSemaphore limits the number of concurrent asynchronous operations.
 * Used to protect Node.js libuv threadpool from saturation during CPU/RAM-heavy Argon2 hashing.
 */
export class AsyncSemaphore {
  private permits: number;
  private readonly maxPermits: number;
  private readonly queue: Array<() => void> = [];

  constructor(maxPermits: number) {
    if (maxPermits <= 0) {
      throw new Error('Semaphore maxPermits must be greater than zero');
    }
    this.maxPermits = maxPermits;
    this.permits = maxPermits;
  }

  get availablePermits(): number {
    return this.permits;
  }

  get waitingCount(): number {
    return this.queue.length;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits--;
      return;
    }

    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    if (this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) {
        next();
      }
    } else {
      if (this.permits < this.maxPermits) {
        this.permits++;
      }
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
