/** Mirrors the server contracts (server/src/routes/contracts.ts and queryService.ts). */
export type SourceType = 'note' | 'url';
export type ItemStatus = 'pending' | 'processing' | 'indexed' | 'failed';

export interface ItemSummary {
  id: string;
  sourceType: SourceType;
  title: string;
  url: string | null;
  contentPreview: string;
  contentChars: number;
  chunkCount: number;
  status: ItemStatus;
  attempts: number;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ItemDetail extends ItemSummary {
  content: string | null;
}

export interface ItemsPage {
  items: ItemSummary[];
  total: number;
  limit: number;
  offset: number;
}

export type IngestRequest = { type: 'note'; content: string; title?: string } | { type: 'url'; url: string; title?: string };

export interface Citation {
  passage: number;
  chunkId: string;
  itemId: string;
  chunkIndex: number;
  title: string;
  sourceType: SourceType;
  url: string | null;
  snippet: string;
  score: number;
}

export type InsufficientReason = 'no_indexed_content' | 'no_relevant_chunks' | 'model_reported_insufficient' | 'unverifiable_answer';

export interface QueryResult {
  answer: string;
  sufficientEvidence: boolean;
  insufficientReason: InsufficientReason | null;
  citations: Citation[];
  retrieval: { candidates: number; aboveThreshold: number; selected: number; topK: number; minScore: number; topScore: number | null };
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown; requestId?: string };
}
