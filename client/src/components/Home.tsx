import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDisplayDate } from '../date-format';
import './HomeFigmaDirect.css';

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

  const money = (value: string) => {
    const amount = Number(value);
    return Number.isFinite(amount)
      ? new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount)
      : value;
  };
  const bankTotal = snapshot?.metrics.bank_balances.state === 'available'
    ? snapshot.metrics.bank_balances.accounts.reduce((sum, account) => account.balance.state === 'available' ? sum + Number(account.balance.amount || 0) : sum, 0)
    : null;
  const taskRows = alerts.map(alert => ({
    ...alert,
    label: alertLabels[alert.key] ?? alert.key,
    owner: homeLabels.ownership[alert.ownership],
  }));

  return (
    <section className="eqfal-figma-home" aria-labelledby="home-title" dir={isArabic ? 'rtl' : 'ltr'}>
      <header className="eqfal-figma-home__heading">
        <div>
          <h1 id="home-title">{isArabic ? 'نظرة عامة مالية' : 'Financial overview'}</h1>
          <p>{isArabic ? 'أهم المؤشرات والمهام التي تتطلب اهتمامك اليوم' : 'Key indicators and tasks requiring your attention today'}</p>
        </div>
      </header>

      {canViewSnapshot && (
        <section className="eqfal-figma-section" aria-labelledby="home-financial-snapshot-title">
          <div className="eqfal-figma-section__title">
            <h2 id="home-financial-snapshot-title">{isArabic ? 'لمحة مالية مجمعة' : homeLabels.snapshot}</h2>
            <span>{homeLabels.operationalView}</span>
          </div>
          {snapshotLoading ? <p className="eqfal-state" role="status">{homeLabels.snapshotLoading}</p> : snapshotError || !snapshot ? (
            <p className="eqfal-state eqfal-state--error" role="alert">{homeLabels.snapshotError} <button type="button" onClick={() => void loadSnapshot()}>{homeLabels.retry}</button></p>
          ) : (
            <div className="eqfal-kpi-grid">
              <article className="eqfal-kpi eqfal-kpi--bank"><span>{homeLabels.bankBalances}</span><strong dir="ltr">{bankTotal === null ? homeLabels.restricted : money(String(bankTotal))}</strong></article>
              {([
                ['amounts_to_collect', homeLabels.amountsToCollect],
                ['amounts_to_pay', homeLabels.amountsToPay],
                ['current_month_sales', homeLabels.monthSales],
                ['current_month_purchases_expenses', homeLabels.monthPurchasesExpenses],
              ] as const).map(([key, label]) => {
                const metric = snapshot.metrics[key];
                return <article className="eqfal-kpi" key={key}><span>{label}</span><strong dir="ltr">{metric.state === 'available' ? money(metric.amount) : homeLabels.restricted}</strong></article>;
              })}
            </div>
          )}
        </section>
      )}

      {canViewAlerts && (
        <section className="eqfal-figma-card" aria-labelledby="home-alerts-title">
          <div className="eqfal-figma-card__header">
            <div><h2 id="home-alerts-title">{isArabic ? 'المهام التي تتطلب متابعة' : 'Tasks requiring follow-up'}</h2><p>{isArabic ? 'العناصر التشغيلية التي تحتاج معالجة أو مراجعة' : 'Operational items requiring action or review'}</p></div>
          </div>
          {alertsLoading ? <p className="eqfal-state" role="status">{homeLabels.alertsLoading}</p> : alertsError ? (
            <p className="eqfal-state eqfal-state--error" role="alert">{homeLabels.alertsError} <button type="button" onClick={() => void loadAlerts()}>{homeLabels.retry}</button></p>
          ) : taskRows.length === 0 ? <p className="eqfal-state" role="status">{homeLabels.alertsEmpty}</p> : (
            <div className="eqfal-task-table-wrap">
              <table className="eqfal-task-table">
                <thead><tr><th>{isArabic ? 'التصنيف' : 'Category'}</th><th>{isArabic ? 'العنصر' : 'Item'}</th><th>{isArabic ? 'العدد' : 'Count'}</th><th>{isArabic ? 'المسؤول' : 'Owner'}</th><th>{isArabic ? 'الحالة' : 'Status'}</th><th>{isArabic ? 'الإجراء' : 'Action'}</th></tr></thead>
                <tbody>{taskRows.map(alert => (
                  <tr key={alert.key}>
                    <td><span className={`eqfal-task-dot eqfal-task-dot--${alert.class}`} />{alert.class === 'needs_action_now' ? (isArabic ? 'عاجل' : 'Action now') : alert.class === 'upcoming_due' ? (isArabic ? 'قادم' : 'Upcoming') : (isArabic ? 'مراجعة' : 'Review')}</td>
                    <td><strong>{alert.label}</strong></td><td>{alert.count}</td><td>{alert.owner}</td>
                    <td><span className="eqfal-task-status">{alert.ownership === 'current_user' ? (isArabic ? 'يتطلب إجراء' : 'Action required') : alert.owner}</span></td>
                    <td><button type="button" onClick={() => navigateToDiscovery(alert.destination, alert.parameters)}>{isArabic ? 'معالجة' : 'Open'}</button></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canViewClose && (
        <section className="eqfal-figma-card eqfal-close" aria-labelledby="home-readiness-title">
          <div className="eqfal-figma-card__header eqfal-close__header">
            <div><h2 id="home-readiness-title">{isArabic ? 'جاهزية إقفال الفترة الشهرية' : 'Monthly close readiness'}</h2><p>{selected ? periodRange : t('monthlyClose.empty')}</p></div>
            {selected && <button className="eqfal-close__open" type="button" onClick={() => navigate('monthlyClose')}>{isArabic ? 'عرض معوقات الإقفال' : 'View close blockers'}</button>}
          </div>
          {loading ? <p className="eqfal-state" role="status">{t('monthlyClose.loading')}</p> : error ? (
            <p className="eqfal-state eqfal-state--error" role="alert">{t('monthlyClose.error')} <button type="button" onClick={() => void load()}>{t('common.retry')}</button></p>
          ) : selected ? (
            <>
              {!selected.ready && <div className="eqfal-close__notice">{selected.has_hidden_blockers ? t('monthlyClose.blockedHidden') : closeSummary}</div>}
              <div className="eqfal-close__body">
                <div className={`eqfal-close__summary ${selected.ready ? 'is-ready' : 'is-blocked'}`}>
                  <span className="eqfal-close__summary-label">{homeLabels.periodState}</span>
                  <strong className="eqfal-close__summary-status">{t(`monthlyClose.${selected.status}`)}</strong>
                  <span className="eqfal-close__summary-divider" aria-hidden="true" />
                  <span className="eqfal-close__summary-label">{isArabic ? 'المعوقات الحالية' : 'Current blockers'}</span>
                  <strong className="eqfal-close__summary-count">{selected.ready ? homeLabels.noBlockers : homeLabels.blockers(selected.disclosed_total)}</strong>
                </div>
                <div className="eqfal-close__blockers">
                  {exceptions.map(item => (
                    <button key={item.key} type="button" disabled={!item.canOpen} onClick={item.open}>
                      <span>{item.label}</span><strong className={item.count > 0 ? 'is-blocked' : 'is-clear'}>{item.count > 0 ? homeLabels.blockers(item.count) : homeLabels.noBlockers}</strong>
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : <p className="eqfal-state" role="status">{t('monthlyClose.empty')}</p>}
        </section>
      )}

    </section>
  );
}
