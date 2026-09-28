import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatDisplayDate } from '../date-format';
import { canStartOperationalDocumentEntry } from './operationalEntryCapabilities';

type HomePage = 'fiscalYears' | 'monthlyClose' | 'vat' | 'documents' | 'banks' | 'partners' | 'obligations' | 'accounting' | 'sales' | 'purchases';
type DiscoveryPage = 'documents' | 'banks' | 'obligations' | 'vat' | 'accounting';
type Period = { id: string; fiscal_year_id: string; period_start: string; period_end: string; status: 'open' | 'closed'; ready: boolean; disclosed_total: number; has_hidden_blockers: boolean; blockers: { documents: number; obligations: number; bank_transactions: number; vat: number; ledger: number } };
type HomeAlert = { key: string; class: 'needs_action_now' | 'upcoming_due' | 'needs_review_completion'; ownership: 'current_user' | 'waiting_for_accountant' | 'waiting_for_team' | 'upcoming'; count: number; destination: DiscoveryPage; parameters: Record<string, string> };
type SnapshotMetric = { state: 'available'; amount: string } | { state: 'hidden' };
type FinancialSnapshot = { metrics: { bank_balances: { state: 'hidden' } | { state: 'available'; accounts: Array<{ id: string; display_name: string; currency_code: string; balance: { state: 'available'; amount: string } | { state: 'unavailable' } }> }; amounts_to_collect: SnapshotMetric; amounts_to_pay: SnapshotMetric; current_month_sales: SnapshotMetric; current_month_purchases_expenses: SnapshotMetric } };
type Props = { capabilities: readonly string[]; navigate: (page: HomePage) => void; navigateToDiscovery: (page: DiscoveryPage, parameters: Record<string, string>) => void; startPurchaseEntry: (type: 'purchase' | 'expense') => void; startSalesEntry: () => void; onUnauthorized: () => void };

const stripDirectionalMarks = (value: string) => value.replace(/[\u061c\u200e\u200f]/g, '');

