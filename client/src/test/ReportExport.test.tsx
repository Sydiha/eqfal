import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ObligationsAging, type AgingReport } from '../components/ObligationsAging';
import { Accounting } from '../components/Accounting';
import { buildXlsx, crc32 } from '../export/xlsx-builder';
import { toCsv, slug } from '../export/downloadExport';
import { agingExport, generalLedgerExport, statementExport, trialBalanceExport } from '../export/reportExport';
import i18n from '../i18n';

const t = (k: string) => k;
const base = { ar: false, company: 'Acme Co', generatedAt: '2026-10-07 12:00 UTC', t };
const sum = (v: string[]) => (v.reduce((a, x) => a + Math.round(Number(x) * 100), 0) / 100).toFixed(2);

// Minimal reader for our own stored-ZIP output: returns file name -> text and checks CRCs.
function unzip(bytes: Uint8Array) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); const out: Record<string, string> = {}; let pos = 0;
  while (dv.getUint32(pos, true) === 0x04034b50) {
    const crc = dv.getUint32(pos + 14, true), size = dv.getUint32(pos + 18, true), nl = dv.getUint16(pos + 26, true);
    const name = new TextDecoder().decode(bytes.subarray(pos + 30, pos + 30 + nl)); const data = bytes.subarray(pos + 30 + nl, pos + 30 + nl + size);
    expect(crc32(data)).toBe(crc); out[name] = new TextDecoder().decode(data); pos += 30 + nl + size;
  }
  return out;
}

const trialRows = [
  { id: 'a', code: '1000', name: 'Bank', debit_movement: '0.00', credit_movement: '100.00', debit_balance: '0.00', credit_balance: '100.00' },
  { id: 'b', code: '2000', name: 'Payable, "net"', debit_movement: '100.00', credit_movement: '0.00', debit_balance: '100.00', credit_balance: '0.00' },
];

describe('xlsx/csv helpers', () => {
  it('writes a valid stored zip with escaped inline strings and verbatim numerics', () => {
    const files = unzip(buildXlsx('Trial', [['A & B <x>'], [{ num: '12.50' }, null, '']], true));
    expect(Object.keys(files)).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']);
    expect(files['xl/worksheets/sheet1.xml']).toContain('A &amp; B &lt;x&gt;');
    expect(files['xl/worksheets/sheet1.xml']).toContain('<c r="A2" s="5"><v>12.50</v></c>');
    expect(files['xl/worksheets/sheet1.xml']).toContain('rightToLeft="1"');
  });
  it('emits CSV with BOM, quoting and formula-injection guard', () => {
    expect(toCsv([['a,b', 'say "hi"'], ['=SUM(A1)', { num: '-5.00' }]])).toBe('﻿"a,b","say ""hi"""\r\n\'=SUM(A1),-5.00\r\n');
    expect(slug('FY 2026/27 ✓')).toBe('fy-2026-27');
  });
});

describe('xlsx formatting', () => {
  it('styles header/total rows, formats numbers, freezes the header and keeps cells numeric', () => {
    const d = trialBalanceExport({ ...base, accountName: (r) => r.name, sum, yearName: '2026', rows: trialRows });
    const sheet = unzip(buildXlsx(d.sheetName, d.rows, true, d.layout, 'EQFAL'))['xl/worksheets/sheet1.xml']!;
    expect(sheet).toContain('<pane ySplit="8" topLeftCell="A9" activePane="bottomLeft" state="frozen"/>'); // brand + title + 4 meta + blank + header
    expect(sheet).toContain('rightToLeft="1"');
    expect(sheet).toContain('<c r="A8" s="4"'); // styled header row
    expect(sheet).toContain('<c r="B9" s="5"><v>0.00</v></c>'); // numeric cell, #,##0.00 style, no inlineStr
    expect(sheet).toMatch(/<c r="B11" s="9"><v>100\.00<\/v><\/c>/); // totals row: bold numeric style
    expect(unzip(buildXlsx('x', [], false))['xl/styles.xml']).toContain('numFmtId="4"');
  });
  it('layout marks header and totals rows for every report type', () => {
    const d = trialBalanceExport({ ...base, accountName: (r) => r.name, sum, yearName: '2026', rows: trialRows });
    expect(d.rows[d.layout.headerRows[0]!]![0]).toBe('accounting.account');
    expect(d.rows[d.layout.totalRows[0]!]![0]).toBe('accounting.statements.total');
    const ag = agingExport({ ...base, labels: { title: 'Aging', asOf: 'As of', receivables: 'AR', payables: 'AP', total: 'Total', counterparty: 'P', dueOn: 'D', daysOverdue: 'N', outstanding: 'O', bucket: 'B', noDue: '-', empty: 'E', buckets: { current: 'C' } }, side: 'receivables', asOf: '2026-10-07', data: { buckets: [{ bucket: 'current', amount: '1.00', count: 1 }], total_outstanding: '1.00', item_count: 1, items: [{ obligation_id: 'o', counterparty_name: 'A', due_on: null, days_overdue: 0, bucket: 'current', outstanding_amount: '1.00' }] } });
    expect(ag.layout.totalRows.map((i) => ag.rows[i]![0])).toEqual(['Total', 'Total']);
    expect(ag.layout.headerRows).toHaveLength(2);
  });
});

