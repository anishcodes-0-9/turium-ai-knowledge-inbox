import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { AddContentForm } from '../src/components/AddContentForm';
import { ApiError } from '../src/api/client';
import { makeItem } from './helpers';

describe('AddContentForm', () => {
  it('submits a note, disables the button while saving, then clears and confirms', async () => {
    let resolve!: (v: ReturnType<typeof makeItem>) => void;
    const onSubmit = vi.fn(() => new Promise<ReturnType<typeof makeItem>>((r) => (resolve = r)));
    render(<AddContentForm onSubmit={onSubmit} />);
    const user = userEvent.setup();

    const button = screen.getByRole('button', { name: 'Save note' });
    expect(button).toBeDisabled();
    await user.type(screen.getByLabelText('Note'), 'The wifi password is pelican42');
    expect(button).toBeEnabled();
    await user.click(button);

    expect(onSubmit).toHaveBeenCalledWith({ type: 'note', content: 'The wifi password is pelican42' });
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Saving…' })); // duplicate click is a no-op
    expect(onSubmit).toHaveBeenCalledTimes(1);

    resolve(makeItem({ title: 'The wifi password is pelican42' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Saved "The wifi password is pelican42"');
    expect(screen.getByLabelText('Note')).toHaveValue('');
  });

  it('switches to URL mode and submits a URL', async () => {
    const onSubmit = vi.fn(async () => makeItem({ sourceType: 'url', title: 'example.com' }));
    render(<AddContentForm onSubmit={onSubmit} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Add URL' }));
    await user.type(screen.getByLabelText('Web page URL'), 'https://example.com/post');
    await user.click(screen.getByRole('button', { name: 'Save URL' }));
    expect(onSubmit).toHaveBeenCalledWith({ type: 'url', url: 'https://example.com/post' });
    expect(await screen.findByRole('status')).toHaveTextContent('Saved "example.com"');
  });

  it('shows the server error message and keeps the input', async () => {
    const onSubmit = vi.fn(async () => {
      throw new ApiError(422, 'url_blocked', 'URL points to a private, loopback or reserved IP address, which is not allowed');
    });
    render(<AddContentForm onSubmit={onSubmit} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Add URL' }));
    await user.type(screen.getByLabelText('Web page URL'), 'http://127.0.0.1/admin');
    await user.click(screen.getByRole('button', { name: 'Save URL' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('private, loopback or reserved');
    expect(screen.getByLabelText('Web page URL')).toHaveValue('http://127.0.0.1/admin');
    expect(screen.getByRole('button', { name: 'Save URL' })).toBeEnabled();
  });
});
