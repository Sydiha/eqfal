import { fireEvent, render as plainRender, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render } from './test-utils';
import { CompanyProvider } from '../context/CompanyContext';
import { AuthProvider } from '../context/AuthContext';
import { BankTransactionsView } from '../components/BankTransactionsView';
import { MonthlyClose } from '../components/MonthlyClose';
import { FixedAssets } from '../components/FixedAssets';
import { PeriodicAdjustments } from '../components/PeriodicAdjustments';
import { Home } from '../components/Home';
import { buildXlsx, crc32 } from '../export/xlsx-builder';
import { toCsv } from '../export/downloadExport';
import { accrualsExport, bankReconciliationExport, fixedAssetsExport, managementSummaryExport, monthlyCloseExport, periodStem } from '../export/reportExport';
import i18n from '../i18n';

const base = { ar: false, company: 'Acme Co', generatedAt: '2026-10-07 12:00 UTC' };
const readSheet = (bytes: Uint8Array) => {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); let pos = 0; let sheet = '';
  while (dv.getUint32(pos, true) === 0x04034b50) {
    const crc = dv.getUint32(pos + 14, true), size = dv.getUint32(pos + 18, true), nl = dv.getUint16(pos + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(pos + 30, pos + 30 + nl)); const data = bytes.subarray(pos + 30 + nl, pos + 30 + nl + size);
    expect(crc32(data)).toBe(crc); if (name === 'xl/worksheets/sheet1.xml') sheet = new TextDecoder().decode(data); pos += 30 + nl + size;
  }
  return sheet;
};
const readBlob = (blob: Blob) => new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(blob); });

/** Captures downloads (names + blobs) and the print call without touching the network. */
function captureDownloads() {
  const blobs: Blob[] = []; const names: string[] = [];
  URL.createObjectURL = vi.fn((b: Blob | MediaSource) => { blobs.push(b as Blob); return 'blob:x'; }); URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
  const print = vi.fn(); vi.stubGlobal('print', print);
  return { blobs, names, print };
}
const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));

describe('periodStem', () => {
  it('uses the real period, never a hard-coded value', () => {
    expect(periodStem('2026-10-01', '2026-10-31', '2026-10-07')).toBe('2026-10');
    expect(periodStem('2026-01-01', '2026-12-31', '2026-10-07')).toBe('2026');
    expect(periodStem('2026-10-05', '2026-10-20', '2026-10-07')).toBe('2026-10-05-to-2026-10-20');
    expect(periodStem('2026-07-01', '2027-06-30', '2026-10-07')).toBe('2026-07-01-to-2027-06-30');
    expect(periodStem(null, null, '2026-10-07 12:00 UTC')).toBe('as-of-2026-10-07');
  });
});

