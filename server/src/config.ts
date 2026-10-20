import { z } from 'zod';

/**
 * All runtime configuration comes from environment variables and is validated
 * once at startup. Anything invalid fails fast with a readable message rather
 * than surfacing as a confusing error deep inside a request.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3001),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_PATH: z.string().min(1).default('./data/inbox.db'),

  AI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  AI_API_KEY: z.string().min(1, 'AI_API_KEY is required'),
  EMBEDDING_MODEL: z.string().min(1).default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: z
    .union([z.literal(''), z.coerce.number().int().positive()])
    .optional()
    .transform((v) => (v === '' || v === undefined ? undefined : v)),
  CHAT_MODEL: z.string().min(1).default('gpt-4o-mini'),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  AI_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),

  CHUNK_SIZE_CHARS: z.coerce.number().int().min(200).default(2800),
  CHUNK_OVERLAP_CHARS: z.coerce.number().int().min(0).default(400),

  RETRIEVAL_TOP_K: z.coerce.number().int().min(1).max(20).default(6),
  RETRIEVAL_MIN_SCORE: z.coerce.number().min(-1).max(1).default(0.3),
  RETRIEVAL_CONTEXT_BUDGET_CHARS: z.coerce.number().int().min(500).default(12_000),

  INGEST_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  INGEST_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(1000),
  NOTE_MAX_CHARS: z.coerce.number().int().min(100).default(50_000),
  URL_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
  URL_MAX_BYTES: z.coerce.number().int().min(10_000).default(2_000_000),
  URL_MAX_REDIRECTS: z.coerce.number().int().min(0).max(10).default(3),
});

export type AppConfig = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const cfg = parsed.data;
  if (cfg.CHUNK_OVERLAP_CHARS >= cfg.CHUNK_SIZE_CHARS) {
    throw new Error('Invalid environment configuration: CHUNK_OVERLAP_CHARS must be smaller than CHUNK_SIZE_CHARS');
  }
  return cfg;
}
