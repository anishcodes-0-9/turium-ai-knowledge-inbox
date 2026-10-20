import { useState } from 'react';
import type { ItemSummary } from '../api/types';
import { formatDateTime, hostOf } from '../format';
import { StatusBadge } from './StatusBadge';

interface Props {
  item: ItemSummary;
  onOpen: (id: string) => void;
  onRetry: (id: string) => Promise<void>;
}

export function ItemCard({ item, onOpen, onRetry }: Props) {
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    try {
      await onRetry(item.id);
    } catch (err) {
      setRetryError(err instanceof Error ? err.message : 'Retry failed');
    } finally {
      setRetrying(false);
    }
  }

  return (
    <li className={`card item-card status-${item.status}`}>
      <div className="item-head">
        <span className={`type-pill type-${item.sourceType}`}>{item.sourceType === 'url' ? 'URL' : 'Note'}</span>
        <button type="button" className="link-button item-title" onClick={() => onOpen(item.id)} title="View saved content">
          {item.title}
        </button>
        <StatusBadge status={item.status} />
      </div>
      {item.sourceType === 'url' && item.url && (
        <a className="item-url" href={item.url} target="_blank" rel="noreferrer noopener">{hostOf(item.url)}</a>
      )}
      {item.contentPreview && <p className="item-preview">{item.contentPreview}</p>}
      <div className="item-meta">
        <span>Saved {formatDateTime(item.createdAt)}</span>
        {item.status === 'indexed' && <span>· {item.chunkCount} chunk{item.chunkCount === 1 ? '' : 's'}</span>}
        {item.attempts > 1 && <span>· attempt {item.attempts}</span>}
      </div>
      {item.status === 'failed' && item.error && (
        <div className="item-error" role="alert">
          <strong>Ingestion failed:</strong> {item.error.message}
          <div className="item-error-actions">
            <button type="button" className="secondary small" onClick={retry} disabled={retrying}>{retrying ? 'Retrying…' : 'Retry'}</button>
            {retryError && <span className="notice err">{retryError}</span>}
          </div>
        </div>
      )}
      {item.status === 'pending' && item.error && (
        <div className="item-warn">Previous attempt failed ({item.error.message}). Retrying automatically…</div>
      )}
    </li>
  );
}
