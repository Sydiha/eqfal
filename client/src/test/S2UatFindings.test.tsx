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

import { render as renderWithProviders, screen as s2 } from './test-utils';
import { AnnualClosing } from '../components/AnnualClosing';
import { afterEach } from 'vitest';
import { annualPackageExport, packageCutoverLines } from '../export/reportExport';
import { toCsv } from '../export/downloadExport';

describe('S2 package export: supplement versions and cutover disclosure (spec v2 G/H)', () => {
  const summary = { cutover_date: '2025-06-30', cash_flow_supplement: 'complete', cash_flow_supplement_version: 2, cash_flow_revision_pending: true, equity_supplement: 'complete', equity_supplement_version: 1, equity_revision_pending: false, tb_basis: 'pre_closing_acknowledged', blockers: '' };
  it.each(['en', 'ar'])('carries both approved version numbers from the snapshot manifest into the export (%s)', async (lng) => {
    await i18n.changeLanguage(lng);
    const t = i18n.t.bind(i18n);
    const labels = { cash_flow: t('annualClosing.package.sections.pre_cutover_cash_flow'), equity: t('annualClosing.package.sections.pre_cutover_equity') };
    const lines = packageCutoverLines(t, summary, labels);
    expect(lines).toContainEqual([`${t('accounting.statements.preCutover.supplementVersion')} — ${labels.cash_flow}`, `2 — ${t('accounting.statements.preCutover.revisionPending')}`]);
    expect(lines).toContainEqual([`${t('accounting.statements.preCutover.supplementVersion')} — ${labels.equity}`, '1']);
    const doc = annualPackageExport({ ar: lng === 'ar', company: 'Co', generatedAt: 'now', fiscalYear: 'FY', startDate: '2025-01-01', endDate: '2025-12-31', title: 'P', labels: { fiscalYear: 'f', range: 'r', packageState: 's', section: 'S', state: 'st', source: 'so', blockers: 'b', snapshot: '' }, packageState: 'Draft', snapshotLines: [], rows: [], cutover: lines });
    const csv = toCsv(doc.rows);
    expect(csv).toContain('2025-06-30');
    expect(csv).toContain(labels.equity);
    expect(csv).not.toContain('annualClosing.');
    expect(csv).not.toContain('accounting.statements');
  });
  it('omits the block for a year without a cutover, and shows "not recorded" when no version is approved', async () => {
    await i18n.changeLanguage('en');
    const t = i18n.t.bind(i18n);
    expect(packageCutoverLines(t, undefined, { cash_flow: 'c', equity: 'e' })).toEqual([]);
    expect(packageCutoverLines(t, { ...summary, equity_supplement_version: '' }, { cash_flow: 'c', equity: 'e' }).at(-1)).toEqual([`${t('accounting.statements.preCutover.supplementVersion')} — e`, 'Not recorded']);
  });
});

describe('S2 package tab: versions flow from the snapshot manifest to the screen', () => {
  afterEach(() => vi.restoreAllMocks());
  it('reads pre_cutover_history.summary of the latest snapshot', async () => {
    await i18n.changeLanguage('en');
    const summary = { cutover_date: '2025-06-30', cash_flow_supplement_version: 3, cash_flow_revision_pending: false, equity_supplement_version: 4, equity_revision_pending: false, tb_basis: 'pre_closing_acknowledged', blockers: '' };
    const manifest = [{ section: 'pre_cutover_history', status: 'ready', blocker_count: 0, blockers: [], source: 'ledger-source-authority', summary }];
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYears: [{ id: 'fy-1', name: '2025', start_date: '2025-01-01', end_date: '2025-12-31' }] }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ready: true, blocker_count: 0, financial_statements_readiness: { status: 'ready', label: '', label_ar: '' }, zakat_readiness: { status: 'ready' }, domains: {}, package_manifest: [] }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ package: { id: 'p', status: 'draft', version: 1, final_snapshot_id: null, finalized_at: null, handed_off_at: null, handoff_note: null, handoff_reference: null, snapshots: [{ id: 's', snapshot_no: 1, snapshot_type: 'preview', created_at: '2026-01-01T00:00:00Z', manifest }] }, live: { manifest: [], source_fingerprint: 'x' }, drift: false }), { status: 200 }));
    renderWithProviders(<AnnualClosing canView canViewPackage onUnauthorized={vi.fn()} />);
    fireEvent.click(await s2.findByRole('tab', { name: /closing package/i }));
    const note = await s2.findByRole('note', { name: 'Cutover disclosure' });
    expect(note).toHaveTextContent('Approved historical supplement version — Pre-cutover cash flows3');
    expect(note).toHaveTextContent('Approved historical supplement version — Pre-cutover equity movements4');
    expect(note).toHaveTextContent('2025-06-30');
  });
});
