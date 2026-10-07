import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ObligationsAging, type AgingReport } from '../components/ObligationsAging';
import { Obligations } from '../components/Obligations';
import { render as renderWithContext } from './test-utils';
import i18n from '../i18n';

const side = (items: AgingReport['receivables']['items'], amounts: Record<string, string>, total: string): AgingReport['receivables'] => ({
  buckets: (['current', 'days_1_30', 'days_31_60', 'days_61_90', 'days_over_90'] as const).map((bucket) => ({ bucket, amount: amounts[bucket] ?? '0.00', count: items.filter((i) => i.bucket === bucket).length })),
  total_outstanding: total, item_count: items.length, items,
});
const item = (id: string, name: string, bucket: AgingReport['receivables']['items'][number]['bucket'], days: number, due: string | null, outstanding: string) => ({
  obligation_id: id, counterparty_name: name, source_type: 'manual', recognized_on: '2026-01-01', due_on: due, original_amount: outstanding, settled_amount: '0.00', outstanding_amount: outstanding, days_overdue: days, bucket,
});
const report: AgingReport = {
  as_of_date: '2026-06-30',
  receivables: side([item('r1', 'Customer A', 'days_31_60', 31, '2026-05-30', '180.00'), item('r2', 'Customer B', 'current', 0, null, '1220.00')], { current: '1220.00', days_31_60: '180.00' }, '1400.00'),
  payables: side([], {}, '0.00'),
};

describe('AR/AP aging report view', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); });

  it('loads with the server as-of date and renders receivable buckets, total and details', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(report)));
    vi.stubGlobal('fetch', fetchMock);
    render(<ObligationsAging onUnauthorized={vi.fn()} />);
    expect(await screen.findByText('Customer A')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith('/api/obligations/aging', expect.anything());
    expect(screen.getByLabelText('As of')).toHaveValue('2026-06-30');
    const buckets = screen.getByLabelText('Receivables (AR)');
    expect(within(buckets).getByText('31–60 days').nextSibling).toHaveTextContent('180.00');
    expect(within(buckets).getByText('Total outstanding').nextSibling).toHaveTextContent('1,400.00');
    const row = screen.getByText('Customer A').closest('tr')!;
    expect(row).toHaveTextContent('2026-05-30');
    expect(row).toHaveTextContent('31');
    expect(screen.getByText('Customer B').closest('tr')).toHaveTextContent('No due date');
    expect(screen.queryByRole('button', { name: /export|csv|pdf/i })).not.toBeInTheDocument();
  });

  it('shows an empty state for a side with nothing outstanding and re-runs for an explicit date', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(report)));
    vi.stubGlobal('fetch', fetchMock);
    render(<ObligationsAging onUnauthorized={vi.fn()} />);
    await screen.findByText('Customer A');
    fireEvent.click(screen.getByRole('tab', { name: 'Payables (AP)' }));
    expect(screen.getByText('No confirmed obligations are outstanding on this date.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('As of'), { target: { value: '2026-07-31' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/obligations/aging?as_of_date=2026-07-31', expect.anything());
  });

  it('renders Arabic labels and an error state with retry', async () => {
    await i18n.changeLanguage('ar');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    render(<ObligationsAging onUnauthorized={vi.fn()} />);
    expect(await screen.findByText('تعذّر تحميل تقرير الأعمار.')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'الذمم المدينة' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'إعادة المحاولة' })).toBeInTheDocument();
  });

  it('opens from the Obligations page through an Aging report tab without changing the register', async () => {
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.startsWith('/api/obligations/aging') ? report
        : url === '/api/obligations' ? { obligations: [], eligible_documents: [], summary: { open_receivables: '0.00', open_payables: '0.00', unconfirmed_receivables: '0.00', unconfirmed_payables: '0.00', unconfirmed_count: 0, partially_settled_count: 0, overdue_count: 0 } }
          : { counterparties: [] })));
    vi.stubGlobal('fetch', fetchMock);
    renderWithContext(<Obligations canView onUnauthorized={vi.fn()} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Aging report' }));
    expect(await screen.findByRole('heading', { name: 'AR/AP aging report' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Register' }));
    expect(screen.queryByRole('heading', { name: 'AR/AP aging report' })).not.toBeInTheDocument();
  });
});
