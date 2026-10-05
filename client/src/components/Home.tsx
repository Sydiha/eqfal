import { useEffect, useState } from "react";
import "@fontsource/readex-pro";
import "./HomeApproved.css";
import { useTranslation } from "react-i18next";
import { formatDisplayDate } from "../date-format";
import { useDateContext } from "../context/DateContext";

// Figma Home KPI and status icons (presentation only).
const svgProps = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
const KpiIconCard = () => (<svg {...svgProps}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 10h18M7 15h4" /></svg>);
const KpiIconPeople = () => (<svg {...svgProps}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0" /><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14a6.5 6.5 0 0 1 3.5 6" /></svg>);
const KpiIconBook = () => (<svg {...svgProps}><path d="M5 4h11a2 2 0 0 1 2 2v14H7a2 2 0 0 1-2-2z" /><path d="M5 18a2 2 0 0 1 2-2h11" /></svg>);
const KpiIconArrowIn = () => (<svg {...svgProps}><path d="M17 7 7 17M7 9v8h8" /></svg>);
const KpiIconArrowOut = () => (<svg {...svgProps}><path d="M7 17 17 7M9 7h8v8" /></svg>);
const KpiIconTrend = () => (<svg {...svgProps}><path d="m3 17 6-6 4 4 8-8" /><path d="M15 7h6v6" /></svg>);
const IconFile = () => (<svg {...svgProps} width={16} height={16}><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5" /></svg>);
const IconCheckCircle = () => (<svg {...svgProps} width={18} height={18}><circle cx="12" cy="12" r="9" /><path d="m8 12.5 2.5 2.5L16 9.5" /></svg>);
const IconRing = () => (<svg {...svgProps} width={18} height={18}><circle cx="12" cy="12" r="8.5" /></svg>);

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

type Props = {
  capabilities: readonly string[];
  navigate: (page: HomePage) => void;
  navigateToDiscovery: (
    page: DiscoveryPage,
    parameters: Record<string, string>,
  ) => void;
  onUnauthorized: () => void;
  periods?: Period[];
  selectedPeriodId?: string | null;
  onSelectedPeriodChange?: (periodId: string) => void;
  onPeriodsLoad?: (p: Period[]) => void;
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
  periods: externalPeriods = [],
  selectedPeriodId: _unusedSelectedPeriodId = null,
  onSelectedPeriodChange: _unusedOnSelectedPeriodChange,
  onPeriodsLoad,
}: Props) {
  const { i18n } = useTranslation();
  const isArabic = i18n.language.startsWith("ar");
  const { selectedPeriodId, onSelectPeriod } = useDateContext();

  const canViewClose = capabilities.includes("monthly_close.view");
  const [periods, setPeriods] = useState<Period[]>(externalPeriods);
  const [loading, setLoading] = useState(canViewClose);
  const [error, setError] = useState(false);
  const canViewSnapshot = capabilities.some((capability) =>
    ["bank.view", "obligation.view", "document.view"].includes(capability),
  );
  const [snapshot, setSnapshot] = useState<FinancialSnapshot | null>(null);

  // KPI metrics in Figma order with icons
  const kpiMetrics = [
    {
      key: "bank_balances",
      labelAr: "النقد والبنوك",
      labelEn: "Cash and Banks",
      icon: KpiIconCard,
      colorClass: "kpi-blue",
    },
    {
      key: "amounts_to_collect",
      labelAr: "الذمم المدينة",
      labelEn: "Receivables",
      icon: KpiIconPeople,
      colorClass: "kpi-blue-light",
    },
    {
      key: "amounts_to_pay",
      labelAr: "الذمم الدائنة",
      labelEn: "Payables",
      icon: KpiIconBook,
      colorClass: "kpi-gray",
    },
    {
      key: "current_month_sales",
      labelAr: "الإيرادات",
      labelEn: "Revenue",
      icon: KpiIconArrowIn,
      colorClass: "kpi-gray-light",
    },
    {
      key: "current_month_purchases_expenses",
      labelAr: "المصروفات",
      labelEn: "Expenses",
      icon: KpiIconArrowOut,
      colorClass: "kpi-green-light",
    },
    {
      key: "net_profit",
      labelAr: "صافي الربح",
      labelEn: "Net Profit",
      icon: KpiIconTrend,
      colorClass: "kpi-green",
    },
  ];

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
      const fetchedPeriods = Array.isArray(payload.periods) ? payload.periods : [];
      setPeriods(fetchedPeriods);
      if (onPeriodsLoad) onPeriodsLoad(fetchedPeriods);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (canViewClose) void load();
  }, [canViewClose]);

  const loadSnapshot = async () => {
    if (!canViewSnapshot) return;
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
      // Snapshot load error - will display unavailable values in KPI cards
    }
  };

  useEffect(() => {
    if (canViewSnapshot) void loadSnapshot();
  }, [canViewSnapshot]);

  const selected = periods.find((p) => p.id === selectedPeriodId) ?? periods[0] ?? null;
  const can = (capability: string) => capabilities.includes(capability);
  const periodParameters = selected
    ? { from: selected.period_start, to: selected.period_end }
    : null;

  // Build 8 steps from blocker areas
  const blockerAreas = [
    {
      key: "documents",
      labelAr: "المستندات",
      labelEn: "Documents",
      count: selected?.blockers.documents ?? 0,
      canOpen: can("document.view"),
      navigate: () => navigateToDiscovery("documents", periodParameters!),
    },
    {
      key: "obligations",
      labelAr: "الالتزامات",
      labelEn: "Obligations",
      count: selected?.blockers.obligations ?? 0,
      canOpen: can("obligation.view"),
      navigate: () =>
        navigateToDiscovery("obligations", { confirmation: "unconfirmed" }),
    },
    {
      key: "banks",
      labelAr: "البنوك",
      labelEn: "Banks",
      count: selected?.blockers.bank_transactions ?? 0,
      canOpen: can("bank.view"),
      navigate: () =>
        navigateToDiscovery("banks", {
          section: "transactions",
          ...periodParameters!,
        }),
    },
    {
      key: "vat",
      labelAr: "ضريبة القيمة المضافة",
      labelEn: "VAT",
      count: selected?.blockers.vat ?? 0,
      canOpen: can("vat.view"),
      navigate: () =>
        navigateToDiscovery("vat", {
          vatFrom: selected?.period_start ?? "",
          vatTo: selected?.period_end ?? "",
        }),
    },
    {
      key: "ledger",
      labelAr: "الدفاتر المحاسبية",
      labelEn: "Ledger",
      count: selected?.blockers.ledger ?? 0,
      canOpen: can("accounting.view"),
      navigate: () =>
        navigateToDiscovery("accounting", {
          accountingTab: "sources",
          sourceFrom: selected?.period_start ?? "",
          sourceTo: selected?.period_end ?? "",
        }),
    },
    {
      key: "assets",
      labelAr: "الأصول الثابتة",
      labelEn: "Fixed Assets",
      count: selected?.blockers.assets ?? 0,
      canOpen: can("asset.view"),
      navigate: () => navigate("assets"),
    },
    {
      key: "opening_balances",
      labelAr: "الأرصدة الافتتاحية",
      labelEn: "Opening Balances",
      count: selected?.blockers.opening_balances ?? 0,
      canOpen: can("opening_balance.view"),
      navigate: () => navigate("openingBalances"),
    },
    {
      key: "periodic_adjustments",
      labelAr: "التسويات الدورية",
      labelEn: "Periodic Adjustments",
      count: selected?.blockers.periodic_adjustments ?? 0,
      canOpen: can("periodic_adjustment.view"),
      navigate: () => navigate("periodicAdjustments"),
    },
  ];

  const readyAreas = blockerAreas.filter((item) => item.count === 0).length;
  const totalBlockers = blockerAreas.reduce((sum, item) => sum + item.count, 0);
  const readyPercentage = Math.round((readyAreas / blockerAreas.length) * 100);

  const today = new Date();
  const displayDate = selected ? new Date(selected.period_start) : today;
  const dayName = isArabic
    ? new Intl.DateTimeFormat("ar-u-ca-gregory", { weekday: "long" }).format(displayDate)
    : new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(displayDate);
  const fullDate = isArabic
    ? `${dayName}، ${new Intl.DateTimeFormat("ar-u-ca-gregory", { day: "numeric", month: "long", year: "numeric" }).format(displayDate)}`
    : `${dayName}, ${new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", year: "numeric" }).format(displayDate)}`;

  const monthYear = isArabic
    ? `${new Intl.DateTimeFormat("ar-u-ca-gregory", { month: "long", year: "numeric" }).format(displayDate)}`
    : `${new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(displayDate)}`;

  const renderKPIValue = (kpi: typeof kpiMetrics[0]) => {
    if (!snapshot) {
      return isArabic ? "غير متاح" : "Unavailable";
    }

    const metric = (snapshot.metrics as Record<string, any>)[kpi.key];
    if (!metric) return isArabic ? "غير متاح" : "Unavailable";
    if (metric.state === "hidden") return isArabic ? "مقيّد" : "Restricted";
    if (metric.state === "available") {
      if (kpi.key === "bank_balances" && metric.accounts) {
        const total = metric.accounts
          .filter((acc: any) => acc.balance.state === "available")
          .reduce((sum: number, acc: any) => sum + Number(acc.balance.amount), 0);
        return formatFinancialAmount(String(total));
      }
      return formatFinancialAmount(metric.amount);
    }
    return isArabic ? "غير متاح" : "Unavailable";
  };

  const renderKPIAmount = (kpi: typeof kpiMetrics[0], value: string) => {
    if (kpi.key === "net_profit" && value === (isArabic ? "غير متاح" : "Unavailable")) {
      return value;
    }
    if (kpi.key === "net_profit") {
      return value;
    }
    return `${value} ${isArabic ? "ر.س" : "SAR"}`;
  };

  const ring = () => {
    const radius = 82;
    const circumference = 2 * Math.PI * radius;
    const filled = (readyPercentage / 100) * circumference;
    return (
      <svg
        className="home__ring"
        viewBox="0 0 210 210"
        role="img"
        aria-label={`${readyAreas}/${blockerAreas.length}`}
      >
        <circle cx="105" cy="105" r={radius} fill="none" stroke="#e4e8ec" strokeWidth="22" />
        <circle
          cx="105"
          cy="105"
          r={radius}
          fill="none"
          stroke="#16b88f"
          strokeWidth="22"
          strokeDasharray={`${filled} ${circumference}`}
          transform="rotate(-90 105 105)"
        />
        <text x="105" y="106" textAnchor="middle" dominantBaseline="middle" className="home__ring-text">
          {readyPercentage}%
        </text>
      </svg>
    );
  };

  return (
    <section
      className="eqfal-home"
      dir={isArabic ? "rtl" : "ltr"}
      data-language={i18n.language}
      aria-labelledby="home-title"
    >
      {/* Page Header */}
      <header className="home__header">
        <h1 id="home-title" className="home__title">
          {isArabic ? "نظرة عامة مالية" : "Financial overview"}
        </h1>
        <div className="home__header-row">
          <p className="home__date">
            {isArabic ? stripDirectionalMarks(fullDate) : fullDate}
          </p>
          <p className="home__greeting">
            {isArabic
              ? "مرحباً. إليك أهم ما يتطلب اهتمامك اليوم"
              : "Hello. Here is what needs your attention today"}
          </p>
        </div>
        <p className="home__subtitle">
          {isArabic
            ? `لمحة مالية مجمعة – ${monthYear}`
            : `Aggregate Financial Summary – ${monthYear}`}
        </p>
      </header>

      {/* Period Selector */}
      {periods.length > 1 && (
        <div className="home__period-selector">
          <label htmlFor="period-select" className="home__period-label">
            {isArabic ? "الفترة:" : "Period:"}
          </label>
          <select
            id="period-select"
            className="home__period-select"
            value={selectedPeriodId || ""}
            onChange={(e) => e.target.value && onSelectPeriod(e.target.value, 'specific')}
          >
            {periods.map((period) => {
              const start = new Date(period.period_start);
              const end = new Date(period.period_end);
              const label = isArabic
                ? `${start.toLocaleDateString("ar-EG")} - ${end.toLocaleDateString("ar-EG")}`
                : `${start.toLocaleDateString("en-US")} - ${end.toLocaleDateString("en-US")}`;
              return (
                <option key={period.id} value={period.id}>
                  {label}
                </option>
              );
            })}
          </select>
        </div>
      )}

      {/* KPI Section - Always Visible */}
      {canViewSnapshot && (
        <section className="home__kpi-section">
          <div className="home__kpi-grid">
            {kpiMetrics.map((kpi) => {
              const value = renderKPIValue(kpi);
              const IconComponent = kpi.icon;
              return (
                <div key={kpi.key} className={`home__kpi-card ${kpi.colorClass}`}>
                  <div className="home__kpi-text">
                    <div className="home__kpi-label">
                      {isArabic ? kpi.labelAr : kpi.labelEn}
                    </div>
                    <div className="home__kpi-value">
                      {renderKPIAmount(kpi, value)}
                    </div>
                  </div>
                  <div className="home__kpi-icon">
                    <IconComponent />
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* Tasks Table - BEFORE Readiness */}
      {canViewClose && !loading && !error && selected && (
        <section className="home__tasks-section">
          <div className="home__tasks-card">
            <div className="home__tasks-header-content">
              <h2 className="home__section-title">
                {isArabic ? "المهام التي تتطلب متابعة" : "Tasks Requiring Follow-up"}
              </h2>
              <p className="home__tasks-subtitle">
                {isArabic ? `${blockerAreas.filter(a => a.count > 0).length} مجالات تتطلب معالجة` : `${blockerAreas.filter(a => a.count > 0).length} areas requiring attention`}
              </p>
            </div>
            <div className="eqfal-home__table-wrap">
              <table className="eqfal-home__table">
                <thead>
                  <tr>
                    <th>{isArabic ? "التصنيف" : "Classification"}</th>
                    <th>{isArabic ? "العنصر" : "Item"}</th>
                    <th>{isArabic ? "العدد" : "Count"}</th>
                    <th>{isArabic ? "المبلغ" : "Amount"}</th>
                    <th>{isArabic ? "المسؤول" : "Responsible"}</th>
                    <th>{isArabic ? "الحالة" : "Status"}</th>
                    <th>{isArabic ? "الأولوية" : "Priority"}</th>
                    <th>
                      <span className="eqfal-home__sr-only">
                        {isArabic ? "الإجراء" : "Action"}
                      </span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {blockerAreas.map((item) => (
                    item.count > 0 && (
                      <tr key={item.key} className={item.count >= 3 ? "home__table-row-critical" : ""}>
                        <td>
                          <span className="home__task-category">
                            <IconFile />
                            {isArabic ? item.labelAr : item.labelEn}
                          </span>
                        </td>
                        <td data-empty="true">—</td>
                        <td>{item.count}</td>
                        <td data-empty="true">—</td>
                        <td data-empty="true">—</td>
                        <td>
                          <span className={`home__status-badge ${item.count >= 3 ? "critical" : item.count >= 1 ? "warning" : "neutral"}`}>
                            {item.count >= 3 ? (isArabic ? "حرج" : "Critical") : item.count >= 1 ? (isArabic ? "تحذير" : "Warning") : (isArabic ? "محايد" : "Neutral")}
                          </span>
                        </td>
                        <td data-empty="true">—</td>
                        <td style={{ textAlign: isArabic ? "right" : "left" }}>
                          {item.canOpen && (
                            <button
                              type="button"
                              className="home__action-button"
                              onClick={item.navigate}
                            >
                              {isArabic ? "معالجة" : "Handle"}
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  ))}
                  {blockerAreas.filter(a => a.count > 0).length > 0 && (
                    <tr className="home__table-totals">
                      <td colSpan={2}><strong>{isArabic ? "الإجمالي" : "Total"}</strong></td>
                      <td><strong>{totalBlockers}</strong></td>
                      <td>—</td>
                      <td colSpan={4}></td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* Closing Readiness Card */}
      {canViewClose && !loading && !error && selected && (
        <section className="home__readiness-section">
          <div className="home__readiness-card">
            <div className="home__readiness-header">
              <div className="home__readiness-header-content">
                <h2 className="home__section-title">
                  {isArabic ? "جاهزية إقفال الفترة الشهرية" : "Monthly Close Readiness"}
                </h2>
                <p className="home__readiness-subtitle">
                  {isArabic
                    ? `مستوى اكتمال مجالات إقفال شهر ${monthYear}`
                    : `Completion of close areas for ${monthYear}`}
                </p>
              </div>
              <div className="home__readiness-actions">
                <span className="home__readiness-updated">
                  {isArabic
                    ? `آخر تحديث: ${stripDirectionalMarks(formatDisplayDate(today.toISOString().split('T')[0], i18n.language))}`
                    : `Last updated: ${formatDisplayDate(today.toISOString().split('T')[0], i18n.language)}`}
                </span>
                <button
                  onClick={() => navigate("monthlyClose")}
                  className="home__readiness-button"
                >
                  {isArabic ? "عرض معوقات الإقفال" : "View Close Blockers"}
                </button>
              </div>
            </div>

            {totalBlockers > 0 && (
              <div className="home__warning-banner">
                <span>
                  {isArabic
                    ? `الإقفال غير متاح – يوجد ${totalBlockers} ${totalBlockers === 1 ? "معوقة" : "معوقات"}`
                    : `Close unavailable – ${totalBlockers} ${totalBlockers === 1 ? "blocker" : "blockers"}`}
                </span>
                <span className="home__warning-dot" aria-hidden="true"></span>
              </div>
            )}

            <div className="home__readiness-grid">
              {/* Ring Chart */}
              <div className="home__ring-container">
                {ring()}
                <div className="home__ring-caption">
                  <div className="home__ring-title">
                    {isArabic ? "نسبة الإنجاز الكلية" : "Overall Progress"}
                  </div>
                  <div className="home__ring-subtitle">
                    {isArabic
                      ? `${readyAreas} من ${blockerAreas.length} مجالات مكتملة`
                      : `${readyAreas} of ${blockerAreas.length} areas completed`}
                  </div>
                </div>
              </div>

              {/* Steps List */}
              <div className="home__steps-list">
                {blockerAreas.map((item) => (
                  <div
                    key={item.key}
                    className={`home__step ${item.count === 0 ? "completed" : item.count >= 3 ? "critical" : "warning"}`}
                  >
                    <span className="home__step-icon">
                      {item.count === 0 ? <IconCheckCircle /> : <IconRing />}
                    </span>
                    <span className="home__step-label">
                      {isArabic ? item.labelAr : item.labelEn}
                    </span>
                    <span className="home__step-status">
                      {item.count === 0
                        ? (isArabic ? "مكتملة" : "Complete")
                        : item.count >= 3
                          ? (isArabic ? "معوق للإقفال" : "Blocking close")
                          : (isArabic ? "قيد التنفيذ" : "In progress")}
                    </span>
                    <span className="home__step-count">
                      {item.count > 0
                        ? (isArabic ? `${item.count} عناصر مفتوحة` : `${item.count} open items`)
                        : "—"}
                    </span>
                    <span className="home__step-action">
                      {item.canOpen && (
                        <button type="button" className="home__step-link" onClick={item.navigate}>
                          {item.count === 0 ? (isArabic ? "عرض" : "View") : (isArabic ? "متابعة" : "Follow up")}
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              </div>

              {/* Legend Panel */}
              <div className="home__readiness-legend">
                <div className="home__legend-item">
                  <div className="home__legend-dot home__legend-complete"></div>
                  <span>{isArabic ? "مكتمل" : "Complete"}</span>
                </div>
                <div className="home__legend-item">
                  <div className="home__legend-dot home__legend-warning"></div>
                  <span>{isArabic ? "يحتاج إجراء" : "Needs Action"}</span>
                </div>
                <div className="home__legend-item">
                  <div className="home__legend-dot home__legend-critical"></div>
                  <span>{isArabic ? "معوق للإقفال" : "Blocking close"}</span>
                </div>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Error State */}
      {canViewClose && error && (
        <div className="home__error">
          <p>{isArabic ? "غير قادر على تحميل البيانات" : "Unable to load data"}</p>
          <button onClick={load} className="home__retry-button">
            {isArabic ? "حاول مجدداً" : "Try Again"}
          </button>
        </div>
      )}

      {/* Last Update Footer */}
      <footer className="home__footer">
        <div className="home__footer-content">
          <span>
            {isArabic
              ? `آخر تحديث: ${stripDirectionalMarks(formatDisplayDate(today.toISOString().split('T')[0], i18n.language))}`
              : `Last updated: ${stripDirectionalMarks(formatDisplayDate(today.toISOString().split('T')[0], i18n.language))}`}
          </span>
        </div>
      </footer>
    </section>
  );
}
