import { useId, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client';
import type { IngestRequest, ItemSummary } from '../api/types';

type Mode = 'note' | 'url';

interface Props {
  onSubmit: (body: IngestRequest) => Promise<ItemSummary>;
}

/** Add-note / add-URL form. One submission at a time; the button is disabled while a request is in flight. */
export function AddContentForm({ onSubmit }: Props) {
  const [mode, setMode] = useState<Mode>('note');
  const [note, setNote] = useState('');
  const [url, setUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const noteId = useId();
  const urlId = useId();

  const value = mode === 'note' ? note.trim() : url.trim();
  const canSubmit = value.length > 0 && !submitting;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    setNotice(null);
    try {
      const item = await onSubmit(mode === 'note' ? { type: 'note', content: note } : { type: 'url', url });
      setNotice(`Saved "${item.title}". Its indexing status is shown in the list below.`);
      if (mode === 'note') setNote('');
      else setUrl('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card add-form" onSubmit={handleSubmit} aria-busy={submitting}>
      <div className="tabs" role="tablist" aria-label="Content type">
        {(['note', 'url'] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className={`tab ${mode === m ? 'active' : ''}`} onClick={() => { setMode(m); setError(null); setNotice(null); }}>
            {m === 'note' ? 'Add note' : 'Add URL'}
          </button>
        ))}
      </div>

      {mode === 'note' ? (
        <div className="field">
          <label htmlFor={noteId}>Note</label>
          <textarea id={noteId} rows={5} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Paste or type anything you want to remember…" disabled={submitting} maxLength={50000} />
          <div className="hint">{note.length.toLocaleString()} / 50,000 characters</div>
        </div>
      ) : (
        <div className="field">
          <label htmlFor={urlId}>Web page URL</label>
          <input id={urlId} type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com/article" disabled={submitting} />
          <div className="hint">The page is fetched server-side. Only public http(s) pages are allowed.</div>
        </div>
      )}

      <div className="form-actions">
        <button type="submit" className="primary" disabled={!canSubmit}>
          {submitting ? 'Saving…' : mode === 'note' ? 'Save note' : 'Save URL'}
        </button>
        {notice && <span className="notice ok" role="status">{notice}</span>}
        {error && <span className="notice err" role="alert">{error}</span>}
      </div>
    </form>
  );
}
