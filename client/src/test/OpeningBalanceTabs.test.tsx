import { fireEvent, screen, waitFor, render, within } from './test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpeningBalanceReview } from '../components/OpeningBalanceReview';
import i18n from '../i18n';

// C4-UI1: three-tab layout, shared readiness summary, approval-gate preservation across tab switches, submit-vs-approve rules,
// human-readable acceptance identity and bidirectional text. The server stays authoritative; these tests only cover the page.
const YEAR = '11111111-1111-4111-8111-111111111111';
const K1 = 'a'.repeat(64), K2 = 'b'.repeat(64), F = 'c'.repeat(64);
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const yr = { id: YEAR, name: 'FY 2026', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' };
const item = (id: string, side: 'debit' | 'credit', extra: Record<string, unknown> = {}) => ({ id, category: 'bank', account_id: 'a1', amount: '10.00', balance_side: side, source_type: 'bank_statement', source_reference: null, confidence: 'high', note: null, ...extra });
const incomplete = (o: Record<string, unknown> = {}) => ({ issue_key: K1, evidence_fingerprint: F, code: 'OB_BANK_AGGREGATE_ONLY', class: 'incomplete_evidence', section: 'bank', item_id: 'i1', acceptable: true, acceptance: 'none', ...o });
const UUID = '0b9f7e2e-6f3c-4a55-9d2b-1a2b3c4d5e6f';
const exRow = (o: Record<string, unknown> = {}) => ({ id: 'e1', issue_code: 'OB_BANK_AGGREGATE_ONLY', section: 'bank', item_id: 'i1', reason: 'Bank confirmation requested from branch', accepted_by: UUID, accepted_by_name: 'Noura Al-Shehri', ended_by_name: null, accepted_at: '2026-10-26 08:00:00+00', status: 'active', acknowledged_difference: null, ended_at: null, end_reason: null, ...o });

type Ev = { recon?: unknown; issues?: unknown[]; exceptions?: unknown[]; fail?: 'exceptions' | 'recon' };
function page(o: { status?: string; difference?: string; items?: unknown[]; ev?: Ev } = {}) {
  const ev = o.ev ?? {};
  const issues = ev.issues ?? [];
  const items = o.items ?? [item('i1', 'debit'), item('i2', 'credit')];
  return vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return json({});
    if (url === '/api/fiscal-years') return json({ fiscalYears: [yr] });
    if (url === '/api/accounts') return json({ accounts: [{ id: 'a1', code: '1000', name: 'Cash', account_type: 'asset', is_active: true }] });
    if (url === '/api/partners') return json({ partners: [] });
    if (url.endsWith('/suggestions')) return json({ suggestions: [] });
    if (url.endsWith('/reconciliation')) return ev.fail === 'recon' ? json({ error: 'x' }, 500) : json(ev.recon ?? { status: 'verified', blocking: false, issues: [] });
    if (url.endsWith('/exceptions')) return ev.fail === 'exceptions' ? json({ error: 'x' }, 500) : json({ required_count: issues.length, accepted_unverified_count: (issues as any[]).filter(i => i.acceptance === 'accepted_unverified').length, stale_count: (issues as any[]).filter(i => i.acceptance === 'stale').length, issues, exceptions: ev.exceptions ?? [] });
    if (url.includes('/api/opening-balances/')) return json({ year: yr, review: { id: 'r1', status: o.status ?? 'in_review', journal_entry_id: null }, items, summary: { debit: '10.00', credit: o.difference && o.difference !== '0.00' ? '0.00' : '10.00', difference: o.difference ?? '0.00', confidence: { high: 2, medium: 0, low: 0 } } });
    return json({});
  });
}
const view = (p: Partial<React.ComponentProps<typeof OpeningBalanceReview>> = {}) => render(<OpeningBalanceReview canView canCreate canEdit canDelete canSubmit canReview canApprove canAcceptException onUnauthorized={vi.fn()} {...p} />);
const tab = (name: RegExp) => screen.findByRole('tab', { name });
const go = async (name: RegExp) => { fireEvent.click(await tab(name)); };
const approve = () => screen.getByRole('button', { name: /^Approve/ }) as HTMLButtonElement;
const submit = () => screen.getByRole('button', { name: 'Submit for review' }) as HTMLButtonElement;
const settle = () => new Promise(r => setTimeout(r, 40));

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); window.history.replaceState(null, '', '/'); });

