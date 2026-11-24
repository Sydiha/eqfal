import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EmployeeBonusBalances } from '../components/EmployeeBonusBalances';
import { CompanyProvider, useCompany } from '../context/CompanyContext';
import { MantineProvider } from '@mantine/core';

afterEach(() => vi.unstubAllGlobals());

it('shows Arabic RTL balances after loading and distinguishes draft and recognized bonuses', async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/accounts' ? { accounts: [] } : {
    bonuses: [{
      id: 'recognized', display_name: 'سارة', period_start: '2026-01-01', period_end: '2026-03-31',
      amount: '21000.00', approved_at: '2026-04-01', accounting_date: '2026-04-02',
      settled: '10000.00', outstanding: '11000.00',
    }, {
      id: 'draft', display_name: 'علي', period_start: '2026-01-01', period_end: '2026-03-31',
      amount: '2000.00', approved_at: null, accounting_date: null, settled: '0.00', outstanding: null,
    }],
  }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  render(<EmployeeBonusBalances arabic onUnauthorized={vi.fn()} />);
  const table = (await screen.findAllByRole('table'))[0]!;
  expect(table.closest('section')).toHaveAttribute('dir', 'rtl');
  const recognized = within(table).getByRole('row', { name: /سارة/ });
  expect(within(recognized).getByText('21000.00')).toBeInTheDocument();
  expect(screen.getAllByText('11000.00').length).toBeGreaterThan(0);
  const draft = within(table).getByRole('row', { name: /علي/ });
  expect(within(draft).queryByText('2000.00')).not.toBeInTheDocument();
});

