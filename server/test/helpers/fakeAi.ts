import type { AiProvider, ChatMessage } from '../../src/providers/aiProvider.js';

const DIMS = 64;

/**
 * Deterministic bag-of-words embedding: each lowercase token is hashed into one
 * of DIMS buckets. Texts sharing vocabulary get high cosine similarity, which is
 * enough to exercise ranking/threshold logic without a real model.
 */
export function fakeEmbed(text: string, dims = DIMS): Float32Array {
  const v = new Float32Array(dims);
  for (const tok of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) h = Math.imul(h ^ tok.charCodeAt(i), 16777619);
    v[Math.abs(h) % dims] += 1;
  }
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dims; i++) v[i] = v[i]! / norm;
  return v;
}

export type ChatScript = (messages: ChatMessage[]) => string;

export class FakeAiProvider implements AiProvider {
  readonly embeddingModel = 'fake-embed-v1';
  readonly chatModel = 'fake-chat-v1';
  embedCalls: string[][] = [];
  chatCalls: ChatMessage[][] = [];
  /** Set to make the next calls throw (simulated provider outage). */
  embedError: Error | null = null;
  chatError: Error | null = null;
  chatScript: ChatScript = defaultChatScript;

  async embed(texts: string[]): Promise<Float32Array[]> {
    this.embedCalls.push(texts);
    if (this.embedError) throw this.embedError;
    return texts.map((t) => fakeEmbed(t));
  }

  async completeJson(messages: ChatMessage[]): Promise<string> {
    this.chatCalls.push(messages);
    if (this.chatError) throw this.chatError;
    return this.chatScript(messages);
  }
}

/** Default script: "answers" by citing passage 1 and echoing its first sentence. */
export function defaultChatScript(messages: ChatMessage[]): string {
  const user = messages.find((m) => m.role === 'user')?.content ?? '';
  const first = /<passage>\n([\s\S]*?)\n<\/passage>/.exec(user)?.[1] ?? '';
  const sentence = first.split(/(?<=[.!?])\s/)[0] ?? first;
  return JSON.stringify({ answer: `${sentence} [1]`, sufficient: true, citations: [1] });
}
