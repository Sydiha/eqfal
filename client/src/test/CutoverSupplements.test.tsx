import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { CutoverSupplements, toRequestLines } from '../components/CutoverSupplements';

const tx = (_a: string, e: string) => e;
const draft = { id: 'v-1', kind: 'cash_flow', version_no: 1, status: 'draft', row_version: 3, source_system: 'ERP', evidence_reference: 'Bank statements', fx_translation_evidence: null, functional_currency: 'SAR', approved_at: null, superseded_at: null, void_reason: null,
  lines: [{ line_type: 'cash_balance', account_id: 'a-bank', opening_amount: '10.00', closing_amount: '20.00', section: null, movement_type: null, label: null, amount: null, classification_override_reason: null }],
  evaluation: { valid: false, issues: [{ code: 'SUPPLEMENT_CASH_ROLLFORWARD_MISMATCH', detail: { difference: '-10.00' } }], totals: { opening: '10.00' } } };

beforeEach(async () => { await i18n.changeLanguage('en'); });

describe('CutoverSupplements', () => {
  it('builds strict request lines (only the keys each line type accepts)', () => {
    const blankLine = { account_id: '', section: '', movement_type: '', label: '', amount: '', opening_amount: '', closing_amount: '', classification_override_reason: '' };
    expect(toRequestLines([
      { ...blankLine, line_type: 'cash_flow', section: 'financing', label: ' Loan ', amount: '5.00', account_id: 'a-loan', classification_override_reason: '  Working capital facility ' },
      { ...blankLine, line_type: 'cash_flow', section: 'operating', label: 'Ops', amount: '1.00' },
      { ...blankLine, line_type: 'equity_opening', account_id: 'a-cap', opening_amount: '7.00', label: 'ignored' },
    ])).toEqual([
      { line_type: 'cash_flow', section: 'financing', label: 'Loan', amount: '5.00', account_id: 'a-loan', classification_override_reason: 'Working capital facility' },
      { line_type: 'cash_flow', section: 'operating', label: 'Ops', amount: '1.00' },
      { line_type: 'equity_opening', account_id: 'a-cap', opening_amount: '7.00' },
    ]);
  });

  it('shows the server differences and keeps Approve disabled while the draft does not reconcile; no write controls without capabilities', async () => {
    const call = vi.fn(async (url: string) => (url.endsWith('/supplements') ? { versions: [draft] } : { accounts: [] }));
    const view = render(<CutoverSupplements rangeId="r-1" call={call} tx={tx} canManage canApprove />);
    expect(await screen.findByText('Opening cash plus flows does not equal cash at the cutover date.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByText(/No version\. The full-year statements package stays blocked/)).toBeInTheDocument(); // equity: nothing yet
    view.unmount();
    render(<CutoverSupplements rangeId="r-1" call={call} tx={tx} canManage={false} canApprove={false} />);
    await waitFor(() => expect(screen.getByText('Bank statements', { exact: false })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Enter data' })).toBeNull();
  });

  it('approves a reconciled draft with its row version (stale-write protection)', async () => {
    const ok = { ...draft, evaluation: { valid: true, issues: [], totals: {} } };
    const call = vi.fn(async (url: string, _init?: RequestInit) => (url.endsWith('/supplements') ? { versions: [ok] } : {}));
    render(<CutoverSupplements rangeId="r-1" call={call} tx={tx} canManage={false} canApprove />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(call).toHaveBeenCalledWith('/api/ledger-source-authority/r-1/supplements/v-1/approve', expect.objectContaining({ method: 'POST', body: JSON.stringify({ confirm: true, expected_row_version: 3 }) })));
  });

  it('entry rows live in the roomy .sa-lines table with a labelled control in every cell (no wrong-field guessing)', async () => {
    const call = vi.fn(async (url: string) => (url.endsWith('/supplements') ? { versions: [] } : { accounts: [] }));
    render(<CutoverSupplements rangeId="r-1" call={call} tx={tx} canManage canApprove={false} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Enter data' }))[0]!);
    const form = await screen.findByRole('form');
    const table = form.querySelector('.sa-lines table')!;
    expect(table).not.toBeNull();
    const row = table.querySelector('tbody tr')!;
    const controls = [...row.querySelectorAll('select,input')];
    expect(controls.length).toBeGreaterThanOrEqual(4);
    for (const c of controls) expect(c.getAttribute('aria-label')).toBeTruthy();
    expect(table.querySelectorAll('thead th').length).toBe(row.querySelectorAll('td').length);
  });

  it('CSS: wide columns so labels are not clipped, strong select/option contrast, visible selected option and focus ring', () => {
    const css = readFileSync(resolve(__dirname, '../components/SourceAuthority.css'), 'utf8');
    expect(css).toMatch(/\.sa-lines table\{min-width:1180px/);
    expect(css).toMatch(/\.sa-lines :is\(th,td\):nth-child\(1\)\{min-width:190px\}/);
    expect(css).toMatch(/\.sa-lines :is\(th,td\):nth-child\(2\)\{min-width:180px\}/);
    expect(css).toMatch(/\.sa-lines select,\.source-authority \.sa-lines input:not\(\[type=checkbox\]\)\{height:40px/);
    expect(css).toMatch(/\.sa-lines option\{[^}]*background:#fff;color:#0f172a/);
    expect(css).toMatch(/\.sa-lines option:checked\{background:#c8f0e3;color:#064e3b;font-weight:700\}/);
    expect(css).toMatch(/\.sa-lines select:focus-visible,[^{]*\{outline:2px solid var\(--sa-primary\)/);
  });

  it('UI-13: remove-row action is in the last column, labelled, and pinned at the inline end by CSS (works in RTL)', async () => {
    const call = vi.fn(async (url: string) => (url.endsWith('/supplements') ? { versions: [] } : { accounts: [] }));
    render(<CutoverSupplements rangeId="r-1" call={call} tx={tx} canManage canApprove={false} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Enter data' }))[0]!);
    const form = await screen.findByRole('form');
    const cells = form.querySelectorAll('.sa-lines tbody tr:first-child td');
    expect(within(cells[cells.length - 1] as HTMLElement).getByRole('button', { name: 'Remove line' })).toBeTruthy();
    const css = readFileSync(resolve(__dirname, '../components/SourceAuthority.css'), 'utf8');
    expect(css).toMatch(/\.sa-lines :is\(th,td\):last-child\{position:sticky;inset-inline-end:0/);
    expect(css).toMatch(/\.sa-lines input\[inputmode=decimal\]\{min-width:124px;text-overflow:clip\}/);
  });
});
