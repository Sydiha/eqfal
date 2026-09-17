import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDisplayDate } from '../date-format';

type HomePage =
  | 'fiscalYears'
  | 'monthlyClose'
  | 'vat'
  | 'documents'
  | 'banks'
  | 'partners'
  | 'obligations'
  | 'accounting'
  | 'sales'
  | 'purchases';

type DiscoveryPage = 'documents' | 'banks' | 'obligations' | 'vat' | 'accounting';

type Period = {
  id: string;
  fiscal_year_id: string;
  period_start: string;
  period_end: string;
  status: 'open' | 'closed';
  ready: boolean;
  blockers: {
    documents: number;
    obligations: number;
    bank_transactions: number;
    vat: number;
    ledger: number;
    total: number;
  };
};

type Props = {
  capabilities: readonly string[];
  navigate: (page: HomePage) => void;
  navigateToDiscovery: (page: DiscoveryPage, parameters: Record<string, string>) => void;
  startPurchaseEntry: (type: 'purchase' | 'expense') => void;
  startSalesEntry: () => void;
  onUnauthorized: () => void;
};

const stripDirectionalMarks = (value: string) => value.replace(/[\u061c\u200e\u200f]/g, '');

export function Home({ capabilities, navigate, navigateToDiscovery, startPurchaseEntry, startSalesEntry, onUnauthorized }: Props) {
  const { t, i18n } = useTranslation();
  const canViewClose = capabilities.includes('fiscal_year.view');
  const [periods, setPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(canViewClose);
  const [error, setError] = useState(false);
  const isArabic = i18n.language.startsWith('ar');
  const homeLabels = isArabic
    ? {
        dailyOperations: 'العمليات اليومية',
        addSale: 'إضافة مبيعات',
        addPurchase: 'إضافة مشتريات',
        addExpense: 'إضافة مصروف',
        uploadDocument: 'رفع مستند',
        openSales: 'فتح المبيعات',
        openPurchases: 'فتح المشتريات',
        openBanking: 'فتح البنوك',
        openObligations: 'فتح الالتزامات',
        closeBlockers: 'معوقات الإقفال',
        area: 'المجال',
        blockerState: 'حالة المعوقات',
        noBlockers: 'لا توجد معوقات',
        blockers: (count: number) => `المعوقات: ${count}`,
        readiness: 'جاهزية الإقفال',
        periodState: 'حالة الفترة',
      }
    : {
        dailyOperations: 'Daily Operations',
        addSale: 'Add sale',
        addPurchase: 'Add purchase',
        addExpense: 'Add expense',
        uploadDocument: 'Upload document',
        openSales: 'Open sales',
        openPurchases: 'Open purchases',
        openBanking: 'Open banking',
        openObligations: 'Open obligations',
        closeBlockers: 'Close blockers',
        area: 'Area',
        blockerState: 'Blocker status',
        noBlockers: 'No blockers',
        blockers: (count: number) => `Blockers: ${count}`,
        readiness: 'Close readiness',
        periodState: 'Period status',
      };

  const load = async () => {
    if (!canViewClose) return;
    setLoading(true);
    setError(false);
    try {
      const response = await fetch('/api/monthly-close-periods', { credentials: 'same-origin' });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as { periods?: Period[] };
      setPeriods(Array.isArray(payload.periods) ? payload.periods : []);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (canViewClose) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canViewClose]);

  const selected = periods[0] ?? null;
  const can = (capability: string) => capabilities.includes(capability);
  const canViewSalesPurchases = can('document.view') && can('obligation.view');
  const dailyOperations = [
    { key: 'add-sale', label: homeLabels.addSale, visible: can('document.upload'), open: startSalesEntry },
    { key: 'add-purchase', label: homeLabels.addPurchase, visible: can('document.upload'), open: () => startPurchaseEntry('purchase') },
    { key: 'add-expense', label: homeLabels.addExpense, visible: can('document.upload'), open: () => startPurchaseEntry('expense') },
    { key: 'upload-document', label: homeLabels.uploadDocument, visible: can('document.upload'), open: () => navigate('documents') },
    { key: 'open-sales', label: homeLabels.openSales, visible: canViewSalesPurchases, open: () => navigate('sales') },
    { key: 'open-purchases', label: homeLabels.openPurchases, visible: canViewSalesPurchases, open: () => navigate('purchases') },
    { key: 'open-banking', label: homeLabels.openBanking, visible: can('bank.view'), open: () => navigate('banks') },
    { key: 'open-obligations', label: homeLabels.openObligations, visible: can('obligation.view'), open: () => navigate('obligations') },
  ].filter((action) => action.visible);
  const periodParameters = selected
    ? { from: selected.period_start, to: selected.period_end }
    : null;

  const exceptions = selected
    ? [
        {
          key: 'documents',
          label: t('nav.documents'),
          count: selected.blockers.documents,
          canOpen: can('document.view'),
          open: () => navigateToDiscovery('documents', periodParameters!),
        },
        {
          key: 'obligations',
          label: t('nav.obligations'),
          count: selected.blockers.obligations,
          canOpen: can('obligation.view'),
          open: () => navigateToDiscovery('obligations', { confirmation: 'unconfirmed' }),
        },
        {
          key: 'banks',
          label: t('nav.banks'),
          count: selected.blockers.bank_transactions,
          canOpen: can('bank.view'),
          open: () => navigateToDiscovery('banks', { section: 'transactions', ...periodParameters! }),
        },
        {
          key: 'vat',
          label: t('nav.vat'),
          count: selected.blockers.vat,
          canOpen: can('vat.view'),
          open: () =>
            navigateToDiscovery('vat', {
              vatFrom: selected.period_start,
              vatTo: selected.period_end,
            }),
        },
        {
          key: 'ledger',
          label: `${t('nav.accounting')} / ${t('accounting.tabs.ledger')}`,
          count: selected.blockers.ledger,
          canOpen: can('accounting.view'),
          open: () =>
            navigateToDiscovery('accounting', {
              accountingTab: 'sources',
              sourceFrom: selected.period_start,
              sourceTo: selected.period_end,
            }),
        },
      ]
    : [];

  const closeSummary = selected
    ? selected.status === 'closed'
      ? homeLabels.noBlockers
      : selected.ready
        ? t('monthlyClose.ready')
        : homeLabels.blockers(selected.blockers.total)
    : '';

  const periodRange = selected ? (
    <span dir="ltr" style={{ unicodeBidi: 'isolate', whiteSpace: 'nowrap' }}>
      <span>{stripDirectionalMarks(formatDisplayDate(selected.period_start, i18n.language))}</span>
      <span aria-hidden="true"> — </span>
      <span>{stripDirectionalMarks(formatDisplayDate(selected.period_end, i18n.language))}</span>
    </span>
  ) : null;

  return (
    <section className="home-modern home-v21" aria-labelledby="home-title" style={{ maxWidth: 1360 }}>
      <header className="home-hero home-v21__hero">
        <div className="home-hero-copy">
          <p className="home-eyebrow">{t('home.workspace')}</p>
          <h1 id="home-title">{t('home.welcome')}</h1>
          <p className="home-intro">{t('home.context')}</p>
        </div>
      </header>

      {dailyOperations.length > 0 && (
        <section className="home-launcher" aria-labelledby="home-daily-operations-title">
          <div className="home-v21__section-heading">
            <h2 id="home-daily-operations-title">{homeLabels.dailyOperations}</h2>
          </div>
          <div className="home-launcher__grid">
            {dailyOperations.map((action) => (
              <button key={action.key} type="button" onClick={action.open}>
                <span>{action.label}</span><span aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {canViewClose && (
        <section className="home-status-strip" aria-label={t('monthlyClose.title')}>
          {loading ? (
            <span role="status">{t('monthlyClose.loading')}</span>
          ) : error ? (
            <>
              <span role="alert">{t('monthlyClose.error')}</span>
              <button type="button" onClick={() => void load()}>{t('common.retry')}</button>
            </>
          ) : selected ? (
            <>
              <div className="home-status-strip__period">
                <span>{t('monthlyClose.title')}</span>
                <strong>{periodRange}</strong>
              </div>
              <span className={`home-status-pill home-status-pill--${selected.status}`}>
                {t(`monthlyClose.${selected.status}`)}
              </span>
              <span className={`home-status-pill ${selected.blockers.total === 0 ? 'is-ready' : 'is-blocked'}`}>
                {closeSummary}
              </span>
            </>
          ) : (
            <span role="status">{t('monthlyClose.empty')}</span>
          )}
        </section>
      )}

      {canViewClose && !loading && !error && selected && (
        <div className="home-v21__workspace-grid" style={{ alignItems: 'start' }}>
          <section className="home-exceptions" aria-labelledby="home-exceptions-title">
            <div className="home-v21__section-heading">
              <div>
                <p className="home-eyebrow">{t('monthlyClose.title')}</p>
                <h2 id="home-exceptions-title">{homeLabels.closeBlockers}</h2>
              </div>
              <span className={`home-status-pill ${selected.blockers.total === 0 ? 'is-ready' : 'is-blocked'}`}>
                {selected.blockers.total === 0 ? homeLabels.noBlockers : homeLabels.blockers(selected.blockers.total)}
              </span>
            </div>
            <div className="home-exceptions__table-wrap">
              <table className="home-exceptions__table">
                <thead>
                  <tr>
                    <th>{homeLabels.area}</th>
                    <th>{homeLabels.blockerState}</th>
                    <th aria-label={t('accounting.action')} />
                  </tr>
                </thead>
                <tbody>
                  {exceptions.map((item) => (
                    <tr key={item.key}>
                      <td><strong>{item.label}</strong></td>
                      <td>
                        <span className={`home-exception-count ${item.count > 0 ? 'is-blocked' : 'is-clear'}`}>
                          {item.count > 0 ? homeLabels.blockers(item.count) : homeLabels.noBlockers}
                        </span>
                      </td>
                      <td>
                        {item.canOpen && (
                          <button type="button" className="home-exception-open" aria-label={item.label} onClick={item.open}>
                            <span aria-hidden="true">↗</span>
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <aside className="home-readiness" aria-labelledby="home-readiness-title" style={{ alignSelf: 'start' }}>
            <p className="home-eyebrow">{homeLabels.readiness}</p>
            <h2 id="home-readiness-title">{closeSummary}</h2>
            <p className="home-readiness__period">{periodRange}</p>
            <div className="home-readiness__summary" style={{ marginTop: 0 }}>
              <span>{homeLabels.periodState}</span>
              <strong style={{ fontSize: '.8rem' }}>{t(`monthlyClose.${selected.status}`)}</strong>
            </div>
            <div className="home-readiness__summary" style={{ marginTop: 0, borderTop: 0 }}>
              <span>{homeLabels.closeBlockers}</span>
              <strong>{selected.blockers.total}</strong>
            </div>
            <button type="button" className="home-readiness__open" onClick={() => navigate('monthlyClose')}>
              {t('nav.monthlyClose')}
            </button>
          </aside>
        </div>
      )}
    </section>
  );
}
