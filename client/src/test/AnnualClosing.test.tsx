import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { AnnualClosing } from '../components/AnnualClosing';

describe('Annual Closing Center', () => {
  beforeEach(async () => { vi.restoreAllMocks(); await i18n.changeLanguage('en'); });
  it('is capability gated', () => { render(<AnnualClosing canView={false} onUnauthorized={vi.fn()}/>); expect(screen.getByText(/permission to view annual closing/i)).toBeInTheDocument(); });
  it('loads a fiscal-year keyed readiness view and renders domains and manifest', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ fiscalYears: [{ id: 'fy-1', name: 'FY', start_date: '2025-04-01', end_date: '2026-03-31' }] }), { status: 200 }));
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ready: false, blocker_count: 1, financial_statements_readiness: { status: 'needs_review', label: 'Ready for financial statement preparation', label_ar: 'جاهز لإعداد القوائم المالية' }, zakat_readiness: { status: 'needs_review' }, domains: { monthly_close: { ready: false, blocker_count: 1, status: 'blocked', summary: {} } }, package_manifest: [{ section: 'fiscal_year', status: 'ready' }] }), { status: 200 }));
    render(<AnnualClosing canView onUnauthorized={vi.fn()}/>);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/annual-closing/fy-1'));
    expect(await screen.findByText('Not ready')).toBeInTheDocument(); expect(screen.getByText('Monthly close')).toBeInTheDocument(); expect(screen.getByText('Annual Closing Package manifest')).toBeInTheDocument();
  });
});
