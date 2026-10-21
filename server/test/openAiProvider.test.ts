import { describe, expect, it } from 'vitest';
import { OpenAiProvider } from '../src/providers/openAiProvider.js';
import { createLogger } from '../src/logger.js';
import { AppError } from '../src/errors.js';

/**
 * Drives the real OpenAI SDK against a stubbed fetch (no network), so the
 * provider's response handling is tested on the SDK's actual parsing.
 */
function providerReturning(body: unknown, status = 200) {
  const calls: Array<{ url: string; body: unknown }> = [];
  const fetchStub = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  const provider = new OpenAiProvider(
    { baseURL: 'http://provider.test/v1', apiKey: 'test-key', embeddingModel: 'e', chatModel: 'c', timeoutMs: 1000, maxRetries: 0, fetch: fetchStub },
    createLogger('silent', 'test'),
  );
  return { provider, calls };
}

const completion = (content: string | null, finish_reason: string) => ({
  id: 'x', object: 'chat.completion', created: 0, model: 'c',
  choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason }],
});

describe('OpenAiProvider.completeJson', () => {
  it('returns content and truncated=false for a normal stop', async () => {
    const { provider, calls } = providerReturning(completion('{"answer":"x"}', 'stop'));
    expect(await provider.completeJson([{ role: 'user', content: 'q' }])).toEqual({ content: '{"answer":"x"}', truncated: false });
    expect(calls[0]!.url).toBe('http://provider.test/v1/chat/completions');
    expect(calls[0]!.body).toMatchObject({ model: 'c', temperature: 0, response_format: { type: 'json_object' } });
  });

  it('flags finish_reason "length" as truncated', async () => {
    const { provider } = providerReturning(completion('{"answer":"The plant is', 'length'));
    expect(await provider.completeJson([{ role: 'user', content: 'q' }])).toEqual({ content: '{"answer":"The plant is', truncated: true });
  });

  it('rejects an empty completion as a provider error', async () => {
    const { provider } = providerReturning(completion(null, 'stop'));
    const err = await provider.completeJson([{ role: 'user', content: 'q' }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('provider_error');
  });
});
