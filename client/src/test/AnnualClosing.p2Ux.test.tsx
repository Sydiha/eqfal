import { fireEvent, render, screen, waitFor, within } from './test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import i18n from '../i18n';
import { AnnualClosing } from '../components/AnnualClosing';

const fy = { id: 'fy-1', name: 'FY 2025', start_date: '2025-01-01', end_date: '2025-12-31' };
const readiness = { ready: false, blocker_count: 1, financial_statements_readiness: { status: 'blocked', label: 'Financial statements', label_ar: 'القوائم المالية' }, zakat_readiness: { status: 'ready' }, domains: {}, package_manifest: [] };
const packageData = (overrides: Record<string, unknown> = {}) => ({
  package: { id: 'p-1', status: 'draft', version: 1, final_snapshot_id: null, finalized_at: null, handed_off_at: null, handoff_note: null, handoff_reference: null, reviewed_by_user_id: null, reviewed_at: null, review_note: null, approved_by_user_id: null, approved_at: null, approval_note: null, snapshots: [], ...overrides },
  live: { manifest: [{ section: 'monthly_close', status: 'blocked', blocker_count: 1, blockers: ['monthly_close_not_ready'], source: 'monthly-close', summary: {} }], source_fingerprint: 'f' }, drift: false,
});
const openPackage = async () => fireEvent.click(await screen.findByRole('tab', { name: /closing package|حزمة الإقفال/i }));

function mockApi(options: { finalize?: { blockers: string[] }; pkg?: ReturnType<typeof packageData> } = {}) {
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
    const url = String(input);
    if (url === '/api/fiscal-years') return Promise.resolve(json({ fiscalYears: [fy] }));
    if (init?.method === 'POST' && url.endsWith('/package/finalize')) return Promise.resolve(json({ error: 'Annual package is blocked', blockers: options.finalize?.blockers ?? [] }, options.finalize ? 422 : 200));
    if (url.endsWith('/package')) return Promise.resolve(json(options.pkg ?? packageData()));
    return Promise.resolve(json(readiness));
  });
}

