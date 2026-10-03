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
  value.replace(/[\u061c\u200e\u200f]/g, "");

export function Home({
  capabilities,
  navigate,
  navigateToDiscovery,
  onUnauthorized,
}: Props) {
  const { t, i18n } = useTranslation();
  const canViewClose = capabilities.includes("monthly_close.view");
  const [periods, setPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(canViewClose);
  const [error, setError] = useState(false);
  const isArabic = i18n.language.startsWith("ar");
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
        ready: "جاهز",
        inProgress: "جارٍ العمل",
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
        ready: "Ready",
        inProgress: "In Progress",
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



  const selected = periods[0] ?? null;
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
          <section
            className={`eqfal-home__status-bar eqfal-home__status-bar--compact ${isReady ? "is-ready" : "is-blocked"}`}
            aria-labelledby="home-readiness-title"
          >
            <div className="eqfal-home__status-bar-content">
              <h2 id="home-readiness-title">{closeSummary}</h2>
              <p className="eqfal-home__status-bar-period">{periodRange}</p>
              <button
                type="button"
                className="eqfal-home__primary-action eqfal-home__primary-action--compact"
                onClick={() => navigate("monthlyClose")}
              >
                <IconMonthlyClose size={16} />
                {t("nav.monthlyClose")}
              </button>
            </div>
          </section>

          <section className="eqfal-home__kpi-tiles">
            <article className="eqfal-home__kpi-tile">
              <span>{homeLabels.readiness}</span>
              <strong>{isReady ? homeLabels.ready : homeLabels.inProgress}</strong>
            </article>
            <article className="eqfal-home__kpi-tile">
              <span>{homeLabels.closeBlockers}</span>
              <strong>
                {selected.has_hidden_blockers
                  ? t("monthlyClose.blockedHidden")
                  : selected.disclosed_total}
              </strong>
            </article>
            <article className="eqfal-home__kpi-tile">
              <span>{homeLabels.periodState}</span>
              <strong>{t(`monthlyClose.${selected.status}`)}</strong>
            </article>
            <article className="eqfal-home__kpi-tile">
              <span>{homeLabels.areasRing}</span>
              <strong>{clearAreas} / {exceptions.length}</strong>
            </article>
          </section>

          {blockedAreaCount > 0 && (
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
                    {exceptions.filter((item) => item.count > 0).map((item) => {
                      const AreaIcon = AREA_ICONS[item.key] ?? IconDocuments;
                      const percent =
                        blockedTotal > 0
                          ? Math.round((item.count / blockedTotal) * 100)
                          : 0;
                      return (
                        <tr key={item.key} className="is-blocked">
                          <td>
                            <span className="eqfal-home__area">
                              <span className="eqfal-home__area-icon">
                                <AreaIcon size={17} />
                              </span>
                              <strong>{item.label}</strong>
                            </span>
                          </td>
                          <td>
                            <span className="home-exception-count is-blocked">
                              {homeLabels.blockers(item.count)}
                            </span>
                          </td>
                          <td className="eqfal-home__col-share">
                            <span className="eqfal-home__share">
                              <span className="eqfal-home__share-track">
                                <b style={{ width: `${percent}%` }} />
                              </span>
                              <span dir="ltr">{percent}%</span>
                            </span>
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
          )}
        </>
      )}

      {selected && (
        <section
          className="eqfal-home__panel eqfal-home__panel--charts"
          aria-labelledby="home-charts-title"
        >
          <div className="eqfal-home__charts-row">
            <div className="eqfal-home__chart-col">
              <h3 id="home-charts-title">{homeLabels.tabs.byArea}</h3>
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
            </div>

            <div className="eqfal-home__chart-col">
              <h3>{homeLabels.periodHistory}</h3>
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
            </div>
          </div>
        </section>
      )}
    </section>
  );
}
