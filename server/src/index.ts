import { loadDotEnv } from './env.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { createApp } from './app.js';
import { OpenAiProvider } from './providers/openAiProvider.js';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

loadDotEnv();
const config = loadConfig();
const log = createLogger(config.LOG_LEVEL, config.NODE_ENV);

const ai = new OpenAiProvider(
  {
    baseURL: config.AI_BASE_URL,
    apiKey: config.AI_API_KEY,
    embeddingModel: config.EMBEDDING_MODEL,
    chatModel: config.CHAT_MODEL,
    timeoutMs: config.AI_TIMEOUT_MS,
    maxRetries: config.AI_MAX_RETRIES,
    expectedDimensions: config.EMBEDDING_DIMENSIONS,
  },
  log.child({ component: 'ai' }),
);

const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
const ctx = createApp({ config, log, ai, staticDir: webDist });
ctx.worker.start();

const server = ctx.app.listen(config.PORT, () => {
  log.info({ port: config.PORT, db: config.DATABASE_PATH, baseURL: config.AI_BASE_URL, embeddingModel: config.EMBEDDING_MODEL, chatModel: config.CHAT_MODEL }, 'server listening');
});

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  server.close();
  await ctx.worker.stop();
  ctx.db.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