describe('three tabs', () => {
  it('renders the Balance Items, Reconciliation & Evidence and Review & Approval tabs with ARIA relationships', async () => {
    vi.stubGlobal('fetch', page()); view();
    const tabs = await screen.findAllByRole('tab');
    expect(tabs.map(t => t.textContent?.replace(/\s*\d+$/, ''))).toEqual(['Balance Items', 'Reconciliation & Evidence', 'Review & Approval']);
    expect(screen.getByRole('tablist')).toBeTruthy();
    for (const t of tabs) {
      const panel = document.getElementById(t.getAttribute('aria-controls')!)!;
      expect(panel.getAttribute('role')).toBe('tabpanel');
      expect(panel.getAttribute('aria-labelledby')).toBe(t.id);
    }
    expect(tabs[0]!.getAttribute('aria-selected')).toBe('true');
    expect(tabs.map(t => t.tabIndex)).toEqual([0, -1, -1]);
  });

  it('keeps inactive panels mounted but hidden so their controls are unreachable', async () => {
    vi.stubGlobal('fetch', page({ ev: { issues: [incomplete()] } })); view();
    await screen.findByRole('tab', { name: /Balance Items/ });
    const recon = document.getElementById('ob-panel-recon')!, review = document.getElementById('ob-panel-review')!;
    await waitFor(() => expect(recon.textContent).toContain('Evidence review'));
    expect(recon.hidden).toBe(true); expect(review.hidden).toBe(true);
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Accept…/ })).toBeNull();
    await go(/Reconciliation/);
    expect(recon.hidden).toBe(false);
    expect(document.getElementById('ob-panel-items')!.hidden).toBe(true);
  });

  it('supports Arrow, Home and End keys in LTR', async () => {
    vi.stubGlobal('fetch', page()); view();
    const first = await tab(/Balance Items/); first.focus();
    fireEvent.keyDown(first, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(await tab(/Reconciliation/));
    fireEvent.keyDown(document.activeElement!, { key: 'End' });
    expect(document.activeElement).toBe(await tab(/Review & Approval/));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(await tab(/Balance Items/));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(await tab(/Review & Approval/));
    fireEvent.keyDown(document.activeElement!, { key: 'Home' });
    expect(document.activeElement).toBe(await tab(/Balance Items/));
    expect((await tab(/Balance Items/)).getAttribute('aria-selected')).toBe('true');
  });

  it('reverses the arrow keys in Arabic (RTL) and uses Arabic labels', async () => {
    await i18n.changeLanguage('ar');
    vi.stubGlobal('fetch', page()); view();
    const first = await tab(/بنود الأرصدة/); first.focus();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(await tab(/التسوية والأدلة/));
    fireEvent.keyDown(document.activeElement!, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(await tab(/بنود الأرصدة/));
    expect(await tab(/المراجعة والاعتماد/)).toBeTruthy();
  });
});

