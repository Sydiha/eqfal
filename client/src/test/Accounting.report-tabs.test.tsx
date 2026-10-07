import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Accounting } from '../components/Accounting';
import i18n from '../i18n';

const year = { id: '33333333-3333-4333-8333-333333333333', name: '2026', start_date: '2026-01-01', end_date: '2026-12-31' };
const accounts = [
  { id: '11111111-1111-4111-8111-111111111111', code: '1000', name: 'Bank', account_type: 'asset' as const, parent_account_id: null, is_active: true },
  { id: '44444444-4444-4444-8444-444444444444', code: '2000', name: 'Payable', account_type: 'liability' as const, parent_account_id: null, is_active: true },
];
const journal = { id: '22222222-2222-4222-8222-222222222222', fiscal_year_id: year.id, accounting_date: '2026-09-10', description: 'Posted rent', reference: null, entry_type: 'standard' as const, status: 'posted' as const };
const lines = [
  { id: 'l1', company_id: 'c', journal_entry_id: journal.id, account_id: accounts[0]!.id, debit: '0.00', credit: '75.00', memo: null, sequence: 1 },
  { id: 'l2', company_id: 'c', journal_entry_id: journal.id, account_id: accounts[1]!.id, debit: '75.00', credit: '0.00', memo: null, sequence: 2 },
];
const trial = [
  { ...accounts[0], debit_movement: '0.00', credit_movement: '100.00', debit_balance: '0.00', credit_balance: '100.00' },
  { ...accounts[1], debit_movement: '40.00', credit_movement: '0.00', debit_balance: '40.00', credit_balance: '0.00' },
];

const stub = (overrides: { trial?: unknown[]; ledger?: unknown[] } = {}) => {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.startsWith('/api/general-ledger')) return new Response(JSON.stringify({ activity: overrides.ledger ?? [] }));
    if (url === '/api/accounts') return new Response(JSON.stringify({ accounts }));
    if (url === '/api/fiscal-years') return new Response(JSON.stringify({ fiscalYears: [year] }));
    if (url === '/api/journals') return new Response(JSON.stringify({ journals: [journal] }));
    if (url === `/api/journals/${journal.id}`) return new Response(JSON.stringify({ ...journal, lines }));
    if (url.startsWith('/api/trial-balance')) return new Response(JSON.stringify({ accounts: overrides.trial ?? trial }));
    return new Response(JSON.stringify({ sources: [] }));
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
};
const ui = () => <Accounting canView canCreateChart={false} canEditChart={false} canCreateJournal canEditJournal canPost onUnauthorized={vi.fn()} />;

