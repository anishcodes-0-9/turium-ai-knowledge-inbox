import { randomUUID } from 'node:crypto';
import type { Database } from './connection.js';
import { nowIso, type ItemRecord, type ItemStatus, type SourceType } from '../domain.js';

interface ItemRow {
  id: string;
  source_type: SourceType;
  title: string;
  url: string | null;
  content: string | null;
  content_chars: number;
  status: ItemStatus;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  completed_at: string | null;
  next_attempt_at: string | null;
}

function rowToItem(r: ItemRow): ItemRecord {
  return {
    id: r.id,
    sourceType: r.source_type,
    title: r.title,
    url: r.url,
    content: r.content,
    contentChars: r.content_chars,
    status: r.status,
    attempts: r.attempts,
    errorCode: r.error_code,
    errorMessage: r.error_message,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    nextAttemptAt: r.next_attempt_at,
  };
}

const COLUMNS = `id, source_type, title, url, content, content_chars, status, attempts, error_code, error_message,
  created_at, updated_at, started_at, completed_at, next_attempt_at`;

export interface NewItem {
  sourceType: SourceType;
  title: string;
  url?: string | null;
  content?: string | null;
}

/** Data access for `items`. Pure SQL; no business rules live here. */
export class ItemsRepo {
  constructor(private readonly db: Database) {}

