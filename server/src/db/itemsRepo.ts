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

  /** Stores extracted content for URL items (called before chunking). */
  setContent(id: string, fields: { title: string; content: string }): void {
    this.db
      .prepare('UPDATE items SET title = ?, content = ?, content_chars = ?, updated_at = ? WHERE id = ?')
      .run(fields.title, fields.content, fields.content.length, nowIso(), id);
  }

  markIndexed(id: string): void {
    const ts = nowIso();
    this.db
      .prepare(`UPDATE items SET status = 'indexed', completed_at = ?, updated_at = ?, error_code = NULL, error_message = NULL, next_attempt_at = NULL WHERE id = ?`)
      .run(ts, ts, id);
  }

  markFailed(id: string, error: { code: string; message: string }): void {
    const ts = nowIso();
    this.db
      .prepare(`UPDATE items SET status = 'failed', completed_at = ?, updated_at = ?, error_code = ?, error_message = ?, next_attempt_at = NULL WHERE id = ?`)
      .run(ts, ts, error.code, error.message, id);
  }

  /** Puts an item back in the queue (used for automatic retry with backoff and for manual retry). */
  requeue(id: string, opts: { nextAttemptAt?: string | null; resetAttempts?: boolean; error?: { code: string; message: string } } = {}): void {
    const ts = nowIso();
    this.db
      .prepare(
        `UPDATE items SET status = 'pending', next_attempt_at = ?, updated_at = ?, completed_at = NULL,
           attempts = CASE WHEN ? THEN 0 ELSE attempts END, error_code = ?, error_message = ?
         WHERE id = ?`,
      )
      .run(opts.nextAttemptAt ?? null, ts, opts.resetAttempts ? 1 : 0, opts.error?.code ?? null, opts.error?.message ?? null, id);
  }

  /**
   * Called once at startup: anything left in `processing` was interrupted by a
   * crash or restart. It is requeued so the worker picks it up again.
   */
  recoverInterrupted(): string[] {
    const rows = this.db.prepare(`SELECT id FROM items WHERE status = 'processing'`).all() as Array<{ id: string }>;
    const ts = nowIso();
    for (const r of rows) {
      this.db
        .prepare(`UPDATE items SET status = 'pending', next_attempt_at = NULL, updated_at = ?, error_code = 'interrupted', error_message = 'Processing was interrupted by a restart; retrying' WHERE id = ?`)
        .run(ts, r.id);
    }
    return rows.map((r) => r.id);
  }
}
