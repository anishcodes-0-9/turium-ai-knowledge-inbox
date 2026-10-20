/**
 * Chunking strategy (see README "Chunking strategy"):
 *
 * Character-based, boundary-aware sliding window.
 *   1. Split text into paragraphs (blank-line separated).
 *   2. Pack whole paragraphs into a chunk while they fit `chunkSize`.
 *   3. A paragraph larger than `chunkSize` is split on sentence boundaries,
 *      and a single oversized sentence is hard-split at the limit.
 *   4. Each chunk after the first starts with the trailing `overlap`
 *      characters of the previous chunk (snapped to a word boundary) so a fact
 *      straddling a boundary is still retrievable from at least one chunk.
 *
 * Sizes are characters (≈4 chars/token for English), which keeps chunking
 * deterministic and provider-agnostic. Defaults: 2800 chars (~700 tokens),
 * 400 chars overlap (~100 tokens).
 */
export interface ChunkOptions {
  chunkSize: number;
  overlap: number;
}

export interface TextChunk {
  index: number;
  text: string;
}

const SENTENCE_BOUNDARY = /(?<=[.!?]["')\]]?)\s+(?=[A-Z0-9"'(\[])/;

export function chunkText(text: string, opts: ChunkOptions): TextChunk[] {
  if (opts.overlap >= opts.chunkSize) throw new Error('overlap must be smaller than chunkSize');
  const trimmed = text.trim();
  if (!trimmed) return [];

  const units = splitIntoUnits(trimmed, opts.chunkSize);
  const chunks: string[] = [];
  let current = '';

  const flush = () => {
    const t = current.trim();
    if (t) chunks.push(t);
    current = '';
  };

  for (const unit of units) {
    const sep = current ? (unit.startsParagraph ? '\n\n' : ' ') : '';
    if (current.length + sep.length + unit.text.length <= opts.chunkSize) {
      current += sep + unit.text;
      continue;
    }
    // Unit does not fit: close the current chunk, seed the next with overlap.
    const previous = current.trim();
    flush();
    const seed = previous ? takeOverlap(previous, opts.overlap) : '';
    current = seed ? `${seed} ${unit.text}` : unit.text;
    // If overlap + unit exceeds limit, drop the overlap for this one.
    if (current.length > opts.chunkSize) current = unit.text;
  }
  flush();

  // Deduplicate exact repeats (can happen with pathological inputs) while keeping order.
  const seen = new Set<string>();
  const out: TextChunk[] = [];
  for (const c of chunks) {
    if (seen.has(c)) continue;
    seen.add(c);
    out.push({ index: out.length, text: c });
  }
  return out;
}

interface Unit {
  text: string;
  startsParagraph: boolean;
}

/** Breaks the text into paragraph-level units, splitting oversized ones on sentences/words. */
function splitIntoUnits(text: string, maxLen: number): Unit[] {
  const units: Unit[] = [];
  for (const paragraph of text.split(/\n\s*\n/)) {
    const p = paragraph.trim();
    if (!p) continue;
    if (p.length <= maxLen) {
      units.push({ text: p, startsParagraph: true });
      continue;
    }
    let first = true;
    for (const sentence of p.split(SENTENCE_BOUNDARY)) {
      const s = sentence.trim();
      if (!s) continue;
      for (const piece of hardSplit(s, maxLen)) {
        units.push({ text: piece, startsParagraph: first });
        first = false;
      }
    }
  }
  return units;
}

/** Splits a string that has no usable boundaries into pieces of at most maxLen, preferring spaces. */
function hardSplit(s: string, maxLen: number): string[] {
  if (s.length <= maxLen) return [s];
  const out: string[] = [];
  let rest = s;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf(' ', maxLen);
    if (cut < maxLen * 0.5) cut = maxLen;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Takes the last `overlap` characters of `text`, snapped forward to a word boundary. */
export function takeOverlap(text: string, overlap: number): string {
  if (overlap <= 0 || text.length <= overlap) return overlap <= 0 ? '' : text;
  const start = text.length - overlap;
  const boundary = text.indexOf(' ', start);
  return (boundary === -1 ? text.slice(start) : text.slice(boundary + 1)).trim();
}
