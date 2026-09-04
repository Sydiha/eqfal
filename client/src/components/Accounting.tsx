import { FormEvent, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDisplayDate } from "../date-format";
import {
  PageHeader,
  StatusBadge,
  WorkspaceState,
  WorkspaceToolbar,
} from "./SharedUI";
import {
  AccountResponse,
  JournalLineEditor,
  JournalLineResponse,
  JournalResponse,
  journalLineToEditor,
  serializeJournalLines,
} from "./accounting-contracts";
import {
  clearQueryParameters,
  readQueryParameter,
  writeQueryParameters,
} from "../navigation/queryState";
import "./accounting-ux.css";

type Account = AccountResponse;
type Year = { id: string; name: string; start_date: string; end_date: string };
type Journal = JournalResponse;
type Line = JournalLineEditor;
type TrialRow = Account & {
  debit_movement: string;
  credit_movement: string;
  debit_balance: string;
  credit_balance: string;
};
type LedgerRow = {
  accounting_date: string;
  journal_id: string;
  reference: string | null;
  description: string;
  debit: string;
  credit: string;
  running_balance: string;
};
type OperationalSource = {
  source_type: string;
  source_id: string;
  accounting_date: string;
  amount: string;
  description: string;
  reference: string | null;
};
type Tab = "accounts" | "journals" | "sources" | "trial" | "ledger";
type JournalFilters = {
  search: string;
  status: "" | "draft" | "posted";
  entryType: "" | "standard" | "opening_balance";
  from: string;
  to: string;
};
type SourceFilters = {
  search: string;
  type: string;
  from: string;
  to: string;
  amountMin: string;
  amountMax: string;
};
const tabs: readonly Tab[] = [
  "accounts",
  "journals",
  "sources",
  "trial",
  "ledger",
];
const journalFilterParameters = [
  "journalSearch",
  "journalStatus",
  "journalEntryType",
  "journalFrom",
  "journalTo",
] as const;
const sourceFilterParameters = [
  "sourceSearch",
  "sourceType",
  "sourceFrom",
  "sourceTo",
  "sourceAmountMin",
  "sourceAmountMax",
] as const;
const validDate = (value: string | null) => {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return "";
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
    ? value
    : "";
};
const validNumber = (value: string | null) =>
  value !== null && value.trim() !== "" && Number.isFinite(Number(value))
    ? value
    : "";
const readTab = () =>
  readQueryParameter("accountingTab", { allowedValues: tabs }) as Tab | null;
const readJournalFilters = (): JournalFilters => ({
  search: readQueryParameter("journalSearch") ?? "",
  status: (readQueryParameter("journalStatus", {
    allowedValues: ["draft", "posted"],
  }) ?? "") as JournalFilters["status"],
  entryType: (readQueryParameter("journalEntryType", {
    allowedValues: ["standard", "opening_balance"],
  }) ?? "") as JournalFilters["entryType"],
  from: validDate(readQueryParameter("journalFrom")),
  to: validDate(readQueryParameter("journalTo")),
});
const readSourceFilters = (): SourceFilters => ({
  search: readQueryParameter("sourceSearch") ?? "",
  type: readQueryParameter("sourceType") ?? "",
  from: validDate(readQueryParameter("sourceFrom")),
  to: validDate(readQueryParameter("sourceTo")),
  amountMin: validNumber(readQueryParameter("sourceAmountMin")),
  amountMax: validNumber(readQueryParameter("sourceAmountMax")),
});
interface Props {
  canView: boolean;
  canManageChart: boolean;
  canManageJournals: boolean;
  canPost: boolean;
  onUnauthorized: () => void;
}
class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
  ) {
    super(String(status));
  }
}
const VAT_RECOGNITION_ERROR =
  "لا يمكن ترحيل القيد. ضريبة القيمة المضافة المعتمدة للمستند لم يتم إثباتها بشكل صحيح في القيد. / The journal cannot be posted. The reviewed VAT is not correctly recognized in the journal.";
async function api(
  url: string,
  options: RequestInit,
  onUnauthorized: () => void,
) {
  const response = await fetch(url, { credentials: "same-origin", ...options });
  if (response.status === 401) onUnauthorized();
  if (!response.ok) {
    let code: string | null = null;
    try {
      const payload = (await response.clone().json()) as { code?: unknown };
      if (typeof payload.code === "string") code = payload.code;
    } catch {
      // Preserve the existing generic error behavior for non-JSON responses.
    }
    throw new ApiError(response.status, code);
  }
  return response;
}
const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});
const emptyLine = (): Line => ({
  account_id: "",
  debit: "0.00",
  credit: "0.00",
  memo: "",
});

