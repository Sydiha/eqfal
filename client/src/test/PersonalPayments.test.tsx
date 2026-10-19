import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PersonalPayments } from '../components/PersonalPayments';
import i18n from '../i18n';

const base = { payer_id: 'y1', payer_name: 'Manager M', payer_kind: 'employee', treatment: 'new_expense', payment_date: '2026-03-12', accounting_date: '2026-03-10', amount: '500.00', purpose: 'Client lunch',
  document_id: 'd1', obligation_id: null, expense_account_id: 'a1', counterparty_id: null, rejection_reason: null, version: 1 };
const draft = { ...base, id: 'p1', status: 'draft' };
const submitted = { ...base, id: 'p2', status: 'submitted', purpose: 'Taxi' };
const approved = { ...base, id: 'p3', status: 'approved', purpose: 'Hotel', reimbursed_amount: '200.00', outstanding_amount: '300.00', settlement_status: 'partial' };
const reviewData = (blockers: string[] = []) => ({
  payment: { ...submitted, counterparty_name: 'Supplier' },
  review: { submitted_by_email: 'sub@example.com', created_by_email: 'prep@example.com', reviewed_by_email: null, document: { id: 'd1', filename: 'receipt.pdf', date: '2026-03-10', total: '500.00' }, obligation: null,
    expense_account: { code: '5100', name: 'Meals' }, accounts: { source: 'projected', debit: { code: '5100', name: 'Meals' }, credit: { code: '2200', name: 'Payable to Manager M' } }, blockers, can_decide: blockers.length === 0 },
  history: [{ id: 'e1', event_type: 'submitted', from_status: 'draft', to_status: 'submitted', actor_email: 'sub@example.com', reason: null, created_at: '2026-03-11T08:30:00Z' }],
});
const payables = { as_of: '2026-10-18', payers: [{ payer_id: 'y1', payer_name: 'Manager M', payer_kind: 'employee', approved_amount: '500.00', reimbursed_amount: '200.00', outstanding_amount: '300.00' }] };
const payers = { payers: [{ id: 'y1', display_name: 'Manager M', partner_id: null, partner_name: null, payable_account_code: '2200', is_active: true, version: 1, mapping_valid: true, user_email: null }] };

const ALL = ['personal_payment.view', 'personal_payment.create', 'personal_payment.submit', 'personal_payment.review', 'personal_payment.reimburse', 'personal_payment.audit.view', 'personal_payment.payer.manage'];
function stubFetch(extra: Record<string, () => Response> = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    for (const key of Object.keys(extra)) if (url.includes(key)) return extra[key]!();
    if (url.endsWith('/review')) return new Response(JSON.stringify(reviewData()));
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
    expect(screen.getByRole('button', { name: 'Review' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reimburse' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit' })).toBeNull();
  });

  it('submits a draft, requires a reason to reject and reports server errors in plain language', async () => {
    const calls = stubFetch({ '/p2/approve': () => new Response(JSON.stringify({ code: 'PERSONAL_PAYMENT_MAPPING_MISSING' }), { status: 409 }) });
    renderIt(ALL);
    await screen.findByText('Client lunch');
    fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    await waitFor(() => expect(calls.some(c => c.url === '/api/personal-payments/p1/submit' && c.init?.method === 'POST')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByLabelText(/I have reviewed this payment/));
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
    fireEvent.click(screen.getByRole('button', { name: 'مراجعة' }));
    fireEvent.click(await screen.findByLabelText(/راجعتُ هذه الدفعة/));
    fireEvent.click(screen.getByRole('button', { name: 'اعتماد' }));
    expect((await screen.findByRole('alert')).textContent).toContain('الفترة المحاسبية مغلقة');
  });
  it('shows the full read-only review and requires an explicit confirmation before approving the reviewed version', async () => {
    const calls = stubFetch();
    renderIt(ALL);
    await screen.findByText('Taxi');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    const panel = await screen.findByRole('region', { name: 'Review before approval' });
    for (const t of ['Manager M', 'sub@example.com', 'prep@example.com', 'Supplier', '5100 Meals', '2200 Payable to Manager M', '2026-03-12', '2026-03-10', 'Projected: nothing has been posted yet.']) expect(panel.textContent).toContain(t);
    expect((screen.getByRole('link', { name: /receipt\.pdf/ }) as HTMLAnchorElement).getAttribute('href')).toBe('/api/documents/d1/file');
    expect(calls.some(c => c.init?.method === 'POST')).toBe(false);
    const approve = screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText(/I have reviewed this payment/));
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    await waitFor(() => expect(calls.some(c => c.url === '/api/personal-payments/p2/approve' && c.init?.body === JSON.stringify({ confirm_review: true, version: 1 }))).toBe(true));
  });

  it('offers approve and reject to anyone holding the review capability, including for a payment they submitted', async () => {
    const calls = stubFetch({ '/review': () => new Response(JSON.stringify(reviewData())) });
    renderIt(['personal_payment.view', 'personal_payment.submit', 'personal_payment.create', 'personal_payment.review']);
    await screen.findByText('Taxi');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    fireEvent.click(await screen.findByLabelText(/I have reviewed this payment/));
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Reject' }) as HTMLButtonElement).disabled).toBe(false);
    expect(calls.some(c => c.init?.method === 'POST')).toBe(false);
    expect(screen.queryByText(/another reviewer/)).toBeNull();
  });

  it('shows no review button without the review capability', async () => {
    stubFetch();
    renderIt(['personal_payment.view', 'personal_payment.submit', 'personal_payment.create']);
    await screen.findByText('Taxi');
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('keeps approval disabled and lists the blocker when the accounts cannot be resolved', async () => {
    stubFetch({ '/review': () => new Response(JSON.stringify(reviewData(['PERSONAL_PAYMENT_MAPPING_MISSING']))) });
    renderIt(ALL);
    await screen.findByText('Taxi');
    fireEvent.click(screen.getByRole('button', { name: 'Review' }));
    expect((await screen.findByText(/Approval is currently blocked/)).textContent).toMatch(/no valid account mapping/i);
    fireEvent.click(screen.getByLabelText(/I have reviewed this payment/));
    expect((screen.getByRole('button', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
  });
  it('keeps the confirmation checkbox inside its label and orders the actions Close, Reject, Approve in both languages', async () => {
    for (const lang of ['en', 'ar'] as const) {
      await i18n.changeLanguage(lang);
      stubFetch({ '/review': () => new Response(JSON.stringify(reviewData())) });
      const { unmount } = renderIt(ALL);
      await screen.findByText('Taxi');
      fireEvent.click(screen.getByRole('button', { name: lang === 'en' ? 'Review' : 'مراجعة' }));
      const checkbox = await screen.findByRole('checkbox');
      const label = checkbox.closest('label.pp-confirm')!;
      expect(label.textContent).toMatch(lang === 'en' ? /I have reviewed this payment/ : /راجعتُ هذه الدفعة/);
      expect(label.firstElementChild).toBe(checkbox);
      const row = checkbox.closest('.pp-review-footer')!.querySelector('.pp-review-actions')!;
      expect(Array.from(row.querySelectorAll('button')).map(b => b.textContent)).toEqual(lang === 'en' ? ['Close', 'Reject', 'Approve'] : ['إغلاق', 'رفض', 'اعتماد']);
      unmount();
    }
  });
});
