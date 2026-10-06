import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../App';
import { AuthProvider } from '../context/AuthContext';
import i18n from '../i18n';

describe('purchase capitalisation navigation', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    window.history.replaceState({}, '', '/?page=purchases');

    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString();

      if (url === '/api/auth/session') {
        return new Response(JSON.stringify({
          user: { id: 'u1', email: 'user@example.com' },
          allowedCompanies: [{ id: 'co-1', name: 'Company One', name_ar: null }],
          activeCompanyId: 'co-1',
          capabilities: ['document.view', 'obligation.view', 'asset.view', 'asset.create'],
        }), { status: 200 });
      }

      if (url === '/api/purchases') {
        return new Response(JSON.stringify({
          purchases: [{
            id: 'purchase-1',
            document_type: 'purchase',
            original_filename: 'asset.pdf',
            status: 'approved',
            document_date: '2026-11-12',
            reference_number: 'EQFAL-14E-ASSET-PUR-001',
            total_amount: '3600.00',
            intake_note: null,
            counterparty_id: 'supplier-1',
            supplier_name: 'Supplier One',
            counterparty_type: 'supplier',
            payable_id: null,
            payable_original_amount: null,
            due_on: null,
            verification_status: null,
            payable_cancelled: false,
            payable_relationship: 'not_created',
            paid_amount: '0.00',
            remaining_amount: '3600.00',
            financial_state: 'open',
            settlement_history: [],
            vat_review_status: 'missing',
            tax_date: null,
            vat_treatment: null,
            taxable_amount: null,
            vat_amount: null,
            asset_id: null,
          }],
        }), { status: 200 });
      }

      if (url === '/api/assets') return new Response(JSON.stringify({ assets: [] }), { status: 200 });
      if (url === '/api/asset-categories') return new Response(JSON.stringify({ categories: [] }), { status: 200 });

      return new Response(JSON.stringify({}), { status: 200 });
    }));
  });

  it('preserves the purchase id when navigating to fixed-asset capitalisation', async () => {
    render(<AuthProvider><App /></AuthProvider>);

    // No row is selected automatically; open the purchase details explicitly.
    fireEvent.click((await screen.findByText('EQFAL-14E-ASSET-PUR-001')).closest('tr')!);
    fireEvent.click(await screen.findByRole('button', { name: 'Capitalise as Fixed Asset' }));

    const params = new URLSearchParams(window.location.search);
    expect(params.get('page')).toBe('assets');
    expect(params.get('assetDocument')).toBe('purchase-1');
    expect(await screen.findByRole('button', { name: 'Capitalise as Fixed Asset' })).toBeInTheDocument();
  });
});
