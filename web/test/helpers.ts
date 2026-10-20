import type { Citation, ItemSummary, QueryResult } from '../src/api/types';

export function makeItem(over: Partial<ItemSummary> = {}): ItemSummary {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    sourceType: 'note',
    title: 'Team mascot',
    url: null,
    contentPreview: 'Our mascot is a llama.',
    contentChars: 22,
    chunkCount: 1,
    status: 'indexed',
    attempts: 1,
    error: null,
    createdAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:01.000Z',
    startedAt: '2026-10-21T10:00:00.500Z',
    completedAt: '2026-10-21T10:00:01.000Z',
    ...over,
  };
}

export function makeCitation(over: Partial<Citation> = {}): Citation {
  return {
    passage: 1,
    chunkId: '11111111-1111-4111-8111-111111111111:0',
    itemId: '11111111-1111-4111-8111-111111111111',
    chunkIndex: 0,
    title: 'Team mascot',
    sourceType: 'note',
    url: null,
    snippet: 'Our mascot is a llama named Steve.',
    score: 0.81,
    ...over,
  };
}

export function makeResult(over: Partial<QueryResult> = {}): QueryResult {
  return {
    answer: 'The mascot is a llama named Steve [1].',
    sufficientEvidence: true,
    insufficientReason: null,
    citations: [makeCitation()],
    retrieval: { candidates: 3, aboveThreshold: 1, selected: 1, topK: 6, minScore: 0.3, topScore: 0.81 },
    ...over,
  };
}
