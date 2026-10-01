import React, { useEffect } from 'react';
import ReactDOM from 'react-dom/client';
import '@mantine/core/styles.css';
import { DirectionProvider, MantineProvider } from '@mantine/core';
import './i18n';
import i18n from './i18n';
import './visual-foundation.css';
import { Home } from './components/Home';
import { eqfalTheme } from './theme';

const capabilities = [
  'monthly_close.view',
  'document.view',
  'obligation.view',
  'bank.view',
  'vat.view',
  'accounting.view',
];

const originalFetch = window.fetch.bind(window);

window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url;

  if (url === '/api/manager-financial-snapshot') {
    return new Response(JSON.stringify({
      metrics: {
        bank_balances: {
          state: 'available',
          accounts: [
            { id: 'bank-1', display_name: 'Operating account', currency_code: 'SAR', balance: { state: 'available', amount: '184250.75' } },
            { id: 'bank-2', display_name: 'Reserve account', currency_code: 'SAR', balance: { state: 'available', amount: '76500.00' } },
          ],
        },
        amounts_to_collect: { state: 'available', amount: '52340.00' },
        amounts_to_pay: { state: 'available', amount: '18750.50' },
        current_month_sales: { state: 'available', amount: '96400.00' },
        current_month_purchases_expenses: { state: 'available', amount: '41280.25' },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (url === '/api/home-alerts') {
    return new Response(JSON.stringify({
      alerts: [
        { key: 'documents_needs_review', class: 'needs_review_completion', ownership: 'current_user', count: 4, destination: 'documents', parameters: { status: 'needs_review' } },
        { key: 'upcoming_obligations', class: 'upcoming_due', ownership: 'upcoming', count: 3, destination: 'obligations', parameters: { dueFrom: '2026-10-01', dueTo: '2026-10-31' } },
        { key: 'bank_transactions_unmatched', class: 'needs_review_completion', ownership: 'waiting_for_accountant', count: 7, destination: 'banks', parameters: { section: 'transactions', reconciliation: 'unmatched' } },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (url === '/api/monthly-close-periods') {
    return new Response(JSON.stringify({
      periods: [
        {
          id: 'preview-period',
          fiscal_year_id: 'fy-2026',
          period_start: '2026-10-01',
          period_end: '2026-10-31',
          status: 'open',
          ready: false,
          disclosed_total: 3,
          has_hidden_blockers: false,
          blockers: {
            documents: 1,
            obligations: 1,
            bank_transactions: 1,
            vat: 0,
            ledger: 0,
          },
        },
      ],
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }

  if (typeof input === 'string' && input.startsWith('/api/')) {
    return new Response('', { status: 404 });
  }

  return originalFetch(input, init);
};

function PreviewApp() {
  const isArabic = i18n.language === 'ar';
  const direction = isArabic ? 'rtl' : 'ltr';

  useEffect(() => {
    document.documentElement.dir = direction;
    document.documentElement.lang = isArabic ? 'ar' : 'en';
  }, [direction, isArabic]);

  const noop = () => {};

  return (
    <DirectionProvider initialDirection={direction}>
      <MantineProvider theme={eqfalTheme} defaultColorScheme="light">
        <div style={{ minHeight: '100%', background: '#fff' }}>
          <div
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 50,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 12,
              padding: '8px 14px',
              background: '#0B1D33',
              color: '#fff',
              fontFamily: 'Tajawal, Inter, sans-serif',
              fontSize: 12,
              fontWeight: 700,
            }}
          >
            <span>{isArabic ? 'معاينة بصرية فقط — بيانات تجريبية' : 'Visual Review Preview — Mock data only'}</span>
            <button
              type="button"
              onClick={() => void i18n.changeLanguage(isArabic ? 'en' : 'ar')}
              style={{
                border: '1px solid rgba(255,255,255,.35)',
                background: 'transparent',
                color: '#fff',
                borderRadius: 8,
                padding: '6px 10px',
                cursor: 'pointer',
                font: 'inherit',
              }}
            >
              {isArabic ? 'English' : 'العربية'}
            </button>
          </div>
          <Home
            capabilities={capabilities}
            navigate={noop}
            navigateToDiscovery={noop}
            startPurchaseEntry={noop}
            startSalesEntry={noop}
            onUnauthorized={noop}
          />
        </div>
      </MantineProvider>
    </DirectionProvider>
  );
}

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Root element not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <PreviewApp />
  </React.StrictMode>,
);
