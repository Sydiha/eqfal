import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { EmployeeBonusBalances } from '../components/EmployeeBonusBalances';

afterEach(() => vi.unstubAllGlobals());

it('shows Arabic RTL balances after loading and distinguishes draft and recognized bonuses', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
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
  expect(fetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'عرض الأرصدة' }));
  const table = await screen.findByRole('table');
  expect(table.closest('section')).toHaveAttribute('dir', 'rtl');
  const recognized = within(table).getByRole('row', { name: /سارة/ });
  expect(within(recognized).getByText('11000.00')).toBeInTheDocument();
  const draft = within(table).getByRole('row', { name: /علي/ });
  expect(within(draft).queryByText('2000.00')).not.toBeInTheDocument();
});

it('submits an approved bonus installment from the Arabic schedule form', async () => {
  const bonuses = [{
    id: 'bonus', display_name: 'سارة', period_start: '2026-01-01', period_end: '2026-03-31',
    amount: '100.00', approved_at: '2026-04-01', accounting_date: null, settled: '0.00', outstanding: null,
  }];
  const fetch = vi.fn(async () => new Response(JSON.stringify({ bonuses }), { status: 200 }));
  vi.stubGlobal('fetch', fetch);
  render(<EmployeeBonusBalances arabic onUnauthorized={vi.fn()} capabilities={['employee_cost.payment.allocate']} />);
  fireEvent.click(screen.getByRole('button', { name: 'عرض الأرصدة' }));
  const table = await screen.findByRole('table');
  fireEvent.click(within(table).getByText('جدولة دفعة'));
  fireEvent.change(within(table).getByLabelText('موعد الدفع'), { target: { value: '2026-04-15' } });
  fireEvent.change(within(table).getByLabelText('المبلغ'), { target: { value: '40' } });
  fireEvent.click(within(table).getByRole('button', { name: 'حفظ الموعد' }));
  expect(fetch).toHaveBeenCalledWith('/api/employee-bonuses/bonus/schedule', expect.objectContaining({
    method: 'POST',
    body: expect.stringContaining('"amount":"40"'),
  }));
  await screen.findByRole('button', { name: 'تحديث الأرصدة' });
});