describe('approval gate is unchanged by switching tabs', () => {
  const cases: Array<[string, Ev, boolean]> = [
    ['accepted exception', { issues: [incomplete({ acceptance: 'accepted_unverified', exception_id: 'e1' })], exceptions: [exRow()] }, true],
    ['clean evidence', {}, true],
    ['missing acceptance', { issues: [incomplete()] }, false],
    ['stale acceptance', { issues: [incomplete({ acceptance: 'stale', exception_id: 'e1' })], exceptions: [exRow()] }, false],
    ['withdrawn acceptance (revoked row, issue back to none)', { issues: [incomplete()], exceptions: [exRow({ status: 'revoked', ended_at: '2026-10-27 06:00:00+00', end_reason: 'Evidence received', ended_by_name: 'Khaled Al-Mutairi' })] }, false],
    ['blocked finding', { recon: { status: 'blocked', blocking: true, issues: [{ code: 'OB_REFERENCE_INVALID', class: 'blocked', section: 'bank', item_id: 'i1' }] } }, false],
    ['mismatched evidence', { recon: { status: 'mismatch', blocking: true, issues: [{ code: 'OB_BANK_AMOUNT_MISMATCH', class: 'mismatch', section: 'bank', item_id: 'i1' }] } }, false],
    ['failed gate load (exceptions)', { fail: 'exceptions' }, false],
    ['failed gate load (reconciliation)', { fail: 'recon' }, false],
  ];
  it.each(cases)('%s', async (_n, ev, enabled) => {
    vi.stubGlobal('fetch', page({ ev })); view();
    await go(/Review & Approval/);
    await waitFor(() => expect(approve().disabled).toBe(!enabled));
    for (const to of [/Balance Items/, /Reconciliation/, /Review & Approval/, /Reconciliation/, /Review & Approval/]) {
      await go(to);
      await settle();
      if (to.source.startsWith('Review')) expect(approve().disabled).toBe(!enabled);
    }
    // readiness summary agrees with the button
    expect(screen.queryAllByText(/prevent(s)? approval/).length > 0).toBe(!enabled);
  });
});

