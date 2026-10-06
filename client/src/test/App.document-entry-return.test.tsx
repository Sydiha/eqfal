import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { AuthProvider } from '../context/AuthContext';
import i18n from '../i18n';

const sale = {
  id: 'sale-doc', original_filename: 'sale.pdf', status: 'uploaded', document_date: '2026-08-01',
  reference_number: 'SALE-1', total_amount: '100.00', intake_note: null, counterparty_id: 'c1', customer_name: 'Customer',
  counterparty_type: 'customer', receivable_id: null, receivable_original_amount: null, due_on: '2026-09-01',
  verification_status: null, receivable_cancelled: false, receivable_relationship: 'not_created', paid_amount: '0.00',
  remaining_amount: '100.00', financial_state: 'open', settlement_history: [], vat_review_status: 'missing',
  tax_date: null, vat_treatment: null, taxable_amount: null, vat_amount: null, asset_id: null,
};

describe('document entry navigation from Sales', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    window.history.replaceState({}, '', '/?page=sales&salesFinancial=open');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/auth/session') {
        return new Response(JSON.stringify({
          user: { id: 'u1', email: 'user@example.com' },
          allowedCompanies: [{ id: 'co-1', name: 'Company One', name_ar: null }],
          activeCompanyId: 'co-1',
          capabilities: ['document.view', 'document.edit', 'document.upload', 'obligation.view'],
        }), { status: 200 });
      }
      if (url.startsWith('/api/sales')) return new Response(JSON.stringify({ sales: [sale] }), { status: 200 });
      if (url.startsWith('/api/documents')) return new Response(JSON.stringify({ documents: [], counterparties: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    }));
  });

  it('returns to Sales with the same filters after opening a document for editing', async () => {
    render(<AuthProvider><App /></AuthProvider>);
    fireEvent.click((await screen.findByText('SALE-1')).closest('tr')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('page')).toBe('documents'));
    expect(new URLSearchParams(window.location.search).get('salesFinancial')).toBeNull();

    const returnButton = (await screen.findAllByRole('button', { name: 'Sales' })).find(button => !button.closest('nav, aside, header'))!;
    fireEvent.click(returnButton);
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('page')).toBe('sales'));
    expect(new URLSearchParams(window.location.search).get('salesFinancial')).toBe('open');
  });

  it('keeps the filtered Sales history entry so browser Back restores the filters', async () => {
    render(<AuthProvider><App /></AuthProvider>);
    fireEvent.click((await screen.findByText('SALE-1')).closest('tr')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('page')).toBe('documents'));
    window.history.back();
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('page')).toBe('sales'));
    expect(new URLSearchParams(window.location.search).get('salesFinancial')).toBe('open');
  });
});
