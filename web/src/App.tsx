import { useState } from 'react';
import { Header } from './components/Header';
import { AddContentForm } from './components/AddContentForm';
import { ItemList } from './components/ItemList';
import { ItemDetailDialog } from './components/ItemDetailDialog';
import { AskPanel } from './components/AskPanel';
import { useItems } from './hooks/useItems';
import { useAsk } from './hooks/useAsk';

export function App() {
  const items = useItems();
  const ask = useAsk();
  const [openItemId, setOpenItemId] = useState<string | null>(null);

  const indexedCount = items.items.filter((i) => i.status === 'indexed').length;
  const activeCount = items.items.filter((i) => i.status === 'pending' || i.status === 'processing').length;

  return (
    <div className="app">
      <Header indexedCount={indexedCount} activeCount={activeCount} />
      <main className="layout">
        <section className="column" aria-labelledby="knowledge-heading">
          <h2 id="knowledge-heading" className="section-title">Saved knowledge</h2>
          <AddContentForm onSubmit={items.addItem} />
          <ItemList state={items} onOpen={setOpenItemId} />
        </section>
        <section className="column" aria-labelledby="ask-heading">
          <h2 id="ask-heading" className="section-title">Ask</h2>
          <AskPanel ask={ask} indexedCount={indexedCount} activeCount={activeCount} onOpenItem={setOpenItemId} />
        </section>
      </main>
      <ItemDetailDialog itemId={openItemId} onClose={() => setOpenItemId(null)} />
    </div>
  );
}
