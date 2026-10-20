import { createApp, type AppContext } from '../../src/app.js';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import type { FetchOptions } from '../../src/services/urlFetcher.js';
import { FakeAiProvider } from './fakeAi.js';

export interface TestApp extends AppContext {
  ai: FakeAiProvider;
  config: AppConfig;
}

/** Builds an app on an in-memory database with the fake provider. Worker is not auto-started; call `worker.drain()`. */
export function buildTestApp(overrides: Partial<Record<string, string>> = {}, fetchOverrides?: Partial<FetchOptions>): TestApp {
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    DATABASE_PATH: ':memory:',
    AI_API_KEY: 'test',
    CHUNK_SIZE_CHARS: '400',
    CHUNK_OVERLAP_CHARS: '60',
    RETRIEVAL_MIN_SCORE: '0.2',
    INGEST_MAX_ATTEMPTS: '2',
    ...overrides,
  });
  const log = createLogger('silent', 'test');
  const ai = new FakeAiProvider();
  const ctx = createApp({ config, log, ai, fetchOverrides, workerOverrides: { backoffMs: () => 0 } });
  return { ...ctx, ai, config };
}
