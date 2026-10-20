export function Header({ indexedCount, activeCount }: { indexedCount: number; activeCount: number }) {
  return (
    <header className="header">
      <div className="brand">
        <span className="brand-mark" aria-hidden="true">◫</span>
        <span className="brand-name">Knowledge Inbox</span>
      </div>
      <nav className="header-nav" aria-label="Sections">
        <a href="#knowledge-heading">Saved</a>
        <a href="#ask-heading">Ask</a>
      </nav>
      <div className="header-status" aria-live="polite">
        {indexedCount} ready{activeCount > 0 ? ` · ${activeCount} processing` : ''}
      </div>
    </header>
  );
}
