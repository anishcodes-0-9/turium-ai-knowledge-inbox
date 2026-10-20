import { useId, useState, type FormEvent } from 'react';
import type { AskState } from '../hooks/useAsk';
import { AnswerView } from './AnswerView';

interface Props {
  ask: AskState;
  indexedCount: number;
  activeCount: number;
  onOpenItem: (id: string) => void;
}

export function AskPanel({ ask, indexedCount, activeCount, onOpenItem }: Props) {
  const [question, setQuestion] = useState('');
  const inputId = useId();
  const trimmed = question.trim();
  const canAsk = trimmed.length >= 3 && !ask.loading;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (canAsk) void ask.ask(trimmed);
  }

  return (
    <div className="ask">
      <form className="card" onSubmit={submit} aria-busy={ask.loading}>
        <div className="field">
          <label htmlFor={inputId}>Question</label>
          <textarea
            id={inputId}
            rows={3}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="What did I save about…?"
            disabled={ask.loading}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
            }}
          />
          <div className="hint">
            {indexedCount === 0
              ? activeCount > 0
                ? 'Your first item is still being indexed; answers will use it once it is ready.'
                : 'Save something first — questions are answered only from your saved knowledge.'
              : `Searching ${indexedCount} indexed item${indexedCount === 1 ? '' : 's'}${activeCount > 0 ? ` (${activeCount} still indexing)` : ''}.`}
          </div>
        </div>
        <div className="form-actions">
          <button type="submit" className="primary" disabled={!canAsk}>{ask.loading ? 'Thinking…' : 'Ask'}</button>
          {ask.result && <button type="button" className="secondary" onClick={() => { ask.reset(); setQuestion(''); }}>Clear</button>}
        </div>
      </form>

      {ask.loading && (
        <div className="card answer" role="status">
          <span className="spinner" aria-hidden="true" /> Retrieving relevant chunks and generating an answer…
        </div>
      )}
      {ask.error && (
        <div className="card answer notice err" role="alert">
          {ask.error}
        </div>
      )}
      {ask.result && ask.question && <AnswerView question={ask.question} result={ask.result} onOpenItem={onOpenItem} />}
    </div>
  );
}
