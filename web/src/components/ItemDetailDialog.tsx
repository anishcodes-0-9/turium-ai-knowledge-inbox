import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api/client';
import type { ItemDetail } from '../api/types';
import { formatDateTime } from '../format';
import { StatusBadge } from './StatusBadge';

interface Props {
  itemId: string | null;
  onClose: () => void;
}

/** Modal showing the full saved content of one item (what the RAG pipeline actually indexed). */
export function ItemDetailDialog({ itemId, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (itemId) {
      if (!dialog.open) dialog.showModal();
    } else if (dialog.open) {
      dialog.close();
    }
  }, [itemId]);

  useEffect(() => {
    if (!itemId) return;
    const ctl = new AbortController();
    setItem(null);
    setError(null);
    api
      .getItem(itemId, ctl.signal)
      .then((r) => setItem(r.item))
      .catch((err) => {
        if (ctl.signal.aborted) return;
        setError(err instanceof ApiError ? err.message : 'Could not load item');
      });
    return () => ctl.abort();
  }, [itemId]);

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="dialog-title">
      <div className="dialog-head">
        <h3 id="dialog-title">{item?.title ?? 'Saved item'}</h3>
        <button type="button" className="secondary small" onClick={onClose} aria-label="Close">✕</button>
      </div>
      {error && <p className="notice err" role="alert">{error}</p>}
      {!item && !error && <p className="muted">Loading…</p>}
      {item && (
        <div className="dialog-body">
          <div className="item-meta">
            <StatusBadge status={item.status} />
            <span>· {item.sourceType === 'url' ? 'URL' : 'Note'}</span>
            <span>· Saved {formatDateTime(item.createdAt)}</span>
            {item.status === 'indexed' && <span>· {item.chunkCount} chunks</span>}
          </div>
          {item.url && (
            <p><a href={item.url} target="_blank" rel="noreferrer noopener">{item.url}</a></p>
          )}
          {item.error && <p className="notice err">{item.error.message}</p>}
          <pre className="content">{item.content ?? (item.status === 'indexed' ? '' : 'Content is not available yet.')}</pre>
        </div>
      )}
    </dialog>
  );
}
