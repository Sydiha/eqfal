import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MantineProvider } from '@mantine/core';
import { afterEach, expect, it, vi } from 'vitest';
import { EmployeeBonusBalances } from '../components/EmployeeBonusBalances';

afterEach(() => vi.unstubAllGlobals());
const caps = ['employee.view', 'employee_cost.salary.view', 'employee_cost.correct', 'employee_cost.approve', 'accounting.journal.post'];
const bonus = {
  id: 'bonus-1', display_name: 'Sara', period_start: '2026-01-01', period_end: '2026-03-31', amount: '1000.00',
  approved_at: '2026-04-01', accounting_date: '2026-04-02', settled: '300.00', outstanding: '750.00',
};
function setup(adjustResponse?: Response, extra: Record<string, string | null> = {}, capabilities = caps) {
  const fetch = vi.fn(async (url: string, options?: RequestInit) => {
    if (url === '/api/accounts') return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
    if (options?.method === 'POST') return adjustResponse ?? new Response(JSON.stringify({ journal_id: 'j1' }), { status: 201 });
    return new Response(JSON.stringify({ bonuses: [{ ...bonus, ...extra }] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetch);
  render(<MantineProvider><EmployeeBonusBalances arabic={false} onUnauthorized={vi.fn()} capabilities={capabilities} /></MantineProvider>);
  return fetch;
}
async function fill(kind = 'decrease') {
  await screen.findAllByRole('table');
  fireEvent.click(screen.getByText('Adjust approved bonus'));
  fireEvent.change(screen.getByLabelText('Adjustment type'), { target: { value: kind } });
  fireEvent.change(screen.getByLabelText('Amount (SAR)'), { target: { value: '50' } });
  fireEvent.change(screen.getByLabelText('Accounting date'), { target: { value: '2026-05-01' } });
  fireEvent.change(screen.getByLabelText('Reason and supporting evidence'), { target: { value: 'Invoice 77 correction' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
}

it('hides the adjustment form unless all API capabilities and a recognition exist', async () => {
  setup(undefined, {}, caps.slice(0, 4));
  await screen.findAllByRole('table');
  expect(screen.queryByText('Adjust approved bonus')).not.toBeInTheDocument();
});

it('hides the form for an unrecognized bonus', async () => {
  setup(undefined, { accounting_date: null, outstanding: null });
  await screen.findAllByRole('table');
  expect(screen.queryByText('Adjust approved bonus')).not.toBeInTheDocument();
});

it('shows balances, requires confirmation, sends the contract once and refreshes', async () => {
  const fetch = setup();
  await fill();
  expect(screen.getByText('Net adjustments (SAR)').nextElementSibling).toHaveTextContent('50.00');
  expect(screen.getByText('Recognized amount (SAR)').nextElementSibling).toHaveTextContent('1000.00');
  expect(fetch.mock.calls.filter(([, o]) => o?.method === 'POST')).toHaveLength(0);
  expect(screen.getByText(/does not cancel or reverse the original recognition/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and post' }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/employee-bonuses/bonus-1/adjustments', expect.objectContaining({ method: 'POST' })));
  const body = JSON.parse((fetch.mock.calls.find(([, o]) => o?.method === 'POST')![1] as RequestInit).body as string);
  expect(body).toMatchObject({ kind: 'decrease', amount: '50', accounting_date: '2026-05-01', reason: 'Invoice 77 correction' });
  expect(body.idempotency_key).toMatch(/[0-9a-f-]{36}/);
  expect(await screen.findByText(/original recognition is unchanged/)).toBeInTheDocument();
  expect(fetch.mock.calls.filter(([u, o]) => u === '/api/employee-bonuses' && o?.method !== 'POST')).toHaveLength(2);
});

it('blocks a decrease larger than outstanding before any request', async () => {
  const fetch = setup();
  await screen.findAllByRole('table');
  fireEvent.click(screen.getByText('Adjust approved bonus'));
  fireEvent.change(screen.getByLabelText('Amount (SAR)'), { target: { value: '750.01' } });
  fireEvent.change(screen.getByLabelText('Adjustment type'), { target: { value: 'decrease' } });
  fireEvent.change(screen.getByLabelText('Accounting date'), { target: { value: '2026-05-01' } });
  fireEvent.change(screen.getByLabelText('Reason and supporting evidence'), { target: { value: 'x' } });
  fireEvent.click(screen.getByRole('button', { name: 'Review adjustment' }));
  expect(screen.getByRole('alert')).toHaveTextContent('cannot exceed the outstanding balance');
  expect(fetch.mock.calls.some(([, o]) => o?.method === 'POST')).toBe(false);
});

it('explains separation-of-duties and blocked errors from the server', async () => {
  setup(new Response(JSON.stringify({ code: 'BONUS_ADJUSTMENT_SEPARATION_REQUIRED' }), { status: 403 }));
  await fill('increase');
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and post' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('independent user is required');
});

it('explains a blocked adjustment without implying it was recorded', async () => {
  setup(new Response(JSON.stringify({ code: 'BONUS_ADJUSTMENT_BLOCKED' }), { status: 409 }));
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Confirm and post' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Nothing was recorded');
});
