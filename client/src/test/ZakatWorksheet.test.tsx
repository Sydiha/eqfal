import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { ZakatWorksheet } from '../components/ZakatWorksheet';

const props = { yearId: 'fy', canCreate: true, canEdit: true, canCreateAdjustment: true, canEditAdjustment: true, canDeleteAdjustment: true, canSubmit: true, canReview: true, canApprove: true, canCreateOwnership: true, canConfirmOwnership: true, canEditOwnership: true, canViewDocuments: true, onUnauthorized: () => undefined };
const gates = ['B0_amendment_1248', 'B3_rounding', 'B4_cap_ordering', 'B7_book_profit_after_zakat', 'B1_hijri_denominator'].map((code) => ({ code, title: code, article_ref: 'Art.', blocks_approval: !code.startsWith('B1'), status: 'unverified' }));
const payload = (over: object = {}) => ({
  scope: { unsupported_reason: null, fiscal_year: { start_date: '2026-01-01', end_date: '2026-12-31' } },
  worksheet: { id: 'w', revision_no: 1, status: 'draft', version: 3, revision_reason: null, non_financing_confirmed: true, accounting_records_confirmed: true, snapshot_captured_at: '2027-01-02', balances_snapshot: { as_of_date: '2026-12-31', accounts: [{ account_id: 'a1', code: '1100', name: 'Cash', name_ar: 'النقدية', statement_category: 'current_asset', amount_cents: '1234500' }] } },
  revisions: [{ id: 'w', revision_no: 1, status: 'draft', revision_reason: null, approved_at: null }],
  classifications: [], adjustments: [], eligibility: [],
  ownership_live: { qualified: false, blockers: ['no_confirmed_ownership'], as_of_date: '2026-12-31', total_ownership_bps4: '0', partners: [] },
  gates,
  readiness: { preparation_blockers: ['unclassified_balance'], gate_blockers: ['B0_amendment_1248'], unclassified_account_count: 1, can_submit: false, can_approve: false },
  ...over,
});
const mockFetch = () => vi.spyOn(globalThis, 'fetch').mockImplementation(async (u) => String(u).includes('/api/documents') ? new Response(JSON.stringify({ documents: [] })) : new Response(JSON.stringify(payload())));

describe('Zakat worksheet', () => {
  beforeEach(async () => { vi.restoreAllMocks(); await i18n.changeLanguage('en'); });
  it('is collapsed and does not fetch until opened', () => {
    const f = mockFetch(); render(<ZakatWorksheet {...props} />);
    expect(f).not.toHaveBeenCalled(); expect(screen.getByText('Zakat preparation worksheet')).toBeTruthy();
  });
  it('shows blockers and gates, withholds any payable amount, and disables submit/approve', async () => {
    mockFetch(); render(<ZakatWorksheet {...props} />); fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(screen.getByText(/Zakat payable is withheld/)).toBeTruthy());
    expect(screen.getByText('Some balances are unclassified')).toBeTruthy();
    expect(screen.getByText('B3 – Rounding rules')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Submit for review' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByText(/payable amount:/i)).toBeNull();
  });
  it('renders Arabic labels in Arabic UI', async () => {
    await i18n.changeLanguage('ar'); mockFetch(); render(<ZakatWorksheet {...props} />); fireEvent.click(screen.getByRole('button', { name: 'عرض' }));
    await waitFor(() => expect(screen.getByText(/مبلغ الزكاة المستحق محجوب/)).toBeTruthy());
    expect(screen.getByText('B3 – قواعد التقريب')).toBeTruthy(); expect(screen.getByText('النقدية', { exact: false })).toBeTruthy();
  });
  it('hides write controls without capabilities', async () => {
    mockFetch(); render(<ZakatWorksheet {...props} canEdit={false} canSubmit={false} canCreateOwnership={false} canCreateAdjustment={false} />); fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    await waitFor(() => expect(screen.getByText('Balances and classification')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Add eligibility record' })).toBeNull(); expect(screen.queryByRole('button', { name: 'Add adjustment' })).toBeNull();
  });
});
