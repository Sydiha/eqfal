import { useEffect, useState } from "react";
import "./HomeApproved.css";
import { useTranslation } from "react-i18next";
import { formatDisplayDate } from "../date-format";

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

type SessionUser = {
  email: string;
  display_name?: string;
};

export function Home({
  capabilities,
  navigate,
  navigateToDiscovery,
  onUnauthorized,
}: Props) {
  const { i18n } = useTranslation();
  const isArabic = i18n.language.startsWith("ar");

  const canViewClose = capabilities.includes("monthly_close.view");
  const [periods, setPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(canViewClose);
  const [error, setError] = useState(false);
  const canViewSnapshot = capabilities.some((capability) =>
    ["bank.view", "obligation.view", "document.view"].includes(capability),
  );
  const [snapshot, setSnapshot] = useState<FinancialSnapshot | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);

  // KPI metrics in Figma order with icons
  const kpiMetrics = [
    {
      key: "bank_balances",
      labelAr: "النقد والبنوك",
      labelEn: "Cash and Banks",
      icon: "💰",
      colorClass: "kpi-blue",
    },
    {
      key: "amounts_to_collect",
      labelAr: "الذمم المدينة",
      labelEn: "Receivables",
      icon: "📊",
      colorClass: "kpi-blue-light",
    },
    {
      key: "amounts_to_pay",
      labelAr: "الذمم الدائنة",
      labelEn: "Payables",
      icon: "📋",
      colorClass: "kpi-gray",
    },
    {
      key: "current_month_sales",
      labelAr: "الإيرادات",
      labelEn: "Revenue",
      icon: "📈",
      colorClass: "kpi-gray-light",
    },
    {
      key: "current_month_purchases_expenses",
      labelAr: "المصروفات",
      labelEn: "Expenses",
      icon: "💸",
      colorClass: "kpi-green-light",
    },
    {
      key: "net_profit",
      labelAr: "صافي الربح",
      labelEn: "Net Profit",
      icon: "✓",
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

  useEffect(() => {
    const loadUser = async () => {
      try {
        const response = await fetch("/auth/session", {
          credentials: "same-origin",
        });
        if (response.ok) {
          const data = (await response.json()) as SessionUser;
          setUser(data);
        }
      } catch {
        // User load error - will use default greeting
      }
    };
    void loadUser();
  }, []);

  const selected = periods[0] ?? null;
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
  const dayName = isArabic
    ? new Intl.DateTimeFormat("ar-SA", { weekday: "long" }).format(today)
    : new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(today);
  const fullDate = isArabic
    ? `${dayName}، ${new Intl.DateTimeFormat("ar-SA", { day: "numeric", month: "long", year: "numeric" }).format(today)}`
    : `${dayName}, ${new Intl.DateTimeFormat("en-US", { day: "numeric", month: "long", year: "numeric" }).format(today)}`;

  const monthYear = isArabic
    ? `${new Intl.DateTimeFormat("ar-SA", { month: "long", year: "numeric" }).format(today)}`
    : `${new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(today)}`;

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
        className="home__ring"
        viewBox="0 0 210 210"
        role="img"
        aria-label={`${readyAreas}/${blockerAreas.length}`}
      >
        {blockerAreas.map((item, index) => {
          const a0 = direction * ((index / blockerAreas.length) * 2 * Math.PI + gap);
          const a1 = direction * (((index + 1) / blockerAreas.length) * 2 * Math.PI - gap);
          const [x0, y0] = point(radius, a0);
          const [x1, y1] = point(radius, a1);
          const [x2, y2] = point(inner, a1);
          const [x3, y3] = point(inner, a0);
          const sweep = direction > 0 ? 1 : 0;
          return (
            <path
              key={item.key}
              fill={item.count > 0 ? "#e3e8ee" : "#0e8f7a"}
              d={`M${x0} ${y0}A${radius} ${radius} 0 0 ${sweep} ${x1} ${y1}L${x2} ${y2}A${inner} ${inner} 0 0 ${1 - sweep} ${x3} ${y3}Z`}
            >
              <title>{item.labelAr || item.labelEn}</title>
            </path>
          );
        })}
        <text x="105" y="106" textAnchor="middle" className="home__ring-text">
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
        <div className="home__header-content">
          <h1 id="home-title" className="home__title">
            {isArabic ? "نظرة عامة مالية" : "Financial overview"}
          </h1>
          <p className="home__greeting">
            {isArabic
              ? `مرحباً${user?.display_name ? ` ${user.display_name}` : ""} - ${stripDirectionalMarks(fullDate)}`
              : `Hello${user?.display_name ? ` ${user.display_name}` : ""} - ${fullDate}`}
          </p>
          <p className="home__subtitle">
            {isArabic
              ? `لمحة مالية مجمعة – ${monthYear}`
              : `Aggregate Financial Summary – ${monthYear}`}
          </p>
        </div>
      </header>

      {/* KPI Section - Always Visible */}
      {canViewSnapshot && (
        <section className="home__kpi-section">
          <div className="home__kpi-grid">
            {kpiMetrics.map((kpi) => (
              <div key={kpi.key} className={`home__kpi-card ${kpi.colorClass}`}>
                <div className="home__kpi-icon">{kpi.icon}</div>
                <div className="home__kpi-label">
                  {isArabic ? kpi.labelAr : kpi.labelEn}
                </div>
                <div className="home__kpi-value">
                  {renderKPIValue(kpi)} ر.س
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Closing Readiness Card */}
      {canViewClose && !loading && !error && selected && (
        <section className="home__readiness-section">
          <button
            onClick={() => navigate("monthlyClose")}
            className="home__readiness-button"
          >
            {isArabic ? "عرض معوقات الإقفال" : "View Close Blockers"}
          </button>

          <h2 className="home__section-title">
            {isArabic ? "جاهزية إقفال الفترة الشهرية" : "Monthly Close Readiness"}
          </h2>

          {totalBlockers > 0 && (
            <div className="home__warning-banner">
              {isArabic
                ? `الإقفال غير متاح – يوجد ${totalBlockers} ${totalBlockers === 1 ? "معوقة" : "معوقات"}`
                : `Close unavailable – ${totalBlockers} ${totalBlockers === 1 ? "blocker" : "blockers"}`}
            </div>
          )}

          <div className="home__readiness-card">
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
                  <div key={item.key} className="home__step">
                    <div
                      className={`home__step-icon ${item.count === 0 ? "completed" : "pending"}`}
                    >
                      {item.count === 0 ? "✓" : item.count}
                    </div>
                    <div className="home__step-content">
                      <div className="home__step-label">
                        {isArabic ? item.labelAr : item.labelEn}
                      </div>
                      {item.count > 0 && (
                        <div className="home__step-status">
                          {isArabic ? "قيد الإنجاز" : "In Progress"}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Tasks Table */}
      {canViewClose && !loading && !error && selected && (
        <section className="home__tasks-section">
          <h2 className="home__section-title">
            {isArabic ? "المهام التي تتطلب متابعة" : "Tasks Requiring Follow-up"}
          </h2>
          <div className="eqfal-home__panel">
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
                      <tr key={item.key}>
                        <td>{isArabic ? item.labelAr : item.labelEn}</td>
                        <td>—</td>
                        <td>{item.count}</td>
                        <td>—</td>
                        <td>—</td>
                        <td>
                          <span className="home__status-badge pending">
                            {isArabic ? "قيد المراجعة" : "Under Review"}
                          </span>
                        </td>
                        <td>—</td>
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
                </tbody>
              </table>
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
