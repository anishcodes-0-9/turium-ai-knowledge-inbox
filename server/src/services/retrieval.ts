import type { ChunkWithItem } from '../domain.js';
import { cosineSimilarity } from './similarity.js';

export interface ScoredChunk {
  chunk: ChunkWithItem;
  score: number;
}

export interface SelectionOptions {
  topK: number;
  minScore: number;
  contextBudgetChars: number;
}

/** Scores every candidate against the query vector and sorts descending. Linear scan (see README). */
export function rankChunks(query: Float32Array, candidates: ChunkWithItem[]): ScoredChunk[] {
  const scored: ScoredChunk[] = [];
  for (const chunk of candidates) {
    if (chunk.embedding.length !== query.length) continue; // incompatible vector, never compare
    scored.push({ chunk, score: cosineSimilarity(query, chunk.embedding) });
  }
  scored.sort((a, b) => b.score - a.score || a.chunk.itemId.localeCompare(b.chunk.itemId) || a.chunk.chunkIndex - b.chunk.chunkIndex);
  return scored;
}

/**
 * Applies the relevance threshold, the top-K cap and the context budget, and
 * drops near-duplicate text (e.g. identical paragraphs saved twice) so the LLM
 * does not receive the same evidence repeatedly.
 */
export function selectContext(ranked: ScoredChunk[], opts: SelectionOptions): ScoredChunk[] {
  const selected: ScoredChunk[] = [];
  const seenText = new Set<string>();
  let used = 0;
  for (const s of ranked) {
    if (s.score < opts.minScore) break; // sorted desc, nothing further can pass
    if (selected.length >= opts.topK) break;
    const key = s.chunk.text.replace(/\s+/g, ' ').trim().toLowerCase();
    if (seenText.has(key)) continue;
    if (used + s.chunk.text.length > opts.contextBudgetChars) {
      if (selected.length === 0) {
        // Always allow at least one chunk, truncated to the budget, so a huge chunk cannot starve the answer.
        selected.push({ ...s, chunk: { ...s.chunk, text: s.chunk.text.slice(0, opts.contextBudgetChars) } });
        seenText.add(key);
        break;
      }
      continue;
    }
    selected.push(s);
    seenText.add(key);
    used += s.chunk.text.length;
  }
  return selected;
}
