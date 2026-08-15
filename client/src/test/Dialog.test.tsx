import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Dialog } from '../components/Dialog';

function DialogHarness({ onClose = vi.fn(), busy = false }: { onClose?: () => void; busy?: boolean }) {
  const [open, setOpen] = useState(false);
  return <><button onClick={() => setOpen(true)}>Open dialog</button>{open && <Dialog title="Test dialog" busy={busy} onClose={() => { onClose(); setOpen(false); }}><button>First action</button></Dialog>}</>;
}

describe('Dialog focus behavior', () => {
  it('moves focus to the first usable control and restores it to the opener after close', async () => {
    render(<DialogHarness/>);
    const opener = screen.getByRole('button', { name: 'Open dialog' });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() => expect(screen.getByRole('button', { name: 'First action' })).toHaveFocus());
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('closes with Escape when not busy', async () => {
    const onClose = vi.fn();
    render(<DialogHarness onClose={onClose}/>);
    fireEvent.click(screen.getByRole('button', { name: 'Open dialog' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
