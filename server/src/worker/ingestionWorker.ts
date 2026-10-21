import type { IngestionDeps } from '../services/ingestionService.js';
import { ItemStateConflictError, processItem } from '../services/ingestionService.js';
import { toAppError } from '../errors.js';

export interface WorkerOptions {
  pollIntervalMs: number;
  maxAttempts: number;
  /** Backoff before automatic retry; attempt is 1-based. */
  backoffMs?: (attempt: number) => number;
  /** How long stop() waits for an in-flight item before giving up (default 10s). */
  stopTimeoutMs?: number;
}

export interface WorkerStatus {
  /** `degraded` while the loop itself is failing (e.g. the database is unavailable). */
  state: 'stopped' | 'ok' | 'degraded';
  consecutiveFailures: number;
  lastFailureAt: string | null;
  currentItemId: string | null;
}

/** Upper bound for the loop's own failure backoff, so a broken DB is retried at most every 30s. */
const MAX_LOOP_BACKOFF_MS = 30_000;

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
  /** True while a loop() body is executing, so at most one loop runs at a time. */
  private loopActive = false;
  private currentItemId: string | null = null;
  /**
   * Set when the loop's own bookkeeping failed. That can strand a row in `processing`
   * (typically a failed write of the item's outcome), so the next idle iteration recovers
   * orphans once. Event-driven: no sweep runs while the worker is healthy.
   */
  private orphanSweepPending = false;
  private consecutiveFailures = 0;
  private lastFailureAt: string | null = null;
  private readonly backoffMs: (attempt: number) => number;

  constructor(private readonly deps: IngestionDeps, private readonly opts: WorkerOptions) {
    this.backoffMs = opts.backoffMs ?? ((attempt) => Math.min(30_000, 1000 * 2 ** (attempt - 1)));
  }

  /**
   * Starts the worker. Idempotent while started: a second call does nothing, so recovery
   * (which resets every `processing` row) runs once per start and never under a live job.
   *
   * Rejects a restart while the previous run is still active, which happens after a stop()
   * that timed out: its job is still in flight, and recovering now would reset that job to
   * `pending` and process it twice. Once that job settles (it records its own outcome),
   * start() succeeds again. A new process has no such job, so its first start() recovers
   * genuinely interrupted work as before.
   */
  start(): void {
    if (!this.stopped) return;
    if (this.running || this.loopActive) {
      throw new Error(`IngestionWorker cannot restart while a job from its previous run is still in flight (item ${this.currentItemId ?? 'unknown'})`);
    }
    this.stopped = false;
    const { requeued, failed } = this.deps.items.recoverInterrupted(this.opts.maxAttempts);
    if (requeued.length > 0) this.deps.log.warn({ itemIds: requeued }, 'requeued items interrupted by a previous shutdown');
    if (failed.length > 0) this.deps.log.error({ itemIds: failed, maxAttempts: this.opts.maxAttempts }, 'marked interrupted items failed: attempt limit reached');
    this.schedule(0);
  }

  /**
   * Stops polling and waits (bounded) for the in-flight item. Returns false if the
   * wait timed out: that item stays `processing` in the database and is recovered
   * by `start()` on the next boot. Its chunks are only ever committed together with
   * the `indexed` status, so abandoning it cannot leave a half-indexed item.
   */
  async stop(timeoutMs = this.opts.stopTimeoutMs ?? 10_000): Promise<boolean> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const until = Date.now() + timeoutMs;
    while (this.running && Date.now() < until) await new Promise((r) => setTimeout(r, 25));
    if (this.running) this.deps.log.warn({ itemId: this.currentItemId, waitedMs: timeoutMs }, 'stopped without waiting for in-flight item; it will be recovered on next start');
    return !this.running;
  }

  status(): WorkerStatus {
    return {
      state: this.stopped ? 'stopped' : this.consecutiveFailures > 0 ? 'degraded' : 'ok',
      consecutiveFailures: this.consecutiveFailures,
      lastFailureAt: this.lastFailureAt,
      currentItemId: this.currentItemId,
    };
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

  /**
   * Errors from processing an item are handled inside tick(). Anything that escapes
   * to here is a failure of the worker's own bookkeeping, typically the database
   * (SQLITE_BUSY beyond busy_timeout, disk full). We log it, back off exponentially
   * so a persistent fault cannot spin, and keep the worker alive so it recovers
   * by itself once the fault clears. The state is visible on GET /health.
   */
  private async loop(): Promise<void> {
    if (this.loopActive || this.running || this.stopped) return;
    this.loopActive = true;
    let delay = this.opts.pollIntervalMs;
    try {
      if (this.orphanSweepPending) this.recoverOrphans();
      while (!this.stopped && (await this.tick())) {
        /* drain all runnable items */
      }
      this.consecutiveFailures = 0;
    } catch (err) {
      this.orphanSweepPending = true;
      this.consecutiveFailures++;
      this.lastFailureAt = new Date().toISOString();
      delay = Math.min(MAX_LOOP_BACKOFF_MS, this.opts.pollIntervalMs * 2 ** (this.consecutiveFailures - 1));
      this.deps.log.error({ err, consecutiveFailures: this.consecutiveFailures, retryInMs: delay }, 'ingestion worker loop failed; retrying after backoff');
    } finally {
      this.loopActive = false;
      this.schedule(delay);
    }
  }

  /**
   * Requeues (or, once attempts are used up, fails) every `processing` row.
   *
   * Safe only because of two facts that hold in this class. It is called from loop() alone,
   * immediately after the `running` check with no `await` in between, and tick() sets
   * `running` synchronously on claiming, so no job of this worker can be in flight here.
   * And exactly one worker owns the table, so no other process's job exists. If the
   * database rejects the update, loop() backs off and the flag stays set, so recovery is
   * retried without a tight loop.
   */
  private recoverOrphans(): void {
    const { requeued, failed } = this.deps.items.recoverOrphaned(this.opts.maxAttempts);
    this.orphanSweepPending = false;
    if (requeued.length > 0) this.deps.log.warn({ itemIds: requeued }, 'requeued orphaned processing items after a worker failure');
    if (failed.length > 0) this.deps.log.error({ itemIds: failed, maxAttempts: this.opts.maxAttempts }, 'marked orphaned processing items failed: attempt limit reached');
  }

  /** Claims and processes at most one item. Returns true if one was processed. */
  private async tick(): Promise<boolean> {
    if (this.running) return false;
    const item = this.deps.items.claimNextPending();
    if (!item) return false;
    this.running = true;
    this.currentItemId = item.id;
    const log = this.deps.log.child({ itemId: item.id, attempt: item.attempts, sourceType: item.sourceType });
    const started = Date.now();
    try {
      log.info('ingestion started');
      const { chunkCount } = await processItem(this.deps, item);
      log.info({ chunkCount, ms: Date.now() - started }, 'ingestion completed');
    } catch (err) {
      if (err instanceof ItemStateConflictError) {
        // Another writer already finished this item. Their state wins; write nothing.
        log.warn({ ms: Date.now() - started }, 'item was finished by another writer; outcome discarded');
        return true;
      }
      const appErr = toAppError(err);
      const willRetry = appErr.retryable && item.attempts < this.opts.maxAttempts;
      log.warn({ code: appErr.code, message: appErr.message, willRetry, ms: Date.now() - started, cause: appErr.cause instanceof Error ? appErr.cause.message : undefined }, 'ingestion failed');
      // Both writes only apply while the item is still `processing`; `false` is a lost race.
      let recorded: boolean;
      if (willRetry) {
        const nextAttemptAt = new Date(Date.now() + this.backoffMs(item.attempts)).toISOString();
        recorded = this.deps.items.requeue(item.id, { nextAttemptAt, error: { code: appErr.code, message: appErr.message }, onlyIfStatus: 'processing' });
      } else {
        recorded = this.deps.items.markFailed(item.id, { code: appErr.code, message: appErr.message });
      }
      if (!recorded) log.warn({ willRetry }, 'item was finished by another writer; outcome discarded');
    } finally {
      this.running = false;
      this.currentItemId = null;
    }
    return true;
  }
}