  create(input: NewItem): ItemRecord {
    const id = randomUUID();
    const ts = nowIso();
    const content = input.content ?? null;
    this.db
      .prepare(
        `INSERT INTO items (id, source_type, title, url, content, content_chars, status, attempts, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(id, input.sourceType, input.title, input.url ?? null, content, content?.length ?? 0, ts, ts);
    return this.getById(id)!;
  }

  getById(id: string): ItemRecord | null {
    const row = this.db.prepare(`SELECT ${COLUMNS} FROM items WHERE id = ?`).get(id) as ItemRow | undefined;
    return row ? rowToItem(row) : null;
  }

  list(opts: { limit: number; offset: number }): { items: ItemRecord[]; total: number } {
    const rows = this.db
      .prepare(`SELECT ${COLUMNS} FROM items ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(opts.limit, opts.offset) as unknown as ItemRow[];
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM items').get() as { n: number };
    return { items: rows.map(rowToItem), total: n };
  }

  countByStatus(): Record<ItemStatus, number> {
    const rows = this.db.prepare('SELECT status, COUNT(*) AS n FROM items GROUP BY status').all() as Array<{ status: ItemStatus; n: number }>;
    const out: Record<ItemStatus, number> = { pending: 0, processing: 0, indexed: 0, failed: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  /**
   * Atomically claims the oldest runnable pending item for the worker. The
   * UPDATE ... WHERE status='pending' guard means two concurrent claims can
   * never pick the same row.
   */
  claimNextPending(): ItemRecord | null {
    const ts = nowIso();
    const candidate = this.db
      .prepare(
        `SELECT id FROM items WHERE status = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY created_at ASC, rowid ASC LIMIT 1`,
      )
      .get(ts) as { id: string } | undefined;
    if (!candidate) return null;
    const res = this.db
      .prepare(
        `UPDATE items SET status = 'processing', attempts = attempts + 1, started_at = ?, updated_at = ?, error_code = NULL, error_message = NULL
         WHERE id = ? AND status = 'pending'`,
      )
      .run(ts, ts, candidate.id);
    if (res.changes !== 1) return null;
    return this.getById(candidate.id);
  }

  /**
   * Stores extracted content for URL items (called before chunking). Conditional on the
   * item still being `processing`, like the outcome writes below, so a stale fetch cannot
   * replace the content of an item another writer already finished. Returns whether it applied.
   */
  setContent(id: string, fields: { title: string; content: string }): boolean {
    const res = this.db
      .prepare(`UPDATE items SET title = ?, content = ?, content_chars = ?, updated_at = ? WHERE id = ? AND status = 'processing'`)
      .run(fields.title, fields.content, fields.content.length, nowIso(), id);
    return res.changes === 1;
  }

  /**
   * Outcome writes are conditional on the item still being `processing`, and return whether
   * they took effect. `false` means the row had already left `processing` (for example another
   * writer indexed or failed it first): a lost race. Callers must then leave the winning state
   * alone. This protects state integrity only. It does not stop two writers from doing the
   * same work, which would need ownership coordination the schema does not have.
   */
  markIndexed(id: string): boolean {
    const ts = nowIso();
    const res = this.db
      .prepare(`UPDATE items SET status = 'indexed', completed_at = ?, updated_at = ?, error_code = NULL, error_message = NULL, next_attempt_at = NULL WHERE id = ? AND status = 'processing'`)
      .run(ts, ts, id);
    return res.changes === 1;
  }

  markFailed(id: string, error: { code: string; message: string }): boolean {
    const ts = nowIso();
    const res = this.db
      .prepare(`UPDATE items SET status = 'failed', completed_at = ?, updated_at = ?, error_code = ?, error_message = ?, next_attempt_at = NULL WHERE id = ? AND status = 'processing'`)
      .run(ts, ts, error.code, error.message, id);
    return res.changes === 1;
  }

  /**
   * Puts an item back in the queue (automatic retry with backoff, and manual retry).
   * `onlyIfStatus` makes the write conditional; the worker passes `'processing'` so a stale
   * retry decision cannot pull an already indexed or failed item back to `pending`.
   * Returns whether a row was updated.
   */
  requeue(
    id: string,
    opts: { nextAttemptAt?: string | null; resetAttempts?: boolean; error?: { code: string; message: string }; onlyIfStatus?: ItemStatus } = {},
  ): boolean {
    const ts = nowIso();
    const res = this.db
      .prepare(
        `UPDATE items SET status = 'pending', next_attempt_at = ?, updated_at = ?, completed_at = NULL,
           attempts = CASE WHEN ? THEN 0 ELSE attempts END, error_code = ?, error_message = ?
         WHERE id = ? AND (? IS NULL OR status = ?)`,
      )
      .run(opts.nextAttemptAt ?? null, ts, opts.resetAttempts ? 1 : 0, opts.error?.code ?? null, opts.error?.message ?? null, id, opts.onlyIfStatus ?? null, opts.onlyIfStatus ?? null);
    return res.changes === 1;
  }

  /**
   * Called once at startup. Nothing is running yet in this process, so every `processing`
   * row was left behind by a crash or restart. `attempts` was already incremented when the
   * item was claimed, so an interrupted item that has used its full budget is marked
   * `failed` instead of requeued. Without this an item that crashes the process every time
   * would be retried forever.
   */
  recoverInterrupted(maxAttempts: number): { requeued: string[]; failed: string[] } {
    return this.recoverProcessing(maxAttempts, 'restart');
  }

  /**
   * Runtime counterpart, called by the worker after its own bookkeeping failed (for example
   * the database rejected the write that records an item's outcome), which leaves a row in
   * `processing` with nothing running it.
   *
   * Invariant it depends on: the caller is the single in-process worker and calls this only
   * while idle, so no job of this process is in flight and every `processing` row is orphaned.
   * That is why there is no "active item" argument. The schema has no lease, owner or
   * heartbeat, so this CANNOT tell another process's running job from an orphan. Two server
   * processes sharing one database file are unsupported; the status guards on the outcome
   * writes above only protect the stored state if that is violated, they do not prevent
   * duplicate processing.
   */
  recoverOrphaned(maxAttempts: number): { requeued: string[]; failed: string[] } {
    return this.recoverProcessing(maxAttempts, 'runtime');
  }

  /** One statement, so recovery is atomic. Same attempt-limit rule for both entry points. */
  private recoverProcessing(maxAttempts: number, cause: 'restart' | 'runtime'): { requeued: string[]; failed: string[] } {
    const ts = nowIso();
    const what = cause === 'restart' ? 'a restart' : 'an internal error';
    const rows = this.db
      .prepare(
        `UPDATE items SET
           status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END,
           completed_at = CASE WHEN attempts >= ? THEN ? ELSE NULL END,
           next_attempt_at = NULL,
           updated_at = ?,
           error_code = 'interrupted',
           error_message = CASE WHEN attempts >= ? THEN ? ELSE ? END
         WHERE status = 'processing'
         RETURNING id, status`,
      )
      .all(
        maxAttempts, maxAttempts, ts, ts, maxAttempts,
        `Processing was interrupted by ${what} and the attempt limit was reached`,
        `Processing was interrupted by ${what}; retrying`,
      ) as Array<{ id: string; status: ItemStatus }>;
    return {
      requeued: rows.filter((r) => r.status === 'pending').map((r) => r.id),
      failed: rows.filter((r) => r.status === 'failed').map((r) => r.id),
    };
  }
}
