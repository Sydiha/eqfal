import { fireEvent, screen, waitFor, within } from './test-utils';
import { render } from './test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { AnnualClosing } from '../components/AnnualClosing';
import { toCsv } from '../export/downloadExport';

const dom = (count: number) => ({ ready: count === 0, blocker_count: count, status: count ? 'blocked' : 'ready', summary: {} });
const domains = { monthly_close: dom(10), ledger: dom(8), documents: dom(7), assets: dom(4), adjustments: dom(0), opening_balances: dom(0), banking: dom(2) };
const result = {
  fiscal_year: { id: 'fy-1', name: 'FY 2025', start_date: '2025-01-01', end_date: '2025-12-31' }, ready: false, blocker_count: 31,
  financial_statements_readiness: { status: 'needs_review', label: 'Ready for financial statement preparation', label_ar: 'جاهز لإعداد القوائم المالية' }, zakat_readiness: { status: 'ready' }, domains,
  package_manifest: [{ section: 'trial_balance', status: 'blocked', blocker_count: 8 }, { section: 'general_ledger', status: 'blocked', blocker_count: 8 }, { section: 'financial_statements_readiness', status: 'blocked', blocker_count: 29 }, { section: 'bank_reconciliation', status: 'blocked', blocker_count: 2 }, { section: 'fixed_assets_depreciation', status: 'blocked', blocker_count: 4 }],
};
const mockApi = () => {
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/fiscal-years' ? { fiscalYears: [result.fiscal_year] } : url.endsWith('/package') ? { package: null, live: null, drift: false } : result)));
  vi.stubGlobal('fetch', fetchMock); return fetchMock;
};
const readBlob = (blob: Blob) => new Promise<string>((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.readAsText(blob); });

