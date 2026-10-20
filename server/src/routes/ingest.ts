import { Router } from 'express';
import type { ItemsRepo } from '../db/itemsRepo.js';
import { parseOrThrow } from '../middleware/validate.js';
import { ingestBodySchema } from './schemas.js';
import { toItemSummary } from './contracts.js';
import { createNoteItem, createUrlItem } from '../services/ingestionService.js';
import { validateUrl } from '../services/urlFetcher.js';

export interface IngestRouteDeps {
  items: ItemsRepo;
  noteMaxChars: number;
  /** Wakes the worker so processing starts immediately. */
  onItemQueued: () => void;
}

/**
 * POST /ingest — accepts `{type:'note', content}` or `{type:'url', url}`.
 * Responds 202 Accepted with the pending item; processing is asynchronous and
 * its progress is visible on GET /items and GET /items/:id.
 */
export function ingestRouter(deps: IngestRouteDeps): Router {
  const router = Router();
  router.post('/ingest', (req, res) => {
    const body = parseOrThrow(ingestBodySchema, req.body, 'ingest request');
    const item =
      body.type === 'note'
        ? createNoteItem(deps, { content: body.content, title: body.title })
        : createUrlItem(deps, { url: validateUrl(body.url), title: body.title });
    req.log.info({ itemId: item.id, sourceType: item.sourceType, contentChars: item.contentChars }, 'item queued for ingestion');
    deps.onItemQueued();
    res.status(202).json({ item: toItemSummary(item, 0) });
  });
  return router;
}
