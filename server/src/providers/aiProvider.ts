/**
 * Provider abstraction. The rest of the application only depends on this
 * interface, so tests use an in-memory fake and the real implementation can
 * target any OpenAI-compatible API (OpenAI, Ollama, LM Studio, ...).
 */
export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface AiProvider {
  readonly embeddingModel: string;
  readonly chatModel: string;
  /** Embeds texts in order; returns one vector per input. */
  embed(texts: string[]): Promise<Float32Array[]>;
  /** Runs a chat completion that must return a JSON object; returns the raw text. */
  completeJson(messages: ChatMessage[]): Promise<string>;
}
