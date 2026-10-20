import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CutoverActivation, CutoverAccount } from '../components/CutoverActivation';

const acc = (id: string, code: string, extra: Partial<CutoverAccount> = {}): CutoverAccount => ({ id, code, name: `N${code}`, name_ar: `ع${code}`, name_en: `E${code}`, is_active: true, account_type: 'asset', ...extra });
const accounts = [acc('a1', '1000'), acc('a2', '2000', { account_type: 'liability' }), acc('a3', '3000', { account_type: 'equity' })];
const range = { id: 'r-1', from_date: '2026-01-01', to_date: '2026-06-30' };
const line = (row: number, code: string, debit: string, credit: string, account_id: string | null, status = 'ok') => ({ row, code, name: null, debit, credit, account_id, status });
const parsed = (lines: unknown[], balanced = true, errors: unknown[] = []) => ({ status: 'parsed', mapping: { header_row: 1, code: 0, debit: 1, credit: 2 }, lines, total_debit: '100.00', total_credit: balanced ? '100.00' : '90.00', balanced, errors, warnings: [], functional_currency: 'SAR', cutover_date: range.to_date });

function setup(response: unknown) {
  const calls: string[] = [];
  const call = vi.fn(async (url: string) => { calls.push(url); return response as Record<string, unknown>; });
  const view = render(<CutoverActivation range={range} accounts={accounts} accountsFailed={false} call={call} tx={(_a, e) => e} ar={false} onDone={vi.fn()} onCancel={vi.fn()} />);
  const upload = () => fireEvent.change(screen.getByLabelText('Trial balance file'), { target: { files: [new File(['x'], 'tb.csv', { type: 'text/csv' })] } });
  return { calls, call, upload, view };
}
const textarea = () => document.querySelector('textarea') as HTMLTextAreaElement;
beforeEach(() => vi.restoreAllMocks());

describe('CutoverFileImport', () => {
  it('fills the existing form field only and never calls preview or activate', async () => {
    const { calls, upload } = setup(parsed([line(2, '1000', '100.00', '0.00', 'a1'), line(3, '2000', '0.00', '100.00', 'a2')]));
    upload();
    fireEvent.click(await screen.findByText('Use these lines in the form'));
    expect(textarea().value).toBe('1000, 100.00, 0.00\n2000, 0.00, 100.00');
    expect(calls).toEqual(['/api/ledger-source-authority/r-1/cutover/parse-file']);
  });
  it('requires a manual choice for unmatched codes, then fills with the chosen account code', async () => {
    const { upload } = setup(parsed([line(2, '9999', '100.00', '0.00', null, 'unmatched'), line(3, '2000', '0.00', '100.00', 'a2')], true, [{ code: 'TB_ACCOUNT_UNMATCHED', row: 2 }]));
    upload();
    const btn = await screen.findByText('Use these lines in the form');
    expect(btn).toBeDisabled();
    expect(screen.queryByText('Code not found in the chart of accounts.')).not.toBeNull();
    fireEvent.change(screen.getByLabelText('Choose an account for row 2'), { target: { value: 'a1' } });
    expect(screen.queryByText('Code not found in the chart of accounts.')).toBeNull();
    expect(screen.getByText('Manually mapped')).toBeTruthy();
    expect(btn).not.toBeDisabled();
    fireEvent.change(screen.getByLabelText('Choose an account for row 2'), { target: { value: '' } });
    expect(screen.queryByText('Code not found in the chart of accounts.')).not.toBeNull();
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Choose an account for row 2'), { target: { value: 'a1' } });
    fireEvent.click(btn);
    expect(textarea().value).toBe('1000, 100.00, 0.00\n2000, 0.00, 100.00');
  });
  it('blocks duplicate mapping, unbalanced files and ambiguous/duplicate rows', async () => {
    const dupMap = setup(parsed([line(2, '9999', '100.00', '0.00', null, 'unmatched'), line(3, '1000', '0.00', '100.00', 'a1')], true, [{ code: 'TB_ACCOUNT_UNMATCHED', row: 2 }]));
    dupMap.upload(); const b1 = await screen.findByText('Use these lines in the form');
    fireEvent.change(screen.getByLabelText('Choose an account for row 2'), { target: { value: 'a1' } });
    expect(b1).toBeDisabled(); expect(screen.getAllByText(/used more than once/).length).toBe(2);
    dupMap.view.unmount();
    const unb = setup(parsed([line(2, '1000', '100.00', '0.00', 'a1'), line(3, '2000', '0.00', '90.00', 'a2')], false, [{ code: 'TB_UNBALANCED' }]));
    unb.upload(); expect(await screen.findByText('Use these lines in the form')).toBeDisabled(); expect(screen.getByRole('alert')).toHaveTextContent('not balanced');
    unb.view.unmount();
    const amb = setup(parsed([line(2, '1000', '100.00', '0.00', null, 'ambiguous'), line(3, '2000', '0.00', '100.00', 'a2')], true, [{ code: 'TB_ACCOUNT_AMBIGUOUS', row: 2 }]));
    amb.upload(); expect(await screen.findByText('Use these lines in the form')).toBeDisabled();
  });
  it('offers explicit column mapping when detection is ambiguous', async () => {
    const { upload, call } = setup({ status: 'needs_mapping', headers: ['Ref', 'X', 'Y'], header_row: 1, issues: [{ code: 'TB_COLUMNS_AMBIGUOUS' }] });
    upload(); expect(await screen.findByText(/ambiguous or conflicting/)).toBeInTheDocument();
    const apply = screen.getByText('Apply columns'); expect(apply).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Account code'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('Debit'), { target: { value: '1' } });
    fireEvent.change(screen.getByLabelText('Credit'), { target: { value: '2' } });
    fireEvent.click(apply);
    await waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect((call.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toHaveProperty('x-tb-mapping');
  });
  it('shows a safe error when the server rejects the file, and renders Arabic', async () => {
    const call = vi.fn(async () => { throw Object.assign(new Error('x'), { code: 'TB_FILE_INVALID' }); });
    render(<CutoverActivation range={range} accounts={accounts} accountsFailed={false} call={call} tx={(a) => a} ar onDone={vi.fn()} onCancel={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('ملف ميزان المراجعة'), { target: { files: [new File(['x'], 'tb.xlsx')] } });
    expect(await screen.findByRole('alert')).toHaveTextContent('الملف غير صالح');
    expect(textarea().value).toBe('');
  });
});
