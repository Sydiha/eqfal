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

const stripDirectionalMarks = (value: string) => value.replace(/[\u061c\u200e\u200f]/g, '');

export function Home({ capabilities, navigate, navigateToDiscovery, onUnauthorized }: Props) {
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
        snapshot: 'الملخص المالي للإدارة', bankBalances: 'أرصدة البنوك', amountsToCollect: 'مبالغ للتحصيل', amountsToPay: 'مبالغ للسداد', monthSales: 'مبيعات الشهر الحالي', monthPurchasesExpenses: 'مشتريات ومصروفات الشهر الحالي', unavailable: 'غير متاح', restricted: 'مقيّد حسب الصلاحيات', snapshotLoading: 'جارٍ تحميل الملخص المالي…', snapshotError: 'تعذر تحميل الملخص المالي.', noBankAccounts: 'لا توجد حسابات بنكية متاحة.', operationalView: 'عرض تشغيلي، وليس قائمة مالية أو مقياساً للربحية.',
        overview: 'نظرة عامة مالية', overviewIntro: 'تابع وضع المنشأة المالي والمهام التي تحتاج إلى اهتمامك.', followUp: 'المتابعة والإجراءات', followUpList: 'قائمة المهام التي تتطلب متابعة', followUpIntro: 'بنود تشغيلية ومالية تحتاج إلى إجراء أو مراجعة.', viewDetails: 'عرض التفاصيل', item: 'البند', responsibility: 'المسؤولية', count: 'العدد', status: 'الحالة', action: 'الإجراء', monthlyActivity: 'حركة الشهر الحالي',
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
        snapshot: 'Manager Financial Snapshot', bankBalances: 'Bank balances', amountsToCollect: 'Amounts to collect', amountsToPay: 'Amounts to pay', monthSales: 'Current-month sales', monthPurchasesExpenses: 'Current-month purchases / expenses', unavailable: 'Unavailable', restricted: 'Restricted by permissions', snapshotLoading: 'Loading financial snapshot…', snapshotError: 'Unable to load financial snapshot.', noBankAccounts: 'No bank accounts available.', operationalView: 'Operational view — not a financial statement or profitability measure.',
        overview: 'Financial overview', overviewIntro: 'Monitor your organization’s financial position and the work requiring attention.', followUp: 'Follow-up and actions', followUpList: 'Tasks requiring follow-up', followUpIntro: 'Operational and financial items requiring action or review.', viewDetails: 'View details', item: 'Item', responsibility: 'Responsibility', count: 'Count', status: 'Status', action: 'Action', monthlyActivity: 'Current-month activity',
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

  const alertClassLabels: Record<HomeAlert['class'], string> = isArabic
    ? { needs_action_now: 'يتطلب إجراء', upcoming_due: 'قادم', needs_review_completion: 'يحتاج مراجعة' }
    : { needs_action_now: 'Action required', upcoming_due: 'Upcoming', needs_review_completion: 'Needs review' };

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
    <section className="home-modern home-v21 home-financial-overview" aria-labelledby="home-title">
      <header className="home-hero home-v21__hero">
        <div className="home-hero-copy">
          <h1 id="home-title">{homeLabels.overview}</h1>
          <p className="home-intro">{homeLabels.overviewIntro}</p>
          {selected && <p className="home-heading-period"><span>{t('monthlyClose.title')}</span><strong>{periodRange}</strong></p>}
        </div>
      </header>

      {canViewSnapshot && (
        <section className="home-exceptions home-financial-summary" aria-labelledby="home-financial-snapshot-title">
          <div className="home-v21__section-heading">
            <div><p className="home-eyebrow">{homeLabels.overview}</p><h2 id="home-financial-snapshot-title">{homeLabels.snapshot}</h2><p>{homeLabels.operationalView}</p></div>
          </div>
          {snapshotLoading ? <div className="home-state" role="status"><span className="home-state__pulse" aria-hidden="true" />{homeLabels.snapshotLoading}</div> : snapshotError || !snapshot ? (
            <div className="home-state home-state--error" role="alert"><span>{homeLabels.snapshotError}</span><button type="button" onClick={() => void loadSnapshot()}>{homeLabels.retry}</button></div>
          ) : (
            <div className="home-kpi-grid">
              <article className="home-kpi-card home-kpi-card--banks">
                <h3>{homeLabels.bankBalances}</h3>
                {snapshot.metrics.bank_balances.state === 'hidden' ? <p>{homeLabels.restricted}</p>
                  : snapshot.metrics.bank_balances.accounts.length === 0 ? <p className="home-kpi-empty">{homeLabels.noBankAccounts}</p>
                    : <div className="home-bank-list">{snapshot.metrics.bank_balances.accounts.map(account => <p key={account.id}><span>{account.display_name}</span><strong dir="ltr">{account.balance.state === 'available' ? `${account.balance.amount} ${account.currency_code}` : homeLabels.unavailable}</strong></p>)}</div>}
              </article>
              {([
                ['amounts_to_collect', homeLabels.amountsToCollect],
                ['amounts_to_pay', homeLabels.amountsToPay],
              ] as const).map(([key, label]) => {
                const metric = snapshot.metrics[key];
                return <article className={`home-kpi-card home-kpi-card--${key}`} key={key}><span className="home-kpi-card__mark" aria-hidden="true" /><h3>{label}</h3><strong dir="ltr">{metric.state === 'available' ? metric.amount : homeLabels.restricted}</strong></article>;
              })}
              <article className="home-kpi-card home-kpi-card--activity">
                <span className="home-kpi-card__mark" aria-hidden="true" /><h3>{homeLabels.monthlyActivity}</h3>
                <div className="home-monthly-activity">
                  {([['current_month_sales', homeLabels.monthSales], ['current_month_purchases_expenses', homeLabels.monthPurchasesExpenses]] as const).map(([key, label]) => {
                    const metric = snapshot.metrics[key];
                    return <div key={key}><span>{label}</span><strong dir="ltr">{metric.state === 'available' ? metric.amount : homeLabels.restricted}</strong></div>;
                  })}
                </div>
              </article>
            </div>
          )}
        </section>
      )}

      {canViewAlerts && (
        <section className="home-exceptions home-follow-up" aria-labelledby="home-alerts-title">
          <div className="home-v21__section-heading"><div><p className="home-eyebrow">{homeLabels.followUp}</p><h2 id="home-alerts-title">{homeLabels.followUpList}</h2><p>{homeLabels.followUpIntro}</p></div></div>
          {alertsLoading ? <div className="home-state" role="status"><span className="home-state__pulse" aria-hidden="true" />{homeLabels.alertsLoading}</div> : alertsError ? (
            <div className="home-state home-state--error" role="alert"><span>{homeLabels.alertsError}</span><button type="button" onClick={() => void loadAlerts()}>{homeLabels.retry}</button></div>
          ) : alerts.length === 0 ? <div className="home-state home-state--empty" role="status">{homeLabels.alertsEmpty}</div> : (
            <div className="home-follow-up__table-wrap">
              <table className="home-follow-up__table">
                <thead><tr><th>{homeLabels.item}</th><th>{homeLabels.responsibility}</th><th>{homeLabels.count}</th><th>{homeLabels.status}</th><th>{homeLabels.action}</th></tr></thead>
                <tbody>
                  {alertGroups.flatMap(group => group.alerts.map(alert => (
                    <tr key={alert.key}>
                      <td><span className={`home-alert-dot home-alert-dot--${alert.class}`} aria-hidden="true" /><strong>{alertLabels[alert.key] ?? alert.key}</strong></td>
                      <td>{homeLabels.ownership[alert.ownership]}</td>
                      <td><span className="home-alert-count" dir="ltr">{alert.count}</span></td>
                      <td><span className={`home-alert-status home-alert-status--${alert.class}`}>{alertClassLabels[alert.class]}</span></td>
                      <td><button type="button" className="home-alert-open" aria-label={`${homeLabels.viewDetails}: ${alertLabels[alert.key] ?? alert.key}`} onClick={() => navigateToDiscovery(alert.destination, alert.parameters)}>{homeLabels.viewDetails}<span aria-hidden="true">↗</span></button></td>
                    </tr>
                  )))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canViewClose && (
        <section className="home-status-strip home-close-strip" aria-label={t('monthlyClose.title')}>
          {loading ? (
            <span className="home-state" role="status">{t('monthlyClose.loading')}</span>
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
          <section className="home-exceptions home-close-blockers" aria-labelledby="home-exceptions-title">
            <div className="home-v21__section-heading">
              <div>
                <p className="home-eyebrow">{t('monthlyClose.title')}</p>
                <h2 id="home-exceptions-title">{homeLabels.readiness}</h2>
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
            <div className={`home-readiness__visual ${selected.status === 'closed' || selected.ready ? 'is-ready' : 'is-blocked'}`} aria-hidden="true"><span>{selected.status === 'closed' || selected.ready ? '✓' : '!'}</span></div>
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