it('submits an approved bonus installment from the Arabic schedule form', async () => {
  const bonuses = [{
    id: 'bonus', display_name: 'سارة', period_start: '2026-01-01', period_end: '2026-03-31',
    award_code: 'bonustest2027', amount: '15000.00', approved_at: '2026-04-01', accounting_date: null, settled: '0.00', outstanding: null,
  }];
  let listCalls = 0;
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/accounts') return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
    if (options?.method === 'POST') return new Response(JSON.stringify({ id: 'schedule-1' }), { status: 201 });
    listCalls++;
    const currentBonuses = listCalls > 1
      ? [{ ...bonuses[0], schedule: [{ id: 'schedule-1', due_on: '2027-02-05', amount: '15000.00', channel: 'bank' }] }]
      : bonuses;
    return new Response(JSON.stringify({ bonuses: currentBonuses }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  render(<EmployeeBonusBalances arabic onUnauthorized={vi.fn()} capabilities={['employee_cost.payment.allocate']} />);
  await screen.findAllByRole('table');
  fireEvent.click(screen.getByText('جدولة دفعة'));
  fireEvent.change(screen.getByLabelText('موعد الدفع'), { target: { value: '2027-02-05' } });
  fireEvent.change(screen.getByLabelText('المبلغ'), { target: { value: '15000' } });
  fireEvent.click(screen.getByRole('button', { name: 'حفظ الموعد' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/employee-bonuses/bonus/schedule', expect.objectContaining({
    method: 'POST',
    body: expect.stringContaining('"due_on":"2027-02-05","amount":"15000","channel":"bank"'),
  })));
  expect(await screen.findByRole('status')).toHaveTextContent('تم حفظ موعد الدفع وتحديث جدول المكافأة.');
  expect(await screen.findByText('2027-02-05')).toBeInTheDocument();
  expect(screen.getAllByText('15000.00').length).toBeGreaterThan(0);
  expect(fetch.mock.calls.filter(([url, options]) => url === '/api/employee-bonuses' && options?.method !== 'POST')).toHaveLength(2);
});

it('shows an actionable Arabic validation code when the schedule request is rejected', async () => {
  const bonuses = [{
    id: 'bonus', display_name: 'سارة', period_start: '2026-01-01', period_end: '2026-03-31',
    amount: '15000.00', approved_at: '2026-04-01', accounting_date: null, settled: '0.00', outstanding: null,
  }];
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/schedule') && options?.method === 'POST') {
      return new Response(JSON.stringify({ code: 'BONUS_SCHEDULE_EXCEEDS_APPROVED' }), { status: 409 });
    }
    return new Response(JSON.stringify(url === '/api/accounts' ? { accounts: [] } : { bonuses }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  render(<EmployeeBonusBalances arabic onUnauthorized={vi.fn()} capabilities={['employee_cost.payment.allocate']} />);
  await screen.findAllByRole('table');
  fireEvent.click(screen.getByText('جدولة دفعة'));
  fireEvent.change(screen.getByLabelText('موعد الدفع'), { target: { value: '2027-02-05' } });
  fireEvent.change(screen.getByLabelText('المبلغ'), { target: { value: '15000' } });
  fireEvent.click(screen.getByRole('button', { name: 'حفظ الموعد' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('المبلغ يتجاوز الرصيد المعتمد المتاح');
  expect(alert).toHaveTextContent('BONUS_SCHEDULE_EXCEEDS_APPROVED');
  expect(screen.queryByText('تعذر تحميل أرصدة المكافآت')).not.toBeInTheDocument();
});

it('sends only one schedule request when the form is submitted twice while saving', async () => {
  const bonuses = [{
    id: 'bonus', display_name: 'سارة', period_start: '2026-01-01', period_end: '2026-03-31',
    amount: '15000.00', approved_at: '2026-04-01', accounting_date: null, settled: '0.00', outstanding: null,
  }];
  let finishPost!: (response: Response) => void;
  const pendingPost = new Promise<Response>(resolve => { finishPost = resolve; });
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url.endsWith('/schedule') && options?.method === 'POST') return pendingPost;
    return new Response(JSON.stringify(url === '/api/accounts' ? { accounts: [] } : { bonuses }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  render(<EmployeeBonusBalances arabic onUnauthorized={vi.fn()} capabilities={['employee_cost.payment.allocate']} />);
  await screen.findAllByRole('table');
  fireEvent.click(screen.getByText('جدولة دفعة'));
  fireEvent.change(screen.getByLabelText('موعد الدفع'), { target: { value: '2027-02-05' } });
  fireEvent.change(screen.getByLabelText('المبلغ'), { target: { value: '15000' } });
  const form = screen.getByLabelText('المبلغ').closest('form')!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  await waitFor(() => expect(fetch.mock.calls.filter(([url, options]) => url.endsWith('/schedule') && options?.method === 'POST')).toHaveLength(1));
  finishPost(new Response(JSON.stringify({ id: 'schedule-1' }), { status: 201 }));
  await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('تم حفظ موعد الدفع'));
});

const recognitionBonus = { id: 'bonus', display_name: 'سارة', period_start: '2026-01-01', period_end: '2026-03-31', amount: '100.00', approved_at: '2026-04-01', accounting_date: null, settled: '0.00', outstanding: null };
const recognitionAccounts = [
  { id: 'expense-id', code: '5100', name: 'مصروف', name_ar: 'مصروف المكافآت', account_type: 'expense', is_active: true, has_children: false },
  { id: 'liability-id', code: '2200', name: 'التزام', name_ar: 'مستحقات المكافآت', account_type: 'liability', is_active: true, has_children: false },
  { id: 'inactive-expense', code: '5101', name: 'غير نشط', name_ar: 'حساب غير نشط', account_type: 'expense', is_active: false, has_children: false },
  { id: 'parent-liability', code: '2201', name: 'مجمع', name_ar: 'حساب تجميعي', account_type: 'liability', is_active: true, has_children: true },
  { id: 'wrong-type', code: '4100', name: 'إيراد', name_ar: 'إيراد', account_type: 'revenue', is_active: true, has_children: false },
];

it('offers only active postable accounts by type and submits their internal IDs', async () => {
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/accounts') return new Response(JSON.stringify({ accounts: recognitionAccounts }));
    if (url === '/api/employee-bonuses') return new Response(JSON.stringify({ bonuses: [recognitionBonus] }));
    if (url.endsWith('/recognition') && options?.method === 'POST') return new Response(JSON.stringify({ journal_id: 'journal' }), { status: 201 });
    return new Response('{}');
  });
  vi.stubGlobal('fetch', fetch);
  render(<MantineProvider><EmployeeBonusBalances arabic onUnauthorized={vi.fn()} capabilities={['employee_cost.approve', 'accounting.journal.post']} /></MantineProvider>);
  fireEvent.click(await screen.findByText('إثبات الاستحقاق والترحيل'));
  const expense = await screen.findByRole('textbox', { name: 'حساب المصروف' });
  const offeredAccounts = screen.getAllByRole('option', { hidden: true }).map(option => option.textContent);
  expect(offeredAccounts).toEqual(expect.arrayContaining(['5100 — مصروف المكافآت', '2200 — مستحقات المكافآت']));
  expect(offeredAccounts.join(' ')).not.toMatch(/5101|2201|4100/);
  fireEvent.change(expense, { target: { value: '5100' } });
  fireEvent.click(await screen.findByRole('option', { name: /5100 — مصروف المكافآت/, hidden: true }));
  const liability = screen.getByRole('textbox', { name: 'حساب الالتزام' });
  fireEvent.change(liability, { target: { value: '2200' } });
  fireEvent.click(await screen.findByRole('option', { name: /2200 — مستحقات المكافآت/, hidden: true }));
  fireEvent.change(screen.getByLabelText('تاريخ تحقق الشرط'), { target: { value: '2026-04-01' } });
  fireEvent.change(screen.getByLabelText('تاريخ الاعتراف'), { target: { value: '2026-04-01' } });
  fireEvent.change(screen.getByLabelText('دليل الاستحقاق'), { target: { value: 'اعتماد المكافأة' } });
  fireEvent.click(screen.getByRole('button', { name: 'ترحيل الاعتراف' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/employee-bonuses/bonus/recognition', expect.objectContaining({
    method: 'POST', body: JSON.stringify({ fulfilled_on: '2026-04-01', accounting_date: '2026-04-01', evidence: 'اعتماد المكافأة', date_reason: '', expense_account_id: 'expense-id', liability_account_id: 'liability-id' }),
  })));
});

it('reloads company accounts after a company switch and clears prior selections', async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/accounts' ? { accounts: recognitionAccounts } : { bonuses: [recognitionBonus] })));
  vi.stubGlobal('fetch', fetch);
  function Switchable() {
    const { setActiveCompany } = useCompany();
    return <><button type="button" onClick={() => setActiveCompany('company-b')}>Switch company</button>
      <MantineProvider><EmployeeBonusBalances arabic onUnauthorized={vi.fn()} capabilities={['employee_cost.approve', 'accounting.journal.post']} /></MantineProvider></>;
  }
  const ui = render(<CompanyProvider allowedCompanies={[{ id: 'company-a', name: 'A' }, { id: 'company-b', name: 'B' }]} initialCompanyId="company-a"><Switchable /></CompanyProvider>);
  fireEvent.click((await screen.findByText('إثبات الاستحقاق والترحيل')));
  const expense = await screen.findByRole('textbox', { name: 'حساب المصروف' });
  fireEvent.change(expense, { target: { value: '5100' } });
  fireEvent.click(await screen.findByRole('option', { name: /5100 — مصروف المكافآت/, hidden: true }));
  fireEvent.click(screen.getByRole('button', { name: 'Switch company' }));
  await waitFor(() => expect(fetch.mock.calls.filter(([url]) => url === '/api/accounts')).toHaveLength(2));
  await waitFor(() => expect(expense).toHaveValue(''));
  ui.unmount();
});

it('explains when no eligible accounts are available and blocks recognition', async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/accounts' ? { accounts: [] } : { bonuses: [recognitionBonus] })));
  vi.stubGlobal('fetch', fetch);
  render(<MantineProvider><EmployeeBonusBalances arabic onUnauthorized={vi.fn()} capabilities={['employee_cost.approve', 'accounting.journal.post']} /></MantineProvider>);
  fireEvent.click(await screen.findByText('إثبات الاستحقاق والترحيل'));
  expect(await screen.findByText('لا توجد حسابات مصروف نشطة وقابلة للترحيل.')).toBeInTheDocument();
  expect(screen.getByText('لا توجد حسابات التزام نشطة وقابلة للترحيل.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'ترحيل الاعتراف' })).toBeDisabled();
});

it('shows Arabic validation when either recognition account is missing', async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/accounts' ? { accounts: recognitionAccounts.slice(0, 2) } : { bonuses: [recognitionBonus] })));
  vi.stubGlobal('fetch', fetch);
  render(<MantineProvider><EmployeeBonusBalances arabic onUnauthorized={vi.fn()} capabilities={['employee_cost.approve', 'accounting.journal.post']} /></MantineProvider>);
  fireEvent.click(await screen.findByText('إثبات الاستحقاق والترحيل'));
  const expense = await screen.findByRole('textbox', { name: 'حساب المصروف' });
  fireEvent.submit(expense.closest('form')!);
  expect(await screen.findByRole('alert')).toHaveTextContent('اختر حساب المصروف وحساب الالتزام قبل الترحيل.');
});

it('loads the register automatically and keeps the creation dialog closed until the header action opens it', async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url === '/api/accounts' ? { accounts: [] } : { employees: [], bonuses: [{
    id: 'b1', display_name: 'سارة', award_code: 'standard', period_start: '2026-01-01', period_end: '2026-03-31',
    amount: '6000.00', approved_at: '2026-04-01', accounting_date: null, settled: '0.00', outstanding: '6000.00',
  }] }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  const { rerender } = render(<EmployeeBonusBalances arabic onUnauthorized={vi.fn()} capabilities={['employee_cost.create']} employees={[{ id: 'e1', display_name: 'سارة' }]} />);
  const table = (await screen.findAllByRole('table'))[0]!;
  expect(within(table).getAllByRole('columnheader')).toHaveLength(5);
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  expect(screen.queryByLabelText('رمز المكافأة')).not.toBeInTheDocument();
  rerender(<EmployeeBonusBalances arabic onUnauthorized={vi.fn()} capabilities={['employee_cost.create']} employees={[{ id: 'e1', display_name: 'سارة' }]} createOpen onCreateClose={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: 'إنشاء مكافأة' });
  expect(within(dialog).getByLabelText(/رمز المكافأة/)).toHaveValue('standard');
});
