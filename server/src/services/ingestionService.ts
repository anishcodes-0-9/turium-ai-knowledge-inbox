import type { Database } from '../db/connection.js';
import { transaction } from '../db/connection.js';
import type { ItemsRepo } from '../db/itemsRepo.js';
import type { ChunksRepo, NewChunk } from '../db/chunksRepo.js';
import type { AiProvider } from '../providers/aiProvider.js';
import type { Logger } from '../logger.js';
import type { ItemRecord } from '../domain.js';
import { AppError } from '../errors.js';
import { chunkText } from './chunker.js';
import { fetchUrl, type FetchOptions } from './urlFetcher.js';
import { extractFromHtml, extractFromPlainText } from './htmlExtractor.js';
import { normalizeText, deriveNoteTitle } from './textNormalizer.js';

export interface IngestionDeps {
  db: Database;
  items: ItemsRepo;
  chunks: ChunksRepo;
  ai: AiProvider;
  log: Logger;
  chunking: { chunkSize: number; overlap: number };
  fetch: FetchOptions;
  noteMaxChars: number;
}

/**
 * Creates a note item. Content is normalised once here; the worker chunks and
 * embeds it asynchronously. Returns the persisted (pending) record.
 */
export function createNoteItem(deps: Pick<IngestionDeps, 'items' | 'noteMaxChars'>, input: { content: string; title?: string }): ItemRecord {
  const content = normalizeText(input.content);
  if (!content) throw new AppError('validation_error', 'Note content is empty after trimming whitespace');
  if (content.length > deps.noteMaxChars) throw new AppError('validation_error', `Note is too long (${content.length} characters; limit ${deps.noteMaxChars})`);
  const title = input.title?.trim() || deriveNoteTitle(content);
  return deps.items.create({ sourceType: 'note', title, content });
}

/** Creates a URL item after static validation; fetching happens in the worker. */
export function createUrlItem(deps: Pick<IngestionDeps, 'items'>, input: { url: URL; title?: string }): ItemRecord {
  const href = input.url.href;
  const title = input.title?.trim() || input.url.hostname + (input.url.pathname !== '/' ? input.url.pathname : '');
  return deps.items.create({ sourceType: 'url', title, url: href, content: null });
}

/**
 * Full processing pipeline for one claimed item:
 *   fetch/extract (URL only) → chunk → embed → store chunks + mark indexed (one transaction).
 * Throws AppError on failure; the worker decides whether to retry.
 */
export async function processItem(deps: IngestionDeps, item: ItemRecord): Promise<{ chunkCount: number }> {
  const log = deps.log.child({ itemId: item.id, sourceType: item.sourceType, attempt: item.attempts });
  let content = item.content ?? '';

  if (item.sourceType === 'url') {
    if (!item.url) throw new AppError('internal_error', 'URL item has no URL', { retryable: false });
    const started = Date.now();
    const doc = await fetchUrl(item.url, deps.fetch, log);
    const page = doc.contentType === 'text/plain' ? extractFromPlainText(doc.body, item.title) : extractFromHtml(doc.body, item.title);
    log.info({ bytes: doc.bytes, redirects: doc.redirects, contentType: doc.contentType, strategy: page.strategy, chars: page.text.length, ms: Date.now() - started }, 'fetched and extracted page');
    if (page.text.length < 20) {
      throw new AppError('extraction_failed', 'No readable text could be extracted from the page', { retryable: false });
    }
    content = page.text;
    deps.items.setContent(item.id, { title: page.title, content });
  }

  const pieces = chunkText(content, deps.chunking);
  if (pieces.length === 0) throw new AppError('extraction_failed', 'Content produced no chunks', { retryable: false });

  const started = Date.now();
  const vectors = await deps.ai.embed(pieces.map((p) => p.text));
  if (vectors.length !== pieces.length) throw new AppError('provider_error', 'Embedding count did not match chunk count');
  log.info({ chunks: pieces.length, dims: vectors[0]?.length, model: deps.ai.embeddingModel, ms: Date.now() - started }, 'embeddings generated');

  const newChunks: NewChunk[] = pieces.map((p, i) => ({
    id: chunkId(item.id, p.index),
    itemId: item.id,
    chunkIndex: p.index,
    text: p.text,
    embedding: vectors[i]!,
    embeddingModel: deps.ai.embeddingModel,
  }));

  // Chunks and the status flip are atomic: an item is never `indexed` without its chunks.
  transaction(deps.db, () => {
    deps.chunks.replaceForItem(item.id, newChunks);
    deps.items.markIndexed(item.id);
  });
  return { chunkCount: newChunks.length };
}

/** Deterministic chunk id: re-processing an item yields the same ids. */
export function chunkId(itemId: string, index: number): string {
  return `${itemId}:${index}`;
}