describe('Annual Closing export and table consistency', () => {
  beforeEach(async () => { vi.restoreAllMocks(); await i18n.changeLanguage('en'); });

  it('exports exactly the visible counts, with fiscal-year context and a deterministic filename', async () => {
    const fetchMock = mockApi(); const blobs: Blob[] = []; const names: string[] = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => { blobs.push(b as Blob); return 'blob:x'; }); URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    const print = vi.fn(); vi.stubGlobal('print', print);
    const { container } = render(<AnnualClosing canView onUnauthorized={vi.fn()} />);
    await screen.findByText('Not ready');
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Export CSV' })[0]).toBeEnabled());
    const calls = fetchMock.mock.calls.length; const before = container.querySelector('#ac-panel-readiness')!.innerHTML;
    fireEvent.click(screen.getAllByRole('button', { name: 'Export CSV' })[0]!); fireEvent.click(screen.getAllByRole('button', { name: 'Export Excel' })[0]!);
    expect(names).toEqual(['eqfal-annual-closing-fy-2025.csv', 'eqfal-annual-closing-fy-2025.xlsx']);
    const csv = await readBlob(blobs[0]!);
    expect(csv).toContain('Fiscal year,FY 2025'); expect(csv).toContain('2025-01-01 — 2025-12-31');
    // every visible domain count is exported unchanged, and the total is the visible total
    for (const [name, count] of [['Monthly close', 10], ['Ledger', 8], ['Document exceptions', 7], ['Fixed assets depreciation', 4], ['Bank reconciliation', 2]] as const) expect(csv).toContain(`${name},`), expect(csv).toMatch(new RegExp(`${name},[A-Za-z ]+,${count}\\r?\\n`));
    expect(csv).toContain('Total,,31');
    // the rollup row exports what the screen shows (blocked domains), the shared Ledger count is repeated, not added
    expect(csv).toContain('Financial statements readiness,Blocked,4 blocked domains');
    expect(csv).toMatch(/Trial balance,Blocked,8\r?\n/); expect(csv).toMatch(/General ledger,Blocked,8\r?\n/);
    fireEvent.click(screen.getAllByRole('button', { name: 'Print / Save PDF' })[0]!);
    expect(print).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls.length).toBe(calls);
    expect(container.querySelector('#ac-panel-readiness')!.innerHTML).toBe(before);
  });

  it('uses the same name for the same concept in both tables and explains how they relate', async () => {
    mockApi();
    render(<AnnualClosing canView onUnauthorized={vi.fn()} />);
    await screen.findByText('Not ready');
    const tables = screen.getAllByRole('table');
    const domainTable = within(tables[0]!), manifestTable = within(tables[1]!);
    for (const shared of ['Bank reconciliation', 'Fixed assets depreciation']) { expect(domainTable.getByText(shared)).toBeInTheDocument(); expect(manifestTable.getByText(shared)).toBeInTheDocument(); }
    expect(domainTable.queryByText('Fixed assets')).not.toBeInTheDocument();
    expect(screen.getByText(/Source readiness checks/)).toBeInTheDocument();
    expect(screen.getByText(/Trial balance and General ledger both read the Ledger check/)).toBeInTheDocument();
    // rollup relationship: the rollup's domain count equals the number of the six financial checks that have blockers
    const rollup = manifestTable.getByText('Financial statements readiness').closest('tr')!;
    const blockedOfSix = ['monthly_close', 'ledger', 'documents', 'assets', 'adjustments', 'opening_balances'].filter((k) => (domains as Record<string, { blocker_count: number }>)[k]!.blocker_count > 0).length;
    expect(within(rollup).getByText(`${blockedOfSix} blocked domains`)).toBeInTheDocument();
  });

  it('Arabic export is RTL with the shared labels', async () => {
    await i18n.changeLanguage('ar'); mockApi(); const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => { blobs.push(b as Blob); return 'blob:x'; }); URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    render(<AnnualClosing canView onUnauthorized={vi.fn()} />);
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'تصدير CSV' })[0]).toBeEnabled());
    fireEvent.click(screen.getAllByRole('button', { name: 'تصدير CSV' })[0]!);
    const csv = await readBlob(blobs[0]!);
    expect(csv).toContain('التسوية البنكية,'); expect(csv).toContain('إهلاك الأصول الثابتة,'); expect(csv).toContain('4 مجالات متعثرة');
    expect(toCsv([['x']])).toContain('x');
  });

  it('package export: enabled with a package, deterministic name, shown manifest rows, print is side-effect free', async () => {
    const live = [
      { section: 'trial_balance', status: 'blocked', blocker_count: 1, blockers: ['trial_balance_not_ready'], source: 'accounting', summary: {} },
      { section: 'vat_periods_returns', status: 'ready', blocker_count: 0, blockers: [], source: 'vat', summary: {} }];
    const pkg = { id: 'p', status: 'draft', version: 1, final_snapshot_id: null, finalized_at: null, handed_off_at: null, handoff_note: null, handoff_reference: null, reviewed_by_user_id: null, reviewed_at: null, review_note: null, approved_by_user_id: null, approved_at: null, approval_note: null, snapshots: [] };
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/fiscal-years' ? { fiscalYears: [result.fiscal_year] } : url.endsWith('/package') ? { package: pkg, live: { manifest: live, source_fingerprint: 'x' }, drift: false } : result)));
    vi.stubGlobal('fetch', fetchMock);
    const blobs: Blob[] = []; const names: string[] = [];
    URL.createObjectURL = vi.fn((b: Blob | MediaSource) => { blobs.push(b as Blob); return 'blob:x'; }); URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    const print = vi.fn(); vi.stubGlobal('print', print);
    const { container } = render(<AnnualClosing canView canViewPackage onUnauthorized={vi.fn()} />);
    fireEvent.click(await screen.findByRole('tab', { name: /closing package/i }));
    const panel = container.querySelector('#ac-panel-package') as HTMLElement;
    await within(panel).findByText('Trial balance');
    const buttons = () => ['Export Excel', 'Export CSV', 'Print / Save PDF'].map((name) => within(panel).getByRole('button', { name }));
    await waitFor(() => buttons().forEach((b) => expect(b).toBeEnabled()));
    const calls = fetchMock.mock.calls.length; const before = panel.innerHTML;
    fireEvent.click(buttons()[1]!); fireEvent.click(buttons()[0]!);
    expect(names).toEqual(['eqfal-annual-closing-package-fy-2025.csv', 'eqfal-annual-closing-package-fy-2025.xlsx']);
    const csv = await readBlob(blobs[0]!);
    expect(csv).toContain('Fiscal year,FY 2025'); expect(csv).toContain('Package state,Draft');
    expect(csv).toContain('Section,State,Source,Blockers');
    expect(csv).toContain('Trial balance,Blocked,accounting,Trial balance is not ready');
    expect(csv).toContain('VAT periods/returns,Ready,vat,—');
    // every manifest row visible in the table is exported
    const shown = within(panel).getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    expect(shown).toEqual(['Trial balance', 'VAT periods/returns']);
    for (const name of shown) expect(csv).toContain(`${name},`);
    expect(blobs[1]!.type).toContain('spreadsheetml'); expect(blobs[1]!.size).toBeGreaterThan(500);
    fireEvent.click(buttons()[2]!);
    expect(print).toHaveBeenCalledTimes(1); expect(fetchMock.mock.calls.length).toBe(calls);
    expect(panel.innerHTML).toBe(before);
  });
});
