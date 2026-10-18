import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonalPayments } from '../components/PersonalPayments';
import i18n from '../i18n';

const base = { payer_id: 'y1', payer_name: 'Manager M', payer_kind: 'employee', treatment: 'new_expense', payment_date: '2026-03-12', accounting_date: '2026-03-10', amount: '500.00', purpose: 'Client lunch',
  document_id: 'd1', obligation_id: null, expense_account_id: 'a1', counterparty_id: null, rejection_reason: null, version: 1 };
const draft = { ...base, id: 'p1', status: 'draft' };
const submitted = { ...base, id: 'p2', status: 'submitted', purpose: 'Taxi' };
const approved = { ...base, id: 'p3', status: 'approved', purpose: 'Hotel', reimbursed_amount: '200.00', outstanding_amount: '300.00', settlement_status: 'partial' };
const payables = { as_of: '2026-10-18', payers: [{ payer_id: 'y1', payer_name: 'Manager M', payer_kind: 'employee', approved_amount: '500.00', reimbursed_amount: '200.00', outstanding_amount: '300.00' }] };
const payers = { payers: [{ id: 'y1', display_name: 'Manager M', partner_id: null, partner_name: null, payable_account_code: '2200', is_active: true, version: 1, mapping_valid: true, user_email: null }] };

const ALL = ['personal_payment.view', 'personal_payment.create', 'personal_payment.submit', 'personal_payment.review', 'personal_payment.reimburse', 'personal_payment.audit.view', 'personal_payment.payer.manage'];
function stubFetch(extra: Record<string, () => Response> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    for (const key of Object.keys(extra)) if (url.includes(key)) return extra[key]!();
    if (url.includes('/payables')) return new Response(JSON.stringify(payables));
    if (url.endsWith('/payers')) return new Response(JSON.stringify(payers));
    if (url.includes('/lookups')) return new Response(JSON.stringify({ payers: [{ id: 'y1', display_name: 'Manager M', is_partner: false }], documents: [], obligations: [], expense_accounts: [] }));
    if (init?.method && init.method !== 'GET') return new Response(JSON.stringify({}));
    return new Response(JSON.stringify({ payments: [draft, submitted, approved] }));
  }));
  return calls;
}
const renderIt = (caps: string[]) => render(<PersonalPayments capabilities={caps} onUnauthorized={vi.fn()} />);

describe('PersonalPayments', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('shows a forbidden state and makes no request without the view capability', () => {
    const calls = stubFetch();
    renderIt(['personal_payment.create']);
    expect(screen.getByText(/do not have permission/i)).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('view-only users see the register but no workflow action', async () => {
    stubFetch();
    renderIt(['personal_payment.view']);
    await screen.findByText('Client lunch');
    for (const name of ['New personal payment', 'Submit', 'Approve', 'Reject', 'Reimburse', 'Edit', 'Delete']) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('shows each action only with its own capability', async () => {
    stubFetch();
    const { unmount } = renderIt(['personal_payment.view', 'personal_payment.submit']);
    await screen.findByText('Client lunch');
    expect(screen.getByRole('button', { name: 'Submit' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    unmount();
    renderIt(['personal_payment.view', 'personal_payment.review', 'personal_payment.reimburse']);
    await screen.findByText('Taxi');
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reimburse' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });

  it('submits a draft, requires a reason to reject and reports server errors in plain language', async () => {
    const calls = stubFetch({ '/p2/approve': () => new Response(JSON.stringify({ code: 'PERSONAL_PAYMENT_MAPPING_MISSING' }), { status: 409 }) });
    renderIt(ALL);
    await screen.findByText('Client lunch');
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(calls.some(c => c.url === '/api/personal-payments/p1/submit' && c.init?.method === 'POST')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/no valid account mapping/i);
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }));
    const reason = screen.getByLabelText('Rejection reason') as HTMLInputElement;
    expect(reason.required).toBe(true);
    fireEvent.change(reason, { target: { value: 'Unreadable receipt' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm rejection' }));
    await waitFor(() => expect(calls.some(c => c.url === '/api/personal-payments/p2/reject' && String(c.init?.body).includes('Unreadable receipt'))).toBe(true));
  });

  it('shows reimbursement balances and amounts owed', async () => {
    stubFetch();
    renderIt(ALL);
    await screen.findByText('Hotel');
    expect(screen.getByText('Partly reimbursed')).toBeTruthy();
    expect(screen.getAllByText('300.00').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('tab', { name: 'Amounts owed' }));
    expect(screen.getByText(/As of 2026-10-18/)).toBeTruthy();
  });

  it('renders Arabic labels and error messages', async () => {
    await i18n.changeLanguage('ar');
    stubFetch({ '/p2/approve': () => new Response(JSON.stringify({ code: 'PERSONAL_PAYMENT_PERIOD_CLOSED' }), { status: 409 }) });
    renderIt(ALL);
    await screen.findByText('Client lunch');
    expect(screen.getByRole('heading', { name: 'المدفوعات الشخصية' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'اعتماد' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'اعتماد' }));
    expect((await screen.findByRole('alert')).textContent).toContain('الفترة المحاسبية مغلقة');
  });
});
