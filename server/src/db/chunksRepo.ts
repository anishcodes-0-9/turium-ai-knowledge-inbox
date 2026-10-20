import type { Database } from './connection.js';
import { nowIso, type ChunkRecord, type ChunkWithItem, type SourceType } from '../domain.js';

interface ChunkRow {
  id: string;
  item_id: string;
  chunk_index: number;
  text: string;
  char_count: number;
  embedding: Uint8Array;
  embedding_model: string;
  embedding_dims: number;
  created_at: string;
  item_title?: string;
  item_source_type?: SourceType;
  item_url?: string | null;
}

export function encodeEmbedding(vec: Float32Array): Uint8Array {
  return new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
}

export function decodeEmbedding(blob: Uint8Array, dims: number): Float32Array {
  // Copy into an aligned buffer: SQLite blobs are not guaranteed to be 4-byte aligned.
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer, 0, dims);
}

function rowToChunk(r: ChunkRow): ChunkRecord {
  return {
    id: r.id,
    itemId: r.item_id,
    chunkIndex: r.chunk_index,
    text: r.text,
    charCount: r.char_count,
    embedding: decodeEmbedding(r.embedding, r.embedding_dims),
    embeddingModel: r.embedding_model,
    embeddingDims: r.embedding_dims,
    createdAt: r.created_at,
  };
}

export interface NewChunk {
  id: string;
  itemId: string;
  chunkIndex: number;
  text: string;
  embedding: Float32Array;
  embeddingModel: string;
}

/** Data access for `chunks` (text + embeddings). */
export class ChunksRepo {
  constructor(private readonly db: Database) {}

  /**
   * Replaces all chunks for an item. Caller wraps this in a transaction together
   * with the item status update so an item is only ever `indexed` when its
   * chunks are durably stored, and a retry can never leave duplicates behind.
   */
  replaceForItem(itemId: string, chunks: NewChunk[]): void {
    this.db.prepare('DELETE FROM chunks WHERE item_id = ?').run(itemId);
    const insert = this.db.prepare(
      `INSERT INTO chunks (id, item_id, chunk_index, text, char_count, embedding, embedding_model, embedding_dims, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ts = nowIso();
    for (const c of chunks) {
      insert.run(c.id, c.itemId, c.chunkIndex, c.text, c.text.length, encodeEmbedding(c.embedding), c.embeddingModel, c.embedding.length, ts);
    }
  }

  countForItem(itemId: string): number {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE item_id = ?').get(itemId) as { n: number };
    return n;
  }

  countsByItem(itemIds: string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (itemIds.length === 0) return out;
    const placeholders = itemIds.map(() => '?').join(',');
    const rows = this.db.prepare(`SELECT item_id, COUNT(*) AS n FROM chunks WHERE item_id IN (${placeholders}) GROUP BY item_id`).all(...itemIds) as Array<{ item_id: string; n: number }>;
    for (const r of rows) out.set(r.item_id, r.n);
    return out;
  }

  getById(id: string): ChunkRecord | null {
    const row = this.db.prepare('SELECT * FROM chunks WHERE id = ?').get(id) as ChunkRow | undefined;
    return row ? rowToChunk(row) : null;
  }

  /**
   * Loads every chunk produced by the given embedding model, joined with item
   * metadata, for in-process similarity scanning. Only chunks whose parent item
   * is `indexed` are returned, so a half-reindexed item is never searchable.
   */
  listForRetrieval(embeddingModel: string): ChunkWithItem[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, i.title AS item_title, i.source_type AS item_source_type, i.url AS item_url
         FROM chunks c JOIN items i ON i.id = c.item_id
         WHERE c.embedding_model = ? AND i.status = 'indexed'
         ORDER BY c.item_id, c.chunk_index`,
      )
      .all(embeddingModel) as unknown as ChunkRow[];
    return rows.map((r) => ({ ...rowToChunk(r), itemTitle: r.item_title!, itemSourceType: r.item_source_type!, itemUrl: r.item_url ?? null }));
  }

  /** Number of indexed chunks that were embedded with a different model (diagnostics). */
  countIncompatible(embeddingModel: string): number {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM chunks WHERE embedding_model != ?').get(embeddingModel) as { n: number };
    return n;
  }
}
