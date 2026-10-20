import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ItemList } from '../src/components/ItemList';
import type { ItemsState } from '../src/hooks/useItems';
import { makeItem } from './helpers';

const state = (over: Partial<ItemsState>): ItemsState => ({
  items: [], loading: false, error: null, refresh: vi.fn(async () => {}), addItem: vi.fn(), retryItem: vi.fn(async () => {}), ...over,
});

describe('ItemList', () => {
  it('shows loading, then an empty state', () => {
    const { rerender } = render(<ItemList state={state({ loading: true })} onOpen={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    rerender(<ItemList state={state({})} onOpen={vi.fn()} />);
    expect(screen.getByText('Nothing saved yet.')).toBeInTheDocument();
  });

  it('renders processing, ready and failed states with metadata', () => {
    const items = [
      makeItem({ id: 'a', title: 'Queued note', status: 'pending', chunkCount: 0 }),
      makeItem({ id: 'b', title: 'Working note', status: 'processing', chunkCount: 0 }),
      makeItem({ id: 'c', title: 'Ready page', status: 'indexed', sourceType: 'url', url: 'https://example.com/x', chunkCount: 3 }),
      makeItem({ id: 'd', title: 'Broken page', status: 'failed', sourceType: 'url', url: 'https://bad.example/x', attempts: 3, error: { code: 'url_fetch_failed', message: 'Remote server responded with HTTP 503' } }),
    ];
    render(<ItemList state={state({ items })} onOpen={vi.fn()} />);
    expect(screen.getByLabelText('Status: Queued')).toBeInTheDocument();
    expect(screen.getByLabelText('Status: Processing')).toBeInTheDocument();
    expect(screen.getByLabelText('Status: Ready')).toBeInTheDocument();
    expect(screen.getByLabelText('Status: Failed')).toBeInTheDocument();
    expect(screen.getByText('· 3 chunks')).toBeInTheDocument();
    expect(screen.getByText('· attempt 3')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Remote server responded with HTTP 503');
    expect(screen.getAllByText('URL')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'example.com' })).toHaveAttribute('href', 'https://example.com/x');
  });

  it('retries a failed item and opens an item on title click', async () => {
    const retryItem = vi.fn(async () => {});
    const onOpen = vi.fn();
    const items = [makeItem({ id: 'd', title: 'Broken page', status: 'failed', error: { code: 'x', message: 'boom' } })];
    render(<ItemList state={state({ items, retryItem })} onOpen={onOpen} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(retryItem).toHaveBeenCalledWith('d');
    await user.click(screen.getByRole('button', { name: 'Broken page' }));
    expect(onOpen).toHaveBeenCalledWith('d');
  });

  it('shows a recoverable error when loading fails', async () => {
    const refresh = vi.fn(async () => {});
    render(<ItemList state={state({ error: 'Could not reach the server. Is it running?', refresh })} onOpen={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the server');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(refresh).toHaveBeenCalled();
  });
});
