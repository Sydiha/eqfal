import { useEffect, useState } from "react";
import "./HomeApproved.css";
import { useTranslation } from "react-i18next";
import { formatDisplayDate } from "../date-format";
import {
  IconAccounting,
  IconBanks,
  IconDocuments,
  IconFixedAssets,
  IconMonthlyClose,
  IconObligations,
  IconOpeningBalances,
  IconPeriodicAdjustments,
  IconSales,
  IconVAT,
} from "./EqfalIcons";

type HomePage =
  | "fiscalYears"
  | "monthlyClose"
  | "vat"
  | "documents"
  | "banks"
  | "partners"
  | "obligations"
  | "accounting"
  | "sales"
  | "purchases"
  | "assets"
  | "openingBalances"
  | "periodicAdjustments";

type DiscoveryPage =
  | "documents"
  | "banks"
  | "obligations"
  | "vat"
  | "accounting";

type Period = {
  id: string;
  fiscal_year_id: string;
  period_start: string;
  period_end: string;
  status: "open" | "closed";
  ready: boolean;
  disclosed_total: number;
  has_hidden_blockers: boolean;
  blockers: {
    documents: number;
    obligations: number;
    bank_transactions: number;
    vat: number;
    ledger: number;
    assets: number;
    opening_balances: number;
    periodic_adjustments: number;
  };
};

type HomeAlert = {
  key: string;
  class: "needs_action_now" | "upcoming_due" | "needs_review_completion";
  ownership:
    | "current_user"
    | "waiting_for_accountant"
    | "waiting_for_team"
    | "upcoming";
  count: number;
  destination: DiscoveryPage;
  parameters: Record<string, string>;
};

type SnapshotMetric =
  | { state: "available"; amount: string }
  | { state: "hidden" };
type FinancialSnapshot = {
  metrics: {
    bank_balances:
      | { state: "hidden" }
      | {
          state: "available";
          accounts: Array<{
            id: string;
            display_name: string;
            currency_code: string;
            balance:
              | { state: "available"; amount: string }
              | { state: "unavailable" };
          }>;
        };
    amounts_to_collect: SnapshotMetric;
    amounts_to_pay: SnapshotMetric;
    current_month_sales: SnapshotMetric;
    current_month_purchases_expenses: SnapshotMetric;
  };
};

type HomeTab = "byArea" | "history" | "amounts" | "banks" | "queue" | "kpis";

const AREA_ICONS: Record<string, typeof IconDocuments> = {
  documents: IconDocuments,
  obligations: IconObligations,
  banks: IconBanks,
  vat: IconVAT,
  ledger: IconAccounting,
  assets: IconFixedAssets,
  opening_balances: IconOpeningBalances,
  periodic_adjustments: IconPeriodicAdjustments,
};

const ChartIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </svg>
);

const ListIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />
  </svg>
);

const GridIcon = () => (
  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <rect x="3" y="3" width="7" height="7"></rect>
    <rect x="14" y="3" width="7" height="7"></rect>
    <rect x="14" y="14" width="7" height="7"></rect>
    <rect x="3" y="14" width="7" height="7"></rect>
  </svg>
);

type Props = {
  capabilities: readonly string[];
  navigate: (page: HomePage) => void;
  navigateToDiscovery: (
    page: DiscoveryPage,
    parameters: Record<string, string>,
  ) => void;
  startPurchaseEntry: (type: "purchase" | "expense") => void;
  startSalesEntry: () => void;
  onUnauthorized: () => void;
};

const stripDirectionalMarks = (value: string) =>
  value.replace(/[؜‎‏]/g, "");

const formatFinancialAmount = (value: string) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(numeric);
};