export function Home({ capabilities, navigate, navigateToDiscovery, startPurchaseEntry, startSalesEntry, onUnauthorized }: Props) {
  const { t, i18n } = useTranslation();
  const isArabic = i18n.language.startsWith('ar');
  const can = (capability: string) => capabilities.includes(capability);
  const canViewClose = can('monthly_close.view');
  const canViewAlerts = capabilities.some(capability => ['obligation.view', 'document.view', 'bank.view'].includes(capability));
  const canViewSnapshot = capabilities.some(capability => ['bank.view', 'obligation.view', 'document.view'].includes(capability));
  const [periods, setPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(canViewClose);
  const [error, setError] = useState(false);
  const [alerts, setAlerts] = useState<HomeAlert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(canViewAlerts);
  const [alertsError, setAlertsError] = useState(false);
  const [snapshot, setSnapshot] = useState<FinancialSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(canViewSnapshot);
  const [snapshotError, setSnapshotError] = useState(false);

  const labels = isArabic ? {
    title: 'النظرة العامة المالية', subtitle: 'ملخص تشغيلي لأهم المؤشرات والمهام وجاهزية الإقفال.', financial: 'المؤشرات المالية', actions: 'إجراءات سريعة', alerts: 'المهام التي تتطلب متابعة', alert: 'المهمة', owner: 'الحالة', count: 'العدد', action: 'الإجراء', open: 'فتح', close: 'جاهزية إقفال الفترة الشهرية', blockers: 'معوقات الإقفال', area: 'المجال', state: 'الحالة', period: 'الفترة', periodState: 'حالة الفترة', noBlockers: 'لا توجد معوقات', restricted: 'مقيّد حسب الصلاحيات', unavailable: 'غير متاح', retry: 'إعادة المحاولة', noAlerts: 'لا توجد إجراءات معلقة.', loadingSnapshot: 'جارٍ تحميل المؤشرات المالية…', snapshotError: 'تعذر تحميل المؤشرات المالية.', alertsLoading: 'جارٍ تحميل المهام…', alertsError: 'تعذر تحميل المهام.', noBanks: 'لا توجد حسابات بنكية متاحة.', bank: 'أرصدة البنوك', collect: 'مبالغ للتحصيل', pay: 'مبالغ للسداد', sales: 'مبيعات الشهر الحالي', purchases: 'مشتريات ومصروفات الشهر الحالي', addSale: 'إضافة مبيعات', addPurchase: 'إضافة مشتريات', addExpense: 'إضافة مصروف', upload: 'رفع مستند', ownership: { current_user: 'مطلوب منك الآن', upcoming: 'قادم', waiting_for_accountant: 'بانتظار المحاسب', waiting_for_team: 'بانتظار الفريق' }, blockersCount: (n: number) => `المعوقات: ${n}`,
  } : {
    title: 'Financial Overview', subtitle: 'Operational summary of key metrics, follow-ups and monthly-close readiness.', financial: 'Financial indicators', actions: 'Quick actions', alerts: 'Tasks requiring follow-up', alert: 'Task', owner: 'Status', count: 'Count', action: 'Action', open: 'Open', close: 'Monthly close readiness', blockers: 'Close blockers', area: 'Area', state: 'Status', period: 'Period', periodState: 'Period status', noBlockers: 'No blockers', restricted: 'Restricted by permissions', unavailable: 'Unavailable', retry: 'Retry', noAlerts: 'No outstanding actions.', loadingSnapshot: 'Loading financial indicators…', snapshotError: 'Unable to load financial indicators.', alertsLoading: 'Loading tasks…', alertsError: 'Unable to load tasks.', noBanks: 'No bank accounts available.', bank: 'Bank balances', collect: 'Amounts to collect', pay: 'Amounts to pay', sales: 'Current-month sales', purchases: 'Current-month purchases / expenses', addSale: 'Add sale', addPurchase: 'Add purchase', addExpense: 'Add expense', upload: 'Upload document', ownership: { current_user: 'Current user action', upcoming: 'Upcoming', waiting_for_accountant: 'Waiting for accountant', waiting_for_team: 'Waiting for team' }, blockersCount: (n: number) => `Blockers: ${n}`,
  };

  const alertLabels: Record<string, string> = isArabic ? {
    overdue_obligations: 'التزامات متأخرة', upcoming_obligations: 'التزامات مستحقة قريباً', unconfirmed_obligations: 'التزامات غير مؤكدة', documents_uploaded: 'مستندات مرفوعة للمراجعة', documents_needs_review: 'مستندات تحتاج مراجعة', documents_incomplete: 'مستندات غير مكتملة', bank_transactions_unmatched: 'حركات بنكية غير مطابقة', bank_transactions_matched: 'حركات بنكية تحتاج تسوية',
  } : {
    overdue_obligations: 'Overdue obligations', upcoming_obligations: 'Obligations due soon', unconfirmed_obligations: 'Unconfirmed obligations', documents_uploaded: 'Uploaded documents to review', documents_needs_review: 'Documents needing review', documents_incomplete: 'Incomplete documents', bank_transactions_unmatched: 'Unmatched bank transactions', bank_transactions_matched: 'Bank transactions awaiting reconciliation',
  };

  const loadClose = async () => {
    if (!canViewClose) return;
    setLoading(true); setError(false);
    try {
      const response = await fetch('/api/monthly-close-periods', { credentials: 'same-origin' });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as { periods?: Period[] };
      setPeriods(Array.isArray(payload.periods) ? payload.periods : []);
    } catch { setError(true); } finally { setLoading(false); }
  };

  const loadAlerts = async () => {
    if (!canViewAlerts) return;
    setAlertsLoading(true); setAlertsError(false);
    try {
      const response = await fetch('/api/home-alerts', { credentials: 'same-origin' });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as { alerts?: HomeAlert[] };
      setAlerts(Array.isArray(payload.alerts) ? payload.alerts.filter(alert => alert.count > 0) : []);
    } catch { setAlertsError(true); } finally { setAlertsLoading(false); }
  };

  const loadSnapshot = async () => {
    if (!canViewSnapshot) return;
    setSnapshotLoading(true); setSnapshotError(false);
    try {
      const response = await fetch('/api/manager-financial-snapshot', { credentials: 'same-origin' });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as Partial<FinancialSnapshot>;
      if (!payload.metrics) throw new Error('Invalid snapshot');
      setSnapshot(payload as FinancialSnapshot);
    } catch { setSnapshotError(true); } finally { setSnapshotLoading(false); }
  };

  useEffect(() => { if (canViewClose) void loadClose(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [canViewClose]);
  useEffect(() => { if (canViewAlerts) void loadAlerts(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [canViewAlerts]);
  useEffect(() => { if (canViewSnapshot) void loadSnapshot(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [canViewSnapshot]);

  const selected = periods[0] ?? null;
  const canStartEntry = canStartOperationalDocumentEntry(capabilities);
  const quickActions = [
    { key: 'sale', label: labels.addSale, visible: canStartEntry, open: startSalesEntry },
    { key: 'purchase', label: labels.addPurchase, visible: canStartEntry, open: () => startPurchaseEntry('purchase') },
    { key: 'expense', label: labels.addExpense, visible: canStartEntry, open: () => startPurchaseEntry('expense') },
    { key: 'upload', label: labels.upload, visible: can('document.upload'), open: () => navigate('documents') },
  ].filter(item => item.visible);
  const periodParameters = selected ? { from: selected.period_start, to: selected.period_end } : null;
  const exceptions = selected ? [
    { key: 'documents', label: t('nav.documents'), count: selected.blockers.documents, canOpen: can('document.view'), open: () => navigateToDiscovery('documents', periodParameters!) },
    { key: 'obligations', label: t('nav.obligations'), count: selected.blockers.obligations, canOpen: can('obligation.view'), open: () => navigateToDiscovery('obligations', { confirmation: 'unconfirmed' }) },
    { key: 'banks', label: t('nav.banks'), count: selected.blockers.bank_transactions, canOpen: can('bank.view'), open: () => navigateToDiscovery('banks', { section: 'transactions', ...periodParameters! }) },
    { key: 'vat', label: t('nav.vat'), count: selected.blockers.vat, canOpen: can('vat.view'), open: () => navigateToDiscovery('vat', { vatFrom: selected.period_start, vatTo: selected.period_end }) },
    { key: 'ledger', label: `${t('nav.accounting')} / ${t('accounting.tabs.ledger')}`, count: selected.blockers.ledger, canOpen: can('accounting.view'), open: () => navigateToDiscovery('accounting', { accountingTab: 'sources', sourceFrom: selected.period_start, sourceTo: selected.period_end }) },
  ] : [];
  const closeSummary = selected ? selected.status === 'closed' ? labels.noBlockers : selected.ready ? t('monthlyClose.ready') : selected.has_hidden_blockers ? t('monthlyClose.blockedHidden') : labels.blockersCount(selected.disclosed_total) : '';
  const periodRange = selected ? <span dir="ltr"><span>{stripDirectionalMarks(formatDisplayDate(selected.period_start, i18n.language))}</span><span aria-hidden="true"> — </span><span>{stripDirectionalMarks(formatDisplayDate(selected.period_end, i18n.language))}</span></span> : null;
  const metricValue = (metric: SnapshotMetric) => metric.state === 'available' ? metric.amount : labels.restricted;
  const firstBank = snapshot?.metrics.bank_balances.state === 'available' ? snapshot.metrics.bank_balances.accounts[0] : null;
  const bankValue = snapshot?.metrics.bank_balances.state === 'hidden' ? labels.restricted : firstBank ? firstBank.balance.state === 'available' ? `${firstBank.balance.amount} ${firstBank.currency_code}` : labels.unavailable : labels.noBanks;

  return (
    <main className="home-master" aria-labelledby="home-title">
      <header className="home-master__header">
        <div><p className="home-master__eyebrow">{t('home.workspace')}</p><h1 id="home-title">{labels.title}</h1><p>{labels.subtitle}</p></div>
        {quickActions.length > 0 && <div className="home-master__quick-actions" aria-label={labels.actions}>{quickActions.map(item => <button key={item.key} type="button" onClick={item.open}>{item.label}</button>)}</div>}
      </header>

      {canViewSnapshot && <section className="home-master__section" aria-labelledby="financial-title">
        <div className="home-master__section-head"><h2 id="financial-title">{labels.financial}</h2></div>
        {snapshotLoading ? <div className="home-master__state" role="status">{labels.loadingSnapshot}</div> : snapshotError || !snapshot ? <div className="home-master__state" role="alert">{labels.snapshotError} <button type="button" onClick={() => void loadSnapshot()}>{labels.retry}</button></div> : <div className="home-master__kpis">
          <article><span>{labels.bank}</span><strong dir="ltr">{bankValue}</strong></article>
          <article><span>{labels.collect}</span><strong dir="ltr">{metricValue(snapshot.metrics.amounts_to_collect)}</strong></article>
          <article><span>{labels.pay}</span><strong dir="ltr">{metricValue(snapshot.metrics.amounts_to_pay)}</strong></article>
          <article><span>{labels.sales}</span><strong dir="ltr">{metricValue(snapshot.metrics.current_month_sales)}</strong></article>
          <article><span>{labels.purchases}</span><strong dir="ltr">{metricValue(snapshot.metrics.current_month_purchases_expenses)}</strong></article>
        </div>}
      </section>}

      {canViewAlerts && <section className="home-master__section" aria-labelledby="alerts-title">
        <div className="home-master__section-head"><h2 id="alerts-title">{labels.alerts}</h2><span>{alerts.length}</span></div>
        {alertsLoading ? <div className="home-master__state" role="status">{labels.alertsLoading}</div> : alertsError ? <div className="home-master__state" role="alert">{labels.alertsError} <button type="button" onClick={() => void loadAlerts()}>{labels.retry}</button></div> : alerts.length === 0 ? <div className="home-master__empty" role="status">{labels.noAlerts}</div> : <div className="home-master__table-wrap"><table className="home-master__table"><thead><tr><th>{labels.alert}</th><th>{labels.owner}</th><th>{labels.count}</th><th>{labels.action}</th></tr></thead><tbody>{alerts.map(alert => <tr key={alert.key}><td><strong>{alertLabels[alert.key] ?? alert.key}</strong></td><td><span className={`home-master__status home-master__status--${alert.ownership}`}>{labels.ownership[alert.ownership]}</span></td><td><strong>{alert.count}</strong></td><td><button type="button" onClick={() => navigateToDiscovery(alert.destination, alert.parameters)}>{labels.open}</button></td></tr>)}</tbody></table></div>}
      </section>}

      {canViewClose && <section className="home-master__section" aria-labelledby="close-title">
        <div className="home-master__section-head"><div><h2 id="close-title">{labels.close}</h2>{selected && <p>{labels.period}: {periodRange}</p>}</div>{selected && <span className={`home-master__status ${selected.status === 'closed' || selected.ready ? 'is-ready' : 'is-blocked'}`}>{closeSummary}</span>}</div>
        {loading ? <div className="home-master__state" role="status">{t('monthlyClose.loading')}</div> : error ? <div className="home-master__state" role="alert">{t('monthlyClose.error')} <button type="button" onClick={() => void loadClose()}>{t('common.retry')}</button></div> : !selected ? <div className="home-master__empty">{t('monthlyClose.empty')}</div> : <div className="home-master__close-grid">
          <div className="home-master__table-wrap"><table className="home-master__table"><thead><tr><th>{labels.area}</th><th>{labels.state}</th><th>{labels.action}</th></tr></thead><tbody>{exceptions.map(item => <tr key={item.key}><td><strong>{item.label}</strong></td><td><span className={`home-master__status ${item.count > 0 ? 'is-blocked' : 'is-ready'}`}>{item.count > 0 ? labels.blockersCount(item.count) : labels.noBlockers}</span></td><td>{item.canOpen && <button type="button" onClick={item.open}>{labels.open}</button>}</td></tr>)}</tbody></table></div>
          <aside className="home-master__readiness"><span>{labels.close}</span><strong>{closeSummary}</strong><dl><div><dt>{labels.periodState}</dt><dd>{t(`monthlyClose.${selected.status}`)}</dd></div><div><dt>{labels.blockers}</dt><dd>{selected.has_hidden_blockers ? t('monthlyClose.blockedHidden') : selected.disclosed_total}</dd></div></dl><button type="button" onClick={() => navigate('monthlyClose')}>{t('nav.monthlyClose')}</button></aside>
        </div>}
      </section>}
    </main>
  );
}
