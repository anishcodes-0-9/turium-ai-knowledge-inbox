import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AskPanel } from '../src/components/AskPanel';
import type { AskState } from '../src/hooks/useAsk';
import { makeCitation, makeResult } from './helpers';

const ask = (over: Partial<AskState>): AskState => ({ question: null, result: null, loading: false, error: null, ask: vi.fn(async () => {}), reset: vi.fn(), ...over });

describe('AskPanel', () => {
  it('submits a question and blocks duplicate submissions while loading', async () => {
    const askFn = vi.fn(async () => {});
    const { rerender } = render(<AskPanel ask={ask({ ask: askFn })} indexedCount={2} activeCount={0} onOpenItem={vi.fn()} />);
    const user = userEvent.setup();
    const button = screen.getByRole('button', { name: 'Ask' });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('Question'), 'What is the mascot?');
    await user.click(button);
    expect(askFn).toHaveBeenCalledWith('What is the mascot?');

    rerender(<AskPanel ask={ask({ ask: askFn, loading: true, question: 'What is the mascot?' })} indexedCount={2} activeCount={0} onOpenItem={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Thinking…' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Retrieving relevant chunks');
  });

  it('explains the empty state when nothing is indexed', () => {
    const { rerender } = render(<AskPanel ask={ask({})} indexedCount={0} activeCount={0} onOpenItem={vi.fn()} />);
    expect(screen.getByText(/Save something first/)).toBeInTheDocument();
    rerender(<AskPanel ask={ask({})} indexedCount={0} activeCount={1} onOpenItem={vi.fn()} />);
    expect(screen.getByText(/still being indexed/)).toBeInTheDocument();
  });

  it('renders the answer with clickable citation markers and source snippets', async () => {
    const onOpenItem = vi.fn();
    const result = makeResult({
      answer: 'Steve is the mascot [2]. Budget reviews are in March [3].',
      citations: [
        makeCitation({ passage: 2, chunkId: 'a:0', itemId: 'a', title: 'Mascot note', snippet: 'llama named Steve' }),
        makeCitation({ passage: 3, chunkId: 'b:1', itemId: 'b', title: 'Budget page', sourceType: 'url', url: 'https://example.com/budget', snippet: 'review happens every March' }),
      ],
    });
    render(<AskPanel ask={ask({ result, question: 'Tell me things' })} indexedCount={2} activeCount={0} onOpenItem={onOpenItem} />);
    const answer = screen.getByTestId('answer');
    expect(answer).toHaveTextContent('Q: Tell me things');
    expect(screen.getByRole('link', { name: '[2]' })).toHaveAttribute('href', '#cite-2');
    expect(screen.getByRole('link', { name: '[3]' })).toHaveAttribute('href', '#cite-3');
    expect(screen.getByText('llama named Steve')).toBeInTheDocument();
    expect(screen.getByText('review happens every March')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'example.com' })).toHaveAttribute('href', 'https://example.com/budget');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Mascot note' }));
    expect(onOpenItem).toHaveBeenCalledWith('a');
    expect(screen.getByText(/3 chunks scanned/)).toBeInTheDocument();
  });

  it('leaves unknown markers as plain text', () => {
    const result = makeResult({ answer: 'Answer [1] and [7].', citations: [makeCitation({ passage: 1 })] });
    render(<AskPanel ask={ask({ result, question: 'q' })} indexedCount={1} activeCount={0} onOpenItem={vi.fn()} />);
    expect(screen.getByRole('link', { name: '[1]' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '[7]' })).toBeNull();
    expect(screen.getByTestId('answer')).toHaveTextContent('[7]');
  });

  it('shows an explicit insufficient-evidence state without citations', () => {
    const result = makeResult({ answer: 'Your saved knowledge does not contain enough information.', sufficientEvidence: false, insufficientReason: 'no_relevant_chunks', citations: [], retrieval: { candidates: 4, aboveThreshold: 0, selected: 0, topK: 6, minScore: 0.3, topScore: 0.12 } });
    render(<AskPanel ask={ask({ result, question: 'zebra?' })} indexedCount={2} activeCount={0} onOpenItem={vi.fn()} />);
    const box = screen.getByTestId('insufficient-evidence');
    expect(box).toHaveTextContent('Not enough evidence in your saved knowledge.');
    expect(box).toHaveTextContent('Nothing in your saved knowledge was similar enough');
    expect(screen.queryByText('Sources')).toBeNull();
  });

  it('shows the model-reported insufficient state with the fixed reason and no model text', () => {
    const result = makeResult({ answer: 'Your saved knowledge does not contain enough information to answer this question.', sufficientEvidence: false, insufficientReason: 'model_reported_insufficient', citations: [] });
    render(<AskPanel ask={ask({ result, question: 'llama lifespan?' })} indexedCount={1} activeCount={0} onOpenItem={vi.fn()} />);
    const box = screen.getByTestId('insufficient-evidence');
    expect(box).toHaveTextContent('Related content was found, but it does not actually answer the question.');
    expect(box).not.toHaveTextContent('Model note');
    expect(screen.queryByText('Sources')).toBeNull();
  });

  it('shows the unverifiable-answer state without sources or the model text', () => {
    const result = makeResult({ answer: 'The model did not return an answer that could be tied to your saved sources, so no answer is shown.', sufficientEvidence: false, insufficientReason: 'unverifiable_answer', citations: [] });
    render(<AskPanel ask={ask({ result, question: 'mascot?' })} indexedCount={1} activeCount={0} onOpenItem={vi.fn()} />);
    const box = screen.getByTestId('insufficient-evidence');
    expect(box).toHaveTextContent('Not enough evidence in your saved knowledge.');
    expect(box).toHaveTextContent('could be tied to your saved sources');
    expect(box).not.toHaveTextContent('Model note');
    expect(screen.queryByText('Sources')).toBeNull();
  });

  it('shows errors and lets the user clear a result', async () => {
    const reset = vi.fn();
    const { rerender } = render(<AskPanel ask={ask({ error: 'AI provider rate limit reached; please try again shortly' })} indexedCount={1} activeCount={0} onOpenItem={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('rate limit');
    rerender(<AskPanel ask={ask({ result: makeResult(), question: 'q', reset })} indexedCount={1} activeCount={0} onOpenItem={vi.fn()} />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Clear' }));
    expect(reset).toHaveBeenCalled();
  });
});
