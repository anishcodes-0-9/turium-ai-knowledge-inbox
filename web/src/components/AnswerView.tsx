import { Fragment } from 'react';
import type { Citation, InsufficientReason, QueryResult } from '../api/types';
import { hostOf } from '../format';

interface Props {
  question: string;
  result: QueryResult;
  onOpenItem: (id: string) => void;
}

const REASON_TEXT: Record<InsufficientReason, string> = {
  no_indexed_content: 'There is no indexed content yet. Save a note or URL and wait for it to finish indexing.',
  no_relevant_chunks: 'Nothing in your saved knowledge was similar enough to this question.',
  model_reported_insufficient: 'Related content was found, but it does not actually answer the question.',
  unverifiable_answer: 'The model did not return an answer that could be tied to your saved sources, so no answer is shown.',
};

export function AnswerView({ question, result, onOpenItem }: Props) {
  if (!result.sufficientEvidence) {
    return (
      <div className="card answer insufficient" data-testid="insufficient-evidence">
        <p className="answer-question">Q: {question}</p>
        <p><strong>Not enough evidence in your saved knowledge.</strong></p>
        <p className="muted">{result.insufficientReason ? REASON_TEXT[result.insufficientReason] : result.answer}</p>
        <RetrievalStats result={result} />
      </div>
    );
  }

  return (
    <div className="card answer" data-testid="answer">
      <p className="answer-question">Q: {question}</p>
      <div className="answer-text">{renderWithMarkers(result.answer, result.citations)}</div>
      <h4 className="sources-title">Sources</h4>
      <ol className="citations">
        {result.citations.map((c) => (
          <li key={c.chunkId} id={`cite-${c.passage}`} className="citation">
            <div className="citation-head">
              <span className="cite-num">[{c.passage}]</span>
              <button type="button" className="link-button" onClick={() => onOpenItem(c.itemId)} title="Open saved item">{c.title}</button>
              <span className={`type-pill type-${c.sourceType}`}>{c.sourceType === 'url' ? 'URL' : 'Note'}</span>
              <span className="muted small">score {c.score.toFixed(2)}</span>
            </div>
            {c.url && <a className="item-url" href={c.url} target="_blank" rel="noreferrer noopener">{hostOf(c.url)}</a>}
            <blockquote className="snippet">{c.snippet}</blockquote>
          </li>
        ))}
      </ol>
      <RetrievalStats result={result} />
    </div>
  );
}

/** Turns `[n]` markers in the answer into links to the citation whose passage number is n. Unknown markers stay plain text. */
function renderWithMarkers(answer: string, citations: Citation[]) {
  const byPassage = new Map(citations.map((c) => [c.passage, c] as const));
  return answer.split(/(\[\d{1,3}\])/g).map((part, i) => {
    const m = /^\[(\d{1,3})\]$/.exec(part);
    const cite = m ? byPassage.get(Number(m[1])) : undefined;
    if (!cite) return <Fragment key={i}>{part}</Fragment>;
    return (
      <a key={i} className="marker" href={`#cite-${cite.passage}`} title={cite.title}>{part}</a>
    );
  });
}

function RetrievalStats({ result }: { result: QueryResult }) {
  const r = result.retrieval;
  return (
    <p className="muted small retrieval-stats">
      Retrieval: {r.candidates} chunk{r.candidates === 1 ? '' : 's'} scanned · {r.aboveThreshold} above threshold {r.minScore} · {r.selected} sent to the model
      {r.topScore !== null ? ` · top score ${r.topScore.toFixed(2)}` : ''}
    </p>
  );
}