export function Home({
  capabilities,
  navigate,
  navigateToDiscovery,
  onUnauthorized,
}: Props) {
  const { i18n, t } = useTranslation();
  const isArabic = i18n.language.startsWith("ar");

  const canViewClose = capabilities.includes("monthly_close.view");
  const [periods, setPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(canViewClose);
  const [error, setError] = useState(false);
  const canViewAlerts = capabilities.some((capability) =>
    ["obligation.view", "document.view", "bank.view"].includes(capability),
  );
  const [alerts, setAlerts] = useState<HomeAlert[]>([]);
  const [alertsLoading, setAlertsLoading] = useState(canViewAlerts);
  const [alertsError, setAlertsError] = useState(false);
  const canViewSnapshot = capabilities.some((capability) =>
    ["bank.view", "obligation.view", "document.view"].includes(capability),
  );
  const [snapshot, setSnapshot] = useState<FinancialSnapshot | null>(null);
  const [snapshotLoading, setSnapshotLoading] = useState(canViewSnapshot);
  const [snapshotError, setSnapshotError] = useState(false);
  const [tab, setTab] = useState<HomeTab | null>(null);

  // Figma KPI config: Available and unavailable metrics
  const kpiMetrics = [
    {
      key: "bank_balances",
      labelAr: "أرصدة بنكية",
      labelEn: "Bank Balances",
      available: true,
    },
    {
      key: "amounts_to_collect",
      labelAr: "الذمم المدينة",
      labelEn: "Receivables",
      available: true,
    },
    {
      key: "amounts_to_pay",
      labelAr: "الذمم الدائنة",
      labelEn: "Payables",
      available: true,
    },
    {
      key: "current_month_sales",
      labelAr: "مبيعات الشهر",
      labelEn: "Month Sales",
      available: true,
    },
    {
      key: "current_month_purchases_expenses",
      labelAr: "مشتريات ومصروفات",
      labelEn: "Month Purchases",
      available: true,
    },
    {
      key: "net_profit",
      labelAr: "صافي الربح",
      labelEn: "Net Profit",
      available: false,
    },
  ];

  const homeLabels = isArabic
    ? {
        dailyOperations: "العمليات اليومية",
        addSale: "إضافة مبيعات",
        addPurchase: "إضافة مشتريات",
        addExpense: "إضافة مصروف",
        uploadDocument: "رفع مستند",
        openSales: "فتح المبيعات",
        openPurchases: "فتح المشتريات",
        openBanking: "فتح البنوك",
        openObligations: "فتح الالتزامات",
        closeBlockers: "معوقات الإقفال",
        area: "المجال",
        blockerState: "حالة المعوقات",
        noBlockers: "لا توجد معوقات",
        blockers: (count: number) => `المعوقات: ${count}`,
        readiness: "جاهزية الإقفال",
        periodState: "حالة الفترة",
        alerts: "قائمة العمل",
        alertsLoading: "جارٍ تحميل التنبيهات…",
        alertsError: "تعذر تحميل التنبيهات.",
        alertsEmpty: "لا توجد إجراءات معلقة.",
        retry: "إعادة المحاولة",
        ownership: {
          current_user: "مطلوب منك الآن",
          upcoming: "قادم",
          waiting_for_accountant: "بانتظار المحاسب",
          waiting_for_team: "بانتظار الفريق",
        },
        snapshot: "الملخص المالي للإدارة",
        bankBalances: "أرصدة البنوك",
        amountsToCollect: "مبالغ للتحصيل",
        amountsToPay: "مبالغ للسداد",
        monthSales: "مبيعات الشهر الحالي",
        monthPurchasesExpenses: "مشتريات ومصروفات الشهر الحالي",
        unavailable: "غير متاح",
        restricted: "مقيّد حسب الصلاحيات",
        snapshotLoading: "جارٍ تحميل الملخص المالي…",
        snapshotError: "تعذر تحميل الملخص المالي.",
        noBankAccounts: "لا توجد حسابات بنكية متاحة.",
        operationalView: "عرض تشغيلي، وليس قائمة مالية أو مقياساً للربحية.",
        tabs: {
          byArea: "المعوقات حسب المجال",
          history: "المعوقات في كل فترة",
          amounts: "المبالغ والمبيعات",
          banks: "أرصدة البنوك",
          kpis: "المؤشرات الرئيسية",
          queue: "قائمة العمل",
        },
        close: "إغلاق",
        share: "نصيبه من المعوقات",
        action: "الإجراء",
        open: "فتح",
        areasReady: (ready: number, total: number) =>
          `${ready} من ${total} مجالات جاهزة`,
        areasWithBlockers: (count: number) => `${count} مجالات بها معوقات`,
        total: (count: number) => `المجموع: ${count}`,
        periodHistory: "المعوقات في الفترات الأخيرة",
        periodHistorySub: "من بيانات فترات الإقفال",
        byAreaSub: "توزيع معوقات الفترة الحالية على المجالات الثمانية",
        areasRing: "مجالات جاهزة",
        hiddenValue: "؟",
      }
    : {
        dailyOperations: "Daily Operations",
        addSale: "Add sale",
        addPurchase: "Add purchase",
        addExpense: "Add expense",
        uploadDocument: "Upload document",
        openSales: "Open sales",
        openPurchases: "Open purchases",
        openBanking: "Open banking",
        openObligations: "Open obligations",
        closeBlockers: "Close blockers",
        area: "Area",
        blockerState: "Blocker status",
        noBlockers: "No blockers",
        blockers: (count: number) => `Blockers: ${count}`,
        readiness: "Close readiness",
        periodState: "Period status",
        alerts: "Work Queue",
        alertsLoading: "Loading alerts…",
        alertsError: "Unable to load alerts.",
        alertsEmpty: "No outstanding actions.",
        retry: "Try again",
        ownership: {
          current_user: "Current user action",
          upcoming: "Upcoming",
          waiting_for_accountant: "Waiting for accountant",
          waiting_for_team: "Waiting for team",
        },
        snapshot: "Manager Financial Snapshot",
        bankBalances: "Bank balances",
        amountsToCollect: "Amounts to collect",
        amountsToPay: "Amounts to pay",
        monthSales: "Current-month sales",
        monthPurchasesExpenses: "Current-month purchases / expenses",
        unavailable: "Unavailable",
        restricted: "Restricted by permissions",
        snapshotLoading: "Loading financial snapshot…",
        snapshotError: "Unable to load financial snapshot.",
        noBankAccounts: "No bank accounts available.",
        operationalView:
          "Operational view — not a financial statement or profitability measure.",
        tabs: {
          byArea: "Blockers by area",
          history: "Blockers per period",
          amounts: "Amounts and sales",
          banks: "Bank balances",
          kpis: "Key metrics",
          queue: "Work queue",
        },
        close: "Close",
        share: "Share of blockers",
        action: "Action",
        open: "Open",
        areasReady: (ready: number, total: number) =>
          `${ready} of ${total} areas are ready`,
        areasWithBlockers: (count: number) => `${count} areas with blockers`,
        total: (count: number) => `Total: ${count}`,
        periodHistory: "Blockers in recent periods",
        periodHistorySub: "From monthly close period data",
        byAreaSub: "Current period blockers across the eight areas",
        areasRing: "areas ready",
        hiddenValue: "?",
      };

  const alertLabels: Record<string, string> = isArabic
    ? {
        overdue_obligations: "التزامات متأخرة",
        upcoming_obligations: "التزامات مستحقة قريباً",
        unconfirmed_obligations: "التزامات غير مؤكدة",
        documents_uploaded: "مستندات مرفوعة للمراجعة",
        documents_needs_review: "مستندات تحتاج مراجعة",
        documents_incomplete: "مستندات غير مكتملة",
        bank_transactions_unmatched: "حركات بنكية غير مطابقة",
        bank_transactions_matched: "حركات بنكية تحتاج تسوية",
      }
    : {
        overdue_obligations: "Overdue obligations",
        upcoming_obligations: "Obligations due soon",
        unconfirmed_obligations: "Unconfirmed obligations",
        documents_uploaded: "Uploaded documents to review",
        documents_needs_review: "Documents needing review",
        documents_incomplete: "Incomplete documents",
        bank_transactions_unmatched: "Unmatched bank transactions",
        bank_transactions_matched: "Bank transactions awaiting reconciliation",
      };

  const load = async () => {
    if (!canViewClose) return;
    setLoading(true);
    setError(false);
    try {
      const response = await fetch("/api/monthly-close-periods", {
        credentials: "same-origin",
      });
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
  }, [canViewClose]);

  const loadAlerts = async () => {
    if (!canViewAlerts) return;
    setAlertsLoading(true);
    setAlertsError(false);
    try {
      const response = await fetch("/api/home-alerts", {
        credentials: "same-origin",
      });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as { alerts?: HomeAlert[] };
      setAlerts(
        Array.isArray(payload.alerts)
          ? payload.alerts.filter((alert) => alert.count > 0)
          : [],
      );
    } catch {
      setAlertsError(true);
    } finally {
      setAlertsLoading(false);
    }
  };

  useEffect(() => {
    if (canViewAlerts) void loadAlerts();
  }, [canViewAlerts]);

  const loadSnapshot = async () => {
    if (!canViewSnapshot) return;
    setSnapshotLoading(true);
    setSnapshotError(false);
    try {
      const response = await fetch("/api/manager-financial-snapshot", {
        credentials: "same-origin",
      });
      if (response.status === 401) onUnauthorized();
      if (!response.ok) throw new Error(String(response.status));
      const payload = (await response.json()) as Partial<FinancialSnapshot>;
      if (!payload.metrics) throw new Error("Invalid snapshot");
      setSnapshot(payload as FinancialSnapshot);
    } catch {
      setSnapshotError(true);
    } finally {
      setSnapshotLoading(false);
    }
  };

  useEffect(() => {
    if (canViewSnapshot) void loadSnapshot();
  }, [canViewSnapshot]);

  const selected = periods[0] ?? null;
  const alertGroups = (
    [
      "current_user",
      "upcoming",
      "waiting_for_accountant",
      "waiting_for_team",
    ] as const
  )
    .map((ownership) => ({
      ownership,
      alerts: alerts.filter((alert) => alert.ownership === ownership),
    }))
    .filter((group) => group.alerts.length > 0);
  const can = (capability: string) => capabilities.includes(capability);
  const periodParameters = selected
    ? { from: selected.period_start, to: selected.period_end }
    : null;

  const exceptions = selected
    ? [
        {
          key: "documents",
          label: t("nav.documents"),
          count: selected.blockers.documents,
          canOpen: can("document.view"),
          open: () => navigateToDiscovery("documents", periodParameters!),
        },
        {
          key: "obligations",
          label: t("nav.obligations"),
          count: selected.blockers.obligations,
          canOpen: can("obligation.view"),
          open: () =>
            navigateToDiscovery("obligations", { confirmation: "unconfirmed" }),
        },
        {
          key: "banks",
          label: t("nav.banks"),
          count: selected.blockers.bank_transactions,
          canOpen: can("bank.view"),
          open: () =>
            navigateToDiscovery("banks", {
              section: "transactions",
              ...periodParameters!,
            }),
        },
        {
          key: "vat",
          label: t("nav.vat"),
          count: selected.blockers.vat,
          canOpen: can("vat.view"),
          open: () =>
            navigateToDiscovery("vat", {
              vatFrom: selected.period_start,
              vatTo: selected.period_end,
            }),
        },
        {
          key: "ledger",
          label: `${t("nav.accounting")} / ${t("accounting.tabs.ledger")}`,
          count: selected.blockers.ledger,
          canOpen: can("accounting.view"),
          open: () =>
            navigateToDiscovery("accounting", {
              accountingTab: "sources",
              sourceFrom: selected.period_start,
              sourceTo: selected.period_end,
            }),
        },
        {
          key: "assets",
          label: isArabic ? "الأصول الثابتة" : "Fixed Assets",
          count: selected.blockers.assets,
          canOpen: can("asset.view"),
          open: () => navigate("assets"),
        },
        {
          key: "opening_balances",
          label: isArabic ? "الأرصدة الافتتاحية" : "Opening Balances",
          count: selected.blockers.opening_balances,
          canOpen: can("opening_balance.view"),
          open: () => navigate("openingBalances"),
        },
        {
          key: "periodic_adjustments",
          label: isArabic ? "التسويات الدورية" : "Periodic Adjustments",
          count: selected.blockers.periodic_adjustments,
          canOpen: can("periodic_adjustment.view"),
          open: () => navigate("periodicAdjustments"),
        },
      ]
    : [];

  const closeSummary = selected
    ? selected.status === "closed"
      ? homeLabels.noBlockers
      : selected.ready
        ? t("monthlyClose.ready")
        : selected.has_hidden_blockers
          ? t("monthlyClose.blockedHidden")
          : homeLabels.blockers(selected.disclosed_total)
    : "";

  const periodRange = selected ? (
    <span dir="ltr" style={{ unicodeBidi: "isolate", whiteSpace: "nowrap" }}>
      <span>
        {stripDirectionalMarks(
          formatDisplayDate(selected.period_start, i18n.language),
        )}
      </span>
      <span aria-hidden="true"> — </span>
      <span>
        {stripDirectionalMarks(
          formatDisplayDate(selected.period_end, i18n.language),
        )}
      </span>
    </span>
  ) : null;

  const blockedTotal = exceptions.reduce((sum, item) => sum + item.count, 0);
  const clearAreas = exceptions.filter((item) => item.count === 0).length;
  const blockedAreaCount = exceptions.length - clearAreas;
  const maxAreaCount = Math.max(1, ...exceptions.map((item) => item.count));
  const isReady = selected
    ? selected.status === "closed" || selected.ready
    : false;
  const recentPeriods = [...periods]
    .sort((a, b) => a.period_start.localeCompare(b.period_start))
    .slice(-6);
  const maxPeriodTotal = Math.max(
    1,
    ...recentPeriods.map((period) => period.disclosed_total),
  );
  const monthLabel = (value: string) => {
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime())
      ? value
      : new Intl.DateTimeFormat(i18n.language, { month: "short" }).format(date);
  };
  const tabs: Array<{ key: HomeTab; label: string; icon: JSX.Element; show: boolean }> = [
    {
      key: "kpis",
      label: homeLabels.tabs.kpis,
      icon: <GridIcon />,
      show: canViewSnapshot,
    },
    {
      key: "byArea",
      label: homeLabels.tabs.byArea,
      icon: <ChartIcon />,
      show: canViewClose && !!selected && !loading && !error,
    },
    {
      key: "history",
      label: homeLabels.tabs.history,
      icon: <IconMonthlyClose size={17} />,
      show: canViewClose && recentPeriods.length > 0 && !loading && !error,
    },
    {
      key: "amounts",
      label: homeLabels.tabs.amounts,
      icon: <IconSales size={17} />,
      show: canViewSnapshot,
    },
    {
      key: "banks",
      label: homeLabels.tabs.banks,
      icon: <IconBanks size={17} />,
      show: canViewSnapshot,
    },
    {
      key: "queue",
      label: homeLabels.tabs.queue,
      icon: <ListIcon />,
      show: canViewAlerts,
    },
  ];
  const visibleTabs = tabs.filter((item) => item.show);
  const activeTab = visibleTabs.some((item) => item.key === tab) ? tab : null;

  const snapshotState = snapshotLoading ? (
    <p role="status">{homeLabels.snapshotLoading}</p>
  ) : snapshotError || !snapshot ? (
    <p role="alert">
      {homeLabels.snapshotError}{" "}
      <button type="button" onClick={() => void loadSnapshot()}>
        {homeLabels.retry}
      </button>
    </p>
  ) : null;

  const panelHeading = (id: string, title: string, subtitle?: string) => (
    <div className="eqfal-home__section-heading">
      <div>
        <h2 id={id}>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      <button
        type="button"
        className="eqfal-home__panel-close"
        aria-label={homeLabels.close}
        onClick={() => setTab(null)}
      >
        <span aria-hidden="true">✕</span>
      </button>
    </div>
  );

  const ring = () => {
    const radius = 82;
    const inner = 60;
    const center = 105;
    const gap = 0.05;
    const direction = isArabic ? -1 : 1;
    const point = (r: number, angle: number) => [
      center + r * Math.sin(angle),
      center - r * Math.cos(angle),
    ];
    return (
      <svg
        className="eqfal-home__ring"
        viewBox="0 0 210 210"
        role="img"
        aria-label={`${clearAreas}/${exceptions.length}`}
      >
        {exceptions.map((item, index) => {
          const a0 = direction * ((index / 8) * 2 * Math.PI + gap);
          const a1 = direction * (((index + 1) / 8) * 2 * Math.PI - gap);
          const [x0, y0] = point(radius, a0);
          const [x1, y1] = point(radius, a1);
          const [x2, y2] = point(inner, a1);
          const [x3, y3] = point(inner, a0);
          const sweep = direction > 0 ? 1 : 0;
          return (
            <path
              key={item.key}
              className={item.count > 0 ? "is-blocked" : "is-clear"}
              d={`M${x0} ${y0}A${radius} ${radius} 0 0 ${sweep} ${x1} ${y1}L${x2} ${y2}A${inner} ${inner} 0 0 ${1 - sweep} ${x3} ${y3}Z`}
            >
              <title>{item.label}</title>
            </path>
          );
        })}
        <text x="105" y="106" textAnchor="middle" className="eqfal-home__ring-value">
          {clearAreas}/{exceptions.length}
        </text>
        <text x="105" y="130" textAnchor="middle" className="eqfal-home__ring-label">
          {homeLabels.areasRing}
        </text>
      </svg>
    );
  };

  const renderKPIValue = (kpi: typeof kpiMetrics[0]) => {
    if (!kpi.available || !snapshot) {
      return homeLabels.unavailable;
    }

    const metric = (snapshot.metrics as Record<string, any>)[kpi.key];
    if (!metric) return homeLabels.unavailable;
    if (metric.state === "hidden") return homeLabels.restricted;
    if (metric.state === "available") {
      if (kpi.key === "bank_balances" && metric.accounts) {
        const total = metric.accounts
          .filter((acc: any) => acc.balance.state === "available")
          .reduce((sum: number, acc: any) => sum + Number(acc.balance.amount), 0);
        return `${formatFinancialAmount(total.toString())}`;
      }
      return `${formatFinancialAmount(metric.amount)}`;
    }
    return homeLabels.unavailable;
  };

  return (
    <section
      className="eqfal-home"
      dir={isArabic ? "rtl" : "ltr"}
      data-language={isArabic ? "ar" : "en"}
      aria-labelledby="home-title"
    >
      <header className="eqfal-home__header">
        <div className="eqfal-home__header-copy">
          <p className="eqfal-home__eyebrow">{t("home.workspace")}</p>
          <h1 id="home-title">
            {isArabic ? "نظرة عامة مالية" : "Financial overview"}
          </h1>
          <p className="eqfal-home__intro">
            {isArabic
              ? "أهم المؤشرات والأرقام التي تتطلب اهتمامك اليوم"
              : "Key indicators and figures requiring your attention today"}
          </p>
        </div>
      </header>

      {canViewClose && (loading || error || !selected) && (
        <section
          className="eqfal-home__status-strip"
          aria-label={t("monthlyClose.title")}
        >
          {loading ? (
            <span role="status">{t("monthlyClose.loading")}</span>
          ) : error ? (
            <>
              <span role="alert">{t("monthlyClose.error")}</span>
              <button type="button" onClick={() => void load()}>
                {t("common.retry")}
              </button>
            </>
          ) : (
            <span role="status">{t("monthlyClose.empty")}</span>
          )}
        </section>
      )}

      {canViewClose && !loading && !error && selected && (
        <>
          <aside
            className={`eqfal-home__hero ${isReady ? "is-ready" : "is-blocked"}`}
            aria-labelledby="home-readiness-title"
          >
            <div className="eqfal-home__hero-main">
              <div className="eqfal-home__hero-meta">
                <span className="eqfal-home__hero-rule" aria-hidden="true" />
                <span>{homeLabels.readiness}</span>
                <span className="eqfal-home__hero-period">{periodRange}</span>
                <span className="eqfal-home__hero-pill">
                  {t(`monthlyClose.${selected.status}`)}
                </span>
              </div>
              <h2 id="home-readiness-title">{closeSummary}</h2>
              {selected.status === "open" && !selected.has_hidden_blockers && (
                <p className="eqfal-home__hero-sub">
                  {homeLabels.areasReady(clearAreas, exceptions.length)}
                </p>
              )}
              <div className="eqfal-home__hero-actions">
                <button
                  type="button"
                  className="eqfal-home__primary-action"
                  onClick={() => navigate("monthlyClose")}
                >
                  <IconMonthlyClose size={18} />
                  {t("nav.monthlyClose")}
                </button>
              </div>
            </div>
            <div className="eqfal-home__hero-stat">
              <span>{homeLabels.closeBlockers}</span>
              <strong>
                {selected.has_hidden_blockers
                  ? t("monthlyClose.blockedHidden")
                  : selected.disclosed_total}
              </strong>
              <small>
                {homeLabels.periodState}: {t(`monthlyClose.${selected.status}`)}
              </small>
            </div>
          </aside>

          <section
            className="eqfal-home__panel eqfal-home__panel--blockers"
            aria-labelledby="home-exceptions-title"
          >
            <div className="eqfal-home__section-heading eqfal-home__section-heading--table">
              <div>
                <p className="eqfal-home__eyebrow">{t("monthlyClose.title")}</p>
                <h2 id="home-exceptions-title">{homeLabels.closeBlockers}</h2>
              </div>
            </div>
            <div className="eqfal-home__table-wrap">
              <table className="eqfal-home__table">
                <thead>
                  <tr>
                    <th>{homeLabels.area}</th>
                    <th>{homeLabels.blockerState}</th>
                    <th className="eqfal-home__col-share">{homeLabels.share}</th>
                    <th>
                      <span className="eqfal-home__sr-only">{homeLabels.action}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {exceptions.map((item) => {
                    const AreaIcon = AREA_ICONS[item.key] ?? IconDocuments;
                    const percent =
                      blockedTotal > 0
                        ? Math.round((item.count / blockedTotal) * 100)
                        : 0;
                    return (
                      <tr
                        key={item.key}
                        className={item.count > 0 ? "is-blocked" : undefined}
                      >
                        <td>
                          <span className="eqfal-home__area">
                            <span className="eqfal-home__area-icon">
                              <AreaIcon size={17} />
                            </span>
                            <strong>{item.label}</strong>
                          </span>
                        </td>
                        <td>
                          <span
                            className={`home-exception-count ${item.count > 0 ? "is-blocked" : "is-clear"}`}
                          >
                            {item.count > 0
                              ? homeLabels.blockers(item.count)
                              : homeLabels.noBlockers}
                          </span>
                        </td>
                        <td className="eqfal-home__col-share">
                          {item.count > 0 ? (
                            <span className="eqfal-home__share">
                              <span className="eqfal-home__share-track">
                                <b style={{ width: `${percent}%` }} />
                              </span>
                              <span dir="ltr">{percent}%</span>
                            </span>
                          ) : (
                            <span className="eqfal-home__share">—</span>
                          )}
                        </td>
                        <td className="eqfal-home__col-action">
                          {item.canOpen && (
                            <button
                              type="button"
                              className="eqfal-home__link-action"
                              aria-label={item.label}
                              onClick={item.open}
                            >
                              <span>{homeLabels.open}</span>
                              <span aria-hidden="true">{isArabic ? "←" : "→"}</span>
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!selected.has_hidden_blockers && (
              <div className="eqfal-home__table-foot">
                <span>{homeLabels.areasWithBlockers(blockedAreaCount)}</span>
                <span>{homeLabels.total(blockedTotal)}</span>
              </div>
            )}
          </section>
        </>
      )}

      {visibleTabs.length > 0 && (
        <div className="eqfal-home__tabs" role="toolbar">
          {visibleTabs.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`eqfal-home__tab${activeTab === item.key ? " is-active" : ""}`}
              aria-expanded={activeTab === item.key}
              aria-controls={`home-panel-${item.key}`}
              onClick={() => setTab(activeTab === item.key ? null : item.key)}
            >
              {item.icon}
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      )}

      {activeTab === "kpis" && (
        <section
          id="home-panel-kpis"
          className="eqfal-home__panel eqfal-home__panel--detail"
          aria-labelledby="home-kpis-title"
        >
          {panelHeading("home-kpis-title", homeLabels.tabs.kpis)}
          {snapshotState ?? (
            <div className="eqfal-home__grid">
              {kpiMetrics.map((kpi) => (
                <article
                  className={`eqfal-home__metric eqfal-home__metric--${kpi.key}`}
                  key={kpi.key}
                >
                  <h3>{isArabic ? kpi.labelAr : kpi.labelEn}</h3>
                  <strong dir="ltr">{renderKPIValue(kpi)}</strong>
                </article>
              ))}
            </div>
          )}
        </section>
      )}

      {activeTab === "byArea" && selected && (
        <section
          id="home-panel-byArea"
          className="eqfal-home__panel eqfal-home__panel--detail"
          aria-labelledby="home-byarea-title"
        >
          {panelHeading("home-byarea-title", homeLabels.tabs.byArea, homeLabels.byAreaSub)}
          <div className="eqfal-home__byarea">
            {ring()}
            <div className="eqfal-home__bars">
              {exceptions.map((item) => (
                <div
                  key={item.key}
                  className={`eqfal-home__bar${item.count === 0 ? " is-clear" : ""}`}
                >
                  <span>{item.label}</span>
                  <span className="eqfal-home__bar-track">
                    {item.count > 0 && (
                      <b style={{ width: `${(item.count / maxAreaCount) * 100}%` }} />
                    )}
                  </span>
                  <strong>{item.count}</strong>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {activeTab === "history" && (
        <section
          id="home-panel-history"
          className="eqfal-home__panel eqfal-home__panel--detail"
          aria-labelledby="home-history-title"
        >
          {panelHeading("home-history-title", homeLabels.periodHistory, homeLabels.periodHistorySub)}
          <div className="eqfal-home__columns">
            {recentPeriods.map((period) => (
              <div
                key={period.id}
                className={`eqfal-home__column${period.id === selected?.id ? " is-current" : ""}`}
                title={`${monthLabel(period.period_start)} · ${
                  period.has_hidden_blockers
                    ? t("monthlyClose.blockedHidden")
                    : homeLabels.blockers(period.disclosed_total)
                }`}
              >
                <span className="eqfal-home__column-value">
                  {period.has_hidden_blockers
                    ? homeLabels.hiddenValue
                    : period.disclosed_total}
                </span>
                <span className="eqfal-home__column-bar">
                  <b
                    style={{
                      height: `${Math.max(period.disclosed_total > 0 ? 8 : 3, (period.disclosed_total / maxPeriodTotal) * 100)}%`,
                    }}
                  />
                </span>
                <span className="eqfal-home__column-label">
                  {monthLabel(period.period_start)}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {activeTab === "amounts" && (
        <section
          id="home-panel-amounts"
          className="eqfal-home__panel eqfal-home__panel--detail"
          aria-labelledby="home-financial-snapshot-title"
        >
          {panelHeading("home-financial-snapshot-title", homeLabels.snapshot, homeLabels.operationalView)}
          {snapshotState ?? (
            <div className="eqfal-home__grid">
              {(
                [
                  ["amounts_to_collect", homeLabels.amountsToCollect],
                  ["amounts_to_pay", homeLabels.amountsToPay],
                  ["current_month_sales", homeLabels.monthSales],
                  [
                    "current_month_purchases_expenses",
                    homeLabels.monthPurchasesExpenses,
                  ],
                ] as const
              ).map(([key, label]) => {
                const metric = snapshot!.metrics[key];
                return (
                  <article
                    className={`eqfal-home__metric eqfal-home__metric--${key}`}
                    key={key}
                  >
                    <h3>{label}</h3>
                    <strong dir="ltr">
                      {metric.state === "available"
                        ? `${formatFinancialAmount(metric.amount)}${isArabic ? " ر.س" : " SAR"}`
                        : homeLabels.restricted}
                    </strong>
                  </article>
                );
              })}
            </div>
          )}
        </section>
      )}

      {activeTab === "banks" && (
        <section
          id="home-panel-banks"
          className="eqfal-home__panel eqfal-home__panel--detail"
          aria-labelledby="home-banks-title"
        >
          {panelHeading("home-banks-title", homeLabels.bankBalances, homeLabels.operationalView)}
          {snapshotState ??
            (snapshot!.metrics.bank_balances.state === "hidden" ? (
              <p>{homeLabels.restricted}</p>
            ) : snapshot!.metrics.bank_balances.accounts.length === 0 ? (
              <p>{homeLabels.noBankAccounts}</p>
            ) : (
              <div className="eqfal-home__banks">
                {snapshot!.metrics.bank_balances.accounts.map((account) => (
                  <p className="eqfal-home__bank-account" key={account.id}>
                    <span>{account.display_name}</span>
                    <strong dir="ltr">
                      {account.balance.state === "available"
                        ? `${formatFinancialAmount(account.balance.amount)} ${isArabic && account.currency_code === "SAR" ? "ر.س" : account.currency_code}`
                        : homeLabels.unavailable}
                    </strong>
                  </p>
                ))}
              </div>
            ))}
        </section>
      )}

      {activeTab === "queue" && (
        <section
          id="home-panel-queue"
          className="eqfal-home__panel eqfal-home__panel--detail eqfal-home__panel--queue"
          aria-labelledby="home-alerts-title"
        >
          {panelHeading("home-alerts-title", homeLabels.alerts)}
          {alertsLoading ? (
            <p role="status">{homeLabels.alertsLoading}</p>
          ) : alertsError ? (
            <p role="alert">
              {homeLabels.alertsError}{" "}
              <button type="button" onClick={() => void loadAlerts()}>
                {homeLabels.retry}
              </button>
            </p>
          ) : alerts.length === 0 ? (
            <p role="status">{homeLabels.alertsEmpty}</p>
          ) : (
            <div className="eqfal-home__tasks">
              <div className="eqfal-home__tasks-header" aria-hidden="true">
                <span>{isArabic ? "التصنيف" : "CATEGORY"}</span>
                <span>{isArabic ? "العنصر" : "ITEM"}</span>
                <span>{isArabic ? "العدد" : "COUNT"}</span>
                <span>{isArabic ? "المسؤول" : "OWNER"}</span>
                <span>{isArabic ? "الحالة" : "STATUS"}</span>
                <span>{isArabic ? "الإجراء" : "ACTION"}</span>
              </div>
              {alertGroups.flatMap((group) =>
                group.alerts.map((alert) => (
                  <button
                    key={alert.key}
                    type="button"
                    className="eqfal-home__task-row"
                    onClick={() =>
                      navigateToDiscovery(alert.destination, alert.parameters)
                    }
                  >
                    <span
                      className={`eqfal-home__task-category eqfal-home__task-category--${alert.class}`}
                    >
                      {isArabic
                        ? alert.class === "needs_action_now"
                          ? "عاجل"
                          : alert.class === "upcoming_due"
                            ? "قادم"
                            : "مراجعة"
                        : alert.class === "needs_action_now"
                          ? "Action now"
                          : alert.class === "upcoming_due"
                            ? "Upcoming"
                            : "Review"}
                    </span>
                    <span className="eqfal-home__task-name">
                      {alertLabels[alert.key] ?? alert.key}
                    </span>
                    <strong className="eqfal-home__task-count">
                      {alert.count}
                    </strong>
                    <span className="eqfal-home__task-owner">
                      {homeLabels.ownership[group.ownership]}
                    </span>
                    <span
                      className={`eqfal-home__task-status eqfal-home__task-status--${alert.ownership}`}
                    >
                      {isArabic
                        ? alert.ownership === "waiting_for_accountant"
                          ? "بانتظار المحاسب"
                          : alert.ownership === "upcoming"
                            ? "قادم"
                            : "يتطلب إجراء"
                        : alert.ownership === "waiting_for_accountant"
                          ? "Waiting for accountant"
                          : alert.ownership === "upcoming"
                            ? "Upcoming"
                            : "Action required"}
                    </span>
                    <span className="eqfal-home__task-open" aria-hidden="true">
                      {isArabic ? "←" : "→"}
                    </span>
                  </button>
                )),
              )}
            </div>
          )}
        </section>
      )}
    </section>
  );
}