describe('report export documents', () => {
  it('trial balance: filename, context, rows and totals', () => {
    const d = trialBalanceExport({ ...base, accountName: (r) => r.name, sum, yearName: '2026', rows: trialRows });
    expect(d.fileStem).toBe('eqfal-trial-balance-2026');
    const csv = toCsv(d.rows);
    expect(csv).toContain('Acme Co'); expect(csv).toContain('accounting.fiscalYear,2026'); expect(csv).toContain('SAR'); expect(csv).toContain('2026-10-07 12:00 UTC');
    expect(csv).toContain('1000 — Bank,0.00,100.00,0.00,100.00');
    expect(csv).toContain('accounting.statements.total,100.00,100.00,100.00,100.00');
    expect(csv).toContain('accounting.balanced');
    expect(unzip(buildXlsx(d.sheetName, d.rows, false))['xl/worksheets/sheet1.xml']).toContain('Payable, &quot;net&quot;');
  });
  it('trial balance and ledger empty state export a message instead of totals', () => {
    expect(toCsv(trialBalanceExport({ ...base, accountName: (r) => r.name, sum, yearName: '2026', rows: [] }).rows)).toContain('accounting.trialEmpty');
    const l = generalLedgerExport({ ...base, sum, yearName: '2026', accountLabel: '1000 — Bank', accountCode: '1000', rows: [] });
    expect(l.fileStem).toBe('eqfal-general-ledger-1000-2026'); expect(toCsv(l.rows)).toContain('accounting.ledgerEmpty');
  });
  it('general ledger totals and closing balance', () => {
    const l = generalLedgerExport({ ...base, sum, yearName: '2026', accountLabel: '1000 — Bank', accountCode: '1000', rows: [
      { accounting_date: '2026-02-01', journal_id: 'abcdefghij', reference: null, description: 'x', debit: '50.00', credit: '0.00', running_balance: '50.00' },
      { accounting_date: '2026-02-02', journal_id: 'j2', reference: 'R2', description: 'y', debit: '0.00', credit: '20.00', running_balance: '30.00' }] });
    expect(toCsv(l.rows)).toContain('accounting.ledgerTotals,,,50.00,20.00,30.00');
    expect(toCsv(l.rows)).toContain('abcdefgh');
  });
  it('statements carry period / as-of context and totals, keeping zero rows', () => {
    const sections = [{ category: 'revenue', total: '10.00', accounts: [{ account_id: '1', code: '4000', name: 'Sales', amount: '10.00' }, { account_id: '2', code: '4100', name: 'Other', amount: '0.00' }] }];
    const pl = statementExport({ ...base, kind: 'profitOrLoss', accountName: (a) => a.name, yearName: '2026', startDate: '2026-01-01', endDate: '2026-12-31', data: { statement: 'profit_or_loss', sections, profit_or_loss: '10.00' } });
    expect(pl.fileStem).toBe('eqfal-profit-or-loss-2026-01-01-to-2026-12-31');
    const csv = toCsv(pl.rows); expect(csv).toContain('accounting.discovery.from,2026-01-01'); expect(csv).toContain('4100 — Other,0.00'); expect(csv).toContain('accounting.statements.profitOrLoss,10.00');
    const fp = statementExport({ ...base, kind: 'financialPosition', accountName: (a) => a.name, yearName: '2026', asOfDate: '2026-12-31', data: { statement: 'financial_position', sections, current_period_earnings: '10.00', accounting_equation: { balanced: true } } });
    expect(fp.fileStem).toBe('eqfal-financial-position-as-of-2026-12-31'); expect(toCsv(fp.rows)).toContain('accounting.statements.asOf,2026-12-31');
    const eq = statementExport({ ...base, kind: 'changesInEquity', accountName: (a) => a.name, yearName: '2026', startDate: '2026-01-01', endDate: '2026-12-31', data: { statement: 'changes_in_equity', opening_equity: '5.00', direct_equity_movements: '0.00', current_period_earnings: '10.00', closing_equity: '15.00', equity_accounts: [], reconciliation: { expected: '15.00', actual: '15.00', difference: '0.00', balanced: true } } });
    expect(toCsv(eq.rows)).toContain('accounting.statements.closingEquity,15.00');
    const cf = statementExport({ ...base, kind: 'cashFlow', accountName: (a) => a.name, yearName: '2026', startDate: '2026-01-01', endDate: '2026-12-31', data: { statement: 'cash_flow', opening_cash_and_cash_equivalents: '1.00', net_change_in_cash_and_cash_equivalents: '2.00', closing_cash_and_cash_equivalents: '3.00' } });
    expect(cf.fileStem).toBe('eqfal-cash-flow-2026-01-01-to-2026-12-31'); expect(toCsv(cf.rows)).toContain('accounting.statements.closingCash,3.00');
  });
});

