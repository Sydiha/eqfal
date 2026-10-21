import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { CutoverSupplements, normalizeAmount, toRequestLines } from '../components/CutoverSupplements';
import en from '../i18n/locales/en';
import ar from '../i18n/locales/ar';

describe('S2 UAT findings', () => {
  it('UI-01: accepts well-formed thousands separators, keeps exact digits, leaves malformed input for server rejection', () => {
    expect(normalizeAmount(' 100,000.00 ')).toBe('100000.00');
    expect(normalizeAmount('-1,234,567.89')).toBe('-1234567.89');
    expect(normalizeAmount('100000.00')).toBe('100000.00');
    for (const bad of ['1,00', '1,,000.00', '12,34.50', ',100.00', '100,000,']) expect(normalizeAmount(bad)).toBe(bad);
    const blank = { account_id: 'a', section: '', movement_type: 'contribution', label: 'x', amount: '2,500.10', opening_amount: '1,000.00', closing_amount: '3,000.00', classification_override_reason: '' };
    expect(toRequestLines([{ ...blank, line_type: 'cash_balance' }, { ...blank, line_type: 'equity_movement' }])).toEqual([
      { line_type: 'cash_balance', account_id: 'a', opening_amount: '1000.00', closing_amount: '3000.00' },
      { line_type: 'equity_movement', account_id: 'a', movement_type: 'contribution', label: 'x', amount: '2500.10' },
    ]);
  });

  it('UI-02/UI-03: localized totals and equity form without cash-only columns', async () => {
    await i18n.changeLanguage('ar');
    const version = { id: 'v', kind: 'equity', version_no: 2, status: 'approved', row_version: 1, source_system: 'ERP', evidence_reference: 'EV', fx_translation_evidence: null, functional_currency: 'SAR', approved_at: null, superseded_at: null, void_reason: null, lines: [], evaluation: { valid: true, issues: [], totals: { opening: '10.00', net_change: '5.00' } } };
    const call = vi.fn(async (url: string) => (url.endsWith('/supplements') ? { versions: [version] } : { accounts: [] }));
    const ar = (a: string) => a;
    render(<CutoverSupplements rangeId="r" call={call} tx={ar} canManage canApprove={false} />);
    expect(await screen.findByText('صافي التغير')).toBeTruthy();
    expect(screen.queryByText(/net_change/)).toBeNull();
    fireEvent.click(screen.getByText('إصدار تصحيحي جديد'));
    await waitFor(() => expect(screen.getByText('نوع الحركة')).toBeTruthy());
    expect(screen.queryByRole('columnheader', { name: 'في تاريخ القطع' })).toBeNull();
    expect(screen.queryByRole('columnheader', { name: 'مبرر التصنيف' })).toBeNull();
  });

  it('UI-06/EXP-02: package section keys exist in both locales, with an approved-version label', () => {
    for (const l of [en, ar] as Array<typeof en>) {
      const p = (l as unknown as { annualClosing: { package: { sections: Record<string, string>; approvedVersion: string } } }).annualClosing.package;
      for (const k of ['pre_cutover_history', 'pre_cutover_cash_flow', 'pre_cutover_equity']) expect(p.sections[k]).toBeTruthy();
      expect(p.approvedVersion).toContain('{{number}}');
    }
  });
});
