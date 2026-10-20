import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { IngestRequest, ItemSummary } from '../api/types';

const ACTIVE_POLL_MS = 1500;

export interface ItemsState {
  items: ItemSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  addItem: (body: IngestRequest) => Promise<ItemSummary>;
  retryItem: (id: string) => Promise<void>;
}

/**
 * Owns the saved-items list. Polls the server while any item is still being
 * processed so status changes appear without a manual refresh, and stops
 * polling once everything is settled.
 */
export function useItems(): ItemsState {
  const [items, setItems] = useState<ItemSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const gen = ++generation.current;
    try {
      const page = await api.listItems({ limit: 100 });
      if (gen !== generation.current) return; // a newer refresh already landed
      setItems(page.items);
      setError(null);
    } catch (err) {
      if (gen !== generation.current) return;
      setError(err instanceof ApiError ? err.message : 'Failed to load items');
    } finally {
      if (gen === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const hasActive = items.some((i) => i.status === 'pending' || i.status === 'processing');
  useEffect(() => {
    if (!hasActive) return;
    const id = window.setInterval(() => void refresh(), ACTIVE_POLL_MS);
    return () => window.clearInterval(id);
  }, [hasActive, refresh]);

  const addItem = useCallback(
    async (body: IngestRequest) => {
      const { item } = await api.ingest(body);
      setItems((prev) => [item, ...prev.filter((p) => p.id !== item.id)]);
      return item;
    },
    [],
  );

  const retryItem = useCallback(async (id: string) => {
    const { item } = await api.retryItem(id);
    setItems((prev) => prev.map((p) => (p.id === id ? item : p)));
  }, []);

  return { items, loading, error, refresh, addItem, retryItem };
}
