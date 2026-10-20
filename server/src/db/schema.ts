/**
 * Database schema. Migrations are applied in order and tracked in
 * `schema_migrations`, so re-running is a no-op and future changes are additive.
 *
 * Design notes:
 *  - `items` carries ingestion state directly (one job per item). A separate
 *    jobs table would only duplicate these columns for a single-user app.
 *  - `chunks.embedding` is a little-endian Float32 BLOB; `embedding_model` and
 *    `embedding_dims` are stored so incompatible vectors are never mixed.
 *  - UNIQUE(item_id, chunk_index) + delete-then-insert inside one transaction
 *    guarantees retries never create duplicate chunks.
 */
export const migrations: ReadonlyArray<{ id: number; name: string; sql: string }> = [
  {
    id: 1,
    name: 'initial',
    sql: `
      CREATE TABLE items (
        id            TEXT PRIMARY KEY,
        source_type   TEXT NOT NULL CHECK (source_type IN ('note', 'url')),
        title         TEXT NOT NULL,
        url           TEXT,
        content       TEXT,
        content_chars INTEGER NOT NULL DEFAULT 0,
        status        TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'indexed', 'failed')),
        attempts      INTEGER NOT NULL DEFAULT 0,
        error_code    TEXT,
        error_message TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        started_at    TEXT,
        completed_at  TEXT,
        next_attempt_at TEXT
      );
      CREATE INDEX idx_items_created_at ON items (created_at DESC);
      CREATE INDEX idx_items_status ON items (status, next_attempt_at);

      CREATE TABLE chunks (
        id              TEXT PRIMARY KEY,
        item_id         TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
        chunk_index     INTEGER NOT NULL,
        text            TEXT NOT NULL,
        char_count      INTEGER NOT NULL,
        embedding       BLOB NOT NULL,
        embedding_model TEXT NOT NULL,
        embedding_dims  INTEGER NOT NULL,
        created_at      TEXT NOT NULL,
        UNIQUE (item_id, chunk_index)
      );
      CREATE INDEX idx_chunks_item ON chunks (item_id);
      CREATE INDEX idx_chunks_model ON chunks (embedding_model);
    `,
  },
];
