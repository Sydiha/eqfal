import { useState } from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EccDialog } from '../components/EccDialog';
import { EmployeeCostCenter } from '../components/EmployeeCostCenter';
import i18n from '../i18n';

afterEach(() => vi.unstubAllGlobals());

function Harness({ busy = false }: { busy?: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <button onClick={() => setOpen(true)}>opener</button>
    {open && <EccDialog title="Create" busy={busy} onClose={() => setOpen(false)} actions={<><button type="button" onClick={() => setOpen(false)}>Cancel</button><button>Save</button></>}>
      <input aria-label="first" /><input aria-label="second" />
    </EccDialog>}
  </>;
}

describe('EccDialog accessibility', () => {
  it('focuses the first control, contains Tab and Shift+Tab, closes on Escape and restores focus to the opener', () => {
    render(<Harness />);
    const opener = screen.getByText('opener');
    opener.focus();
    fireEvent.click(opener);
    expect(screen.getByRole('dialog', { name: 'Create' })).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByLabelText('first')).toHaveFocus();
    screen.getByText('Save').focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByLabelText('first')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByText('Save')).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('cannot be dismissed by Escape or backdrop while busy', () => {
    render(<Harness busy />);
    fireEvent.click(screen.getByText('opener'));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
});

describe('employee creation in-flight safety', () => {
  it('keeps the dialog and typed values open during a pending save, submits once, then closes', async () => {
    await i18n.changeLanguage('en');
    let finish: (r: Response) => void = () => undefined;
    const posts: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, options?: RequestInit) => {
      if (options?.method === 'POST' && url === '/api/employees') { posts.push(JSON.parse(String(options.body))); return new Promise<Response>(r => { finish = r; }); }
      if (url === '/api/employees') return Promise.resolve(new Response(JSON.stringify({ employees: [] }), { status: 200 }));
      return Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));
    }));
    render(<EmployeeCostCenter capabilities={['employee.view', 'employee.manage']} onUnauthorized={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create employee' }));
    fireEvent.change(screen.getByLabelText('Employee number'), { target: { value: 'E-9' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Test Person' } });
    const form = screen.getByLabelText('Name').closest('form')!;
    fireEvent.submit(form);
    await waitFor(() => expect(posts).toHaveLength(1));
    fireEvent.keyDown(document, { key: 'Escape' });
    fireEvent.mouseDown(screen.getByRole('dialog').parentElement!);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Name')).toHaveValue('Test Person');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(posts[0]).toMatchObject({ employee_number: 'E-9', display_name: 'Test Person' });
    finish(new Response('{}', { status: 201 }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