describe('Wave 2 export documents', () => {
  const statusLabels = { unmatched: 'Unmatched', matched: 'Matched', reconciled: 'Reconciled' };
  it('bank reconciliation: counts, totals, filters, filename, numeric cells', () => {
    const d = bankReconciliationExport({ ...base, asOf: '2026-10-07', statusLabels, filters: [['Reconciliation status', 'Unmatched']], from: '2026-10-01', to: '2026-10-31', rows: [
      { transaction_date: '2026-10-02', description: 'Fee', bank_reference: null, amount: '-20.00', currency_code: 'SAR', reconciliation_status: 'unmatched' },
      { transaction_date: '2026-10-03', description: 'Receipt', bank_reference: 'R1', amount: '1150.50', currency_code: 'SAR', reconciliation_status: 'reconciled' }] });
    expect(d.fileStem).toBe('eqfal-bank-reconciliation-2026-10');
    const csv = toCsv(d.rows);
    expect(csv).toContain('Match status,Count,Amount'); expect(csv).toContain('Unmatched,1,-20.00'); expect(csv).toContain('Total,2,1130.50');
    expect(csv).toContain('Reconciliation status,Unmatched'); expect(csv).toContain('As of,2026-10-07'); expect(csv).toContain('Currency,SAR');
    expect(csv).toContain('Date,Description,Bank reference,Amount,Currency,Match status'); expect(csv).toContain('2026-10-03,Receipt,R1,1150.50,SAR,Reconciled');
    expect(readSheet(buildXlsx(d.sheetName, d.rows, false, d.layout))).toMatch(/<c r="D\d+" s="\d+"><v>1150\.50<\/v><\/c>/);
  });
  it('bank reconciliation: mixed currencies are not added together; no filters falls back to the as-of date', () => {
    const d = bankReconciliationExport({ ...base, asOf: '2026-10-07', statusLabels, filters: [], rows: [
      { transaction_date: '2026-10-02', description: 'a', bank_reference: null, amount: '1.00', currency_code: 'SAR', reconciliation_status: 'matched' },
      { transaction_date: '2026-10-02', description: 'b', bank_reference: null, amount: '2.00', currency_code: 'USD', reconciliation_status: 'matched' }] });
    expect(d.fileStem).toBe('eqfal-bank-reconciliation-as-of-2026-10-07');
    expect(toCsv(d.rows)).toContain('Total,2,\r\n'); expect(toCsv(d.rows)).toContain('Currency,"SAR, USD"');
    expect(toCsv(bankReconciliationExport({ ...base, asOf: '2026-10-07', statusLabels, filters: [], rows: [] }).rows)).toContain('No bank transactions');
  });
  it('monthly close: status, readiness, domain counts, total, hidden blockers', () => {
    const labels = { domain: 'Domain', status: 'Status', count: 'Count', needsAction: 'Needs action', clear: 'No blockers', total: 'Total', hidden: 'Hidden blockers', empty: 'Empty', title: 'Monthly close', fiscalYear: 'Fiscal year', period: 'Period', periodStatus: 'Period status', readiness: 'Readiness' };
    const d = monthlyCloseExport({ ...base, fiscalYear: 'FY 2026', periodStart: '2026-10-01', periodEnd: '2026-10-31', statusLabel: 'Open', readinessLabel: 'Not ready', hiddenBlockers: false, labels, domains: [{ label: 'Documents', count: 3 }, { label: 'Bank', count: 0 }] });
    expect(d.fileStem).toBe('eqfal-monthly-close-2026-10');
    const csv = toCsv(d.rows);
    expect(csv).toContain('Fiscal year,FY 2026'); expect(csv).toContain('Period,2026-10-01 — 2026-10-31'); expect(csv).toContain('Readiness,Not ready');
    expect(csv).toContain('Documents,Needs action,3'); expect(csv).toContain('Bank,No blockers,0'); expect(csv).toContain('Total,,3');
    expect(d.rows[d.layout.totalRows[0]!]![0]).toBe('Total');
    const hidden = toCsv(monthlyCloseExport({ ...base, fiscalYear: '—', periodStart: '2026-10-01', periodEnd: '2026-10-31', statusLabel: 'Open', readinessLabel: 'Not ready', hiddenBlockers: true, labels, domains: [] }).rows);
    expect(hidden).toContain('Hidden blockers'); expect(hidden).not.toContain('Total,,');
  });
  it('fixed assets: register columns, totals, as-of filename and empty state', () => {
    const row = (n: string, cost: string, acc: string, nbv: string) => ({ asset_number: n, name: `Asset ${n}`, category: 'Equipment', acquisition_date: '2026-01-05', placed_in_service_date: '2026-01-06', acquisition_cost: cost, accumulated: acc, net_book_value: nbv, status: 'active' });
    const d = fixedAssetsExport({ ...base, asOf: '2026-10-07', statusLabel: (s) => s.toUpperCase(), rows: [row('FA-1', '1000.00', '100.00', '900.00'), row('FA-2', '500.50', '0.00', '500.50')] });
    expect(d.fileStem).toBe('eqfal-fixed-assets-as-of-2026-10-07');
    const csv = toCsv(d.rows);
    expect(csv).toContain('Asset no.,Name,Category,Acquisition date,In-service date,Acquisition cost,Accumulated depreciation,Net book value,Status');
    expect(csv).toContain('Total,,,,,1500.50,100.00,1400.50,'); expect(csv).toContain('FA-1,Asset FA-1,Equipment,2026-01-05,2026-01-06,1000.00,100.00,900.00,ACTIVE');
    expect(fixedAssetsExport({ ...base, asOf: '2026-10-07', from: '2026-10-01', to: '2026-10-31', statusLabel: (s) => s, rows: [] }).fileStem).toBe('eqfal-fixed-assets-2026-10');
    expect(toCsv(fixedAssetsExport({ ...base, asOf: '2026-10-07', statusLabel: (s) => s, rows: [] }).rows)).toContain('No fixed assets');
  });
  it('accruals & prepayments: filters, scope, per-type subtotals and filename', () => {
    const row = (typeLabel: string, amount: string) => ({ typeLabel, description: 'Rent', reference: '', document: '', balanceAccount: '1500 — Prepaid', pnlAccount: '', start: '2026-09-01', end: '2026-11-30', amount, posted: 1, periods: 3, statusLabel: 'Approved' });
    const d = accrualsExport({ ...base, asOf: '2026-10-07', scopeRange: { from: '2026-10-01', to: '2026-10-31' }, scopeLabel: '2026-10-01 — 2026-10-31', filters: [['Filter by type', 'Prepaid expense']], pending: 2, postedEntries: 1, rows: [row('Prepaid expense', '900.00'), row('Prepaid expense', '100.25'), row('Accrued expense', '50.00')] });
    expect(d.fileStem).toBe('eqfal-accruals-prepayments-2026-10');
    const csv = toCsv(d.rows);
    expect(csv).toContain('Accounting period,2026-10-01 — 2026-10-31'); expect(csv).toContain('Filter by type,Prepaid expense'); expect(csv).toContain('Pending schedule entries,2');
    expect(csv).toContain('Prepaid expense,2,1000.25'); expect(csv).toContain('Accrued expense,1,50.00');
    expect(csv).toContain('Prepaid expense,Rent,—,—,1500 — Prepaid,—,2026-09-01,2026-11-30,900.00,1,3,Approved');
    expect(accrualsExport({ ...base, asOf: '2026-10-07', scopeRange: null, scopeLabel: 'All periods', filters: [], pending: 0, postedEntries: 0, rows: [] }).fileStem).toBe('eqfal-accruals-prepayments-all-periods');
  });
  it('management summary: snapshot values only, restricted/unavailable states, bank accounts and close block', () => {
    const d = managementSummaryExport({ ...base, periodLabel: 'October 2026', from: '2026-10-01', to: '2026-10-31', asOf: '2026-10-07', hiddenText: 'Restricted', unavailableText: 'Unavailable',
      metrics: [{ label: 'Receivables', scope: 'All open balances', state: 'available', amount: '1200.00' }, { label: 'Payables', scope: null, state: 'hidden' }, { label: 'Revenue', scope: 'October 2026', state: 'unavailable' }],
      bankAccounts: [{ name: 'Main', currency: 'SAR', amount: '10.00' }, { name: 'Old', currency: 'SAR', amount: null }], closeRows: [['Period status', 'Open'], ['Documents', { num: '2', int: true }]] });
    expect(d.fileStem).toBe('eqfal-management-summary-2026-10');
    const csv = toCsv(d.rows);
    expect(csv).toContain('Receivables,All open balances,1200.00'); expect(csv).toContain('Payables,,Restricted'); expect(csv).toContain('Revenue,October 2026,Unavailable');
    expect(csv).toContain('Main,SAR,10.00'); expect(csv).toContain('Old,SAR,Unavailable'); expect(csv).toContain('Documents,2'); expect(csv).not.toMatch(/net (profit|result)/i);
    const sheet = readSheet(buildXlsx(d.sheetName, d.rows, true, d.layout));
    expect(sheet).toMatch(/<v>1200\.00<\/v>/); expect(sheet).toContain('rightToLeft="1"');
  });
  it('Arabic documents use Arabic labels', () => {
    const d = fixedAssetsExport({ ...base, ar: true, asOf: '2026-10-07', statusLabel: (s) => s, rows: [] });
    expect(d.rtl).toBe(true); expect(toCsv(d.rows)).toContain('سجل الأصول الثابتة');
  });
});

