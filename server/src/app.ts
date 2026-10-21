import express, { type Express } from 'express';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pinoHttp } from 'pino-http';
import type { AppConfig } from './config.js';
import type { Logger } from './logger.js';
import { openDatabase, type Database } from './db/connection.js';
import { ItemsRepo } from './db/itemsRepo.js';
import { ChunksRepo } from './db/chunksRepo.js';
import type { AiProvider } from './providers/aiProvider.js';
import { IngestionWorker, type WorkerOptions } from './worker/ingestionWorker.js';
import type { IngestionDeps } from './services/ingestionService.js';
import { healthRouter } from './routes/health.js';
import { ingestRouter } from './routes/ingest.js';
import { itemsRouter } from './routes/items.js';
import { queryRouter } from './routes/query.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import type { FetchOptions } from './services/urlFetcher.js';

export interface AppContext {
  app: Express;
  db: Database;
  items: ItemsRepo;
  chunks: ChunksRepo;
  worker: IngestionWorker;
  log: Logger;
}

export interface CreateAppOptions {
  config: AppConfig;
  log: Logger;
  ai: AiProvider;
  /** Test hook passed through to the URL fetcher (e.g. fake DNS). */
  fetchOverrides?: Partial<FetchOptions>;
  /** Test hook for the worker (e.g. zero backoff). */
  workerOverrides?: Partial<WorkerOptions>;
  /** Directory of the built frontend; when it exists it is served from the same port (single-process local run). */
  staticDir?: string;
}

/**
 * Composition root. Builds the Express app and wires repositories, services
 * and the worker together. Nothing here starts listening — `index.ts` does.
 */
export function createApp({ config, log, ai, fetchOverrides, workerOverrides, staticDir }: CreateAppOptions): AppContext {
  const db = openDatabase(config.DATABASE_PATH, log);
  const items = new ItemsRepo(db);
  const chunks = new ChunksRepo(db);

  const ingestionDeps: IngestionDeps = {
    db,
    items,
    chunks,
    ai,
    log: log.child({ component: 'worker' }),
    chunking: { chunkSize: config.CHUNK_SIZE_CHARS, overlap: config.CHUNK_OVERLAP_CHARS },
    fetch: { timeoutMs: config.URL_FETCH_TIMEOUT_MS, maxBytes: config.URL_MAX_BYTES, maxRedirects: config.URL_MAX_REDIRECTS, ...fetchOverrides },
    noteMaxChars: config.NOTE_MAX_CHARS,
  };
  const worker = new IngestionWorker(ingestionDeps, { pollIntervalMs: config.INGEST_POLL_INTERVAL_MS, maxAttempts: config.INGEST_MAX_ATTEMPTS, ...workerOverrides });
  const onItemQueued = () => worker.kick();

  const app = express();
  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      logger: log,
      genReqId: (req) => (typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : randomUUID()),
      customLogLevel: (_req, res, err) => (err || res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info'),
      // Keep request logs compact and free of bodies (notes are private user data).
      serializers: { req: (req) => ({ id: req.id, method: req.method, url: req.url }), res: (res) => ({ statusCode: res.statusCode }) },
      autoLogging: { ignore: (req) => req.url === '/health' },
      // The error handler already logs every failure with its code and cause; keep the
      // request-completed line to status/timing instead of a synthetic stack trace.
      customErrorObject: (_req, _res, _error, val) => {
        const { err: _ignored, ...rest } = val as Record<string, unknown>;
        return rest;
      },
      customErrorMessage: (_req, res) => `request completed with ${res.statusCode}`,
    }),
  );
  app.use((req, res, next) => {
    res.setHeader('x-request-id', String(req.id));
    next();
  });
  app.use(express.json({ limit: '1mb' }));

  app.use(healthRouter({ items, embeddingModel: ai.embeddingModel, chatModel: ai.chatModel, startedAt: new Date(), workerStatus: () => worker.status() }));
  app.use(ingestRouter({ items, noteMaxChars: config.NOTE_MAX_CHARS, onItemQueued }));
  app.use(itemsRouter({ items, chunks, onItemQueued }));
  app.use(
    queryRouter({
      chunks,
      ai,
      log: log.child({ component: 'query' }),
      defaults: { topK: config.RETRIEVAL_TOP_K, minScore: config.RETRIEVAL_MIN_SCORE, contextBudgetChars: config.RETRIEVAL_CONTEXT_BUDGET_CHARS },
    }),
  );
  if (staticDir && existsSync(join(staticDir, 'index.html'))) {
    log.info({ staticDir }, 'serving built frontend');
    app.use(express.static(staticDir));
    app.get('/{*splat}', (req, res, next) => (req.accepts('html') ? res.sendFile(join(staticDir, 'index.html')) : next()));
  }
  app.use(notFoundHandler);
  app.use(errorHandler);

  return { app, db, items, chunks, worker, log };
}
