import { ReactNode, useEffect, useState } from 'react';
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

type SnapshotMetric = { state: 'available'; amount: string } | { state: 'hidden' };
type FinancialSnapshot = {
  as_of?: string;
  month?: { start: string; end_exclusive: string };
  metrics: {
    bank_balances: { state: 'hidden' } | { state: 'available'; accounts: Array<{ id: string; display_name: string; currency_code: string; balance: { state: 'available'; amount: string } | { state: 'unavailable' } }> };
    amounts_to_collect: SnapshotMetric;
    amounts_to_pay: SnapshotMetric;
    current_month_sales: SnapshotMetric;
    current_month_purchases_expenses: SnapshotMetric;
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

type HomeActionIconName = 'sale' | 'purchase' | 'expense' | 'document' | 'sales' | 'bank' | 'obligation';

function HomeActionIcon({ name }: { name: HomeActionIconName }) {
  const paths: Record<HomeActionIconName, ReactNode> = {
    sale: <><path d="M4 5h16v14H4z"/><path d="M7 9h10M7 13h6M16 16h3"/></>,
    purchase: <><path d="M4 5h16v14H4z"/><path d="M7 9h10M7 13h7M16 16h3"/></>,
    expense: <><path d="M5 3h14v18H5z"/><path d="M8 8h8M8 12h8M8 16h5"/></>,
    document: <><path d="M6 3.5h8l4 4V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14 3.5V8h4M8 12h8M8 16h6"/></>,
    sales: <><path d="M4 18V6M4 18h16"/><path d="m7 14 4-4 3 2 5-6"/></>,
    bank: <><path d="M3 9h18M5 9v9M9.5 9v9M14.5 9v9M19 9v9M3 18h18M2 21h20M12 3 3 7h18L12 3Z"/></>,
    obligation: <><circle cx="12" cy="12" r="8"/><path d="M12 8v5l3 2"/></>,
  };
  return <svg className="home-review__action-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

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
  const canViewSnapshot = capabilities.some(capability => ['bank.view', 'obligation.view', 'document.view'].includes(capability));
  const [snapshot, setSnapshot] = useState<FinancialSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(canViewSnapshot);
  const [snapshotError, setSnapshotError] = useState(false);
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
         snapshot: 'اللقطة المالية', bankBalances: 'أرصدة البنوك', amountsToCollect: 'مبالغ للتحصيل', amountsToPay: 'مبالغ للسداد', monthSales: 'مبيعات الشهر الحالي', monthPurchasesExpenses: 'مشتريات ومصروفات الشهر الحالي', unavailable: 'غير متاح', restricted: 'مقيّد حسب الصلاحيات', snapshotLoading: 'جارٍ تحميل الملخص المالي…', snapshotError: 'تعذر تحميل الملخص المالي.', noBankAccounts: 'لا توجد حسابات بنكية متاحة.', operationalView: 'عرض تشغيلي، وليس قائمة مالية أو مقياساً للربحية.', overview: 'نظرة عامة مالية', asOf: 'حتى تاريخ', activePeriod: 'الفترة الحالية', alertClass: { needs_action_now: 'إجراء مطلوب', upcoming_due: 'مستحق قريباً', needs_review_completion: 'يحتاج مراجعة' },
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
         snapshot: 'Manager Financial Snapshot', bankBalances: 'Bank balances', amountsToCollect: 'Amounts to collect', amountsToPay: 'Amounts to pay', monthSales: 'Current-month sales', monthPurchasesExpenses: 'Current-month purchases / expenses', unavailable: 'Unavailable', restricted: 'Restricted by permissions', snapshotLoading: 'Loading financial snapshot…', snapshotError: 'Unable to load financial snapshot.', noBankAccounts: 'No bank accounts available.', operationalView: 'Operational view — not a financial statement or profitability measure.', overview: 'Financial overview', asOf: 'As of', activePeriod: 'Active period', alertClass: { needs_action_now: 'Action required', upcoming_due: 'Due soon', needs_review_completion: 'Needs review' },
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

  const loadSnapshot = async () => {
    if (!canViewSnapshot) return;
    setSnapshotLoading(true);
    setSnapshotError(false);
    try {
      const response = await fetch('/api/manager-financial-snapshot', { credentials: 'same-origin' });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as Partial<FinancialSnapshot>;
      if (!payload.metrics) throw new Error('Invalid snapshot');
      setSnapshot(payload as FinancialSnapshot);
    } catch {
      setSnapshotError(true);
    } finally {
      setSnapshotLoading(false);
    }
  };

  useEffect(() => {
    if (canViewSnapshot) void loadSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canViewSnapshot]);

  const selected = periods[0] ?? null;
  const alertGroups = (['current_user', 'upcoming', 'waiting_for_accountant', 'waiting_for_team'] as const)
    .map(ownership => ({ ownership, alerts: alerts.filter(alert => alert.ownership === ownership) }))
    .filter(group => group.alerts.length > 0);
  const can = (capability: string) => capabilities.includes(capability);
  const canViewSalesPurchases = can('document.view') && can('obligation.view');
  const canStartOperationalEntry = canStartOperationalDocumentEntry(capabilities);
  const dailyOperations = [
    { key: 'add-sale', icon: 'sale' as const, label: homeLabels.addSale, visible: canStartOperationalEntry, open: startSalesEntry },
    { key: 'add-purchase', icon: 'purchase' as const, label: homeLabels.addPurchase, visible: canStartOperationalEntry, open: () => startPurchaseEntry('purchase') },
    { key: 'add-expense', icon: 'expense' as const, label: homeLabels.addExpense, visible: canStartOperationalEntry, open: () => startPurchaseEntry('expense') },
    { key: 'upload-document', icon: 'document' as const, label: homeLabels.uploadDocument, visible: can('document.upload'), open: () => navigate('documents') },
    { key: 'open-sales', icon: 'sales' as const, label: homeLabels.openSales, visible: canViewSalesPurchases, open: () => navigate('sales') },
    { key: 'open-purchases', icon: 'purchase' as const, label: homeLabels.openPurchases, visible: canViewSalesPurchases, open: () => navigate('purchases') },
    { key: 'open-banking', icon: 'bank' as const, label: homeLabels.openBanking, visible: can('bank.view'), open: () => navigate('banks') },
    { key: 'open-obligations', icon: 'obligation' as const, label: homeLabels.openObligations, visible: can('obligation.view'), open: () => navigate('obligations') },
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
  const overviewDate = snapshot?.as_of ?? selected?.period_end ?? null;
  const overviewYear = selected?.period_start.slice(0, 4) ?? snapshot?.month?.start.slice(0, 4) ?? null;

  return (
    <section className="home-modern home-v21 home-review" aria-labelledby="home-title">
      <header className="home-hero home-v21__hero">
        <div className="home-hero-copy">
          <p className="home-eyebrow">{t('home.workspace')}</p>
            <h1 id="home-title" aria-label={homeLabels.overview}>{isArabic ? 'مرحبًا بك في إقفال' : homeLabels.overview}</h1>
            <p className="home-intro">{t('home.context')}</p>
            <div className="home-review__context" aria-label={homeLabels.overview}>
              {overviewDate && <span><small>{homeLabels.asOf}</small><strong dir="ltr">{stripDirectionalMarks(formatDisplayDate(overviewDate, i18n.language))}</strong></span>}
              {overviewYear && <span><small>{homeLabels.activePeriod}</small><strong dir="ltr">{overviewYear}</strong></span>}
            </div>
        </div>
      </header>

      {canViewClose && (
        <section className="home-status-strip home-review__close-status" aria-label={t('monthlyClose.title')}>
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

      {dailyOperations.length > 0 && (
        <section className="home-launcher home-review__operations" aria-labelledby="home-daily-operations-title">
          <div className="home-v21__section-heading">
            <h2 id="home-daily-operations-title">{homeLabels.dailyOperations}</h2>
          </div>
          <div className="home-launcher__grid">
            {dailyOperations.map((action) => (
              <button key={action.key} type="button" onClick={action.open} data-operation={action.key}>
                <span className="home-review__action-icon"><HomeActionIcon name={action.icon} /></span>
                <span>{action.label}</span><span className="home-review__arrow" aria-hidden="true">↗</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {canViewSnapshot && (
        <section className="home-exceptions home-review__snapshot" aria-labelledby="home-financial-snapshot-title">
          <div className="home-v21__section-heading">
            <div><h2 id="home-financial-snapshot-title">{homeLabels.snapshot}</h2><p>{overviewDate ? `${homeLabels.asOf} ${stripDirectionalMarks(formatDisplayDate(overviewDate, i18n.language))}` : homeLabels.operationalView}</p></div>
          </div>
          {snapshotLoading ? <p role="status">{homeLabels.snapshotLoading}</p> : snapshotError || !snapshot ? (
            <p role="alert">{homeLabels.snapshotError} <button type="button" onClick={() => void loadSnapshot()}>{homeLabels.retry}</button></p>
          ) : (
            <div className="home-review__financial-summary">
              <article className="home-review__bank-band">
                <h3>{homeLabels.bankBalances}</h3>
                <div className="home-review__bank-accounts">
                  {snapshot.metrics.bank_balances.state === 'hidden' ? <p>{homeLabels.restricted}</p>
                    : snapshot.metrics.bank_balances.accounts.length === 0 ? <p>{homeLabels.noBankAccounts}</p>
                      : snapshot.metrics.bank_balances.accounts.map(account => <p key={account.id}><span>{account.display_name}</span>{' '}<strong dir="ltr">{account.balance.state === 'available' ? `${account.balance.amount} ${account.currency_code}` : homeLabels.unavailable}</strong></p>)}
                </div>
              </article>
              {([
                ['amounts_to_collect', homeLabels.amountsToCollect],
                ['amounts_to_pay', homeLabels.amountsToPay],
                ['current_month_sales', homeLabels.monthSales],
                ['current_month_purchases_expenses', homeLabels.monthPurchasesExpenses],
              ] as const).map(([key, label]) => {
                const metric = snapshot.metrics[key];
                return <article className="home-review__metric" key={key}><h3>{label}</h3><strong dir="ltr">{metric.state === 'available' ? metric.amount : homeLabels.restricted}</strong></article>;
              })}
            </div>
          )}
        </section>
      )}

      {canViewAlerts && (
        <section className="home-exceptions home-review__alerts" aria-labelledby="home-alerts-title">
          <div className="home-v21__section-heading"><h2 id="home-alerts-title">{homeLabels.alerts}</h2></div>
          {alertsLoading ? <p role="status">{homeLabels.alertsLoading}</p> : alertsError ? (
            <p role="alert">{homeLabels.alertsError} <button type="button" onClick={() => void loadAlerts()}>{homeLabels.retry}</button></p>
          ) : alerts.length === 0 ? <p role="status">{homeLabels.alertsEmpty}</p> : (
            <div className="home-review__alert-table-wrap">
              <table className="home-review__alert-table">
                <tbody>
                  {alertGroups.flatMap(group => group.alerts.map(alert => (
                    <tr key={alert.key}>
                      <td><span className="home-review__alert-dot" aria-hidden="true" /><strong>{alertLabels[alert.key] ?? alert.key}</strong></td>
                      <td><span className={`home-review__alert-class home-review__alert-class--${alert.class}`}>{homeLabels.alertClass[alert.class]}</span><span className="home-review__alert-owner">{homeLabels.ownership[group.ownership]}</span></td>
                      <td><span className="home-review__alert-count">{alert.count}</span></td>
                      <td><button type="button" aria-label={alertLabels[alert.key] ?? alert.key} onClick={() => navigateToDiscovery(alert.destination, alert.parameters)}><span aria-hidden="true">↗</span></button></td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canViewClose && !loading && !error && selected && (
        <div className="home-v21__workspace-grid home-review__close-workspace" style={{ alignItems: 'start' }}>
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
