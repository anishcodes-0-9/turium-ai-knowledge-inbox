/** Shared domain types used across repositories, services and routes. */

export type SourceType = 'note' | 'url';
export type ItemStatus = 'pending' | 'processing' | 'indexed' | 'failed';

export interface ItemRecord {
  id: string;
  sourceType: SourceType;
  title: string;
  url: string | null;
  content: string | null;
  contentChars: number;
  status: ItemStatus;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  nextAttemptAt: string | null;
}

export interface ChunkRecord {
  id: string;
  itemId: string;
  chunkIndex: number;
  text: string;
  charCount: number;
  embedding: Float32Array;
  embeddingModel: string;
  embeddingDims: number;
  createdAt: string;
}

/** Chunk joined with the metadata of its parent item, as used by retrieval. */
export interface ChunkWithItem extends ChunkRecord {
  itemTitle: string;
  itemSourceType: SourceType;
  itemUrl: string | null;
}

export function nowIso(): string {
  return new Date().toISOString();
}
