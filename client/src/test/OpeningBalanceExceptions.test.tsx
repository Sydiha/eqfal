import { fireEvent, screen, waitFor, render } from './test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { OpeningBalanceReview } from '../components/OpeningBalanceReview';
import { OpeningBalanceExceptions } from '../components/OpeningBalanceExceptions';
import i18n from '../i18n';

const YEAR = '11111111-1111-4111-8111-111111111111';
const K1 = 'a'.repeat(64), K2 = 'b'.repeat(64), F1 = 'c'.repeat(64), F2 = 'd'.repeat(64);
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const aggIssue = { issue_key: K1, evidence_fingerprint: F1, code: 'OB_BANK_AGGREGATE_ONLY', class: 'incomplete_evidence', section: 'bank', item_id: 'item-1', acceptable: true, acceptance: 'none' };
const diffIssue = { issue_key: K2, evidence_fingerprint: F2, code: 'OB_SUBLEDGER_TOTAL_DIFFERENCE', class: 'incomplete_evidence', section: 'receivable', detail: { gl_total: '1500.00', subledger_total: '1000.00', difference: '500.00' }, acceptable: true, acceptance: 'none' };
const exRow = { id: 'e1', issue_code: 'OB_BANK_AGGREGATE_ONLY', section: 'bank', item_id: 'item-1', reason: 'Bank confirmation requested from branch', accepted_by: 'user-fm', accepted_at: '2026-10-26T08:00:00Z', status: 'active', acknowledged_difference: null, ended_at: null, end_reason: null };

function server(o: { issues?: unknown[]; exceptions?: unknown[]; recon?: unknown; post?: (url: string, body: any) => Promise<Response> } = {}) {
  const issues = o.issues ?? [aggIssue];
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return o.post ? o.post(url, JSON.parse(String(init.body))) : json({});
    if (url.endsWith('/reconciliation')) return json(o.recon ?? { status: 'incomplete_evidence', blocking: false, issues: [] });
    return json({ required_count: issues.length, accepted_unverified_count: (issues as any[]).filter(i => i.acceptance === 'accepted_unverified').length, stale_count: (issues as any[]).filter(i => i.acceptance === 'stale').length, issues, exceptions: o.exceptions ?? [] });
  });
}
const setup = (p: Partial<React.ComponentProps<typeof OpeningBalanceExceptions>> = {}) => {
  const onGate = vi.fn();
  const view = render(<OpeningBalanceExceptions yearId={YEAR} reviewStatus="in_review" canAccept lang="en" reloadToken={0} describeItem={id => `Item ${id}`} onUnauthorized={vi.fn()} onGate={onGate} {...p} />);
  return { onGate, ...view };
};

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });

