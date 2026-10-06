import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { Accounting } from '../components/Accounting';

const bank = { id: '00000000-0000-4000-8000-000000000001', code: '1000', name: 'Bank', account_type: 'asset', parent_account_id: null, is_active: true, is_used: true };
const stub = () => {
  const fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === `/api/accounts/${bank.id}` && options?.method === 'PATCH') return new Response(JSON.stringify({ ...bank, name: 'Main bank' }));
    if (url === '/api/accounts') return new Response(JSON.stringify({ accounts: [bank] }));
    if (url.startsWith('/api/account-classifications')) return new Response(JSON.stringify({ accounts: [] }));
    if (url === '/api/fiscal-years') return new Response(JSON.stringify({ fiscalYears: [] }));
    if (url === '/api/journals') return new Response(JSON.stringify({ journals: [] }));
    return new Response(JSON.stringify({ sources: [] }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};

describe('Chart of Accounts edit mode (Task 30A)', () => {
  beforeEach(async () => { await i18n.changeLanguage('ar'); window.history.replaceState(null, '', '/?page=accounting'); });

  it('enters a visible, usable edit mode on one click and saves only the allowed changed field', async () => {
    const fetchMock = stub();
    render(<Accounting canView canCreateChart canEditChart canCreateJournal={false} canEditJournal={false} canPost={false} onUnauthorized={vi.fn()} />);
    await screen.findAllByText('Bank');
    const panel = screen.getByRole('complementary');
    const form = panel.querySelector('form')!;
    expect(form).toHaveAttribute('data-mode', 'view');
    expect(within(panel).getAllByRole('textbox')[1]).toBeDisabled();

    fireEvent.click(within(panel).getByRole('button', { name: 'تعديل' }));

    expect(form).toHaveAttribute('data-mode', 'edit');
    expect(form).toHaveClass('is-editing');
    const [code, name] = within(panel).getAllByRole('textbox') as HTMLInputElement[];
    expect(name).toBeEnabled();
    expect(name.readOnly).toBe(false);
    expect(name).toHaveFocus();
    expect(code).toBeDisabled();
    for (const select of [0, 1].map((i) => within(panel).getAllByRole('combobox')[i]!)) expect(select).toBeDisabled();
    expect(within(panel).getAllByRole('note').length).toBe(3);
    expect(within(panel).getByRole('button', { name: 'حفظ التعديلات' })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: 'إلغاء' })).toBeInTheDocument();
    expect(within(panel).queryByRole('button', { name: 'تعديل' })).not.toBeInTheDocument();

    fireEvent.change(name, { target: { value: 'Main bank' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'حفظ التعديلات' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'PATCH')).toBe(true));
    const call = fetchMock.mock.calls.find(([, o]) => o?.method === 'PATCH')!;
    expect(JSON.parse(String(call[1]?.body))).toEqual({ name_ar: 'Main bank' });
  });

  it('restores the original values on Cancel', async () => {
    stub();
    render(<Accounting canView canCreateChart canEditChart canCreateJournal={false} canEditJournal={false} canPost={false} onUnauthorized={vi.fn()} />);
    await screen.findAllByText('Bank');
    const panel = screen.getByRole('complementary');
    fireEvent.click(within(panel).getByRole('button', { name: 'تعديل' }));
    fireEvent.change(within(panel).getAllByRole('textbox')[1]!, { target: { value: 'Changed' } });
    fireEvent.click(within(panel).getByRole('button', { name: 'إلغاء' }));
    // Legacy account (no localized names yet): the Arabic field returns to empty, showing the legacy name as placeholder.
    expect(within(panel).getAllByRole('textbox')[1]).toHaveValue('');
    expect(within(panel).getAllByRole('textbox')[1]).toHaveAttribute('placeholder', 'Bank');
    expect(within(panel).getAllByRole('textbox')[1]).toBeDisabled();
  });

  it('styles editable and locked fields differently (the locked stylesheet renders them identically)', () => {
    const css = readFileSync(resolve(__dirname, '../components/AccountEdit.css'), 'utf8');
    expect(css).toContain('.is-editing input:enabled');
    expect(css).toContain('.is-editing input:disabled');
    expect(readFileSync(resolve(__dirname, '../components/AccountingCore.tsx'), 'utf8')).toContain('import "./AccountEdit.css"');
  });
  it('never reuses the Edit button node as the Save submit button (runtime click would submit the form and leave edit mode)', async () => {
    const fetchMock = stub();
    render(<Accounting canView canCreateChart canEditChart canCreateJournal={false} canEditJournal={false} canPost={false} onUnauthorized={vi.fn()} />);
    await screen.findAllByText('Bank');
    const panel = screen.getByRole('complementary');
    const edit = within(panel).getByRole('button', { name: 'تعديل' });
    expect(edit).toHaveAttribute('type', 'button');
    fireEvent.click(edit);
    const save = within(panel).getByRole('button', { name: 'حفظ التعديلات' });
    // React must mount a fresh <button type="submit">; mutating the clicked node's type lets the browser submit the form in the same click.
    expect(save).not.toBe(edit);
    expect(edit.isConnected).toBe(false);
    expect(edit).toHaveAttribute('type', 'button');
    expect(panel.querySelector('form')).toHaveAttribute('data-mode', 'edit');
    expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'PATCH')).toBe(false);
  });
});
