import type { ChunksRepo } from '../db/chunksRepo.js';
import type { AiProvider } from '../providers/aiProvider.js';
import type { Logger } from '../logger.js';
import type { SourceType } from '../domain.js';
import { rankChunks, selectContext, type SelectionOptions } from './retrieval.js';
import { generateAnswer } from './answerGenerator.js';

export interface Citation {
  /** 1-based passage number as it appears in the answer text (e.g. "[2]"). */
  passage: number;
  /** Stable chunk id (`<itemId>:<chunkIndex>`). */
  chunkId: string;
  itemId: string;
  chunkIndex: number;
  title: string;
  sourceType: SourceType;
  url: string | null;
  snippet: string;
  score: number;
}

export type InsufficientReason = 'no_indexed_content' | 'no_relevant_chunks' | 'model_reported_insufficient';

export interface QueryResult {
  answer: string;
  sufficientEvidence: boolean;
  insufficientReason: InsufficientReason | null;
  citations: Citation[];
  retrieval: { candidates: number; aboveThreshold: number; selected: number; topK: number; minScore: number; topScore: number | null };
}

export interface QueryDeps {
  chunks: ChunksRepo;
  ai: AiProvider;
  log: Logger;
  defaults: SelectionOptions;
}

const NO_EVIDENCE_ANSWER = 'Your saved knowledge does not contain enough information to answer this question.';

/**
 * RAG pipeline: embed question → rank all compatible chunks → threshold / top-K /
 * budget → LLM answer → citations validated against the chunks actually sent.
 * A valid-but-empty retrieval is a normal 200 result, not an error.
 */
export async function answerQuestion(deps: QueryDeps, input: { question: string; topK?: number; minScore?: number }, requestLog?: Logger): Promise<QueryResult> {
  const log = requestLog ?? deps.log;
  const opts: SelectionOptions = { ...deps.defaults, topK: input.topK ?? deps.defaults.topK, minScore: input.minScore ?? deps.defaults.minScore };
  const stats = (extra: Partial<QueryResult['retrieval']>): QueryResult['retrieval'] => ({ candidates: 0, aboveThreshold: 0, selected: 0, topK: opts.topK, minScore: opts.minScore, topScore: null, ...extra });

  const candidates = deps.chunks.listForRetrieval(deps.ai.embeddingModel);
  if (candidates.length === 0) {
    const incompatible = deps.chunks.countIncompatible(deps.ai.embeddingModel);
    if (incompatible > 0) log.warn({ incompatible, model: deps.ai.embeddingModel }, 'chunks exist but were embedded with a different model; re-ingest to make them searchable');
    log.info({ reason: 'no_indexed_content' }, 'query answered without evidence');
    return { answer: NO_EVIDENCE_ANSWER, sufficientEvidence: false, insufficientReason: 'no_indexed_content', citations: [], retrieval: stats({}) };
  }

  const started = Date.now();
  const [queryVector] = await deps.ai.embed([input.question]);
  if (!queryVector) throw new Error('embedding provider returned no vector for the question');
  const ranked = rankChunks(queryVector, candidates);
  const aboveThreshold = ranked.filter((r) => r.score >= opts.minScore).length;
  const selected = selectContext(ranked, opts);
  const topScore = ranked[0]?.score ?? null;
  log.info({ candidates: candidates.length, aboveThreshold, selected: selected.length, topScore, minScore: opts.minScore, ms: Date.now() - started }, 'retrieval completed');

  if (selected.length === 0) {
    return { answer: NO_EVIDENCE_ANSWER, sufficientEvidence: false, insufficientReason: 'no_relevant_chunks', citations: [], retrieval: stats({ candidates: candidates.length, aboveThreshold, topScore }) };
  }

  const genStarted = Date.now();
  const generated = await generateAnswer(deps.ai, input.question, selected);
  log.info({ sufficient: generated.sufficient, cited: generated.citedNumbers, parseFallback: generated.parseFallback, ms: Date.now() - genStarted }, 'answer generated');

  // Citations can only ever point at chunks that were in the prompt (and therefore exist in the DB).
  const citations: Citation[] = generated.sufficient
    ? generated.citedNumbers.map((n) => toCitation(n, selected[n - 1]!))
    : [];

  return {
    answer: generated.answer,
    sufficientEvidence: generated.sufficient,
    insufficientReason: generated.sufficient ? null : 'model_reported_insufficient',
    citations,
    retrieval: stats({ candidates: candidates.length, aboveThreshold, selected: selected.length, topScore }),
  };
}

function toCitation(passage: number, s: { chunk: { id: string; itemId: string; chunkIndex: number; itemTitle: string; itemSourceType: SourceType; itemUrl: string | null; text: string }; score: number }): Citation {
  return {
    passage,
    chunkId: s.chunk.id,
    itemId: s.chunk.itemId,
    chunkIndex: s.chunk.chunkIndex,
    title: s.chunk.itemTitle,
    sourceType: s.chunk.itemSourceType,
    url: s.chunk.itemUrl,
    snippet: makeSnippet(s.chunk.text),
    score: Number(s.score.toFixed(4)),
  };
}

function makeSnippet(text: string, maxChars = 400): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1).trimEnd()}…`;
}