describe('OpeningBalanceExceptions', () => {
  it('offers acceptance to an authorized user while in review, with an exact disclosure and approval blocker', async () => {
    vi.stubGlobal('fetch', server()); const { onGate } = setup();
    expect(await screen.findByText('Bank balance imported as a single total, with no bank account link')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Accept…' })).toBeTruthy();
    expect(screen.getByText('Final approval is unavailable')).toBeTruthy();
    expect(screen.getByText(/1 finding\(s\) still need an accepted reason/)).toBeTruthy();
    await waitFor(() => expect(onGate).toHaveBeenLastCalledWith({ blocked: true }));
  });

  it('hides accept and revoke without the exception capability or outside in_review', async () => {
    vi.stubGlobal('fetch', server({ issues: [{ ...aggIssue, acceptance: 'accepted_unverified', exception_id: 'e1' }], exceptions: [exRow] }));
    const a = setup({ canAccept: false }); await screen.findByText(/You can view these findings/);
    expect(screen.queryByRole('button', { name: /Accept…|Revoke…/ })).toBeNull(); a.unmount();
    vi.stubGlobal('fetch', server({ issues: [{ ...aggIssue, acceptance: 'accepted_unverified', exception_id: 'e1' }], exceptions: [exRow] }));
    setup({ reviewStatus: 'draft' }); await screen.findByText(/only after the review is submitted/);
    expect(screen.queryByRole('button', { name: /Accept…|Revoke…/ })).toBeNull();
  });

  it('never offers acceptance for blocked or mismatch findings and tells the user to correct them', async () => {
    const recon = { status: 'blocked', blocking: true, issues: [{ code: 'OB_BANK_DUPLICATE', class: 'blocked', section: 'bank', item_id: 'item-9' }, { code: 'OB_BANK_AMOUNT_MISMATCH', class: 'mismatch', section: 'bank', item_id: 'item-8', detail: { expected: '100.00', actual: '120.00', difference: '20.00' } }] };
    vi.stubGlobal('fetch', server({ issues: [], recon })); const { onGate } = setup();
    expect(await screen.findByText('The same bank account appears more than once')).toBeTruthy();
    expect(screen.getByText('Amount differs from the bank statement balance')).toBeTruthy();
    expect(screen.getByText('Item item-9', { exact: false })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Accept/ })).toBeNull();
    expect(screen.getByText(/Blocked or mismatched findings must be corrected first/)).toBeTruthy();
    await waitFor(() => expect(onGate).toHaveBeenLastCalledWith({ blocked: true }));
  });

  it('requires a meaningful reason and posts the fingerprint; accepted is never called verified', async () => {
    const post = vi.fn().mockImplementation(() => json({ exceptions: [exRow] }, 201));
    const f = server({ post: (u, b) => post(u, b) }); vi.stubGlobal('fetch', f); setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Accept…' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    const confirm = screen.getByRole('button', { name: 'Accept — not verified' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: '   short   ' } });
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Bank letter requested' } });
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe(`/api/opening-balances/${YEAR}/exceptions`);
    expect(post.mock.calls[0][1]).toEqual([{ issue_key: K1, evidence_fingerprint: F1, reason: 'Bank letter requested' }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('requires explicit acknowledgment of the displayed amount for aggregate total differences', async () => {
    const post = vi.fn().mockImplementation(() => json({ exceptions: [] }, 201));
    vi.stubGlobal('fetch', server({ issues: [diffIssue], post: (u, b) => post(u, b) })); setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Accept…' }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Difference under investigation' } });
    const confirm = screen.getByRole('button', { name: 'Accept — not verified' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText(/unexplained difference of 500\.00 stays/)).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][1][0].acknowledged_difference).toBe('500.00');
  });

  it('shows accepted_by, accepted_at, reason and the "Accepted — not verified." status', async () => {
    vi.stubGlobal('fetch', server({ issues: [{ ...aggIssue, acceptance: 'accepted_unverified', exception_id: 'e1' }], exceptions: [exRow] })); const { onGate } = setup();
    expect((await screen.findAllByText('Accepted — not verified.')).length).toBeGreaterThan(0);
    expect(screen.getByText('user-fm')).toBeTruthy();
    expect(screen.getByText('2026-10-26 08:00')).toBeTruthy();
    expect(screen.getByText('Bank confirmation requested from branch')).toBeTruthy();
    expect(screen.queryByText(/^Verified$/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Accept…' })).toBeNull();
    await waitFor(() => expect(onGate).toHaveBeenLastCalledWith({ blocked: false }));
  });

  it('revokes with a required reason, then refreshes', async () => {
    const post = vi.fn().mockImplementation(() => json({ exception: {} }));
    vi.stubGlobal('fetch', server({ issues: [{ ...aggIssue, acceptance: 'accepted_unverified', exception_id: 'e1' }], exceptions: [exRow], post: (u, b) => post(u, b) })); setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke…' }));
    const confirm = screen.getByRole('button', { name: 'Revoke acceptance' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Statement now received' } });
    fireEvent.click(confirm);
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/api/opening-balances/${YEAR}/exceptions/e1/revoke`, { reason: 'Statement now received' }));
  });

  it('explains stale exceptions and offers re-acceptance', async () => {
    vi.stubGlobal('fetch', server({ issues: [{ ...aggIssue, acceptance: 'stale', exception_id: 'e1' }], exceptions: [exRow] })); const { onGate } = setup();
    expect(await screen.findByText(/evidence changed after this exception was accepted/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-accept…' })).toBeTruthy();
    expect(screen.getByText(/must be accepted again/)).toBeTruthy();
    await waitFor(() => expect(onGate).toHaveBeenLastCalledWith({ blocked: true }));
  });

  it('shows a localized message for a server STALE conflict and refreshes the list', async () => {
    const f = server({ post: () => json({ error: 'The evidence changed since it was displayed', code: 'OB_EXCEPTION_STALE' }, 409) }); vi.stubGlobal('fetch', f); setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Accept…' }));
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Bank letter requested' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept — not verified' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'The evidence changed. The list was refreshed; review the new figures.');
    await waitFor(() => expect(f.mock.calls.filter(c => String(c[0]).endsWith('/exceptions') && !c[1]?.method).length).toBeGreaterThan(1));
  });

  it('renders Arabic with RTL-safe numerals and no English labels', async () => {
    await i18n.changeLanguage('ar');
    vi.stubGlobal('fetch', server({ issues: [diffIssue] })); setup({ lang: 'ar' });
    expect(await screen.findByText('إجمالي الدفتر يختلف عن إجمالي الحسابات الفرعية')).toBeTruthy();
    expect(screen.getByText('الاعتماد النهائي غير متاح')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'قبول…' }));
    expect(screen.getByRole('button', { name: 'قبول — غير موثّق' })).toBeTruthy();
    expect(screen.getByText(/الفرق غير المبرَّر البالغ 500\.00/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Accept|Revoke|Evidence|Stale/);
    expect(document.querySelector('bdi[dir="ltr"]')).toBeTruthy();
  });

  it('reloads when the review status or refresh token changes', async () => {
    const f = server(); vi.stubGlobal('fetch', f); const { rerender } = setup();
    await screen.findByText('Evidence review');
    const count = () => f.mock.calls.length;
    const before = count();
    rerender(<OpeningBalanceExceptions yearId={YEAR} reviewStatus="draft" canAccept lang="en" reloadToken={0} describeItem={String} onUnauthorized={vi.fn()} onGate={vi.fn()} />);
    await waitFor(() => expect(count()).toBeGreaterThan(before));
  });

  it('wires the capability to the page and labels it in both languages', () => {
    const app = readFileSync('src/App.tsx', 'utf8');
    expect(app).toContain("canAcceptException={c.includes('opening_balance.exception.accept')}");
    const labels = readFileSync('src/labels/capabilityLabels.ts', 'utf8');
    expect(labels).toContain("'opening_balance.exception.accept'");
  });

  it('disables page-level approval while required exceptions remain, and shows the exception section only for a loaded review', async () => {
    const year = { id: YEAR, name: 'FY 2026', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' };
    const base = server();
    vi.stubGlobal('fetch', vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/fiscal-years') return json({ fiscalYears: [year] });
      if (url === '/api/accounts') return json({ accounts: [] });
      if (url.endsWith('/suggestions')) return json({ suggestions: [] });
      if (url.endsWith('/reconciliation') || url.endsWith('/exceptions')) return base(url, init);
      if (url.includes('/api/opening-balances/')) return json({ year, review: { id: 'r1', status: 'in_review', journal_entry_id: null }, items: [], summary: { debit: '0.00', credit: '0.00', difference: '0.00', confidence: { high: 0, medium: 0, low: 0 } } });
      return json({});
    }));
    render(<OpeningBalanceReview canView canCreate={false} canEdit={false} canDelete={false} canSubmit={false} canReview={false} canApprove canAcceptException onUnauthorized={vi.fn()} />);
    expect(await screen.findByText('Final approval is unavailable')).toBeTruthy();
    await waitFor(() => expect((screen.getByRole('button', { name: /^Approve/ }) as HTMLButtonElement).disabled).toBe(true));
  });
});