describe('Annual Closing P2 UI fixes', () => {
  beforeEach(async () => { vi.restoreAllMocks(); await i18n.changeLanguage('en'); window.history.replaceState(null, '', '/'); document.documentElement.dir = 'ltr'; });

  it.each([
    ['en', 'Section', 'State', 'Source', 'Blockers'],
    ['ar', 'القسم', 'الحالة', 'المصدر', 'العوائق'],
  ])('labels all package manifest cells in %s for a mobile stacked layout', async (language, section, state, source, blockers) => {
    await i18n.changeLanguage(language);
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
    mockApi();
    const { container } = render(<AnnualClosing canView canViewPackage onUnauthorized={vi.fn()} />);
    await openPackage();
    await waitFor(() => expect(container.querySelector('.ac-package-manifest tbody tr')).toBeInTheDocument());
    const table = container.querySelector('.ac-package-manifest');
    expect(table).toBeInTheDocument();
    const row = table!.querySelector('tbody tr')!;
    expect(Array.from(row.querySelectorAll('td')).map(cell => cell.getAttribute('data-label'))).toEqual([section, state, source, blockers]);
    const css = readFileSync(resolve(__dirname, '../components/AnnualClosing.css'), 'utf8');
    expect(css).toMatch(/@media \(max-width:800px\)[\s\S]*?\.table-wrap\.ac-stack table\{display:block;min-width:0/);
    expect(css).toContain('.table-wrap.ac-package-manifest td:last-child{grid-column:1/-1}');
    expect(document.documentElement.dir).toBe(language === 'ar' ? 'rtl' : 'ltr');
  });

  it('shows exact translated finalization details and links only to permitted destinations', async () => {
    mockApi({ finalize: { blockers: ['monthly_close:blocked', 'monthly_close:monthly_close_not_ready', 'cash_flow:cash_flow_not_ready'] } });
    const onNavigate = vi.fn();
    render(<AnnualClosing canView canViewPackage canFinalizePackage onUnauthorized={vi.fn()} onNavigate={onNavigate} canNavigate={{ monthlyClose: true, accounting: true }} />);
    await openPackage();
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize package' }));
    const warning = await screen.findByRole('alert');
    expect(within(warning).getByText('Monthly close is not ready')).toBeInTheDocument();
    expect(within(warning).getByText('Cash Flow is not ready')).toBeInTheDocument();
    const monthlyAction = within(warning).getByRole('button', { name: 'View monthly close' });
    const ledgerAction = within(warning).getByRole('button', { name: 'View ledger' });
    fireEvent.click(monthlyAction);
    fireEvent.click(ledgerAction);
    expect(onNavigate).toHaveBeenNthCalledWith(1, 'monthlyClose');
    expect(onNavigate).toHaveBeenNthCalledWith(2, 'accounting');
  });

  it('keeps a source action as plain text when its page is not authorized and hides unknown blocker codes', async () => {
    await i18n.changeLanguage('ar');
    mockApi({ finalize: { blockers: ['cash_flow:unknown_private_code'] } });
    render(<AnnualClosing canView canViewPackage canFinalizePackage onUnauthorized={vi.fn()} onNavigate={vi.fn()} canNavigate={{ accounting: false }} />);
    await openPackage();
    fireEvent.click(await screen.findByRole('button', { name: 'اعتماد الحزمة نهائياً' }));
    const warning = await screen.findByRole('alert');
    expect(within(warning).getByText('توجد متطلبات غير مكتملة تحتاج إلى المراجعة')).toBeInTheDocument();
    expect(within(warning).getByText('عرض دفتر الأستاذ')).toBeInTheDocument();
    expect(within(warning).queryByRole('button', { name: 'عرض دفتر الأستاذ' })).not.toBeInTheDocument();
    expect(warning).not.toHaveTextContent('unknown_private_code');
  });

  it.each([[true, true], [false, false]])('links to the Tax/Zakat workpaper only when its target is rendered (canViewWorkpaper=%s)', async (canViewWorkpaper, linkExpected) => {
    mockApi({ finalize: { blockers: ['tax_zakat_working_paper:workpaper_not_started'] } });
    const { container } = render(<AnnualClosing canView canViewPackage canFinalizePackage canViewWorkpaper={canViewWorkpaper} onUnauthorized={vi.fn()} />);
    await openPackage();
    fireEvent.click(await screen.findByRole('button', { name: 'Finalize package' }));
    const warning = await screen.findByRole('alert');
    const action = within(warning).getByText('View workpaper in package');
    const link = action.closest('a');
    if (linkExpected) {
      expect(link).toHaveAttribute('href', '#tax-workpaper-title');
      const target = container.querySelector('#tax-workpaper-title');
      expect(target).toBeInTheDocument();
      expect(target?.closest('[role="tabpanel"]')).not.toHaveAttribute('hidden');
    } else {
      expect(link).toBeNull();
      expect(action.tagName).toBe('SPAN');
      expect(container.querySelector('#tax-workpaper-title')).not.toBeInTheDocument();
    }
  });

  it('renders human-readable package reviewers while retaining isolated actor IDs in Arabic', async () => {
    await i18n.changeLanguage('ar');
    document.documentElement.dir = 'rtl';
    mockApi({ pkg: packageData({
      status: 'approved', reviewed_by_user_id: '11111111-1111-4111-8111-111111111111', reviewed_by_display_name: 'مراجع مالي', reviewed_at: '2025-06-02T11:30:00.000Z', review_note: 'تمت المطابقة',
      approved_by_user_id: '22222222-2222-4222-8222-222222222222', approved_by_display_name: null, approved_at: '2025-06-03T11:30:00.000Z', approval_note: null,
    }) });
    const { container } = render(<AnnualClosing canView canViewPackage onUnauthorized={vi.fn()} />);
    await openPackage();
    expect(await screen.findByText('مراجع مالي')).toBeInTheDocument();
    expect(screen.getByText('الاسم غير متاح')).toBeInTheDocument();
    const actorIds = container.querySelectorAll('.ac-actor-id');
    expect(actorIds).toHaveLength(2);
    expect(actorIds[0]).toHaveAttribute('dir', 'ltr');
    expect(actorIds[0]).toHaveTextContent('11111111-1111-4111-8111-111111111111');
    expect(actorIds[1]).toHaveAttribute('dir', 'ltr');
    expect(actorIds[1]).toHaveTextContent('22222222-2222-4222-8222-222222222222');
    await waitFor(() => expect(document.documentElement.dir).toBe('rtl'));
  });
});
