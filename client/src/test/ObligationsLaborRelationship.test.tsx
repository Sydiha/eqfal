import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ObligationsAging, type AgingReport } from '../components/ObligationsAging';
import i18n from '../i18n';
import { render } from './test-utils';

const empty = { buckets: [], total_outstanding: '0.00', item_count: 0, items: [] };
const report = (labor: string | null): AgingReport => ({
  as_of_date: '2026-06-30',
  receivables: empty,
  payables: {
    buckets: [{ bucket: 'current', amount: '150.00', count: 2 }],
    total_outstanding: '150.00', item_count: 2, labor_related_outstanding: labor ? '50.00' : '0.00', labor_related_count: labor ? 1 : 0,
    items: [
      { obligation_id: 'a', counterparty_name: 'Supplier Co', counterparty_labor_relationship: null, source_type: 'manual', recognized_on: '2026-01-01', due_on: null, original_amount: '100.00', settled_amount: '0.00', outstanding_amount: '100.00', days_overdue: 0, bucket: 'current' },
      { obligation_id: 'b', counterparty_name: 'Worker X', counterparty_labor_relationship: labor, source_type: 'manual', recognized_on: '2026-01-01', due_on: null, original_amount: '50.00', settled_amount: '0.00', outstanding_amount: '50.00', days_overdue: 0, bucket: 'current' },
    ],
  },
});

describe('aging report labor relationship display', () => {
  beforeEach(async () => { await i18n.changeLanguage('en'); });

  it('tags labor-related counterparties and shows the separate non-payroll subtotal', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(report('unresolved')))));
    render(<ObligationsAging onUnauthorized={vi.fn()} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Payables (AP)' }));
    expect(await screen.findByText('Worker X')).toBeInTheDocument();
    expect(screen.getByText(/Unresolved relationship/)).toBeInTheDocument();
    expect(screen.getByText(/not payroll/)).toBeInTheDocument();
    expect(screen.getAllByText('50.00').length).toBeGreaterThan(1);
  });

  it('shows no labor line for ordinary counterparties', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(report(null)))));
    render(<ObligationsAging onUnauthorized={vi.fn()} />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Payables (AP)' }));
    await screen.findByText('Worker X');
    expect(screen.queryByText(/not payroll/)).toBeNull();
  });
});
