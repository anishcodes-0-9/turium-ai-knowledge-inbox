import type { ApiErrorBody, IngestRequest, ItemDetail, ItemsPage, ItemSummary, QueryResult } from './types';

/** Thrown for any non-2xx response; carries the server's stable error code. */
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly requestId?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function http<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { ...init, headers: { 'content-type': 'application/json', ...(init.headers ?? {}) } });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', 'Could not reach the server. Is it running?');
  }
  const text = await res.text();
  const body = text ? safeJson(text) : null;
  if (!res.ok) {
    const e = (body as ApiErrorBody | null)?.error;
    throw new ApiError(res.status, e?.code ?? 'http_error', e?.message ?? `Request failed with HTTP ${res.status}`, e?.requestId);
  }
  return body as T;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export const api = {
  listItems: (opts: { limit?: number; offset?: number } = {}, signal?: AbortSignal) =>
    http<ItemsPage>(`/items?limit=${opts.limit ?? 100}&offset=${opts.offset ?? 0}`, { signal }),
  getItem: (id: string, signal?: AbortSignal) => http<{ item: ItemDetail }>(`/items/${encodeURIComponent(id)}`, { signal }),
  ingest: (body: IngestRequest) => http<{ item: ItemSummary }>('/ingest', { method: 'POST', body: JSON.stringify(body) }),
  retryItem: (id: string) => http<{ item: ItemSummary }>(`/items/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  query: (question: string, signal?: AbortSignal) => http<QueryResult>('/query', { method: 'POST', body: JSON.stringify({ question }), signal }),
};

export type Api = typeof api;
