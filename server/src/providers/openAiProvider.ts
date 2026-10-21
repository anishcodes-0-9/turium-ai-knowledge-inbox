import OpenAI from 'openai';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { AiProvider, ChatCompletion, ChatMessage } from './aiProvider.js';

export interface OpenAiProviderOptions {
  baseURL: string;
  apiKey: string;
  embeddingModel: string;
  chatModel: string;
  timeoutMs: number;
  maxRetries: number;
  /** When set, any embedding of a different length is rejected. */
  expectedDimensions?: number;
  embedBatchSize?: number;
  /** Test hook: replaces the HTTP fetch used by the SDK. */
  fetch?: typeof fetch;
}

/**
 * OpenAI-compatible implementation. The SDK already retries transient errors
 * (429/5xx/network) with backoff up to `maxRetries`, so spending is bounded.
 */
export class OpenAiProvider implements AiProvider {
  readonly embeddingModel: string;
  readonly chatModel: string;
  private readonly client: OpenAI;
  private readonly batchSize: number;
  private readonly expectedDimensions?: number;

  constructor(private readonly opts: OpenAiProviderOptions, private readonly log: Logger) {
    this.embeddingModel = opts.embeddingModel;
    this.chatModel = opts.chatModel;
    this.batchSize = opts.embedBatchSize ?? 64;
    this.expectedDimensions = opts.expectedDimensions;
    this.client = new OpenAI({ baseURL: opts.baseURL, apiKey: opts.apiKey, timeout: opts.timeoutMs, maxRetries: opts.maxRetries, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const out: Float32Array[] = [];
    for (let i = 0; i < texts.length; i += this.batchSize) {
      const batch = texts.slice(i, i + this.batchSize);
      const started = Date.now();
      const res = await this.call('embeddings', () => this.client.embeddings.create({ model: this.embeddingModel, input: batch }));
      this.log.debug({ model: this.embeddingModel, inputs: batch.length, ms: Date.now() - started, usage: res.usage }, 'embeddings generated');
      if (res.data.length !== batch.length) {
        throw new AppError('provider_error', 'Embedding provider returned an unexpected number of vectors', { retryable: true });
      }
      const sorted = [...res.data].sort((a, b) => a.index - b.index);
      for (const d of sorted) {
        const vec = Float32Array.from(d.embedding);
        this.validateDimensions(vec, out[0]);
        out.push(vec);
      }
    }
    return out;
  }

  async completeJson(messages: ChatMessage[]): Promise<ChatCompletion> {
    const started = Date.now();
    const res = await this.call('chat', () =>
      this.client.chat.completions.create({
        model: this.chatModel,
        messages,
        temperature: 0,
        response_format: { type: 'json_object' },
      }),
    );
    const choice = res.choices[0];
    const text = choice?.message?.content;
    this.log.debug({ model: this.chatModel, ms: Date.now() - started, usage: res.usage, finish: choice?.finish_reason }, 'chat completion generated');
    if (!text) throw new AppError('provider_error', 'Chat provider returned an empty response', { retryable: true });
    return { content: text, truncated: choice?.finish_reason === 'length' };
  }

  private validateDimensions(vec: Float32Array, reference?: Float32Array): void {
    const expected = this.expectedDimensions ?? reference?.length;
    if (vec.length === 0) throw new AppError('provider_error', 'Embedding provider returned an empty vector', { retryable: false });
    if (expected !== undefined && vec.length !== expected) {
      throw new AppError('provider_error', `Embedding dimension mismatch: expected ${expected}, got ${vec.length}`, { retryable: false });
    }
  }

  /** Maps SDK failures to stable application errors without leaking the key or request internals. */
  private async call<T>(kind: 'embeddings' | 'chat', fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof OpenAI.APIError) {
        const status = err.status ?? 0;
        this.log.warn({ kind, status, type: err.type, code: err.code, message: err.message }, 'AI provider request failed');
        if (status === 429) throw new AppError('provider_rate_limited', 'AI provider rate limit reached; please try again shortly', { cause: err });
        if (status === 401 || status === 403) throw new AppError('provider_error', 'AI provider rejected the configured credentials', { retryable: false, cause: err });
        if (status === 404 || status === 400) throw new AppError('provider_error', `AI provider rejected the request (${status}); check model configuration`, { retryable: false, cause: err });
        throw new AppError('provider_error', 'AI provider is unavailable', { cause: err });
      }
      this.log.warn({ kind, err: err instanceof Error ? err.message : String(err) }, 'AI provider request failed');
      throw new AppError('provider_error', 'AI provider request failed', { cause: err });
    }
  }
}
