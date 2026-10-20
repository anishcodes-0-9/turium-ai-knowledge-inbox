import { useCallback, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { QueryResult } from '../api/types';

export interface AskState {
  question: string | null;
  result: QueryResult | null;
  loading: boolean;
  error: string | null;
  ask: (question: string) => Promise<void>;
  reset: () => void;
}

/** Runs a question against the server; aborts any in-flight request so a slow older answer can never overwrite a newer one. */
export function useAsk(): AskState {
  const [question, setQuestion] = useState<string | null>(null);
  const [result, setResult] = useState<QueryResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const ask = useCallback(async (q: string) => {
    controller.current?.abort();
    const ctl = new AbortController();
    controller.current = ctl;
    setQuestion(q);
    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.query(q, ctl.signal);
      if (ctl.signal.aborted) return;
      setResult(res);
    } catch (err) {
      if (ctl.signal.aborted) return;
      setError(err instanceof ApiError ? err.message : 'Something went wrong while asking');
    } finally {
      if (!ctl.signal.aborted) setLoading(false);
    }
  }, []);

  const reset = useCallback(() => {
    controller.current?.abort();
    setQuestion(null);
    setResult(null);
    setError(null);
    setLoading(false);
  }, []);

  return { question, result, loading, error, ask, reset };
}
