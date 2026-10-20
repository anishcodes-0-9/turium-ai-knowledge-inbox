import type { ItemsState } from '../hooks/useItems';
import { ItemCard } from './ItemCard';

interface Props {
  state: ItemsState;
  onOpen: (id: string) => void;
}

export function ItemList({ state, onOpen }: Props) {
  if (state.loading) return <p className="muted" role="status">Loading saved items…</p>;
  if (state.error && state.items.length === 0) {
    return (
      <div className="card empty" role="alert">
        <p>{state.error}</p>
        <button type="button" className="secondary" onClick={() => void state.refresh()}>Try again</button>
      </div>
    );
  }
  if (state.items.length === 0) {
    return (
      <div className="card empty">
        <p><strong>Nothing saved yet.</strong></p>
        <p className="muted">Add a note or a URL above. Once it is indexed you can ask questions about it.</p>
      </div>
    );
  }
  return (
    <>
      {state.error && <p className="notice err" role="alert">{state.error}</p>}
      <ul className="item-list" aria-label="Saved items">
        {state.items.map((item) => (
          <ItemCard key={item.id} item={item} onOpen={onOpen} onRetry={state.retryItem} />
        ))}
      </ul>
    </>
  );
}
