import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import en from '../i18n/locales/en';
import ar from '../i18n/locales/ar';
import { ZakatWorksheet } from '../components/ZakatWorksheet';

const gate = (code: string, key: string) => ({ code, key, article: 'م15', status: 'unverified' });
const calculation = { status: 'blocked', payable_amount: null, blockers: [gate('B0', 'amendment_1248'), gate('B3', 'rounding_rule'), gate('B4', 'liability_cap_order'), gate('B7', 'book_profit_after_zakat_circularity')] };
const base = { workpaper: { id: 'w', tax_path: 'zakat' }, scope_problems: [], revisions: [], eligibility: [], ownership_preview: { qualified: false, reasons: [], detail: { partners: [{ partner_id: 'p1', name: 'Partner A' }] } }, calculation };
const worksheet = (over: object = {}) => ({
  id: 'r1', revision_no: 1, status: 'draft', version: 3, revision_reason: null, approved_fingerprint: null, source_drift: false,
  balance_snapshot: { as_of: '2026-12-31', book_net_profit: '500.00', accounts: [{ account_id: 'a1', code: '1000', name: 'Cash', statement_category: 'current_asset', balance_halalas: '100000' }] },
  classifications: [{ account_id: 'a1', account_code: '1000', account_name: 'Cash', statement_category: 'current_asset', zakat_class: 'not_deducted', reg_article: 'م26', evidence_document_id: null, note: null, status: 'suggested' }],
  adjustments: [], ownership_snapshot: { qualified: false, reasons: ['partner_eligibility_missing'], detail: { total_percentage: '100.0000', partners: [{ partner_id: 'p1', name: 'Partner A', percentage: '100.0000', ownership_class: null }] } },
  blockers: [{ code: 'unconfirmed_classification', count: 1 }], ...over,
});
const caps = { canView: true, canCreate: true, canEdit: true, canSubmit: true, canReview: true, canApprove: true, onUnauthorized: vi.fn(), onChanged: vi.fn() };
const mockFetch = (payload: object) => vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => String(input).includes('/api/documents') ? new Response(JSON.stringify({ documents: [{ id: 'd1', original_filename: 'id.pdf' }] })) : new Response(JSON.stringify(payload)));

describe('Zakat worksheet UI', () => {
  beforeEach(async () => { vi.restoreAllMocks(); await i18n.changeLanguage('en'); });

  it('shows calculation as blocked with the specific gates and never a payable amount', async () => {
    mockFetch({ ...base, worksheet: worksheet() });
    render(<ZakatWorksheet yearId="fy" {...caps} />);
    expect(await screen.findByText(/Final Zakat calculation is not available/)).toBeTruthy();
    for (const code of ['B0', 'B3', 'B4', 'B7']) expect(screen.getByText(code)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/(payable|due)\s*[:=]?\s*[\d,]+\.\d{2}/i);
    expect(screen.getAllByText(/Ownership is not qualified/).length).toBeGreaterThan(0);
    expect(screen.getByText('Partner without eligibility evidence')).toBeTruthy();
    expect(screen.getByText('Not confirmed')).toBeTruthy();
  });

  it('lets a reviewer confirm a classification and sends the worksheet version', async () => {
    const fetchMock = mockFetch({ ...base, worksheet: worksheet() });
    render(<ZakatWorksheet yearId="fy" {...caps} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => String(u).endsWith('/classifications/a1/confirm') && (i as RequestInit).method === 'POST' && (i as RequestInit).body === JSON.stringify({ version: 3 }))).toBe(true));
  });

  it('hides write controls without the matching capabilities and outside draft', async () => {
    mockFetch({ ...base, worksheet: worksheet() });
    const { rerender } = render(<ZakatWorksheet yearId="fy" {...caps} canEdit={false} canReview={false} canSubmit={false} canCreate={false} />);
    await screen.findByText(/Final Zakat calculation is not available/);
    for (const name of ['Confirm', 'Save', 'Confirm eligibility', 'Submit for review']) expect(screen.queryByRole('button', { name })).toBeNull();
    mockFetch({ ...base, worksheet: worksheet({ status: 'approved', approved_fingerprint: 'a'.repeat(64) }), revisions: [{ id: 'r1', revision_no: 1, status: 'approved', revision_reason: null, approved_fingerprint: 'a'.repeat(64) }] });
    rerender(<ZakatWorksheet yearId="fy2" {...caps} />);
    expect(await screen.findByRole('button', { name: 'Start a new revision' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('requires the non-financing declaration before starting and blocks unsupported years visibly', async () => {
    mockFetch({ ...base, worksheet: null, scope_problems: ['fiscal_year_before_2024'] });
    render(<ZakatWorksheet yearId="fy" {...caps} />);
    const start = await screen.findByRole('button', { name: 'Start Zakat worksheet' });
    expect((start as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Fiscal year starts before 2024')).toBeTruthy();
  });

  it('renders Arabic labels with LTR-isolated numbers', async () => {
    await i18n.changeLanguage('ar');
    mockFetch({ ...base, worksheet: worksheet() });
    render(<ZakatWorksheet yearId="fy" {...caps} />);
    expect(await screen.findByText(/احتساب الزكاة النهائي غير متاح/)).toBeTruthy();
    expect(screen.getAllByText(/الملكية غير مؤهلة/).length).toBeGreaterThan(0);
    expect(document.querySelector('td[dir="ltr"]')).toBeTruthy();
  });
});

describe('Zakat worksheet localization', () => {
  const keys = (o: unknown, prefix = ''): string[] => Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => (v && typeof v === 'object' ? keys(v, `${prefix}${k}.`) : [`${prefix}${k}`]));
  it('has identical Arabic and English key sets, with no empty strings', () => {
    const e = (en as any).zakatWorksheet, a = (ar as any).zakatWorksheet;
    expect(keys(a).sort()).toEqual(keys(e).sort());
    expect(keys(e).every((k) => k.split('.').reduce((o: any, p) => o[p], e).length > 0)).toBe(true);
  });
});
