import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReverseJournalAction } from '../components/ReverseJournalAction';
import i18n from '../i18n';

// Posted-journal reversal dialog (AR/EN): nothing is sent before an explicit confirmation with a date and a reason.
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });
const view = (onReversed = vi.fn(), onUnauthorized = vi.fn()) =>
  render(<ReverseJournalAction journalId="j-1" journalDate="2026-03-10" onReversed={onReversed} onUnauthorized={onUnauthorized} />);
const open = () => fireEvent.click(screen.getByRole('button', { name: /Reverse journal|عكس القيد/ }));

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });
afterEach(() => cleanup());

describe('ReverseJournalAction', () => {
  it('explains the effect, requires a reason, then POSTs the date and reason and reloads', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ reversal: { id: 'r-1' } }, 201));
    vi.stubGlobal('fetch', fetchMock);
    const onReversed = vi.fn();
    view(onReversed);
    open();
    expect(screen.getByText(/original journal stays unchanged/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('Reversal date'), { target: { value: '2026-04-01' } });
    fireEvent.change(screen.getByLabelText('Reason for the reversal'), { target: { value: '  Wrong account  ' } });
    const buttons = screen.getAllByRole('button', { name: 'Reverse journal' });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(onReversed).toHaveBeenCalledWith('r-1'));
    expect(fetchMock).toHaveBeenCalledWith('/api/journals/j-1/reverse', expect.objectContaining({ method: 'POST', body: JSON.stringify({ accounting_date: '2026-04-01', reason: 'Wrong account' }) }));
  });

  it('keeps the confirm button disabled until a reason is typed', () => {
    vi.stubGlobal('fetch', vi.fn());
    view();
    open();
    const buttons = screen.getAllByRole('button', { name: 'Reverse journal' });
    expect(buttons[buttons.length - 1]).toBeDisabled();
  });

  it('shows the server refusal in plain words (Arabic) and keeps the dialog open', async () => {
    await i18n.changeLanguage('ar');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'x', code: 'JOURNAL_ALREADY_REVERSED' }, 409)));
    const onReversed = vi.fn();
    view(onReversed);
    open();
    fireEvent.change(screen.getByLabelText('سبب العكس'), { target: { value: 'خطأ' } });
    const buttons = screen.getAllByRole('button', { name: 'عكس القيد' });
    fireEvent.click(buttons[buttons.length - 1]!);
    expect(await screen.findByRole('alert')).toHaveTextContent('تم عكس هذا القيد مسبقاً');
    expect(onReversed).not.toHaveBeenCalled();
  });

  it('signals an expired session instead of an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 401)));
    const onUnauthorized = vi.fn();
    view(vi.fn(), onUnauthorized);
    open();
    fireEvent.change(screen.getByLabelText('Reason for the reversal'), { target: { value: 'x' } });
    const buttons = screen.getAllByRole('button', { name: 'Reverse journal' });
    fireEvent.click(buttons[buttons.length - 1]!);
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });
});
