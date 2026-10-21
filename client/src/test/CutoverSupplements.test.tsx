import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
});
