import type { IngestionDeps } from '../services/ingestionService.js';
import { processItem } from '../services/ingestionService.js';
import { toAppError } from '../errors.js';

export interface WorkerOptions {
  pollIntervalMs: number;
  maxAttempts: number;
  /** Backoff before automatic retry; attempt is 1-based. */
  backoffMs?: (attempt: number) => number;
}

/**
 * Single-instance, in-process worker. It claims one pending item at a time
 * (atomic UPDATE), processes it, and either marks it indexed, requeues it with
 * backoff, or marks it failed once attempts are exhausted. `kick()` wakes it
 * immediately after a new item is created; the poll interval is a safety net.
 */
export class IngestionWorker {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = true;
  private readonly backoffMs: (attempt: number) => number;

  constructor(private readonly deps: IngestionDeps, private readonly opts: WorkerOptions) {
    this.backoffMs = opts.backoffMs ?? ((attempt) => Math.min(30_000, 1000 * 2 ** (attempt - 1)));
  }

  start(): void {
    this.stopped = false;
    const recovered = this.deps.items.recoverInterrupted();
    if (recovered.length > 0) this.deps.log.warn({ itemIds: recovered }, 'requeued items interrupted by a previous shutdown');
    this.schedule(0);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    // Wait for an in-flight item to finish so we do not leave it half-processed.
    while (this.running) await new Promise((r) => setTimeout(r, 25));
  }

  /** Wakes the worker immediately (e.g. right after POST /ingest). */
  kick(): void {
    if (!this.stopped) this.schedule(0);
  }

  /** Processes everything that is runnable now; resolves when the queue is drained. Used by tests. */
  async drain(): Promise<void> {
    while (await this.tick()) {
      /* keep going */
    }
  }

  private schedule(delay: number): void {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.loop(), delay);
  }

  private async loop(): Promise<void> {
    if (this.running || this.stopped) return;
    try {
      while (!this.stopped && (await this.tick())) {
        /* drain all runnable items */
      }
    } finally {
      this.schedule(this.opts.pollIntervalMs);
    }
  }

  /** Claims and processes at most one item. Returns true if one was processed. */
  private async tick(): Promise<boolean> {
    if (this.running) return false;
    const item = this.deps.items.claimNextPending();
    if (!item) return false;
    this.running = true;
    const log = this.deps.log.child({ itemId: item.id, attempt: item.attempts, sourceType: item.sourceType });
    const started = Date.now();
    try {
      log.info('ingestion started');
      const { chunkCount } = await processItem(this.deps, item);
      log.info({ chunkCount, ms: Date.now() - started }, 'ingestion completed');
    } catch (err) {
      const appErr = toAppError(err);
      const willRetry = appErr.retryable && item.attempts < this.opts.maxAttempts;
      log.warn({ code: appErr.code, message: appErr.message, willRetry, ms: Date.now() - started, cause: appErr.cause instanceof Error ? appErr.cause.message : undefined }, 'ingestion failed');
      if (willRetry) {
        const nextAttemptAt = new Date(Date.now() + this.backoffMs(item.attempts)).toISOString();
        this.deps.items.requeue(item.id, { nextAttemptAt, error: { code: appErr.code, message: appErr.message } });
      } else {
        this.deps.items.markFailed(item.id, { code: appErr.code, message: appErr.message });
      }
    } finally {
      this.running = false;
    }
    return true;
  }
}