describe('submit and approve follow the backend rules', () => {
  it('lets an unbalanced draft be submitted for review but never approved', async () => {
    vi.stubGlobal('fetch', page({ status: 'draft', difference: '10.00', items: [item('i1', 'debit')] })); view();
    await go(/Review & Approval/);
    await waitFor(() => expect(submit().disabled).toBe(false));
    expect(screen.getAllByText(/Debit does not equal credit/).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
  });
  it('does not require accepted exceptions to submit, and says so', async () => {
    vi.stubGlobal('fetch', page({ status: 'draft', ev: { issues: [incomplete()] } })); view();
    await go(/Review & Approval/);
    await waitFor(() => expect(submit().disabled).toBe(false));
    expect(screen.getAllByText(/does not block submitting/).length).toBeGreaterThan(0);
  });
  it('blocks submit for blocked or mismatched findings with an explanation, and keeps it open for reconciliation load failure', async () => {
    vi.stubGlobal('fetch', page({ status: 'draft', ev: { recon: { status: 'mismatch', blocking: true, issues: [{ code: 'OB_BANK_AMOUNT_MISMATCH', class: 'mismatch', section: 'bank', item_id: 'i1' }] } } })); view();
    await go(/Review & Approval/);
    await waitFor(() => expect(submit().disabled).toBe(true));
    expect(screen.getByText(/Submitting is unavailable/)).toBeTruthy();
  });
  it('fails closed for approval (not submit) when the evidence review cannot be loaded', async () => {
    vi.stubGlobal('fetch', page({ status: 'draft', ev: { fail: 'recon' } })); view();
    await go(/Review & Approval/);
    await waitFor(() => expect(submit().disabled).toBe(false));
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
  });
  it('keeps permission-gated actions hidden', async () => {
    vi.stubGlobal('fetch', page({ status: 'in_review' })); view({ canApprove: false, canReview: false, canSubmit: false });
    await go(/Review & Approval/);
    expect(screen.queryByRole('button', { name: /^Approve/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Return to draft' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull();
  });
});

describe('readiness summary', () => {
  it('describes the problem, affected item and action, and navigates to the finding', async () => {
    vi.stubGlobal('fetch', page({ ev: { recon: { status: 'mismatch', blocking: true, issues: [{ code: 'OB_BANK_AMOUNT_MISMATCH', class: 'mismatch', section: 'bank', item_id: 'i1' }] } } })); view();
    expect((await screen.findAllByText(/Evidence mismatch/)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Amount differs from the bank statement balance/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Bank · 1000 · 10.00/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/cannot be accepted as an exception/).length).toBeGreaterThan(0);
    const more = screen.queryByRole('button', { name: 'Show details' }); if (more) fireEvent.click(more);
    fireEvent.click(screen.getAllByRole('button', { name: 'Go to fix' })[0]!);
    expect((await tab(/Reconciliation/)).getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(document.activeElement?.getAttribute('data-finding')).toBe('ob-r-0'));
  });
  it('never invents an item id: whole-section findings link without an item', async () => {
    vi.stubGlobal('fetch', page({ ev: { recon: { status: 'blocked', blocking: true, issues: [{ code: 'OB_CONTROL_ACCOUNT_UNMAPPED', class: 'blocked', section: 'receivable' }] } } })); view();
    await screen.findAllByText(/Blocked finding/);
    expect(screen.queryByRole('button', { name: 'Show item' })).toBeNull();
  });
});

describe('acceptance identity and bidirectional text', () => {
  it('shows the display name, never the UUID, and a localized fallback when the user is unavailable', async () => {
    const accepted = (key: string, id: string, name: string | null) => ({ issue: incomplete({ issue_key: key, acceptance: 'accepted_unverified', exception_id: id }), row: exRow({ id, accepted_by_name: name, item_id: 'i1' }) });
    const a = accepted(K1, 'e1', 'Noura Al-Shehri'), b = accepted(K2, 'e2', null);
    vi.stubGlobal('fetch', page({ ev: { issues: [a.issue, b.issue], exceptions: [a.row, b.row] } })); view();
    await go(/Reconciliation/);
    expect((await screen.findAllByText('Noura Al-Shehri')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('User unavailable').length).toBeGreaterThan(0);
    expect(document.body.textContent).not.toContain(UUID);
    expect(screen.getAllByText('26 Oct 2026, 11:00').length).toBeGreaterThanOrEqual(2);
  });
  it('localizes the fallback in Arabic and isolates user-entered reasons with dir="auto"', async () => {
    await i18n.changeLanguage('ar');
    const i = incomplete({ acceptance: 'accepted_unverified', exception_id: 'e1' });
    vi.stubGlobal('fetch', page({ ev: { issues: [i], exceptions: [exRow({ accepted_by_name: null, reason: 'Bank confirmation requested from branch' })] } })); view();
    await go(/التسوية والأدلة/);
    expect((await screen.findAllByText('مستخدم غير متاح')).length).toBeGreaterThan(0);
    const reason = screen.getAllByText('Bank confirmation requested from branch')[0]!;
    expect(reason.closest('bdi')?.getAttribute('dir')).toBe('auto');
    expect(document.body.textContent).not.toContain(UUID);
  });
  it('renders history in the Review tab with names and keeps English labels in English mode', async () => {
    vi.stubGlobal('fetch', page({ ev: { issues: [incomplete()], exceptions: [exRow({ status: 'revoked', ended_at: '2026-10-27 06:00:00+00', end_reason: 'سبب الإنهاء بالعربية', ended_by_name: 'Khaled Al-Mutairi' })] } })); view();
    await go(/Review & Approval/);
    const host = document.querySelector('.ob-history-host') as HTMLElement;
    await waitFor(() => expect(within(host).getByText('Exception acceptance history')).toBeTruthy());
    expect(within(host).getByText('Khaled Al-Mutairi')).toBeTruthy();
    expect(within(host).getByText('سبب الإنهاء بالعربية').closest('bdi')?.getAttribute('dir')).toBe('auto');
  });
  it('does not hard-code RTL for the as-of date in English', async () => {
    vi.stubGlobal('fetch', page()); view();
    await screen.findByText(/As of/);
    expect(document.querySelector('.ob-context__asof bdi')?.getAttribute('dir')).toBeNull();
  });
});

