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
  const canViewSnapshot = capabilities.some((capability) =>
    ["bank.view", "obligation.view", "document.view"].includes(capability),
  );
  const [snapshot, setSnapshot] = useState<FinancialSnapshot | null>(null);

  // KPI metrics configuration
  const kpiMetrics = [
    {
      key: "bank_balances",
      labelAr: "النقد والبنوك",
      labelEn: "Cash and Banks",
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
      labelAr: "المشتريات والمصروفات",
      labelEn: "Purchases & Expenses",
      available: true,
    },
    {
      key: "net_profit",
      labelAr: "صافي الربح",
      labelEn: "Net Profit",
      available: false,
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

  const blockedTotal = exceptions.reduce((sum, item) => sum + item.count, 0);
  const clearAreas = exceptions.filter((item) => item.count === 0).length;

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
        style={{ width: "100%", maxWidth: "160px", margin: "0 auto 16px" }}
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
              fill={item.count > 0 ? "#e3e8ee" : "#0e8f7a"}
              d={`M${x0} ${y0}A${radius} ${radius} 0 0 ${sweep} ${x1} ${y1}L${x2} ${y2}A${inner} ${inner} 0 0 ${1 - sweep} ${x3} ${y3}Z`}
            >
              <title>{item.label}</title>
            </path>
          );
        })}
        <text x="105" y="106" textAnchor="middle" style={{ fontSize: "28px", fontWeight: 800, fill: "#0b1d3a" }}>
          {clearAreas}/{exceptions.length}
        </text>
      </svg>
    );
  };

  const today = new Date();
  const monthYear = isArabic
    ? `${new Intl.DateTimeFormat("ar-SA", { month: "long", year: "numeric" }).format(today)}`
    : `${new Intl.DateTimeFormat("en-US", { month: "long", year: "numeric" }).format(today)}`;

  const renderKPIValue = (kpi: typeof kpiMetrics[0]) => {
    if (!kpi.available || !snapshot) {
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
        return `${formatFinancialAmount(total.toString())} ${isArabic ? "ر.س" : "SAR"}`;
      }
      return `${formatFinancialAmount(metric.amount)} ${isArabic ? "ر.س" : "SAR"}`;
    }
    return isArabic ? "غير متاح" : "Unavailable";
  };

  return (
    <section
      className="eqfal-home"
      dir={isArabic ? "rtl" : "ltr"}
      data-language={isArabic ? "ar" : "en"}
      aria-labelledby="home-title"
    >
      {/* Page Header */}
      <header className="eqfal-home__header">
        <div className="eqfal-home__header-copy">
          <h1 id="home-title" style={{ marginBottom: "8px" }}>
            {isArabic ? "نظرة عامة مالية" : "Financial Overview"}
          </h1>
          <p style={{ fontSize: "0.9rem", color: "#5b6878", margin: "0" }}>
            {stripDirectionalMarks(formatDisplayDate(today.toISOString().split('T')[0], i18n.language))}
          </p>
        </div>
      </header>

      {/* KPI Section - Always Visible */}
      {canViewSnapshot && (
        <section style={{ marginBottom: "24px" }}>
          <h2 style={{ fontSize: "0.95rem", marginBottom: "12px", color: "#666", fontWeight: 600 }}>
            {isArabic ? `لمحة مالية مجمعة – ${monthYear}` : `Aggregate Financial Summary – ${monthYear}`}
          </h2>
          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            gap: "12px",
          }}>
            {kpiMetrics.map((kpi) => (
              <div
                key={kpi.key}
                style={{
                  padding: "16px",
                  border: "1px solid #e3e8ee",
                  borderRadius: "10px",
                  background: "#fafbfc",
                  textAlign: "center",
                }}
              >
                <div style={{ fontSize: "0.78rem", color: "#5b6878", marginBottom: "8px" }}>
                  {isArabic ? kpi.labelAr : kpi.labelEn}
                </div>
                <div style={{
                  fontSize: "1rem",
                  fontWeight: 700,
                  color: "#0b1d3a",
                  fontFamily: "Readex Pro, sans-serif",
                  wordBreak: "break-word",
                }}>
                  {renderKPIValue(kpi)}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Closing Readiness Card */}
      {canViewClose && !loading && !error && selected && (
        <section style={{ marginBottom: "24px" }}>
          <h2 style={{ fontSize: "0.95rem", marginBottom: "12px", color: "#666", fontWeight: 600 }}>
            {isArabic ? "جاهزية إقفال الفترة الشهرية" : "Monthly Close Readiness"}
          </h2>

          {blockedTotal > 0 && (
            <div style={{
              padding: "12px 16px",
              background: "#fbf0de",
              border: "1px solid #f5d9a3",
              borderRadius: "8px",
              marginBottom: "16px",
              color: "#8f5200",
              fontSize: "0.9rem",
            }}>
              {isArabic
                ? `الإقفال غير متوقف – توجد معوقات ${blockedTotal}`
                : `Close is not paused – there are ${blockedTotal} blockers`}
            </div>
          )}

          <div style={{
            border: "1px solid #e3e8ee",
            borderRadius: "10px",
            padding: "24px",
            background: "#fff",
          }}>
            <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", gap: "32px", alignItems: "start" }}>
              {/* Ring Chart */}
              <div style={{ textAlign: "center" }}>
                {ring()}
              </div>

              {/* Step List */}
              <div>
                <div style={{ marginBottom: "24px" }}>
                  {[
                    { label: isArabic ? "محاسبة وتسوية حسابات البنوك" : "Bank Settlement", status: "completed" },
                    { label: isArabic ? "معالجة الدفعات والإيرادات" : "Process Payments & Revenue", status: "in-progress" },
                    { label: isArabic ? "معالجة المصروفات" : "Process Expenses", status: "in-progress" },
                    { label: isArabic ? "مراجعة الالتزامات" : "Review Obligations", status: "pending" },
                  ].map((step, idx) => (
                    <div key={idx} style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "12px",
                      padding: "8px 0",
                      borderBottom: "1px solid #e3e8ee",
                    }}>
                      <div style={{
                        width: "24px",
                        height: "24px",
                        borderRadius: "50%",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "0.8rem",
                        fontWeight: 700,
                        background: step.status === "completed" ? "#1e7f4f" : step.status === "in-progress" ? "#f5d9a3" : "#e3e8ee",
                        color: step.status === "completed" ? "#fff" : step.status === "in-progress" ? "#8f5200" : "#5b6878",
                        flexShrink: 0,
                      }}>
                        {step.status === "completed" ? "✓" : step.status === "in-progress" ? "◐" : "○"}
                      </div>
                      <div style={{ flex: 1, fontSize: "0.9rem", color: "#0b1d3a" }}>
                        {step.label}
                      </div>
                    </div>
                  ))}
                </div>
                <button
                  onClick={() => navigate("monthlyClose")}
                  style={{
                    padding: "10px 16px",
                    background: "#0b1d3a",
                    color: "#fff",
                    border: "none",
                    borderRadius: "8px",
                    fontSize: "0.85rem",
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {isArabic ? "عرض معوقات الإقفال" : "View Close Blockers"}
                </button>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Issues Table */}
      {canViewClose && !loading && !error && selected && (
        <section style={{ marginBottom: "24px" }}>
          <h2 style={{ fontSize: "0.95rem", marginBottom: "12px", color: "#666", fontWeight: 600 }}>
            {isArabic ? "المعوقات حسب المجال" : "Blockers by Area"}
          </h2>
          <div className="eqfal-home__panel">
            <div className="eqfal-home__table-wrap">
              <table className="eqfal-home__table">
                <thead>
                  <tr>
                    <th>{isArabic ? "المجال" : "Area"}</th>
                    <th>{isArabic ? "الحالة" : "Status"}</th>
                    <th style={{ textAlign: "center" }}>{isArabic ? "النسبة" : "Share"}</th>
                    <th>
                      <span className="eqfal-home__sr-only">{isArabic ? "الإجراء" : "Action"}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {exceptions.map((item) => {
                    const percent = blockedTotal > 0 ? Math.round((item.count / blockedTotal) * 100) : 0;
                    return (
                      <tr
                        key={item.key}
                        className={item.count > 0 ? "is-blocked" : undefined}
                      >
                        <td>{item.label}</td>
                        <td>
                          {item.count > 0
                            ? `${item.count} ${isArabic ? "معوقات" : "blockers"}`
                            : isArabic ? "لا توجد معوقات" : "No blockers"}
                        </td>
                        <td style={{ textAlign: "center" }}>
                          {item.count > 0 ? `${percent}%` : "—"}
                        </td>
                        <td style={{ textAlign: isArabic ? "right" : "left" }}>
                          {item.canOpen && (
                            <button
                              type="button"
                              style={{
                                padding: "6px 12px",
                                background: "transparent",
                                border: "1px solid #0e8f7a",
                                borderRadius: "6px",
                                color: "#0e8f7a",
                                fontSize: "0.85rem",
                                fontWeight: 600,
                                cursor: "pointer",
                              }}
                              onClick={item.open}
                            >
                              {isArabic ? "فتح" : "Open"}
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}

      {/* Last Update Footer */}
      <div style={{
        marginTop: "24px",
        paddingTop: "16px",
        borderTop: "1px solid #e3e8ee",
        fontSize: "0.75rem",
        color: "#999",
        textAlign: isArabic ? "right" : "left",
      }}>
        {isArabic
          ? `آخر تحديث: ${stripDirectionalMarks(formatDisplayDate(today.toISOString().split('T')[0], i18n.language))}`
          : `Last updated: ${stripDirectionalMarks(formatDisplayDate(today.toISOString().split('T')[0], i18n.language))}`}
      </div>
    </section>
  );
}