const side = (names: string[], total: string): AgingReport['receivables'] => ({ buckets: [{ bucket: 'current', amount: total, count: names.length }], total_outstanding: total, item_count: names.length, items: names.map((n, i) => ({ obligation_id: `${n}-${i}`, counterparty_name: n, source_type: 'manual', recognized_on: '2026-01-01', due_on: null, original_amount: '1.00', settled_amount: '0.00', outstanding_amount: '1.00', days_overdue: 0, bucket: 'current' as const })) as AgingReport['receivables']['items'] });
const report: AgingReport = { as_of_date: '2026-10-07', receivables: side(['Customer A'], '1.00'), payables: side(['Supplier Z'], '1.00') };

describe('aging export + buttons', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });
  const labels = { title: 'Aging', asOf: 'As of', receivables: 'AR', payables: 'AP', total: 'Total', counterparty: 'Party', dueOn: 'Due', daysOverdue: 'Days', outstanding: 'Outstanding', bucket: 'Bucket', noDue: 'None', empty: 'Empty', buckets: { current: 'Current' } };
  it('AR export contains AR only, AP export AP only, with as-of date and filenames', () => {
    const ar = agingExport({ ...base, labels, side: 'receivables', asOf: report.as_of_date, data: report.receivables });
    const ap = agingExport({ ...base, labels, side: 'payables', asOf: report.as_of_date, data: report.payables });
    expect(ar.fileStem).toBe('eqfal-ar-aging-2026-10-07'); expect(ap.fileStem).toBe('eqfal-ap-aging-2026-10-07');
    expect(toCsv(ar.rows)).toContain('Customer A'); expect(toCsv(ar.rows)).not.toContain('Supplier Z');
    expect(toCsv(ap.rows)).toContain('Supplier Z'); expect(toCsv(ap.rows)).not.toContain('Customer A');
    expect(toCsv(ar.rows)).toContain('As of,2026-10-07'); expect(toCsv(ar.rows)).toContain('Total,,,,,1.00');
  });
  it('empty side exports the empty message', () => {
    expect(toCsv(agingExport({ ...base, labels, side: 'payables', asOf: '2026-10-07', data: side([], '0.00') }).rows)).toContain('Empty');
  });
  it('downloads XLSX/CSV with deterministic names and print does not refetch or change state', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(report))); vi.stubGlobal('fetch', fetchMock);
    const blobs: Blob[] = []; const names: string[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => { blobs.push(b); return 'blob:x'; }); URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    const print = vi.fn(); vi.stubGlobal('print', print);
    render(<ObligationsAging onUnauthorized={vi.fn()} />);
    await screen.findByText('Customer A');
    const before = document.querySelector('.ob-aging')!.innerHTML;
    fireEvent.click(screen.getByRole('button', { name: 'Export Excel' })); fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(names).toEqual(['eqfal-ar-aging-2026-10-07.xlsx', 'eqfal-ar-aging-2026-10-07.csv']);
    expect(blobs[0]!.type).toContain('spreadsheetml');
    fireEvent.click(screen.getByRole('button', { name: 'Print / Save PDF' }));
    expect(print).toHaveBeenCalledTimes(1); expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(document.querySelector('.ob-aging')!.innerHTML).toBe(before);
    fireEvent.click(screen.getByRole('tab', { name: /Payables/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Export CSV' }));
    expect(names[2]).toBe('eqfal-ap-aging-2026-10-07.csv');
  });
});

