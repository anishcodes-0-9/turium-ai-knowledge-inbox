import type { ItemStatus } from '../api/types';
import { STATUS_LABEL } from '../format';

export function StatusBadge({ status }: { status: ItemStatus }) {
  const busy = status === 'pending' || status === 'processing';
  return (
    <span className={`badge badge-${status}`} aria-label={`Status: ${STATUS_LABEL[status]}`}>
      {busy && <span className="spinner" aria-hidden="true" />}
      {STATUS_LABEL[status]}
    </span>
  );
}
