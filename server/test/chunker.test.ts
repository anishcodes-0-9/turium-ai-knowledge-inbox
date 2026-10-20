import { describe, expect, it } from 'vitest';
import { chunkText, takeOverlap } from '../src/services/chunker.js';

const para = (n: number, words = 40) => Array.from({ length: words }, (_, i) => `p${n}w${i}`).join(' ') + '.';

describe('chunkText', () => {
  it('returns no chunks for empty or whitespace input', () => {
    expect(chunkText('', { chunkSize: 100, overlap: 10 })).toEqual([]);
    expect(chunkText('   \n\n  ', { chunkSize: 100, overlap: 10 })).toEqual([]);
  });

  it('keeps short text as a single chunk', () => {
    const chunks = chunkText('Hello world. This is short.', { chunkSize: 100, overlap: 10 });
    expect(chunks).toEqual([{ index: 0, text: 'Hello world. This is short.' }]);
  });

  it('never exceeds chunkSize and keeps sequential indexes', () => {
    const text = Array.from({ length: 12 }, (_, i) => para(i)).join('\n\n');
    const chunks = chunkText(text, { chunkSize: 500, overlap: 80 });
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((c, i) => {
      expect(c.index).toBe(i);
      expect(c.text.length).toBeLessThanOrEqual(500);
      expect(c.text.trim().length).toBeGreaterThan(0);
    });
  });

  it('packs whole paragraphs and splits on paragraph boundaries', () => {
    const text = `${para(1, 20)}\n\n${para(2, 20)}\n\n${para(3, 20)}`;
    const chunks = chunkText(text, { chunkSize: para(1, 20).length * 2 + 2, overlap: 0 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]!.text).toBe(`${para(1, 20)}\n\n${para(2, 20)}`);
    expect(chunks[1]!.text).toBe(para(3, 20));
  });

  it('carries overlap from the previous chunk into the next', () => {
    const text = Array.from({ length: 6 }, (_, i) => para(i, 30)).join('\n\n');
    const chunks = chunkText(text, { chunkSize: 400, overlap: 100 });
    for (let i = 1; i < chunks.length; i++) {
      const prevTail = chunks[i - 1]!.text.slice(-40);
      const lastWord = prevTail.split(' ').pop()!;
      expect(chunks[i]!.text.startsWith(lastWord) || chunks[i]!.text.includes(lastWord)).toBe(true);
    }
  });

  it('splits an oversized paragraph on sentence boundaries', () => {
    const sentences = Array.from({ length: 10 }, (_, i) => `Sentence number ${i} has a few words in it.`);
    const chunks = chunkText(sentences.join(' '), { chunkSize: 120, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(120);
      expect(c.text.endsWith('.')).toBe(true);
    }
  });

  it('hard-splits a single oversized token without losing content', () => {
    const long = Array.from({ length: 1000 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    const chunks = chunkText(long, { chunkSize: 300, overlap: 0 });
    expect(chunks.map((c) => c.text).join('')).toBe(long);
    expect(chunks.every((c) => c.text.length <= 300)).toBe(true);
  });

  it('is deterministic and never produces duplicate chunks', () => {
    const text = Array.from({ length: 5 }, () => 'repeat repeat repeat.').join('\n\n');
    const a = chunkText(text, { chunkSize: 50, overlap: 10 });
    const b = chunkText(text, { chunkSize: 50, overlap: 10 });
    expect(a).toEqual(b);
    expect(new Set(a.map((c) => c.text)).size).toBe(a.length);
  });

  it('rejects overlap >= chunkSize', () => {
    expect(() => chunkText('abc', { chunkSize: 10, overlap: 10 })).toThrow();
  });
});

describe('takeOverlap', () => {
  it('snaps to a word boundary', () => {
    expect(takeOverlap('alpha beta gamma delta', 8)).toBe('delta');
    expect(takeOverlap('short', 100)).toBe('short');
    expect(takeOverlap('anything', 0)).toBe('');
  });
});
