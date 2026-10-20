import { Router } from 'express';
import type { ItemsRepo } from '../db/itemsRepo.js';
import type { ChunksRepo } from '../db/chunksRepo.js';
import { AppError } from '../errors.js';
import { parseOrThrow } from '../middleware/validate.js';
import { itemIdParamSchema, listItemsQuerySchema } from './schemas.js';
import { toItemDetail, toItemSummary } from './contracts.js';

export interface ItemsRouteDeps {
  items: ItemsRepo;
  chunks: ChunksRepo;
  onItemQueued: () => void;
}

/**
 * GET /items            — paginated list (newest first) with processing state
 * GET /items/:id        — full saved content for one item
 * POST /items/:id/retry — requeue a failed item (manual retry from the UI)
 */
export function itemsRouter(deps: ItemsRouteDeps): Router {
  const router = Router();

  router.get('/items', (req, res) => {
    const { limit, offset } = parseOrThrow(listItemsQuerySchema, req.query, 'query parameters');
    const { items, total } = deps.items.list({ limit, offset });
    const counts = deps.chunks.countsByItem(items.map((i) => i.id));
    res.json({ items: items.map((i) => toItemSummary(i, counts.get(i.id) ?? 0)), total, limit, offset });
  });

  router.get('/items/:id', (req, res) => {
    const { id } = parseOrThrow(itemIdParamSchema, req.params, 'item id');
    const item = deps.items.getById(id);
    if (!item) throw new AppError('not_found', 'Item not found');
    res.json({ item: toItemDetail(item, deps.chunks.countForItem(id)) });
  });

  router.post('/items/:id/retry', (req, res) => {
    const { id } = parseOrThrow(itemIdParamSchema, req.params, 'item id');
    const item = deps.items.getById(id);
    if (!item) throw new AppError('not_found', 'Item not found');
    if (item.status !== 'failed') throw new AppError('conflict', `Only failed items can be retried (current status: ${item.status})`);
    deps.items.requeue(id, { resetAttempts: true });
    req.log.info({ itemId: id }, 'item manually requeued');
    deps.onItemQueued();
    res.status(202).json({ item: toItemSummary(deps.items.getById(id)!, 0) });
  });

  return router;
}
