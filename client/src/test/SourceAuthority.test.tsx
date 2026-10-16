import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { SourceAuthority } from '../components/SourceAuthority';

const year = { id: 'fy-1', name: 'FY 2026', start_date: '2026-01-01', end_date: '2026-12-31', status: 'open' };
const draft = { id: 'r-1', from_date: '2026-01-01', to_date: '2026-06-30', status: 'draft', reason: 'Excel until June', void_reason: null, created_at: '2026-10-16T00:00:00Z' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function stub(ranges: unknown[], post?: (url: string, body: any) => Response) {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return post ? post(url, JSON.parse(String(init.body))) : json({});
    if (url === '/api/ledger-source-authority') return json({ ranges });
    return json({ fiscalYears: [year] });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(async () => { await i18n.changeLanguage('en'); vi.restoreAllMocks(); });

describe('SourceAuthority', () => {
  it('shows a loading state, then the empty state', async () => {
    stub([]);
    render(<SourceAuthority canManage onUnauthorized={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
    expect(await screen.findByText('No configurations.')).toBeInTheDocument();
  });

  it('is LTR in English and RTL in Arabic', async () => {
    stub([]);
    const en = render(<SourceAuthority canManage onUnauthorized={vi.fn()} />);
    expect(en.container.querySelector('section')).toHaveAttribute('dir', 'ltr');
    en.unmount();
    await i18n.changeLanguage('ar');
    const ar = render(<SourceAuthority canManage onUnauthorized={vi.fn()} />);
    expect(ar.container.querySelector('section')).toHaveAttribute('dir', 'rtl');
    expect(await screen.findByText('لا توجد إعدادات.')).toBeInTheDocument();
  });

  it('keeps Save disabled until year, date, reason and the explicit confirmation are all given, then posts confirm:true and never offers activation', async () => {
    const fetchMock = stub([], () => json({ range: draft }, 201));
    render(<SourceAuthority canManage onUnauthorized={vi.fn()} />);
    await screen.findByText('No configurations.');
    fireEvent.click(screen.getAllByText('Select')[1]!);
    const save = screen.getByRole('button', { name: 'Save configuration' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Fiscal year'), { target: { value: 'fy-1' } });
    fireEvent.change(screen.getByLabelText(/Last day whose books/), { target: { value: '2026-06-30' } });
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'Excel until June' } });
    expect(save).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox'));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, i]) => u === '/api/ledger-source-authority/drafts' && JSON.parse(String((i as RequestInit).body)).confirm === true)).toBe(true));
    expect(screen.queryByText(/activate/i)).toBeNull();
  });

  it('labels a draft as recorded and not financially ready, and requires reason + confirmation to void it', async () => {
    const fetchMock = stub([draft], () => json({ range: { ...draft, status: 'voided' } }));
    render(<SourceAuthority canManage onUnauthorized={vi.fn()} />);
    expect(await screen.findByText('Recorded, not financially ready')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Void' }));
    const confirmVoid = screen.getByRole('button', { name: 'Confirm void' });
    expect(confirmVoid).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Void reason (required)'), { target: { value: 'Changed plan' } });
    expect(confirmVoid).toBeDisabled();
    fireEvent.click(within(screen.getByLabelText('Void reason (required)').closest('form')!).getByRole('checkbox'));
    expect(confirmVoid).toBeEnabled();
    fireEvent.click(confirmVoid);
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/ledger-source-authority/r-1/void-draft')).toBe(true));
  });

  it('hides write controls without manage permission and shows a server error in the selected language', async () => {
    stub([draft]);
    const view = render(<SourceAuthority canManage={false} onUnauthorized={vi.fn()} />);
    await screen.findByText('Recorded, not financially ready');
    expect(screen.queryByRole('button', { name: 'Void' })).toBeNull();
    view.unmount();

    await i18n.changeLanguage('ar');
    stub([], () => json({ code: 'AUTHORITY_RANGE_OVERLAP' }, 409));
    render(<SourceAuthority canManage onUnauthorized={vi.fn()} />);
    await screen.findByText('لا توجد إعدادات.');
    fireEvent.click(screen.getAllByText('عرض')[1]!);
    fireEvent.change(screen.getByLabelText('السنة المالية'), { target: { value: 'fy-1' } });
    fireEvent.change(screen.getByLabelText(/آخر يوم/), { target: { value: '2026-06-30' } });
    fireEvent.change(screen.getByLabelText('السبب (إلزامي)'), { target: { value: 'سبب' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.click(screen.getByRole('button', { name: 'حفظ الإعداد' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('تتداخل');
  });
});
