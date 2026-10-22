import { fireEvent, render, screen, waitFor } from './test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpeningBalanceReview } from '../components/OpeningBalanceReview';
import i18n from '../i18n';

// T7.2: Import from Excel/CSV inside Opening Balance Review — preview, explicit category and partner, confirmation, draft-only save.
const year = { id: '11111111-1111-4111-8111-111111111111', name: 'FY 2026', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' };
const cash = { id: '22222222-2222-4222-8222-222222222222', code: '1000', name: 'Cash', account_type: 'asset', is_active: true };
const capital = { id: '33333333-3333-4333-8333-333333333333', code: '3000', name: 'Capital', account_type: 'equity', is_active: true };
const partner = { id: '55555555-5555-4555-8555-555555555555', name: 'Partner A', is_active: true };
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const preview = (o: Record<string, unknown> = {}) => ({ status: 'parsed', lines: [
  { row: 2, code: '1000', name: 'Cash', debit: '1234567.89', credit: '0.00', account_id: cash.id, status: 'ok' },
  { row: 3, code: '3000', name: 'Capital', debit: '0.00', credit: '1234567.89', account_id: capital.id, status: 'ok' },
], total_debit: '1234567.89', total_credit: '1234567.89', balanced: true, errors: [], warnings: [], import_allowed: true, ...o });

function mock(items: unknown[], parsed: unknown, importStatus = 201) {
  return vi.fn().mockImplementation((url: string) => {
    if (url === '/api/fiscal-years') return json({ fiscalYears: [year] });
    if (url === '/api/accounts') return json({ accounts: [cash, capital] });
    if (url === '/api/partners') return json({ partners: [partner] });
    if (url.endsWith('/suggestions')) return json({ suggestions: [] });
    if (url.endsWith('/import/parse-file')) return json(parsed);
    if (url.endsWith('/import')) return json(importStatus === 201 ? { items: [] } : { error: 'x', code: 'IMPORT_DRAFT_NOT_EMPTY' }, importStatus);
    return json({ year, review: { id: 'r1', status: 'draft', journal_entry_id: null }, items, summary: { debit: '0.00', credit: '0.00', difference: '0.00', confidence: { high: 0, medium: 0, low: 0 } } });
  });
}
const renderView = () => render(<OpeningBalanceReview canView canCreate canEdit canDelete canSubmit canReview canApprove={false} onUnauthorized={() => undefined} />);
const upload = async () => { await waitFor(() => screen.getByLabelText('Opening balance file')); await new Promise((r) => setTimeout(r, 100)); fireEvent.change(await waitFor(() => screen.getByLabelText('Opening balance file')), { target: { files: [new File(['x'], 'ob.csv', { type: 'text/csv' })] } }); };

describe('OpeningBalanceFileImport', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });

  it('requires a category per row, a partner for partner categories and confirmation, then saves draft items with exact amounts', async () => {
    const f = mock([], preview()); vi.stubGlobal('fetch', f); renderView();
    await upload();
    const save = await screen.findByRole('button', { name: 'Save as draft' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Category for row 2'), { target: { value: 'bank' } });
    fireEvent.change(screen.getByLabelText('Category for row 3'), { target: { value: 'partner_capital' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Partner for row 3'), { target: { value: partner.id } });
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(f.mock.calls.some(([u]) => String(u).endsWith('/import'))).toBe(true));
    const body = JSON.parse(String(f.mock.calls.find(([u]) => String(u).endsWith('/import'))![1].body));
    expect(body).toEqual({ confirm: true, file_name: 'ob.csv', items: [
      { row: 2, account_id: cash.id, debit: '1234567.89', credit: '0.00', category: 'bank', partner_id: null },
      { row: 3, account_id: capital.id, debit: '0.00', credit: '1234567.89', category: 'partner_capital', partner_id: partner.id },
    ] });
    expect(f.mock.calls.some(([u]) => /approve|submit-review/.test(String(u)))).toBe(false);
  });

  it('blocks saving an unbalanced or erroneous file but still previews it', async () => {
    vi.stubGlobal('fetch', mock([], preview({ balanced: false, errors: [{ code: 'TB_UNBALANCED' }] }))); renderView();
    await upload();
    expect(await screen.findByText(/total debit differs from total credit/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Category for row 2'), { target: { value: 'bank' } });
    fireEvent.change(screen.getByLabelText('Category for row 3'), { target: { value: 'equity' } });
    fireEvent.click(screen.getByRole('checkbox'));
    expect(screen.getByRole('button', { name: 'Save as draft' })).toBeDisabled();
  });

  it('is hidden when the draft already has items, keeping manual entry', async () => {
    vi.stubGlobal('fetch', mock([{ id: 'i1', category: 'bank', account_id: cash.id, amount: '1.00', balance_side: 'debit', source_type: 'bank_statement', source_reference: null, confidence: 'high', note: null }], preview()));
    renderView();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add item' })).toBeInTheDocument());
    await waitFor(() => expect(screen.getAllByText(/Cash/).length).toBeGreaterThan(0));
    expect(screen.queryByLabelText('Opening balance file')).toBeNull();
  });

  it('renders Arabic labels', async () => {
    await i18n.changeLanguage('ar');
    vi.stubGlobal('fetch', mock([], preview())); renderView();
    await waitFor(() => expect(screen.getByText('استيراد من Excel/CSV')).toBeInTheDocument());
  });
});