export function Accounting({
  canView,
  canManageChart,
  canManageJournals,
  canPost,
  onUnauthorized,
}: Props) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language.startsWith("ar");
  const [tab, setTabState] = useState<Tab>(() => readTab() ?? "accounts");
  const [journalFilters, setJournalFilters] = useState(readJournalFilters);
  const [sourceFilters, setSourceFilters] = useState(readSourceFilters);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [years, setYears] = useState<Year[]>([]);
  const [journals, setJournals] = useState<Journal[]>([]);
  const [selected, setSelected] = useState<Journal | null>(null);
  const [lines, setLines] = useState<Line[]>([emptyLine(), emptyLine()]);
  const [trial, setTrial] = useState<TrialRow[]>([]);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [sources, setSources] = useState<OperationalSource[]>([]);
  const [loading, setLoading] = useState(canView);
  const [error, setError] = useState(false);
  const [operationError, setOperationError] = useState<"closed" | null>(null);
  const [vatRecognitionError, setVatRecognitionError] = useState(false);
  const [refreshError, setRefreshError] = useState<
    "workspace" | "journal" | null
  >(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const copy = ar
    ? {
        difference: "الفرق",
        journalLines: "سطور القيد",
        sourceDetails: "تفاصيل المصدر",
        closedPeriod: "لا يمكن إنشاء أو ترحيل قيد داخل فترة محاسبية مقفلة.",
      }
    : {
        difference: "Difference",
        journalLines: "Journal lines",
        sourceDetails: "Source details",
        closedPeriod: "A journal cannot be created or posted inside a closed accounting period.",
      };
  const sourceLabels: Record<string, string> = ar
    ? {
        obligation: "ذمة",
        document_settlement: "تسوية مستند",
        obligation_settlement: "تسوية ذمة",
        custody_allocation: "تخصيص عهدة",
        custody_funding: "تمويل عهدة",
        custody_return: "إعادة عهدة",
      }
    : {
        obligation: "Obligation",
        document_settlement: "Document settlement",
        obligation_settlement: "Obligation settlement",
        custody_allocation: "Custody allocation",
        custody_funding: "Custody funding",
        custody_return: "Custody return",
      };
  const formatMoney = (value: string | number) =>
    new Intl.NumberFormat(ar ? "ar-SA" : "en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
      useGrouping: true,
    }).format(Number(value));
  const sourceDescription = (source: OperationalSource) =>
    source.description.replace(/^[^:]+:\s*/, "") || source.description;
  const setTab = (value: Tab) => {
    setTabState(value);
    writeQueryParameters({ accountingTab: value });
  };
  const updateJournalFilter = (key: keyof JournalFilters, value: string) => {
    setJournalFilters((current) => ({ ...current, [key]: value }));
    const names: Record<keyof JournalFilters, string> = {
      search: "journalSearch",
      status: "journalStatus",
      entryType: "journalEntryType",
      from: "journalFrom",
      to: "journalTo",
    };
    writeQueryParameters({ [names[key]]: value }, "replace");
  };
  const updateSourceFilter = (key: keyof SourceFilters, value: string) => {
    setSourceFilters((current) => ({ ...current, [key]: value }));
    const names: Record<keyof SourceFilters, string> = {
      search: "sourceSearch",
      type: "sourceType",
      from: "sourceFrom",
      to: "sourceTo",
      amountMin: "sourceAmountMin",
      amountMax: "sourceAmountMax",
    };
    writeQueryParameters({ [names[key]]: value }, "replace");
  };
  const clearJournalFilters = () => {
    setJournalFilters({
      search: "",
      status: "",
      entryType: "",
      from: "",
      to: "",
    });
    clearQueryParameters(journalFilterParameters);
  };
  const clearSourceFilters = () => {
    setSourceFilters({
      search: "",
      type: "",
      from: "",
      to: "",
      amountMin: "",
      amountMax: "",
    });
    clearQueryParameters(sourceFilterParameters);
  };
  useEffect(() => {
    const restore = () => {
      setTabState(readTab() ?? "accounts");
      setJournalFilters(readJournalFilters());
      setSourceFilters(readSourceFilters());
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  const load = async (afterMutation = false) => {
    setLoading(true);
    if (!afterMutation) setError(false);
    try {
      const [a, y, j, o] = await Promise.all([
        api("/api/accounts", {}, onUnauthorized),
        api("/api/fiscal-years", {}, onUnauthorized),
        api("/api/journals", {}, onUnauthorized),
        api("/api/accounting/operational-sources", {}, onUnauthorized),
      ]);
      setAccounts(((await a.json()) as { accounts: Account[] }).accounts);
      setYears(((await y.json()) as { fiscalYears: Year[] }).fiscalYears);
      setJournals(((await j.json()) as { journals: Journal[] }).journals);
      setSources(
        ((await o.json()) as { sources: OperationalSource[] }).sources,
      );
      setRefreshError(null);
    } catch {
      if (afterMutation) setRefreshError("workspace");
      else setError(true);
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (canView) void load(); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView]);
  const totals = useMemo(
    () =>
      lines.reduce(
        (v, l) => ({
          debit: v.debit + Number(l.debit || 0),
          credit: v.credit + Number(l.credit || 0),
        }),
        { debit: 0, credit: 0 },
      ),
    [lines],
  );
  const difference = Math.abs(totals.debit - totals.credit);
  const visibleJournals = useMemo(() => {
    const search = journalFilters.search.trim().toLocaleLowerCase();
    return journals.filter(
      (j) =>
        (!search ||
          [j.description, j.reference, j.id, j.entry_type].some((value) =>
            String(value ?? "")
              .toLocaleLowerCase()
              .includes(search),
          )) &&
        (!journalFilters.status || j.status === journalFilters.status) &&
        (!journalFilters.entryType ||
          j.entry_type === journalFilters.entryType) &&
        (!journalFilters.from || j.accounting_date >= journalFilters.from) &&
        (!journalFilters.to || j.accounting_date <= journalFilters.to),
    );
  }, [journals, journalFilters]);
  const sourceTypes = useMemo(
    () => [...new Set(sources.map((source) => source.source_type))].sort(),
    [sources],
  );
  const visibleSources = useMemo(() => {
    const search = sourceFilters.search.trim().toLocaleLowerCase();
    return sources.filter(
      (source) =>
        (!search ||
          [
            source.description,
            source.reference,
            source.source_type,
            source.source_id,
            source.amount,
          ].some((value) =>
            String(value ?? "")
              .toLocaleLowerCase()
              .includes(search),
          )) &&
        (!sourceFilters.type ||
          !sourceTypes.includes(sourceFilters.type) ||
          source.source_type === sourceFilters.type) &&
        (!sourceFilters.from || source.accounting_date >= sourceFilters.from) &&
        (!sourceFilters.to || source.accounting_date <= sourceFilters.to) &&
        (!sourceFilters.amountMin ||
          Number(source.amount) >= Number(sourceFilters.amountMin)) &&
        (!sourceFilters.amountMax ||
          Number(source.amount) <= Number(sourceFilters.amountMax)),
    );
  }, [sources, sourceFilters, sourceTypes]);
  if (!canView)
    return (
      <section className="panel accounting-workspace">
        <WorkspaceState>{t("accounting.noAccess")}</WorkspaceState>
      </section>
    );
  const mutationStarted = () => {
    setSaved(false);
    setError(false);
    setOperationError(null);
    setVatRecognitionError(false);
    setRefreshError(null);
  };
  const mutationSucceeded = () => {
    setError(false);
    setOperationError(null);
    setVatRecognitionError(false);
    setSaved(true);
  };
  const mutationFailed = (cause: unknown) => {
    if (cause instanceof ApiError && cause.code === "ACCOUNTING_PERIOD_CLOSED") {
      setError(false);
      setOperationError("closed");
      return;
    }
    setError(true);
  };
  const createAccount = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const d = new FormData(form);
    mutationStarted();
    setSaving(true);
    try {
      await api(
        "/api/accounts",
        json("POST", {
          code: d.get("code"),
          name: d.get("name"),
          account_type: d.get("account_type"),
          parent_account_id: d.get("parent_account_id") || null,
        }),
        onUnauthorized,
      );
      form.reset();
      mutationSucceeded();
      await load(true);
    } catch (cause) {
      mutationFailed(cause);
    } finally {
      setSaving(false);
    }
  };
  const toggleAccount = async (a: Account) => {
    mutationStarted();
    setSaving(true);
    try {
      await api(
        `/api/accounts/${a.id}`,
        json("PATCH", { is_active: !a.is_active }),
        onUnauthorized,
      );
      mutationSucceeded();
      await load(true);
    } catch (cause) {
      mutationFailed(cause);
    } finally {
      setSaving(false);
    }
  };
  const createJournal = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    mutationStarted();
    setSaving(true);
    try {
      const response = await api(
        "/api/journals",
        json("POST", {
          fiscal_year_id: d.get("fiscal_year_id"),
          accounting_date: d.get("accounting_date"),
          description: d.get("description"),
          reference: d.get("reference") || null,
          entry_type: d.get("entry_type"),
        }),
        onUnauthorized,
      );
      const journal = (await response.json()) as Journal;
      setSelected(journal);
      setLines([emptyLine(), emptyLine()]);
      mutationSucceeded();
      await load(true);
    } catch (cause) {
      mutationFailed(cause);
    } finally {
      setSaving(false);
    }
  };
  const createSourceJournal = async (source: OperationalSource) => {
    const year = years.find(
      (y) =>
        source.accounting_date >= y.start_date &&
        source.accounting_date <= y.end_date,
    );
    if (!year) {
      setError(true);
      return;
    }
    mutationStarted();
    setSaving(true);
    try {
      const response = await api(
        "/api/journals",
        json("POST", {
          fiscal_year_id: year.id,
          accounting_date: source.accounting_date,
          description: source.description,
          reference: source.reference,
          source_type: source.source_type,
          source_id: source.source_id,
          entry_type: "standard",
        }),
        onUnauthorized,
      );
      setSelected((await response.json()) as Journal);
      setLines([emptyLine(), emptyLine()]);
      setTab("journals");
      mutationSucceeded();
      await load(true);
    } catch (cause) {
      mutationFailed(cause);
    } finally {
      setSaving(false);
    }
  };
  const openJournal = async (j: Journal, afterMutation = false) => {
    setSelected(j);
    try {
      const response = await api(`/api/journals/${j.id}`, {}, onUnauthorized);
      const value = (await response.json()) as Journal & {
        lines: JournalLineResponse[];
      };
      setSelected(value);
      setLines(
        value.lines.length
          ? value.lines.map(journalLineToEditor)
          : [emptyLine(), emptyLine()],
      );
      setRefreshError(null);
    } catch {
      if (afterMutation) setRefreshError("journal");
      else setError(true);
    }
  };
  const saveLines = async () => {
    if (!selected) return;
    mutationStarted();
    setSaving(true);
    try {
      await api(
        `/api/journals/${selected.id}/lines`,
        json("PUT", serializeJournalLines(lines)),
        onUnauthorized,
      );
      mutationSucceeded();
      await openJournal(selected, true);
    } catch (cause) {
      mutationFailed(cause);
    } finally {
      setSaving(false);
    }
  };
  const post = async () => {
    if (!selected) return;
    mutationStarted();
    setSaving(true);
    try {
      await api(
        `/api/journals/${selected.id}/post`,
        json("POST", {}),
        onUnauthorized,
      );
      setSelected(null);
      mutationSucceeded();
      await load(true);
    } catch (postError) {
      if (
        postError instanceof ApiError &&
        postError.code === "VAT_RECOGNITION_INCOMPLETE"
      ) {
        setVatRecognitionError(true);
      } else {
        mutationFailed(postError);
      }
    } finally {
      setSaving(false);
    }
  };
  const report = async (
    kind: "trial" | "ledger",
    e: FormEvent<HTMLFormElement>,
  ) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const year = String(d.get("fiscal_year_id"));
    try {
      if (kind === "trial") {
        const r = await api(
          `/api/trial-balance?fiscal_year_id=${encodeURIComponent(year)}`,
          {},
          onUnauthorized,
        );
        setTrial(((await r.json()) as { accounts: TrialRow[] }).accounts);
      } else {
        const account = String(d.get("account_id"));
        const r = await api(
          `/api/general-ledger?fiscal_year_id=${encodeURIComponent(year)}&account_id=${encodeURIComponent(account)}`,
          {},
          onUnauthorized,
        );
        setLedger(((await r.json()) as { activity: LedgerRow[] }).activity);
      }
    } catch {
      setError(true);
    }
  };
  return (
    <section className="panel accounting-workspace" aria-labelledby="accounting-title">
      <PageHeader
        titleId="accounting-title"
        eyebrow={t("accounting.title")}
        title={t("accounting.title")}
        description={t("accounting.description")}
      />
      <div className="workspace-tabs accounting-tabs" role="tablist">
        {tabs.map((x) => (
          <button
            role="tab"
            aria-selected={tab === x}
            className={tab === x ? "active" : ""}
            onClick={() => setTab(x)}
            key={x}
          >
            {t(`accounting.tabs.${x}`)}
          </button>
        ))}
      </div>
      {vatRecognitionError && (
        <WorkspaceState tone="error">{VAT_RECOGNITION_ERROR}</WorkspaceState>
      )}
      {operationError === "closed" && (
        <WorkspaceState tone="error">{copy.closedPeriod}</WorkspaceState>
      )}
      {error && (
        <WorkspaceState
          tone="error"
          action={
            <button onClick={() => void load()}>{t("common.retry")}</button>
          }
        >
          {t("accounting.error")}
        </WorkspaceState>
      )}
      {refreshError && (
        <WorkspaceState
          tone="error"
          action={
            <button
              onClick={() =>
                void (refreshError === "journal" && selected
                  ? openJournal(selected, true)
                  : load(true))
              }
            >
              {t("common.retry")}
            </button>
          }
        >
          {t("accounting.refreshError")}
        </WorkspaceState>
      )}
      {saved && !error && !operationError && !vatRecognitionError && (
        <WorkspaceState>{t("accounting.saved")}</WorkspaceState>
      )}
      {loading && <WorkspaceState>{t("accounting.loading")}</WorkspaceState>}
      <div className="accounting-content">
      {!loading && tab === "accounts" && (
        <>
          <h2>{t("accounting.accounts")}</h2>
          {canManageChart && (
            <form className="form-grid compact-form" onSubmit={createAccount}>
              <label>
                {t("accounting.code")}
                <input name="code" required maxLength={50} />
              </label>
              <label>
                {t("accounting.name")}
                <input name="name" required maxLength={200} />
              </label>
              <label>
                {t("accounting.type")}
                <select name="account_type">
                  {(
                    [
                      "asset",
                      "liability",
                      "equity",
                      "revenue",
                      "expense",
                    ] as const
                  ).map((x) => (
                    <option value={x} key={x}>
                      {t(`accounting.types.${x}`)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("accounting.parent")}
                <select name="parent_account_id">
                  <option value="">—</option>
                  {accounts.map((a) => (
                    <option value={a.id} key={a.id}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </select>
              </label>
              <button className="primary" disabled={saving}>
                {t("accounting.addAccount")}
              </button>
            </form>
          )}
          <div className="table-wrap accounting-financial-table">
            <table>
              <thead>
                <tr>
                  <th>{t("accounting.code")}</th>
                  <th>{t("accounting.name")}</th>
                  <th>{t("accounting.type")}</th>
                  <th>{t("accounting.status")}</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((a) => (
                  <tr key={a.id}>
                    <td><span className="accounting-reference">{a.code}</span></td>
                    <td>{a.name}</td>
                    <td>{t(`accounting.types.${a.account_type}`)}</td>
                    <td>
                      {canManageChart ? (
                        <button
                          disabled={saving}
                          onClick={() => void toggleAccount(a)}
                        >
                          {t(
                            a.is_active
                              ? "accounting.active"
                              : "accounting.inactive",
                          )}
                        </button>
                      ) : (
                        t(
                          a.is_active
                            ? "accounting.active"
                            : "accounting.inactive",
                        )
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {!loading && tab === "sources" && (
        <>
          <h2>{t("accounting.operationalSources")}</h2>
          <WorkspaceToolbar
            ariaLabel={t("accounting.discovery.sourceToolbar")}
            search={
              <label>
                {t("accounting.discovery.sourceSearch")}
                <input
                  type="search"
                  value={sourceFilters.search}
                  onChange={(e) => updateSourceFilter("search", e.target.value)}
                />
              </label>
            }
            filters={
              <>
                <label>
                  {t("accounting.sourceType")}
                  <select
                    value={
                      sourceTypes.includes(sourceFilters.type)
                        ? sourceFilters.type
                        : ""
                    }
                    onChange={(e) => updateSourceFilter("type", e.target.value)}
                  >
                    <option value="">
                      {t("accounting.discovery.allTypes")}
                    </option>
                    {sourceTypes.map((type) => (
                      <option key={type} value={type}>
                        {sourceLabels[type] ?? type}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  {t("accounting.discovery.from")}
                  <input
                    type="date"
                    value={sourceFilters.from}
                    onChange={(e) => updateSourceFilter("from", e.target.value)}
                  />
                </label>
                <label>
                  {t("accounting.discovery.to")}
                  <input
                    type="date"
                    value={sourceFilters.to}
                    onChange={(e) => updateSourceFilter("to", e.target.value)}
                  />
                </label>
                <label>
                  {t("accounting.discovery.amountMin")}
                  <input
                    className="accounting-money-input"
                    type="number"
                    inputMode="decimal"
                    step="any"
                    value={sourceFilters.amountMin}
                    onChange={(e) =>
                      updateSourceFilter("amountMin", e.target.value)
                    }
                  />
                </label>
                <label>
                  {t("accounting.discovery.amountMax")}
                  <input
                    className="accounting-money-input"
                    type="number"
                    inputMode="decimal"
                    step="any"
                    value={sourceFilters.amountMax}
                    onChange={(e) =>
                      updateSourceFilter("amountMax", e.target.value)
                    }
                  />
                </label>
              </>
            }
            resultCount={t("accounting.discovery.sourceCount", {
              count: visibleSources.length,
            })}
            clearAction={
              Object.values(sourceFilters).some(Boolean) ? (
                <button type="button" onClick={clearSourceFilters}>
                  {t("accounting.discovery.clear")}
                </button>
              ) : undefined
            }
          />
          {sources.length === 0 ? (
            <WorkspaceState kind="empty">
              {t("accounting.discovery.noSources")}
            </WorkspaceState>
          ) : visibleSources.length === 0 ? (
            <WorkspaceState
              kind="no-results"
              action={
                <button type="button" onClick={clearSourceFilters}>
                  {t("accounting.discovery.clear")}
                </button>
              }
            >
              {t("accounting.discovery.noSourceResults")}
            </WorkspaceState>
          ) : (
            <div className="table-wrap accounting-source-table">
              <table>
                <thead>
                  <tr>
                    <th>{copy.sourceDetails}</th>
                    <th>{t("accounting.date")}</th>
                    <th>{t("accounting.amount")}</th>
                    <th>{t("accounting.reference")}</th>
                    <th>{t("accounting.action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleSources.map((source) => (
                    <tr key={`${source.source_type}-${source.source_id}`}>
                      <td className="accounting-source-main">
                        <strong>{sourceLabels[source.source_type] ?? source.source_type}</strong>
                        <span>{sourceDescription(source)}</span>
                      </td>
                      <td><span className="accounting-date">{formatDisplayDate(source.accounting_date, i18n.language)}</span></td>
                      <td><span className="accounting-money">{formatMoney(source.amount)}</span></td>
                      <td><span className="accounting-reference">{source.reference ?? "—"}</span></td>
                      <td>
                        {canManageJournals && (
                          <button
                            className="primary"
                            disabled={saving}
                            onClick={() => void createSourceJournal(source)}
                          >
                            {t("accounting.createDraft")}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {!loading && tab === "journals" && (
        <>
          <h2>{t("accounting.journals")}</h2>
          {canManageJournals && (
            <form className="form-grid compact-form accounting-journal-create" onSubmit={createJournal}>
              <label>
                {t("accounting.fiscalYear")}
                <select name="fiscal_year_id" required>
                  {years.map((y) => (
                    <option key={y.id} value={y.id}>
                      {y.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("accounting.date")}
                <input name="accounting_date" type="date" required />
              </label>
              <label className="accounting-create-description">
                {t("accounting.descriptionLabel")}
                <input name="description" required maxLength={500} />
              </label>
              <label>
                {t("accounting.reference")}
                <input className="accounting-reference-input" name="reference" maxLength={200} />
              </label>
              <label>
                {t("accounting.entryType")}
                <select name="entry_type">
                  <option value="standard">{t("accounting.standard")}</option>
                  <option value="opening_balance">
                    {t("accounting.opening")}
                  </option>
                </select>
              </label>
              <button className="primary" disabled={saving}>
                {t("accounting.createJournal")}
              </button>
            </form>
          )}
          <WorkspaceToolbar
            ariaLabel={t("accounting.discovery.journalToolbar")}
            search={
              <label>
                {t("accounting.discovery.journalSearch")}
                <input
                  type="search"
                  value={journalFilters.search}
                  onChange={(e) =>
                    updateJournalFilter("search", e.target.value)
                  }
                />
              </label>
            }
            filters={
              <>
                <label>
                  {t("accounting.status")}
                  <select
                    value={journalFilters.status}
                    onChange={(e) =>
                      updateJournalFilter("status", e.target.value)
                    }
                  >
                    <option value="">
                      {t("accounting.discovery.allStatuses")}
                    </option>
                    <option value="draft">{t("accounting.draft")}</option>
                    <option value="posted">{t("accounting.posted")}</option>
                  </select>
                </label>
                <label>
                  {t("accounting.entryType")}
                  <select
                    value={journalFilters.entryType}
                    onChange={(e) =>
                      updateJournalFilter("entryType", e.target.value)
                    }
                  >
                    <option value="">
                      {t("accounting.discovery.allEntryTypes")}
                    </option>
                    <option value="standard">{t("accounting.standard")}</option>
                    <option value="opening_balance">
                      {t("accounting.opening")}
                    </option>
                  </select>
                </label>
                <label>
                  {t("accounting.discovery.from")}
                  <input
                    type="date"
                    value={journalFilters.from}
                    onChange={(e) =>
                      updateJournalFilter("from", e.target.value)
                    }
                  />
                </label>
                <label>
                  {t("accounting.discovery.to")}
                  <input
                    type="date"
                    value={journalFilters.to}
                    onChange={(e) => updateJournalFilter("to", e.target.value)}
                  />
                </label>
              </>
            }
            resultCount={t("accounting.discovery.journalCount", {
              count: visibleJournals.length,
            })}
            clearAction={
              Object.values(journalFilters).some(Boolean) ? (
                <button type="button" onClick={clearJournalFilters}>
                  {t("accounting.discovery.clear")}
                </button>
              ) : undefined
            }
          />
          {journals.length === 0 ? (
            <WorkspaceState kind="empty">
              {t("accounting.discovery.noJournals")}
            </WorkspaceState>
          ) : visibleJournals.length === 0 ? (
            <WorkspaceState
              kind="no-results"
              action={
                <button type="button" onClick={clearJournalFilters}>
                  {t("accounting.discovery.clear")}
                </button>
              }
            >
              {t("accounting.discovery.noJournalResults")}
            </WorkspaceState>
          ) : (
            <div className="accounting-journal-list">
              {visibleJournals.map((j) => (
                <button key={j.id} onClick={() => void openJournal(j)} aria-pressed={selected?.id === j.id}>
                  <span className="accounting-journal-summary">
                    <strong>{j.description}</strong>
                    <span>
                      <span className="accounting-date">{formatDisplayDate(j.accounting_date, i18n.language)}</span>
                      {" · "}
                      <span className="accounting-reference">{j.reference ?? j.id.slice(0, 8)}</span>
                    </span>
                  </span>
                  <StatusBadge status={j.status}>
                    {t(`accounting.${j.status}`)}
                  </StatusBadge>
                </button>
              ))}
            </div>
          )}
          {selected && (
            <div className="accounting-editor">
              <div className="accounting-editor-heading">
                <div>
                  <span className="accounting-editor-eyebrow">{copy.journalLines}</span>
                  <h3>{selected.description}</h3>
                </div>
                <StatusBadge status={selected.status}>{t(`accounting.${selected.status}`)}</StatusBadge>
              </div>
              <div className="journal-line-header" aria-hidden="true">
                <span>{t("accounting.account")}</span>
                <span>{t("accounting.debit")}</span>
                <span>{t("accounting.credit")}</span>
              </div>
              <div className="journal-lines">
              {lines.map((l, i) => (
                <div className="journal-line" key={i}>
                  <select
                    aria-label={`${t("accounting.account")} ${i + 1}`}
                    value={l.account_id}
                    disabled={selected.status === "posted"}
                    onChange={(e) =>
                      setLines((v) =>
                        v.map((x, n) =>
                          n === i ? { ...x, account_id: e.target.value } : x,
                        ),
                      )
                    }
                  >
                    <option value="">{t("accounting.account")}</option>
                    {accounts.map((a) => (
                      <option disabled={!a.is_active} key={a.id} value={a.id}>
                        {a.code} — {a.name}
                      </option>
                    ))}
                  </select>
                  <input
                    className="accounting-money-input"
                    aria-label={t("accounting.debit")}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={l.debit}
                    disabled={selected.status === "posted"}
                    onChange={(e) =>
                      setLines((v) =>
                        v.map((x, n) =>
                          n === i ? { ...x, debit: e.target.value } : x,
                        ),
                      )
                    }
                  />
                  <input
                    className="accounting-money-input"
                    aria-label={t("accounting.credit")}
                    type="number"
                    inputMode="decimal"
                    min="0"
                    step="0.01"
                    value={l.credit}
                    disabled={selected.status === "posted"}
                    onChange={(e) =>
                      setLines((v) =>
                        v.map((x, n) =>
                          n === i ? { ...x, credit: e.target.value } : x,
                        ),
                      )
                    }
                  />
                </div>
              ))}
              </div>
              <div
                className={`accounting-totals ${
                  totals.debit === totals.credit && totals.debit > 0
                    ? "is-balanced"
                    : "is-unbalanced"
                }`}
              >
                <div><span>{t("accounting.debit")}</span><strong className="accounting-money">{formatMoney(totals.debit)}</strong></div>
                <div><span>{t("accounting.credit")}</span><strong className="accounting-money">{formatMoney(totals.credit)}</strong></div>
                <div><span>{copy.difference}</span><strong className="accounting-money">{formatMoney(difference)}</strong></div>
                <div className="accounting-balance-state">
                  {t(
                    totals.debit === totals.credit && totals.debit > 0
                      ? "accounting.balanced"
                      : "accounting.unbalanced",
                  )}
                </div>
              </div>
              <div className="accounting-editor-actions">
              {selected.status === "draft" && canManageJournals && (
                <>
                  <button onClick={() => setLines((v) => [...v, emptyLine()])}>
                    {t("accounting.addLine")}
                  </button>
                  <button
                    disabled={saving}
                    onClick={() => void saveLines()}
                  >
                    {t("common.save")}
                  </button>
                </>
              )}
              {selected.status === "draft" && canPost && (
                <button
                  className="primary"
                  disabled={
                    saving ||
                    totals.debit !== totals.credit ||
                    totals.debit === 0 ||
                    lines.length < 2
                  }
                  onClick={() => void post()}
                >
                  {t("accounting.post")}
                </button>
              )}
              </div>
            </div>
          )}
        </>
      )}
      {!loading && tab === "trial" && (
        <>
          <form
            className="compact-form accounting-report-form"
            onSubmit={(e) => void report("trial", e)}
          >
            <select name="fiscal_year_id" required>
              {years.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.name}
                </option>
              ))}
            </select>
            <button className="primary">{t("accounting.run")}</button>
          </form>
          <div className="table-wrap accounting-financial-table accounting-trial-table">
            <table>
              <thead>
                <tr>
                  <th>{t("accounting.account")}</th>
                  <th>{t("accounting.debitMovement")}</th>
                  <th>{t("accounting.creditMovement")}</th>
                  <th>{t("accounting.balance")}</th>
                </tr>
              </thead>
              <tbody>
                {trial.map((r) => (
                  <tr key={r.id}>
                    <td>
                      <span className="accounting-reference">{r.code}</span> — {r.name}
                    </td>
                    <td><span className="accounting-money">{formatMoney(r.debit_movement)}</span></td>
                    <td><span className="accounting-money">{formatMoney(r.credit_movement)}</span></td>
                    <td>
                      <span className="accounting-money">
                      {Number(r.debit_balance) > 0
                        ? `${formatMoney(r.debit_balance)} ${t("accounting.debit")}`
                        : `${formatMoney(r.credit_balance)} ${t("accounting.credit")}`}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      {!loading && tab === "ledger" && (
        <>
          <form
            className="compact-form accounting-report-form"
            onSubmit={(e) => void report("ledger", e)}
          >
            <select name="fiscal_year_id" required>
              {years.map((y) => (
                <option key={y.id} value={y.id}>
                  {y.name}
                </option>
              ))}
            </select>
            <select name="account_id" required>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.code} — {a.name}
                </option>
              ))}
            </select>
            <button className="primary">{t("accounting.run")}</button>
          </form>
          <div className="table-wrap accounting-financial-table accounting-ledger-table">
            <table>
              <thead>
                <tr>
                  <th>{t("accounting.date")}</th>
                  <th>{t("accounting.reference")}</th>
                  <th>{t("accounting.descriptionLabel")}</th>
                  <th>{t("accounting.debit")}</th>
                  <th>{t("accounting.credit")}</th>
                  <th>{t("accounting.balance")}</th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((r) => (
                  <tr
                    key={`${r.journal_id}-${r.accounting_date}-${r.running_balance}`}
                  >
                    <td><span className="accounting-date">{formatDisplayDate(r.accounting_date, i18n.language)}</span></td>
                    <td><span className="accounting-reference">{r.reference ?? r.journal_id.slice(0, 8)}</span></td>
                    <td>{r.description}</td>
                    <td><span className="accounting-money">{formatMoney(r.debit)}</span></td>
                    <td><span className="accounting-money">{formatMoney(r.credit)}</span></td>
                    <td><span className="accounting-money">{formatMoney(r.running_balance)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
      </div>
    </section>
  );
}
