import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDisplayDate } from '../date-format';
import { canStartOperationalDocumentEntry } from './operationalEntryCapabilities';

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
  disclosed_total: number;
  has_hidden_blockers: boolean;
  blockers: {
    documents: number;
    obligations: number;
    bank_transactions: number;
    vat: number;
    ledger: number;
  };
};

type HomeAlert = {
  key: string;
  class: 'needs_action_now' | 'upcoming_due' | 'needs_review_completion';
  ownership: 'current_user' | 'waiting_for_accountant' | 'waiting_for_team' | 'upcoming';
  count: number;
  destination: DiscoveryPage;
  parameters: Record<string, string>;
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
  const canViewClose = capabilities.includes('monthly_close.view');
  const [periods, setPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(canViewClose);
  const [error, setError] = useState(false);
  const canViewAlerts = capabilities.some(capability => ['obligation.view', 'document.view', 'bank.view'].includes(capability));
  const [alerts, setAlerts] = useState<HomeAlert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(canViewAlerts);
  const [alertsError, setAlertsError] = useState(false);
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
        alerts: 'التنبيهات', alertsLoading: 'جارٍ تحميل التنبيهات…', alertsError: 'تعذر تحميل التنبيهات.', alertsEmpty: 'لا توجد إجراءات معلقة.', retry: 'إعادة المحاولة',
        ownership: { current_user: 'مطلوب منك الآن', upcoming: 'قادم', waiting_for_accountant: 'بانتظار المحاسب', waiting_for_team: 'بانتظار الفريق' },
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
        alerts: 'Alerts', alertsLoading: 'Loading alerts…', alertsError: 'Unable to load alerts.', alertsEmpty: 'No outstanding actions.', retry: 'Try again',
        ownership: { current_user: 'Current user action', upcoming: 'Upcoming', waiting_for_accountant: 'Waiting for accountant', waiting_for_team: 'Waiting for team' },
      };

  const alertLabels: Record<string, string> = isArabic ? {
    overdue_obligations: 'التزامات متأخرة', upcoming_obligations: 'التزامات مستحقة قريباً', unconfirmed_obligations: 'التزامات غير مؤكدة',
    documents_uploaded: 'مستندات مرفوعة للمراجعة', documents_needs_review: 'مستندات تحتاج مراجعة', documents_incomplete: 'مستندات غير مكتملة',
    bank_transactions_unmatched: 'حركات بنكية غير مطابقة', bank_transactions_matched: 'حركات بنكية تحتاج تسوية',
  } : {
    overdue_obligations: 'Overdue obligations', upcoming_obligations: 'Obligations due soon', unconfirmed_obligations: 'Unconfirmed obligations',
    documents_uploaded: 'Uploaded documents to review', documents_needs_review: 'Documents needing review', documents_incomplete: 'Incomplete documents',
    bank_transactions_unmatched: 'Unmatched bank transactions', bank_transactions_matched: 'Bank transactions awaiting reconciliation',
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

  const loadAlerts = async () => {
    if (!canViewAlerts) return;
    setAlertsLoading(true);
    setAlertsError(false);
    try {
      const response = await fetch('/api/home-alerts', { credentials: 'same-origin' });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as { alerts?: HomeAlert[] };
      setAlerts(Array.isArray(payload.alerts) ? payload.alerts.filter(alert => alert.count > 0) : []);
    } catch {
      setAlertsError(true);
    } finally {
      setAlertsLoading(false);
    }
  };

  useEffect(() => {
    if (canViewAlerts) void loadAlerts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canViewAlerts]);

  const selected = periods[0] ?? null;
  const alertGroups = (['current_user', 'upcoming', 'waiting_for_accountant', 'waiting_for_team'] as const)
    .map(ownership => ({ ownership, alerts: alerts.filter(alert => alert.ownership === ownership) }))
    .filter(group => group.alerts.length > 0);
  const can = (capability: string) => capabilities.includes(capability);
  const canViewSalesPurchases = can('document.view') && can('obligation.view');
  const canStartOperationalEntry = canStartOperationalDocumentEntry(capabilities);
  const dailyOperations = [
    { key: 'add-sale', label: homeLabels.addSale, visible: canStartOperationalEntry, open: startSalesEntry },
    { key: 'add-purchase', label: homeLabels.addPurchase, visible: canStartOperationalEntry, open: () => startPurchaseEntry('purchase') },
    { key: 'add-expense', label: homeLabels.addExpense, visible: canStartOperationalEntry, open: () => startPurchaseEntry('expense') },
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
        : selected.has_hidden_blockers
          ? t('monthlyClose.blockedHidden')
          : homeLabels.blockers(selected.disclosed_total)
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

      {canViewAlerts && (
        <section className="home-exceptions" aria-labelledby="home-alerts-title">
          <div className="home-v21__section-heading"><h2 id="home-alerts-title">{homeLabels.alerts}</h2></div>
          {alertsLoading ? <p role="status">{homeLabels.alertsLoading}</p> : alertsError ? (
            <p role="alert">{homeLabels.alertsError} <button type="button" onClick={() => void loadAlerts()}>{homeLabels.retry}</button></p>
          ) : alerts.length === 0 ? <p role="status">{homeLabels.alertsEmpty}</p> : (
            <div>
              {alertGroups.map(group => (
                <section key={group.ownership} aria-labelledby={`home-alerts-${group.ownership}`}>
                  <h3 id={`home-alerts-${group.ownership}`}>{homeLabels.ownership[group.ownership]}</h3>
                  <div className="home-launcher__grid">
                    {group.alerts.map(alert => (
                      <button key={alert.key} type="button" onClick={() => navigateToDiscovery(alert.destination, alert.parameters)}>
                        <span>{alertLabels[alert.key] ?? alert.key}</span><strong>{alert.count}</strong><span aria-hidden="true">↗</span>
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}
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
              <span className={`home-status-pill ${selected.status === 'closed' || selected.ready ? 'is-ready' : 'is-blocked'}`}>
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
              <span className={`home-status-pill ${selected.status === 'closed' || selected.ready ? 'is-ready' : 'is-blocked'}`}>
                {closeSummary}
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
              <strong>
                {selected.has_hidden_blockers
                  ? t('monthlyClose.blockedHidden')
                  : selected.disclosed_total}
              </strong>
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
