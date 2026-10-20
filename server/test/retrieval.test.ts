import { describe, expect, it } from 'vitest';
import { cosineSimilarity } from '../src/services/similarity.js';
import { rankChunks, selectContext } from '../src/services/retrieval.js';
import type { ChunkWithItem } from '../src/domain.js';
import { fakeEmbed } from './helpers/fakeAi.js';

const mk = (id: string, text: string, embedding = fakeEmbed(text)): ChunkWithItem => ({
  id: `${id}:0`, itemId: id, chunkIndex: 0, text, charCount: text.length, embedding, embeddingModel: 'fake', embeddingDims: embedding.length,
  createdAt: '', itemTitle: id, itemSourceType: 'note', itemUrl: null,
});

describe('cosineSimilarity', () => {
  it('is 1 for identical, 0 for orthogonal, -1 for opposite vectors', () => {
    expect(cosineSimilarity(new Float32Array([1, 2, 3]), new Float32Array([1, 2, 3]))).toBeCloseTo(1);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([0, 1]))).toBeCloseTo(0);
    expect(cosineSimilarity(new Float32Array([1, 0]), new Float32Array([-1, 0]))).toBeCloseTo(-1);
  });
  it('returns 0 for mismatched or zero vectors', () => {
    expect(cosineSimilarity(new Float32Array([1, 2]), new Float32Array([1, 2, 3]))).toBe(0);
    expect(cosineSimilarity(new Float32Array([0, 0]), new Float32Array([1, 2]))).toBe(0);
    expect(cosineSimilarity(new Float32Array([]), new Float32Array([]))).toBe(0);
  });
});

describe('rankChunks', () => {
  it('orders by similarity descending and skips incompatible dimensions', () => {
    const q = fakeEmbed('the capital of france is paris');
    const chunks = [
      mk('b', 'bananas are yellow fruit'),
      mk('a', 'paris is the capital of france'),
      mk('c', 'wrong dims', new Float32Array([1, 2, 3])),
    ];
    const ranked = rankChunks(q, chunks);
    expect(ranked.map((r) => r.chunk.itemId)).toEqual(['a', 'b']);
    expect(ranked[0]!.score).toBeGreaterThan(ranked[1]!.score);
  });
});

describe('selectContext', () => {
  const ranked = [
    { chunk: mk('a', 'alpha text'), score: 0.9 },
    { chunk: mk('b', 'beta text'), score: 0.6 },
    { chunk: mk('c', 'ALPHA   text'), score: 0.5 }, // near-duplicate of a
    { chunk: mk('d', 'delta text'), score: 0.1 },
  ];

  it('applies the threshold', () => {
    const out = selectContext(ranked, { topK: 10, minScore: 0.55, contextBudgetChars: 10_000 });
    expect(out.map((s) => s.chunk.itemId)).toEqual(['a', 'b']);
  });

  it('returns nothing when no chunk passes the threshold', () => {
    expect(selectContext(ranked, { topK: 10, minScore: 0.95, contextBudgetChars: 10_000 })).toEqual([]);
  });

  it('caps at topK and drops near-duplicate text', () => {
    const out = selectContext(ranked, { topK: 3, minScore: 0, contextBudgetChars: 10_000 });
    expect(out.map((s) => s.chunk.itemId)).toEqual(['a', 'b', 'd']);
  });

  it('respects the context budget but always returns at least one (truncated) chunk', () => {
    const big = [{ chunk: mk('x', 'y'.repeat(5000)), score: 0.9 }, { chunk: mk('z', 'small'), score: 0.8 }];
    const out = selectContext(big, { topK: 5, minScore: 0, contextBudgetChars: 1000 });
    expect(out).toHaveLength(1);
    expect(out[0]!.chunk.text.length).toBe(1000);

    const out2 = selectContext(ranked, { topK: 5, minScore: 0, contextBudgetChars: 22 });
    expect(out2.map((s) => s.chunk.itemId)).toEqual(['a', 'b']); // 10 + 9 chars fit, 'delta text' would exceed
  });
});