describe('Accounting report and journal tabs (Figma 246:*)', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); window.history.replaceState(null, '', '/?page=accounting'); });

  it('lists journals in the register and opens a read-only posted journal with its totals', async () => {
    stub();
    render(ui());
    fireEvent.click(await screen.findByRole('tab', { name: 'Journals' }));
    const register = (await screen.findByRole('heading', { name: 'Journal register' })).closest('section')!;
    expect(within(register).getByRole('status')).toHaveTextContent('1 journals');
    fireEvent.click(within(register).getByRole('button', { name: /Posted rent/ }));
    const editor = (await screen.findByRole('heading', { name: 'Selected journal' })).closest('section')!;
    expect(within(editor).getByText('Posted rent', { selector: 'h3' })).toBeInTheDocument();
    for (const amount of within(editor).getAllByRole('spinbutton')) expect(amount).toBeDisabled();
    expect(within(editor).getByText('Total debit').nextSibling).toHaveTextContent('75.00');
    expect(within(editor).getByText('Total credit').nextSibling).toHaveTextContent('75.00');
    expect(within(editor).getByText('Balanced')).toBeInTheDocument();
    expect(within(editor).queryByRole('button', { name: 'Post journal' })).not.toBeInTheDocument();
  });

  it('runs the trial balance with a labelled fiscal year and shows the balance side', async () => {
    const fetchMock = stub();
    render(ui());
    fireEvent.click(await screen.findByRole('tab', { name: 'Trial Balance' }));
    expect(screen.getByLabelText('Fiscal year')).toHaveValue(year.id);
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    const bank = (await screen.findByText('1000 — Bank')).closest('tr')!;
    expect(bank.lastElementChild).toHaveTextContent('100.00 Credit');
    expect(screen.getByText('2000 — Payable').closest('tr')!.lastElementChild).toHaveTextContent('40.00 Debit');
    expect(fetchMock).toHaveBeenCalledWith(`/api/trial-balance?fiscal_year_id=${year.id}`, expect.anything());
    expect(screen.getByText('Fiscal year: 2026')).toBeInTheDocument();
  });

  it('totals the trial balance and flags an unbalanced result without hiding it', async () => {
    stub();
    render(ui());
    fireEvent.click(await screen.findByRole('tab', { name: 'Trial Balance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    const total = (await screen.findByRole('rowheader', { name: 'Total' })).closest('tr')!;
    expect(total.children[1]).toHaveTextContent('40.00');
    expect(total.children[2]).toHaveTextContent('100.00');
    expect(total.children[3]).toHaveTextContent('Debit 40.00');
    expect(total.children[3]).toHaveTextContent('Credit 100.00');
    expect(within(total).getByText('Unbalanced')).toBeInTheDocument();
  });

  it('marks a balanced trial balance as balanced', async () => {
    stub({ trial: [
      { ...accounts[0], debit_movement: '75.00', credit_movement: '0.00', debit_balance: '75.00', credit_balance: '0.00' },
      { ...accounts[1], debit_movement: '0.00', credit_movement: '75.00', debit_balance: '0.00', credit_balance: '75.00' },
    ] });
    render(ui());
    fireEvent.click(await screen.findByRole('tab', { name: 'Trial Balance' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    const total = (await screen.findByRole('rowheader', { name: 'Total' })).closest('tr')!;
    expect(within(total).getByText('Balanced')).toBeInTheDocument();
  });

  it('shows an explicit empty state for a ledger with no posted activity', async () => {
    stub();
    render(ui());
    fireEvent.click(await screen.findByRole('tab', { name: 'General Ledger' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    expect(await screen.findByText('No posted activity for this account in the selected fiscal year.')).toBeInTheDocument();
    expect(screen.queryByRole('rowheader', { name: 'Period totals' })).not.toBeInTheDocument();
  });

  it('totals ledger activity and ends on the closing running balance', async () => {
    stub({ ledger: [
      { accounting_date: '2026-03-01', journal_id: 'j1', line_id: 'a', reference: 'R1', description: 'Sale', debit: '500.00', credit: '0.00', running_balance: '500.00' },
      { accounting_date: '2026-04-01', journal_id: 'j2', line_id: 'b', reference: 'R2', description: 'Payment', debit: '0.00', credit: '120.50', running_balance: '379.50' },
    ] });
    render(ui());
    fireEvent.click(await screen.findByRole('tab', { name: 'General Ledger' }));
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    const total = (await screen.findByRole('rowheader', { name: 'Period totals' })).closest('tr')!;
    expect(total.children[1]).toHaveTextContent('500.00');
    expect(total.children[2]).toHaveTextContent('120.50');
    expect(total.children[3]).toHaveTextContent('379.50');
  });

  it('scopes every new style rule to the non-chart tabs', () => {
    const css = readFileSync(resolve(__dirname, '../components/AccountingTabs.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const selectors = [...css.matchAll(/([^{}@]+)\{[^{}]*\}/g)].flatMap((m) => m[1]!.split(',').map((s) => s.trim())).filter(Boolean);
    expect(selectors.length).toBeGreaterThan(50);
    for (const selector of selectors) expect(selector).toContain('.ac-tabview');
  });
});