describe('Wave 2 screens: export actions, filenames, print', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });

  it('bank reconciliation exports the filtered list and print neither refetches nor mutates the screen', async () => {
    window.history.replaceState(null, '', '/?page=banks&section=transactions&reconciliation=unmatched&from=2026-08-01&to=2026-08-31');
    const txs = [
      { id: 'a', transaction_date: '2026-08-01', description: 'Vendor payment', bank_reference: 'B1', amount: '-350.00', running_balance: null, currency_code: 'SAR', reconciliation_status: 'unmatched' },
      { id: 'b', transaction_date: '2026-08-20', description: 'Customer receipt', bank_reference: null, amount: '1150.00', running_balance: null, currency_code: 'SAR', reconciliation_status: 'matched' }];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ transactions: txs }))); vi.stubGlobal('fetch', fetchMock);
    const cap = captureDownloads();
    const { container } = plainRender(<MantineProvider><BankTransactionsView canView canMatch canReconcile onUnauthorized={vi.fn()} /></MantineProvider>);
    await screen.findByText('Vendor payment');
    const card = () => container.querySelector('.bank-recon__card')!.outerHTML + container.querySelector('.bank-recon__toolbar')!.outerHTML;
    const before = card();
    click('Export Excel'); click('Export CSV');
    expect(cap.names).toEqual(['eqfal-bank-reconciliation-2026-08.xlsx', 'eqfal-bank-reconciliation-2026-08.csv']);
    const csv = await readBlob(cap.blobs[1]!);
    expect(csv).toContain('Vendor payment'); expect(csv).not.toContain('Customer receipt'); expect(csv).toContain('Reconciliation status,Unmatched');
    click('Print / Save PDF');
    expect(cap.print).toHaveBeenCalledTimes(1); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(card()).toBe(before);
    expect(document.body.querySelector('.eqfal-print-doc')).not.toBeNull();
    window.dispatchEvent(new Event('afterprint'));
    await waitFor(() => expect(document.body.querySelector('.eqfal-print-doc')).toBeNull());
  });

  it('bank reconciliation export is disabled while there is nothing to export', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ transactions: [] }))));
    plainRender(<MantineProvider><BankTransactionsView canView canMatch canReconcile onUnauthorized={vi.fn()} /></MantineProvider>);
    await screen.findByText('No bank transactions');
    for (const name of ['Export Excel', 'Export CSV', 'Print / Save PDF']) expect(screen.getByRole('button', { name })).toBeDisabled();
  });

  it('monthly close exports the selected period only, in Arabic too', async () => {
    const period = { id: 'p1', fiscal_year_id: 'fy', period_start: '2026-10-01', period_end: '2026-10-31', status: 'open', ready: false, disclosed_total: 3, has_hidden_blockers: false, blockers: { documents: 3, obligations: 0, bank_transactions: 0, vat: 0, ledger: 0, assets: 0, opening_balances: 0, periodic_adjustments: 0 } };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/fiscal-years' ? { fiscalYears: [{ id: 'fy', name: 'FY 2026', start_date: '2026-01-01', end_date: '2026-12-31' }] } : { periods: [period] }))));
    const cap = captureDownloads();
    const views = { documents: true, obligations: true, bank: true, vat: true, accounting: true, assets: true, openingBalances: true, periodicAdjustments: true };
    render(<MonthlyClose viewCapabilities={views} canView canViewFiscalYears canCreate={false} canClose={false} canReopen={false} onUnauthorized={vi.fn()} />);
    await screen.findByRole('button', { name: 'Export CSV' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled());
    click('Export Excel'); click('Export CSV');
    expect(cap.names).toEqual(['eqfal-monthly-close-2026-10.xlsx', 'eqfal-monthly-close-2026-10.csv']);
    const csv = await readBlob(cap.blobs[1]!);
    expect(csv).toContain('FY 2026'); expect(csv).toContain('2026-10-01 — 2026-10-31'); expect(csv).toMatch(/,Needs action,3/);
    click('Print / Save PDF'); expect(cap.print).toHaveBeenCalledTimes(1);
  });

  it('fixed assets exports the register that is on screen', async () => {
    const asset = { id: 'a1', asset_category_id: 'c1', asset_number: 'FA-001', name: 'Laptop', description: null, source_type: 'manual_opening', source_document_id: null, source_reference: 'R', category_name_ar: 'أجهزة', category_name_en: 'Equipment', acquisition_cost: '1000.00', acquisition_date: '2026-01-05', placed_in_service_date: '2026-01-06', depreciation_start_date: null, residual_value: '0.00', opening_accumulated_depreciation: '100.00', posted_depreciation: '50.00', net_book_value: '850.00', useful_life_months: 36, status: 'active' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/assets' ? { assets: [asset] } : url === '/api/asset-categories' ? { categories: [] } : {}))));
    const cap = captureDownloads();
    plainRender(<FixedAssets canView canCreate={false} canEdit={false} canCancel={false} canManagePolicy={false} canApprove={false} canDispose={false} onUnauthorized={vi.fn()} />);
    await screen.findByText('FA-001');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled());
    click('Export CSV'); expect(cap.names[0]).toMatch(/^eqfal-fixed-assets-as-of-\d{4}-\d{2}-\d{2}\.csv$/);
    const csv = await readBlob(cap.blobs[0]!);
    expect(csv).toContain('FA-001,Laptop,Equipment,2026-01-05,2026-01-06,1000.00,150.00,850.00'); expect(csv).toContain('Total,,,,,1000.00,150.00,850.00');
  });

  it('accruals & prepayments exports the visible register', async () => {
    const adj = { id: 'a1', adjustment_type: 'prepaid_expense', total_amount: '900.00', recognition_start: '2026-09-01', recognition_end: '2026-11-30', document_id: null, obligation_id: null, document_name: null, description: 'Prepaid rent', reference: 'REF-1', notes: null, balance_account_id: 'b', pnl_account_id: 'p', workflow_status: 'approved', review_note: null, version: 1, schedule: [{ id: 's1', period_start: '2026-09-01', period_end: '2026-09-30', recognition_date: '2026-09-30', amount: '300.00', status: 'posted', journal_entry_id: 'j' }, { id: 's2', period_start: '2026-10-01', period_end: '2026-10-31', recognition_date: '2026-10-31', amount: '300.00', status: 'pending', journal_entry_id: null }] };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/periodic-adjustments' ? { adjustments: [adj] } : url === '/api/accounts' ? { accounts: [{ id: 'b', code: '1500', name: 'Prepaid', account_type: 'asset', is_active: true }] } : url === '/api/documents' ? { documents: [] } : { obligations: [] }))));
    const cap = captureDownloads();
    render(<PeriodicAdjustments canView canCreate={false} canEdit={false} canSubmit={false} canReview={false} canApprove={false} canPost={false} onUnauthorized={vi.fn()} />);
    await screen.findByText('Prepaid rent');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled());
    click('Export CSV'); expect(cap.names[0]).toMatch(/^eqfal-accruals-prepayments-.+\.csv$/);
    const csv = await readBlob(cap.blobs[0]!);
    expect(csv).toContain('Prepaid expense,Prepaid rent,REF-1,—,1500 — Prepaid'); expect(csv).toContain('900.00,1,2,Approved'); expect(csv).toContain('Prepaid expense,1,900.00');
  });

  it('management summary never sums different bank currencies into one exported amount', async () => {
    const snapshot = { metrics: { bank_balances: { state: 'available', accounts: [
      { id: 'k1', display_name: 'Main SAR', currency_code: 'SAR', balance: { state: 'available', amount: '500.00' } },
      { id: 'k2', display_name: 'Dollar', currency_code: 'USD', balance: { state: 'available', amount: '100.00' } }] }, amounts_to_collect: { state: 'hidden' }, amounts_to_pay: { state: 'hidden' }, current_month_sales: { state: 'hidden' }, current_month_purchases_expenses: { state: 'hidden' } } };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/manager-financial-snapshot')) return new Response(JSON.stringify(snapshot));
      if (url === '/api/auth/session') return new Response(JSON.stringify({ user: { id: 'u', email: 'u@x.test' }, allowedCompanies: [], activeCompanyId: null, capabilities: [] }));
      return new Response(JSON.stringify({ periods: [] }));
    }));
    const cap = captureDownloads();
    render(<AuthProvider><CompanyProvider allowedCompanies={[{ id: 'co-1', name: 'Company One' }]} initialCompanyId="co-1"><Home capabilities={['bank.view']} navigate={vi.fn()} navigateToDiscovery={vi.fn()} onUnauthorized={vi.fn()} /></CompanyProvider></AuthProvider>);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled());
    click('Export CSV');
    const csv = await readBlob(cap.blobs[0]!);
    expect(csv).toContain('Cash and Banks,,Unavailable – mixed currencies');
    expect(csv).not.toContain('600.00');
    expect(csv).toContain('Main SAR,SAR,500.00'); expect(csv).toContain('Dollar,USD,100.00');
  });

  it('management summary exports the snapshot values and stays disabled without a snapshot', async () => {
    const snapshot = { metrics: { bank_balances: { state: 'available', accounts: [{ id: 'k', display_name: 'Main', currency_code: 'SAR', balance: { state: 'available', amount: '500.00' } }] }, amounts_to_collect: { state: 'available', amount: '1200.00' }, amounts_to_pay: { state: 'hidden' }, current_month_sales: { state: 'available', amount: '3000.00' }, current_month_purchases_expenses: { state: 'available', amount: '1800.00' } } };
    let failSnapshot = true;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/manager-financial-snapshot')) return failSnapshot ? new Response('{}', { status: 500 }) : new Response(JSON.stringify(snapshot));
      if (url === '/api/auth/session') return new Response(JSON.stringify({ user: { id: 'u', email: 'u@x.test' }, allowedCompanies: [], activeCompanyId: null, capabilities: [] }));
      return new Response(JSON.stringify({ periods: [] }));
    }));
    const cap = captureDownloads();
    const mount = () => render(<AuthProvider><CompanyProvider allowedCompanies={[{ id: 'co-1', name: 'Company One' }]} initialCompanyId="co-1"><Home capabilities={['bank.view', 'obligation.view', 'document.view']} navigate={vi.fn()} navigateToDiscovery={vi.fn()} onUnauthorized={vi.fn()} /></CompanyProvider></AuthProvider>);
    const first = mount();
    await screen.findByRole('heading', { name: 'Financial overview' });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole('button', { name: 'Export Excel' })).toBeDisabled();
    first.unmount(); failSnapshot = false;
    mount();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export CSV' })).toBeEnabled());
    click('Export CSV');
    expect(cap.names[0]).toMatch(/^eqfal-management-summary-.+\.csv$/);
    const csv = await readBlob(cap.blobs[0]!);
    expect(csv).toContain('Company One'); expect(csv).toContain('Receivables,All open balances,1200.00'); expect(csv).toContain('Payables,All open balances,Restricted');
    expect(csv).toContain('Cash and Banks,SAR,500.00'); expect(csv).toContain('Main,SAR,500.00'); expect(csv).not.toContain('Net Profit');
  });
});