describe('print document', () => {
  it('renders a print-only report table with title, company, period and totals, and removes it on unmount', async () => {
    const { ExportButtons } = await import('../components/ExportButtons');
    const d = trialBalanceExport({ ...base, accountName: (r) => r.name, sum, yearName: '2026', rows: trialRows });
    const print = vi.fn(); vi.stubGlobal('print', print);
    const { unmount } = render(<ExportButtons language="en" document={d} landscape />);
    expect(document.body.querySelector('.eqfal-print-doc')).toBeNull(); // not in the DOM until printing
    fireEvent.click(screen.getByRole('button', { name: 'Print / Save PDF' }));
    expect(print).toHaveBeenCalledTimes(1);
    expect(document.head.textContent).toContain('size:A4 landscape');
    const doc = document.body.querySelector('.eqfal-print-doc')!;
    expect(doc.parentElement).toBe(document.body);
    expect(doc.querySelector('h1')).toHaveTextContent('accounting.tabs.trial');
    expect(doc).toHaveTextContent('Acme Co'); expect(doc).toHaveTextContent('2026'); expect(doc).toHaveTextContent('SAR');
    expect(doc.querySelectorAll('thead th')).toHaveLength(5);
    expect(doc.querySelector('tr.t')).toHaveTextContent('100.00');
    window.dispatchEvent(new Event('afterprint')); // browser finished: print document and @page rule are removed
    await waitFor(() => expect(document.body.querySelector('.eqfal-print-doc')).toBeNull());
    expect(document.head.textContent).not.toContain('size:A4');
    unmount();
  });
});

describe('Accounting trial balance export buttons', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); window.history.replaceState(null, '', '/?page=accounting&tab=trial'); });
  it('stay disabled until a report with data is loaded, then enable', async () => {
    const year = { id: 'y1', name: '2026', start_date: '2026-01-01', end_date: '2026-12-31' };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.startsWith('/api/trial-balance')) return new Response(JSON.stringify({ accounts: trialRows }));
      if (url === '/api/fiscal-years') return new Response(JSON.stringify({ fiscalYears: [year] }));
      if (url === '/api/accounts') return new Response(JSON.stringify({ accounts: [] }));
      if (url === '/api/journals') return new Response(JSON.stringify({ journals: [] }));
      return new Response(JSON.stringify({ sources: [] }));
    }));
    render(<Accounting canView canCreateChart={false} canEditChart={false} canCreateJournal={false} canEditJournal={false} canPost={false} onUnauthorized={vi.fn()} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Trial Balance' }));
    const excel = await screen.findByRole('button', { name: 'Export Excel' });
    expect(excel).toBeDisabled(); expect(screen.getByRole('button', { name: 'Print / Save PDF' })).toBeDisabled();
    fireEvent.click(await screen.findByRole('button', { name: 'Run report' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Export Excel' })).toBeEnabled());
  });
});
