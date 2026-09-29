import { Fragment, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDisplayDate } from '../date-format';
import { canStartOperationalDocumentEntry } from './operationalEntryCapabilities';
import '../home-master.css';

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
  ].filter(action => action.visible);
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

  const metricValue = (metric: SnapshotMetric | undefined) =>
    metric?.state === 'available' ? metric.amount : '—';
  const bankAccount = snapshot?.metrics.bank_balances.state === 'available'
    ? snapshot.metrics.bank_balances.accounts[0] ?? null
    : null;
  const bankValue = bankAccount?.balance.state === 'available'
    ? `${bankAccount.balance.amount} ${bankAccount.currency_code}`
    : '—';
  const periodLabel = selected
    ? new Intl.DateTimeFormat(i18n.language, { month: 'long', year: 'numeric' }).format(new Date(`${selected.period_start}T00:00:00`))
    : (isArabic ? 'الفترة الحالية' : 'Current period');
  const kpis = [
    [homeLabels.bankBalances, bankValue],
    [homeLabels.amountsToCollect, metricValue(snapshot?.metrics.amounts_to_collect)],
    [homeLabels.amountsToPay, metricValue(snapshot?.metrics.amounts_to_pay)],
    [homeLabels.monthSales, metricValue(snapshot?.metrics.current_month_sales)],
    [homeLabels.monthPurchasesExpenses, metricValue(snapshot?.metrics.current_month_purchases_expenses)],
    [isArabic ? 'صافي الربح' : 'Net profit', '—'],
  ] as const;

  return (
    <section className="home-master" aria-labelledby="home-title">
      <header className="home-master__head">
        <div>
          <h1 id="home-title">{t('home.welcome')}</h1>
          <p>{isArabic ? 'ملخص تشغيلي للوضع المالي والإجراءات التي تتطلب المتابعة' : 'Operational financial summary and items requiring follow-up'}</p>
        </div>
      </header>

      {dailyOperations.length > 0 && (
        <section className="home-master__quick-actions" aria-labelledby="home-daily-operations-title"><h2 id="home-daily-operations-title" className="home-master__semantic-heading">{homeLabels.dailyOperations}</h2>
          {dailyOperations.map(action => <button key={action.key} type="button" onClick={action.open}>{action.label}</button>)}
        </section>
      )}

      {canViewSnapshot && (
        <section aria-labelledby="home-financial-snapshot-title">
          <div className="home-master__sectionbar">
            <h2 id="home-financial-snapshot-title">{homeLabels.snapshot}</h2>
            <span className="home-master__period">{periodLabel}</span>
          </div>
          {snapshotLoading ? <p role="status">{homeLabels.snapshotLoading}</p> : snapshotError || !snapshot ? (
            <p className="home-master__error" role="alert">{homeLabels.snapshotError} <button className="home-master__retry" type="button" onClick={() => void loadSnapshot()}>{homeLabels.retry}</button></p>
          ) : (
            <div className="home-master__kpis">
              {kpis.map(([label,value], index) => (
                <article className="home-master__kpi" key={label}>
                  <span className="home-master__kpi-label">{label}</span>
                  {index === 0 && snapshot?.metrics.bank_balances.state === 'available' ? (
                    snapshot.metrics.bank_balances.accounts.length === 0 ? <span>{homeLabels.noBankAccounts}</span> :
                    snapshot.metrics.bank_balances.accounts.map((account, accountIndex) => (
                      <p key={account.id} className={accountIndex > 0 ? 'home-master__semantic-detail' : undefined}>
                        <span className={accountIndex > 0 ? undefined : 'home-master__semantic-heading'}>{account.display_name}</span>
                        <strong className={`home-master__kpi-value ${account.balance.state !== 'available' ? 'is-muted' : ''}`} dir="ltr">
                          {account.balance.state === 'available' ? `${account.balance.amount} ${account.currency_code}` : homeLabels.unavailable}
                        </strong>
                      </p>
                    ))
                  ) : (
                    <strong className={`home-master__kpi-value ${value === '—' ? 'is-muted' : ''}`} dir="ltr">
                      {value === '—' && index > 0 && index < 5 ? homeLabels.restricted : value}
                    </strong>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {canViewAlerts && (
        <section className="home-master__card" aria-labelledby="home-alerts-title">
          <div className="home-master__cardhead">
            <div><h2 id="home-alerts-title">{homeLabels.alerts}</h2><span className="home-master__visual-title">{isArabic ? 'المهام التي تتطلب متابعة' : 'Items requiring follow-up'}</span><p>{isArabic ? 'الإجراءات التشغيلية المفتوحة حسب البيانات الحالية' : 'Open operational actions from current data'}</p></div>
          </div>
          {alertsLoading ? <p role="status">{homeLabels.alertsLoading}</p> : alertsError ? (
            <p className="home-master__error" role="alert">{homeLabels.alertsError} <button className="home-master__retry" type="button" onClick={() => void loadAlerts()}>{homeLabels.retry}</button></p>
          ) : alerts.length === 0 ? <div className="home-master__empty">{homeLabels.alertsEmpty}</div> : (
            <div className="home-master__tablewrap">
              <table className="home-master__table">
                <thead><tr><th>{isArabic ? 'المهمة' : 'Item'}</th><th>{isArabic ? 'الحالة' : 'Status'}</th><th>{isArabic ? 'العدد' : 'Count'}</th><th>{isArabic ? 'الإجراء' : 'Action'}</th></tr></thead>
                <tbody>{(['current_user', 'upcoming', 'waiting_for_accountant', 'waiting_for_team'] as const).map(ownership => {
                  const groupAlerts = alerts.filter(alert => alert.ownership === ownership);
                  if (groupAlerts.length === 0) return null;
                  return <Fragment key={ownership}>
                    <tr className="home-master__semantic-row"><td colSpan={4}><h3>{homeLabels.ownership[ownership]}</h3></td></tr>
                    {groupAlerts.map(alert => (
                  <tr key={alert.key}>
                    <td><button className="home-master__alert-action" type="button" onClick={() => navigateToDiscovery(alert.destination, alert.parameters)}><strong>{alertLabels[alert.key] ?? alert.key}</strong><span className="home-master__semantic-heading">{alert.count}</span></button></td>
                    <td><span className="home-master__badge">{homeLabels.ownership[alert.ownership]}</span></td>
                    <td dir="ltr">{alert.count}</td>
                    <td aria-hidden="true"><span>{isArabic ? 'فتح' : 'Open'}</span></td>
                  </tr>
                    ))}
                  </Fragment>;
                })}</tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {canViewClose && (
        <section className="home-master__card home-master__close" aria-labelledby="home-close-title">
          <div className="home-master__close-main">
            <div className="home-master__cardhead">
              <div><h2 id="home-close-title">{homeLabels.closeBlockers}</h2><span className="home-master__visual-title">{isArabic ? 'جاهزية إقفال الفترة الشهرية' : 'Monthly close readiness'}</span><p>{selected ? periodRange : (isArabic ? 'لا توجد فترة متاحة' : 'No period available')}</p></div>
              {selected && <span className={`home-master__badge ${selected.status === 'closed' || selected.ready ? 'is-clear' : ''}`}>{closeSummary}</span>}
            </div>
            {loading ? <p role="status">{t('monthlyClose.loading')}</p> : error ? (
              <p className="home-master__error" role="alert">{t('monthlyClose.error')} <button className="home-master__retry" type="button" onClick={() => void load()}>{t('common.retry')}</button></p>
            ) : !selected ? <div className="home-master__empty">{t('monthlyClose.empty')}</div> : (
              <div className="home-master__tablewrap">
                <table className="home-master__table">
                  <thead><tr><th>{homeLabels.area}</th><th>{homeLabels.blockerState}</th><th>{isArabic ? 'الإجراء' : 'Action'}</th></tr></thead>
                  <tbody>{exceptions.map(item => (
                    <tr key={item.key}>
                      <td><strong>{item.label}</strong></td>
                      <td><span className={`home-master__badge ${item.count === 0 ? 'is-clear' : ''}`}>{item.count > 0 ? homeLabels.blockers(item.count) : homeLabels.noBlockers}</span></td>
                      <td>{item.canOpen && <button type="button" aria-label={item.label} onClick={item.open}>{isArabic ? 'فتح' : 'Open'}</button>}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
          <aside className="home-master__close-side" aria-labelledby="home-readiness-title"><h2 id="home-readiness-title" className="home-master__semantic-heading">{closeSummary}</h2>{selected && !selected.has_hidden_blockers && <span className="home-master__semantic-heading">{selected.disclosed_total}</span>}
            <div className={`home-master__ring ${selected && selected.status !== 'closed' && !selected.ready ? 'is-blocked' : ''}`}>
              {selected ? (selected.status === 'closed' ? t('monthlyClose.closed') : selected.ready ? t('monthlyClose.ready') : (isArabic ? 'قيد العمل' : 'In progress')) : '—'}
            </div>
            {selected && <><strong>{closeSummary}</strong><p>{periodRange}</p><div className="home-master__status"><span className={`home-master__dot ${selected.status !== 'closed' && !selected.ready ? 'is-blocked' : ''}`} /><span>{t(`monthlyClose.${selected.status}`)}</span></div><button type="button" onClick={() => navigate('monthlyClose')}>{t('nav.monthlyClose')}</button></>}
          </aside>
        </section>
      )}
    </section>
  );
}
