import { Router } from 'express';
import type { ItemsRepo } from '../db/itemsRepo.js';
import type { WorkerStatus } from '../worker/ingestionWorker.js';

/** GET /health — liveness plus a few cheap diagnostics (no provider calls, so it never spends money). */
export function healthRouter(deps: { items: ItemsRepo; embeddingModel: string; chatModel: string; startedAt: Date; workerStatus: () => WorkerStatus }): Router {
  const router = Router();
  router.get('/health', (_req, res) => {
    const counts = deps.items.countByStatus();
    const worker = deps.workerStatus();
    res.json({
      status: worker.state === 'degraded' ? 'degraded' : 'ok',
      uptimeSeconds: Math.round((Date.now() - deps.startedAt.getTime()) / 1000),
      items: counts,
      models: { embedding: deps.embeddingModel, chat: deps.chatModel },
      worker,
    });
  });
  return router;
}
