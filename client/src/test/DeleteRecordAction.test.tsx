import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DeleteRecordAction, DeletableKind } from '../components/DeleteRecordAction';
import i18n from '../i18n';

// Delete & Void Phase 3: one confirmation flow for journals, accruals, bank imports, counterparties and partners (AR/EN).
const view = (kind: DeletableKind, onDeleted = vi.fn(), onUnauthorized = vi.fn()) =>
  render(<DeleteRecordAction kind={kind} url="/api/x/1?version=2" name="Rent" onDeleted={onDeleted} onUnauthorized={onUnauthorized} />);
const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });
afterEach(() => cleanup());

describe('DeleteRecordAction', () => {
  it.each(['journal', 'periodicAdjustment', 'bankImport', 'counterparty', 'partner'] as const)('%s: asks for confirmation naming the record, sends nothing until confirmed, then DELETEs and reloads', async (kind) => {
    const fetchMock = vi.fn().mockResolvedValue(json({ deleted: true }, 200));
    vi.stubGlobal('fetch', fetchMock);
    const onDeleted = vi.fn();
    view(kind, onDeleted);
    fireEvent.click(screen.getByRole('button'));
    expect(screen.getByText(/permanently removes/)).toHaveTextContent(/Rent/);
    expect(screen.getByText(/cannot be undone/)).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(onDeleted).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith('/api/x/1?version=2', expect.objectContaining({ method: 'DELETE', credentials: 'same-origin' }));
  });

  it('shows the specific blocked reason and keeps the dialog open', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'x', code: 'JOURNAL_DELETE_BLOCKED', reason: 'posted' }, 409)));
    const onDeleted = vi.fn();
    view('journal', onDeleted);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('posted journal is part of the accounting records');
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it('falls back to a generic reason for an unknown dependency, in Arabic too', async () => {
    await i18n.changeLanguage('ar');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: 'x', code: 'PARTNER_DELETE_BLOCKED', reason: 'something_new' }, 409)));
    view('partner');
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: 'حذف نهائي' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('مستخدم في سجلات أخرى');
  });

  it('signals an expired session instead of showing an error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({}, 401)));
    const onUnauthorized = vi.fn();
    view('partner', vi.fn(), onUnauthorized);
    fireEvent.click(screen.getByRole('button'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
  });
});
