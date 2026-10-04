import { FormEvent, Fragment, ReactNode, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import "./AccountingApproved.css";
import "./AccountingTabs.css";
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
type StatementSection = {
  category: string;
  accounts: Array<{ account_id: string; code: string; name: string; amount: string }>;
  total: string;
};
type StatementReport = { statement: "financial_position" | "profit_or_loss" | "changes_in_equity" | "cash_flow"; sections?: StatementSection[]; equity_accounts?: StatementSection["accounts"]; profit_or_loss?: string; opening_equity?: string; direct_equity_movements?: string; current_period_earnings?: string; closing_equity?: string; operating_cash_flow?: string; investing_cash_flow?: string; financing_cash_flow?: string; net_change_in_cash_and_cash_equivalents?: string; opening_cash_and_cash_equivalents?: string; closing_cash_and_cash_equivalents?: string; total_assets?: string; total_liabilities?: string; total_equity?: string; accounting_equation?: { assets: string; liabilities_and_equity: string; difference: string; balanced: boolean }; reconciliation?: { expected: string; actual: string; difference: string; balanced: boolean } };
type OperationalSource = {
  source_type: string;
  source_id: string;
  accounting_date: string;
  amount: string;
  description: string;
  reference: string | null;
};
type Tab = "accounts" | "journals" | "sources" | "trial" | "ledger" | "financialPosition" | "profitOrLoss" | "changesInEquity" | "cashFlow";
type AccountTypeFilter = "" | Account["account_type"];
type AccountStatusFilter = "" | "active" | "inactive";
type AccountPanelMode = "auto" | "add" | { accountId: string };
const accountTypes = ["asset", "liability", "equity", "revenue", "expense"] as const;
const ACCOUNT_PAGE_SIZE = 5;
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
  "financialPosition",
  "profitOrLoss",
  "changesInEquity",
  "cashFlow",
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
  canCreateChart: boolean;
  canEditChart: boolean;
  canCreateJournal: boolean;
  canEditJournal: boolean;
  canPost: boolean;
  onUnauthorized: () => void;
  accountsFooter?: ReactNode;
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
  canCreateChart,
  canEditChart,
  canCreateJournal,
  canEditJournal,
  canPost,
  onUnauthorized,
  accountsFooter,
}: Props) {
  const { t } = useTranslation();
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
  const [statement, setStatement] = useState<StatementReport | null>(null);
  const [statementBlocked, setStatementBlocked] = useState(false);
  const [changesInEquityYearId, setChangesInEquityYearId] = useState("");
  const [sources, setSources] = useState<OperationalSource[]>([]);
  const [loading, setLoading] = useState(canView);
  const [error, setError] = useState(false);
  const [vatRecognitionError, setVatRecognitionError] = useState(false);
  const [refreshError, setRefreshError] = useState<
    "workspace" | "journal" | null
  >(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [accountSearch, setAccountSearch] = useState("");
  const [accountTypeFilter, setAccountTypeFilter] = useState<AccountTypeFilter>("");
  const [accountStatusFilter, setAccountStatusFilter] = useState<AccountStatusFilter>("");
  const [accountPage, setAccountPage] = useState(1);
  const [panelMode, setPanelMode] = useState<AccountPanelMode>("auto");
  const [statusDraft, setStatusDraft] = useState<boolean | null>(null);
  const setTab = (value: Tab) => {
    setTabState(value);
    if (value === "financialPosition" || value === "profitOrLoss" || value === "changesInEquity" || value === "cashFlow") {
      setStatement(null);
      setStatementBlocked(false);
    }
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
  const visibleAccounts = useMemo(() => {
    const search = accountSearch.trim().toLocaleLowerCase();
    return accounts.filter(
      (a) =>
        (!search ||
          [a.code, a.name].some((value) =>
            value.toLocaleLowerCase().includes(search),
          )) &&
        (!accountTypeFilter || a.account_type === accountTypeFilter) &&
        (!accountStatusFilter ||
          a.is_active === (accountStatusFilter === "active")),
    );
  }, [accounts, accountSearch, accountTypeFilter, accountStatusFilter]);
  const accountPageCount = Math.max(1, Math.ceil(visibleAccounts.length / ACCOUNT_PAGE_SIZE));
  const currentAccountPage = Math.min(accountPage, accountPageCount);
  const pageAccounts = visibleAccounts.slice(
    (currentAccountPage - 1) * ACCOUNT_PAGE_SIZE,
    currentAccountPage * ACCOUNT_PAGE_SIZE,
  );
  const showAddForm =
    canCreateChart &&
    (panelMode === "add" || (panelMode === "auto" && accounts.length === 0));
  const activeAccount = showAddForm
    ? null
    : typeof panelMode === "object"
      ? accounts.find((a) => a.id === panelMode.accountId) ?? null
      : pageAccounts[0] ?? null;
  const selectedStatus = statusDraft ?? activeAccount?.is_active ?? false;
  const parentLabel = (a: Account) => {
    if (!a.parent_account_id) return "—";
    const parent = accounts.find((x) => x.id === a.parent_account_id);
    return parent ? `${parent.code} — ${parent.name}` : "—";
  };
  const selectAccount = (a: Account) => {
    setPanelMode({ accountId: a.id });
    setStatusDraft(null);
  };
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
  const changesInEquityYear = years.find((year) => year.id === changesInEquityYearId) ?? years[0];
  if (!canView)
    return (
      <section className="panel">
        <WorkspaceState>{t("accounting.noAccess")}</WorkspaceState>
      </section>
    );
  const mutationStarted = () => {
    setSaved(false);
    setVatRecognitionError(false);
    setRefreshError(null);
  };
  const mutationSucceeded = () => {
    setError(false);
    setVatRecognitionError(false);
    setSaved(true);
  };
  const createAccount = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setPanelMode("add");
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
    } catch {
      setError(true);
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
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  };
  const applyStatus = async (a: Account) => {
    if (statusDraft === null || statusDraft === a.is_active) return;
    await toggleAccount(a);
    setStatusDraft(null);
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
    } catch {
      setError(true);
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
    } catch {
      setError(true);
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
    } catch {
      setError(true);
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
        setError(true);
      }
    } finally {
      setSaving(false);
    }
  };
  const report = async (
    kind: "trial" | "ledger" | "financialPosition" | "profitOrLoss" | "changesInEquity" | "cashFlow",
    e: FormEvent<HTMLFormElement>,
  ) => {
    e.preventDefault();
    const d = new FormData(e.currentTarget);
    const year = String(d.get("fiscal_year_id"));
    setStatementBlocked(false);
    try {
      if (kind === "trial") {
        const r = await api(
          `/api/trial-balance?fiscal_year_id=${encodeURIComponent(year)}`,
          {},
          onUnauthorized,
        );
        setTrial(((await r.json()) as { accounts: TrialRow[] }).accounts);
      } else if (kind === "ledger") {
        const account = String(d.get("account_id"));
        const r = await api(
          `/api/general-ledger?fiscal_year_id=${encodeURIComponent(year)}&account_id=${encodeURIComponent(account)}`,
          {},
          onUnauthorized,
        );
        setLedger(((await r.json()) as { activity: LedgerRow[] }).activity);
      } else {
        const endpoint = kind === "financialPosition" ? "financial-position" : kind === "profitOrLoss" ? "profit-or-loss" : kind === "changesInEquity" ? "changes-in-equity" : "cash-flow";
        const dates = kind === "financialPosition"
          ? `&as_of_date=${encodeURIComponent(String(d.get("as_of_date")))}`
          : `&start_date=${encodeURIComponent(String(d.get("start_date")))}&end_date=${encodeURIComponent(String(d.get("end_date")))}`;
        setStatement(null);
        const r = await api(`/api/financial-statements/${endpoint}?fiscal_year_id=${encodeURIComponent(year)}${dates}`, {}, onUnauthorized);
        setStatement((await r.json()) as StatementReport);
      }
    } catch (reportError) {
      if (reportError instanceof ApiError && (reportError.code === "FINANCIAL_STATEMENT_UNMAPPED_ACCOUNTS" || reportError.code === "CASH_FLOW_CLASSIFICATION_BLOCKED")) setStatementBlocked(true);
      else setError(true);
    }
  };
  return (
    <section className="panel ac-approved" aria-labelledby="accounting-title">
      <PageHeader
        className="ac-approved__header"
        titleId="accounting-title"
        title={t("accounting.title")}
        description={t("accounting.description")}
      />
      <div className="workspace-tabs ac-approved__tabs" role="tablist">
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
      {saved && !error && !vatRecognitionError && (
        <WorkspaceState>{t("accounting.saved")}</WorkspaceState>
      )}
      {loading && <WorkspaceState>{t("accounting.loading")}</WorkspaceState>}
      {!loading && tab === "accounts" && (
        <div className="ac-approved__accounts">
          <section className="ac-approved__card ac-approved__chart" aria-labelledby="accounting-chart-title">
            <div className="ac-approved__card-header">
              <h2 id="accounting-chart-title">{t("accounting.accounts")}</h2>
              <span className="ac-approved__muted">{t("accounting.chart.count", { count: visibleAccounts.length })}</span>
            </div>
            <div className="ac-approved__toolbar">
              <label className="ac-approved__search">
                <span className="ac-approved__sr">{t("accounting.chart.search")}</span>
                <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
                <input type="search" value={accountSearch} placeholder={t("accounting.chart.searchPlaceholder")} onChange={(e) => { setAccountSearch(e.target.value); setAccountPage(1); }} />
              </label>
              <label className="ac-approved__prefixed">
                <span className="ac-approved__prefix">{t("accounting.type")}</span>
                <select aria-label={t("accounting.chart.typeFilter")} value={accountTypeFilter} onChange={(e) => { setAccountTypeFilter(e.target.value as AccountTypeFilter); setAccountPage(1); }}>
                  <option value="">{t("accounting.chart.all")}</option>
                  {accountTypes.map((x) => (
                    <option value={x} key={x}>{t(`accounting.types.${x}`)}</option>
                  ))}
                </select>
              </label>
              <label className="ac-approved__prefixed">
                <span className="ac-approved__prefix">{t("accounting.status")}</span>
                <select aria-label={t("accounting.chart.statusFilter")} value={accountStatusFilter} onChange={(e) => { setAccountStatusFilter(e.target.value as AccountStatusFilter); setAccountPage(1); }}>
                  <option value="">{t("accounting.chart.all")}</option>
                  <option value="active">{t("accounting.active")}</option>
                  <option value="inactive">{t("accounting.inactive")}</option>
                </select>
              </label>
              {canCreateChart && (
                <button type="button" className="ac-approved__create" onClick={() => { setPanelMode("add"); setStatusDraft(null); }}>
                  <span aria-hidden="true">+</span> {t("accounting.chart.newAccount")}
                </button>
              )}
            </div>
            <div className="ac-approved__table">
              <table>
                <thead>
                  <tr>
                    <th>{t("accounting.code")}</th>
                    <th>{t("accounting.chart.accountName")}</th>
                    <th>{t("accounting.type")}</th>
                    <th>{t("accounting.parent")}</th>
                    <th>{t("accounting.status")}</th>
                    <th>{t("accounting.action")}</th>
                  </tr>
                </thead>
                <tbody>
                  {pageAccounts.map((a) => (
                    <tr key={a.id} className={activeAccount?.id === a.id ? "is-selected" : undefined} aria-selected={activeAccount?.id === a.id}>
                      <td className="ac-approved__code">{a.code}</td>
                      <td className="ac-approved__name">{a.name}</td>
                      <td>{t(`accounting.types.${a.account_type}`)}</td>
                      <td>{parentLabel(a)}</td>
                      <td>
                        <span className={`ac-approved__badge ${a.is_active ? "is-active" : "is-inactive"}`}>
                          {t(a.is_active ? "accounting.active" : "accounting.inactive")}
                        </span>
                      </td>
                      <td>
                        <button type="button" className="ac-approved__link" onClick={() => selectAccount(a)}>
                          {t(canEditChart ? "accounting.chart.edit" : "accounting.chart.view")}
                          <span className="ac-approved__sr"> {a.code}</span>
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {accounts.length === 0 && <WorkspaceState kind="empty">{t("accounting.chart.empty")}</WorkspaceState>}
              {accounts.length > 0 && visibleAccounts.length === 0 && <WorkspaceState kind="no-results">{t("accounting.chart.noResults")}</WorkspaceState>}
            </div>
            {visibleAccounts.length > 0 && (
              <div className="ac-approved__footer">
                <span className="ac-approved__muted">
                  {t("accounting.chart.pageSummary", { from: (currentAccountPage - 1) * ACCOUNT_PAGE_SIZE + 1, to: Math.min(currentAccountPage * ACCOUNT_PAGE_SIZE, visibleAccounts.length), total: visibleAccounts.length })}
                </span>
                {accountPageCount > 1 && (
                  <nav className="ac-approved__pager" aria-label={t("accounting.chart.pagination")}>
                    <button type="button" aria-label={t("accounting.chart.previousPage")} disabled={currentAccountPage <= 1} onClick={() => setAccountPage(currentAccountPage - 1)}>‹</button>
                    {Array.from({ length: accountPageCount }, (_, i) => i + 1).map((n) => (
                      <button type="button" key={n} className={n === currentAccountPage ? "is-current" : undefined} aria-current={n === currentAccountPage ? "page" : undefined} onClick={() => setAccountPage(n)}>{n}</button>
                    ))}
                    <button type="button" aria-label={t("accounting.chart.nextPage")} disabled={currentAccountPage >= accountPageCount} onClick={() => setAccountPage(currentAccountPage + 1)}>›</button>
                  </nav>
                )}
              </div>
            )}
          </section>
          <aside className="ac-approved__card ac-approved__details" aria-labelledby="accounting-details-title">
            {showAddForm ? (
              <>
                <div className="ac-approved__card-header">
                  <h2 id="accounting-details-title">{t("accounting.chart.newAccountTitle")}</h2>
                </div>
                <form className="ac-approved__fields" onSubmit={createAccount}>
                  <label>
                    <span>{t("accounting.code")}</span>
                    <input name="code" required maxLength={50} />
                  </label>
                  <label>
                    <span>{t("accounting.name")}</span>
                    <input name="name" required maxLength={200} />
                  </label>
                  <label>
                    <span>{t("accounting.type")}</span>
                    <select name="account_type">
                      {accountTypes.map((x) => (
                        <option value={x} key={x}>
                          {t(`accounting.types.${x}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>{t("accounting.parent")}</span>
                    <select name="parent_account_id">
                      <option value="">—</option>
                      {accounts.map((a) => (
                        <option value={a.id} key={a.id}>
                          {a.code} — {a.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="ac-approved__hint">{t("accounting.chart.parentHint")}</p>
                  <div className="ac-approved__actions">
                    <button className="primary ac-approved__submit" disabled={saving}>
                      {t("accounting.addAccount")}
                    </button>
                    {accounts.length > 0 && (
                      <button type="button" className="ac-approved__ghost" onClick={() => setPanelMode("auto")}>
                        {t("accounting.chart.cancel")}
                      </button>
                    )}
                  </div>
                </form>
              </>
            ) : activeAccount ? (
              <>
                <div className="ac-approved__card-header">
                  <h2 id="accounting-details-title">{t("accounting.chart.detailsTitle")}</h2>
                  <span className="ac-approved__muted">{activeAccount.code}</span>
                </div>
                <form className="ac-approved__fields" onSubmit={(e) => { e.preventDefault(); void applyStatus(activeAccount); }}>
                  <label>
                    <span>{t("accounting.code")}</span>
                    <input value={activeAccount.code} disabled readOnly />
                  </label>
                  <label>
                    <span>{t("accounting.name")}</span>
                    <input value={activeAccount.name} disabled readOnly />
                  </label>
                  <label>
                    <span>{t("accounting.type")}</span>
                    <select value={activeAccount.account_type} disabled>
                      <option value={activeAccount.account_type}>{t(`accounting.types.${activeAccount.account_type}`)}</option>
                    </select>
                  </label>
                  <label>
                    <span>{t("accounting.parent")}</span>
                    <select value={activeAccount.parent_account_id ?? ""} disabled>
                      <option value={activeAccount.parent_account_id ?? ""}>{parentLabel(activeAccount)}</option>
                    </select>
                  </label>
                  <label>
                    <span>{t("accounting.status")}</span>
                    <select
                      value={selectedStatus ? "active" : "inactive"}
                      disabled={!canEditChart || saving}
                      onChange={(e) => setStatusDraft(e.target.value === "active")}
                    >
                      <option value="active">{t("accounting.active")}</option>
                      <option value="inactive">{t("accounting.inactive")}</option>
                    </select>
                  </label>
                  <p className="ac-approved__hint">{t("accounting.chart.editLocked")}</p>
                  <div className="ac-approved__actions">
                    <button className="primary ac-approved__submit" disabled={!canEditChart || saving || selectedStatus === activeAccount.is_active}>
                      {t("accounting.chart.updateAccount")}
                    </button>
                    <button type="button" className="ac-approved__ghost" disabled={selectedStatus === activeAccount.is_active} onClick={() => setStatusDraft(null)}>
                      {t("accounting.chart.cancel")}
                    </button>
                  </div>
                </form>
              </>
            ) : (
              <WorkspaceState kind="empty">{t("accounting.chart.selectAccount")}</WorkspaceState>
            )}
          </aside>
        </div>
      )}
      {tab === "accounts" && accountsFooter}
      {!loading && tab === "sources" && (
        <div className="ac-tabview">
          <div className="ac-tab__card ac-tab__filters">
            <WorkspaceToolbar
              className="ac-tab__toolbar ac-tab__toolbar--sources"
              ariaLabel={t("accounting.discovery.sourceToolbar")}
              search={
                <label className="ac-tab__field">
                  <span>{t("accounting.discovery.sourceSearch")}</span>
                  <input
                    type="search"
                    value={sourceFilters.search}
                    onChange={(e) => updateSourceFilter("search", e.target.value)}
                  />
                </label>
              }
              filters={
                <>
                  <label className="ac-tab__field">
                    <span>{t("accounting.sourceType")}</span>
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
                          {type}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="ac-tab__field">
                    <span>{t("accounting.discovery.from")}</span>
                    <input
                      type="date"
                      value={sourceFilters.from}
                      onChange={(e) => updateSourceFilter("from", e.target.value)}
                    />
                  </label>
                  <label className="ac-tab__field">
                    <span>{t("accounting.discovery.to")}</span>
                    <input
                      type="date"
                      value={sourceFilters.to}
                      onChange={(e) => updateSourceFilter("to", e.target.value)}
                    />
                  </label>
                  <label className="ac-tab__field">
                    <span>{t("accounting.discovery.amountMin")}</span>
                    <input
                      type="number"
                      step="any"
                      value={sourceFilters.amountMin}
                      onChange={(e) =>
                        updateSourceFilter("amountMin", e.target.value)
                      }
                    />
                  </label>
                  <label className="ac-tab__field">
                    <span>{t("accounting.discovery.amountMax")}</span>
                    <input
                      type="number"
                      step="any"
                      value={sourceFilters.amountMax}
                      onChange={(e) =>
                        updateSourceFilter("amountMax", e.target.value)
                      }
                    />
                  </label>
                </>
              }
              clearAction={
                Object.values(sourceFilters).some(Boolean) ? (
                  <button type="button" className="ac-tab__ghost" onClick={clearSourceFilters}>
                    {t("accounting.discovery.clear")}
                  </button>
                ) : undefined
              }
            />
          </div>
          <section className="ac-tab__card" aria-labelledby="accounting-sources-title">
            <div className="ac-tab__head">
              <h2 id="accounting-sources-title">{t("accounting.operationalSources")}</h2>
              <span className="ac-tab__muted" role="status" aria-live="polite">
                {t("accounting.discovery.sourceCount", { count: visibleSources.length })}
              </span>
            </div>
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
              <div className="table-wrap ac-tab__table ac-tab__table--sources">
                <table>
                  <thead>
                    <tr>
                      <th>{t("accounting.date")}</th>
                      <th>{t("accounting.sourceType")}</th>
                      <th>{t("accounting.descriptionLabel")}</th>
                      <th>{t("accounting.amount")}</th>
                      <th>{t("accounting.reference")}</th>
                      <th>{t("accounting.action")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleSources.map((source) => (
                      <tr key={`${source.source_type}-${source.source_id}`}>
                        <td className="ac-tab__num">{source.accounting_date}</td>
                        <td>{source.source_type}</td>
                        <td className="ac-tab__wide">{source.description}</td>
                        <td className="ac-tab__num">{source.amount}</td>
                        <td className="ac-tab__num">{source.reference ?? "—"}</td>
                        <td>
                          {canCreateJournal && (
                            <button
                              className="primary ac-tab__primary"
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
          </section>
        </div>
      )}
      {!loading && tab === "journals" && (
        <div className="ac-tabview">
          {canCreateJournal && (
            <section className="ac-tab__card" aria-labelledby="accounting-journals-title">
              <div className="ac-tab__head">
                <h2 id="accounting-journals-title">{t("accounting.journals")}</h2>
              </div>
              <form className="ac-tab__row ac-tab__row--create" onSubmit={createJournal}>
                <label className="ac-tab__field">
                  <span>{t("accounting.fiscalYear")}</span>
                  <select name="fiscal_year_id" required>
                    {years.map((y) => (
                      <option key={y.id} value={y.id}>
                        {y.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="ac-tab__field">
                  <span>{t("accounting.date")}</span>
                  <input name="accounting_date" type="date" required />
                </label>
                <label className="ac-tab__field ac-tab__field--grow">
                  <span>{t("accounting.descriptionLabel")}</span>
                  <input name="description" required maxLength={500} />
                </label>
                <label className="ac-tab__field">
                  <span>{t("accounting.reference")}</span>
                  <input name="reference" maxLength={200} />
                </label>
                <label className="ac-tab__field">
                  <span>{t("accounting.entryType")}</span>
                  <select name="entry_type">
                    <option value="standard">{t("accounting.standard")}</option>
                    <option value="opening_balance">
                      {t("accounting.opening")}
                    </option>
                  </select>
                </label>
                <button className="primary ac-tab__primary" disabled={saving}>
                  {t("accounting.createJournal")}
                </button>
              </form>
            </section>
          )}
          <div className="ac-tab__card ac-tab__filters">
            <WorkspaceToolbar
              className="ac-tab__toolbar ac-tab__toolbar--journals"
              ariaLabel={t("accounting.discovery.journalToolbar")}
              search={
                <label className="ac-tab__field">
                  <span>{t("accounting.discovery.journalSearch")}</span>
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
                  <label className="ac-tab__field">
                    <span>{t("accounting.status")}</span>
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
                  <label className="ac-tab__field">
                    <span>{t("accounting.entryType")}</span>
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
                  <label className="ac-tab__field">
                    <span>{t("accounting.discovery.from")}</span>
                    <input
                      type="date"
                      value={journalFilters.from}
                      onChange={(e) =>
                        updateJournalFilter("from", e.target.value)
                      }
                    />
                  </label>
                  <label className="ac-tab__field">
                    <span>{t("accounting.discovery.to")}</span>
                    <input
                      type="date"
                      value={journalFilters.to}
                      onChange={(e) => updateJournalFilter("to", e.target.value)}
                    />
                  </label>
                </>
              }
              clearAction={
                Object.values(journalFilters).some(Boolean) ? (
                  <button type="button" className="ac-tab__ghost" onClick={clearJournalFilters}>
                    {t("accounting.discovery.clear")}
                  </button>
                ) : undefined
              }
            />
          </div>
          <div className={`ac-tab__journals${selected ? " has-selected" : ""}`}>
            <section className="ac-tab__card" aria-labelledby="accounting-register-title">
              <div className="ac-tab__head">
                <h2 id="accounting-register-title">{t("accounting.journalRegister")}</h2>
                <span className="ac-tab__muted" role="status" aria-live="polite">
                  {t("accounting.discovery.journalCount", { count: visibleJournals.length })}
                </span>
              </div>
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
                <div className="table-wrap ac-tab__table ac-tab__table--register">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("accounting.date")}</th>
                        <th>{t("accounting.descriptionLabel")}</th>
                        <th>{t("accounting.status")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {visibleJournals.map((j) => (
                        <tr key={j.id} className={selected?.id === j.id ? "is-selected" : undefined}>
                          <td className="ac-tab__num">{j.accounting_date}</td>
                          <td className="ac-tab__wide">
                            <button type="button" className="ac-tab__rowlink" onClick={() => void openJournal(j)}>
                              <span className="ac-tab__sr">{j.accounting_date} · </span>
                              {j.description}
                            </button>
                          </td>
                          <td>
                            <StatusBadge status={j.status}>
                              {t(`accounting.${j.status}`)}
                            </StatusBadge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
            {selected && (
              <section className="ac-tab__card accounting-editor ac-tab__editor" aria-labelledby="accounting-selected-title">
                <div className="ac-tab__head">
                  <h2 id="accounting-selected-title">{t("accounting.selectedJournal")}</h2>
                  <span className={`ac-tab__pill is-${selected.status}`}>{t(`accounting.${selected.status}`)}</span>
                </div>
                <h3>{selected.description}</h3>
                {lines.map((l, i) => (
                  <div className="journal-line ac-tab__line" key={i}>
                    <div className="ac-tab__field ac-tab__field--full">
                      <span aria-hidden="true">{t("accounting.account")}</span>
                      <select
                        value={l.account_id}
                        disabled={selected.status === "posted" || !canEditJournal}
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
                    </div>
                    <div className="ac-tab__field">
                      <span aria-hidden="true">{t("accounting.debit")}</span>
                      <input
                        aria-label={t("accounting.debit")}
                        type="number"
                        min="0"
                        step="0.01"
                        value={l.debit}
                        disabled={selected.status === "posted" || !canEditJournal}
                        onChange={(e) =>
                          setLines((v) =>
                            v.map((x, n) =>
                              n === i ? { ...x, debit: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </div>
                    <div className="ac-tab__field">
                      <span aria-hidden="true">{t("accounting.credit")}</span>
                      <input
                        aria-label={t("accounting.credit")}
                        type="number"
                        min="0"
                        step="0.01"
                        value={l.credit}
                        disabled={selected.status === "posted" || !canEditJournal}
                        onChange={(e) =>
                          setLines((v) =>
                            v.map((x, n) =>
                              n === i ? { ...x, credit: e.target.value } : x,
                            ),
                          )
                        }
                      />
                    </div>
                  </div>
                ))}
                <div
                  className={`ac-tab__totals ${
                    totals.debit === totals.credit && totals.debit > 0
                      ? "balanced"
                      : "unbalanced"
                  }`}
                >
                  <div><span>{t("accounting.totalDebit")}</span><strong>{totals.debit.toFixed(2)}</strong></div>
                  <div><span>{t("accounting.totalCredit")}</span><strong>{totals.credit.toFixed(2)}</strong></div>
                  <span className={`ac-tab__pill ${totals.debit === totals.credit && totals.debit > 0 ? "is-balanced" : "is-unbalanced"}`}>
                    {t(
                      totals.debit === totals.credit && totals.debit > 0
                        ? "accounting.balanced"
                        : "accounting.unbalanced",
                    )}
                  </span>
                </div>
                {selected.status === "draft" && (canEditJournal || canPost) && (
                  <div className="ac-tab__actions">
                    {canEditJournal && (
                      <>
                        <button className="ac-tab__ghost" onClick={() => setLines((v) => [...v, emptyLine()])}>
                          {t("accounting.addLine")}
                        </button>
                        <button
                          className="primary ac-tab__primary"
                          disabled={saving}
                          onClick={() => void saveLines()}
                        >
                          {t("common.save")}
                        </button>
                      </>
                    )}
                    {canPost && (
                      <button
                        className="primary ac-tab__primary"
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
                )}
              </section>
            )}
          </div>
        </div>
      )}
      {!loading && tab === "trial" && (
        <div className="ac-tabview">
          <form
            className="ac-tab__card ac-tab__report-form"
            onSubmit={(e) => void report("trial", e)}
          >
            <label className="ac-tab__field ac-tab__field--year">
              <span>{t("accounting.fiscalYear")}</span>
              <select name="fiscal_year_id" required>
                {years.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary ac-tab__primary">{t("accounting.run")}</button>
          </form>
          <section className="ac-tab__card" aria-labelledby="accounting-trial-title">
            <div className="ac-tab__head">
              <h2 id="accounting-trial-title">{t("accounting.tabs.trial")}</h2>
            </div>
            <div className="table-wrap ac-tab__table ac-tab__table--trial">
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
                      <td className="ac-tab__wide">
                        {r.code} — {r.name}
                      </td>
                      <td className="ac-tab__num">{r.debit_movement}</td>
                      <td className="ac-tab__num">{r.credit_movement}</td>
                      <td className="ac-tab__balance-cell">
                        <span className="ac-tab__balance">
                          {Number(r.debit_balance) > 0
                            ? <><span>{r.debit_balance}</span> <span className="ac-tab__side">{t("accounting.debit")}</span></>
                            : <><span>{r.credit_balance}</span> <span className="ac-tab__side">{t("accounting.credit")}</span></>}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
      {!loading && tab === "ledger" && (
        <div className="ac-tabview">
          <form
            className="ac-tab__card ac-tab__report-form"
            onSubmit={(e) => void report("ledger", e)}
          >
            <label className="ac-tab__field ac-tab__field--year">
              <span>{t("accounting.fiscalYear")}</span>
              <select name="fiscal_year_id" required>
                {years.map((y) => (
                  <option key={y.id} value={y.id}>
                    {y.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="ac-tab__field ac-tab__field--account">
              <span>{t("accounting.account")}</span>
              <select name="account_id" required>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="primary ac-tab__primary">{t("accounting.run")}</button>
          </form>
          <section className="ac-tab__card" aria-labelledby="accounting-ledger-title">
            <div className="ac-tab__head">
              <h2 id="accounting-ledger-title">{t("accounting.tabs.ledger")}</h2>
            </div>
            <div className="table-wrap ac-tab__table ac-tab__table--ledger">
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
                      <td className="ac-tab__num">{r.accounting_date}</td>
                      <td className="ac-tab__num">{r.reference ?? r.journal_id.slice(0, 8)}</td>
                      <td className="ac-tab__wide">{r.description}</td>
                      <td className="ac-tab__num">{r.debit}</td>
                      <td className="ac-tab__num">{r.credit}</td>
                      <td className="ac-tab__num">{r.running_balance}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      )}
      {!loading && (tab === "financialPosition" || tab === "profitOrLoss" || tab === "changesInEquity" || tab === "cashFlow") && (
        <div className="ac-tabview">
          <form className="ac-tab__card ac-tab__report-form" onSubmit={(e) => void report(tab, e)}>
            <label className="ac-tab__field ac-tab__field--year"><span>{t("accounting.fiscalYear")}</span><select name="fiscal_year_id" required {...(tab === "changesInEquity" || tab === "cashFlow" ? { value: changesInEquityYear?.id ?? "", onChange: (event) => setChangesInEquityYearId(event.target.value) } : {})}>{years.map((y) => <option key={y.id} value={y.id}>{y.name}</option>)}</select></label>
            {tab === "financialPosition" ? <label className="ac-tab__field ac-tab__field--date"><span>{t("accounting.statements.asOf")}</span><input name="as_of_date" type="date" defaultValue={years[0]?.end_date} required /></label> : <>
              <label className="ac-tab__field ac-tab__field--date"><span>{t("accounting.discovery.from")}</span><input key={`${tab}-${changesInEquityYear?.id}-start`} name="start_date" type="date" defaultValue={tab === "changesInEquity" ? changesInEquityYear?.start_date : years[0]?.start_date} required /></label>
              <label className="ac-tab__field ac-tab__field--date"><span>{t("accounting.discovery.to")}</span><input key={`${tab}-${changesInEquityYear?.id}-end`} name="end_date" type="date" defaultValue={tab === "changesInEquity" ? changesInEquityYear?.end_date : years[0]?.end_date} required /></label>
            </>}
            <button className="primary ac-tab__primary">{t("accounting.run")}</button>
          </form>
          {statementBlocked && <WorkspaceState tone="error">{t(tab === "cashFlow" ? "accounting.statements.cashFlowBlocked" : "accounting.statements.unmapped")}</WorkspaceState>}
          {statement && !statementBlocked && statement.statement === (tab === "financialPosition" ? "financial_position" : tab === "profitOrLoss" ? "profit_or_loss" : tab === "changesInEquity" ? "changes_in_equity" : "cash_flow") && <section className="ac-tab__card" aria-labelledby="accounting-statement-title">
            <div className="ac-tab__head"><h2 id="accounting-statement-title">{t(`accounting.tabs.${tab}`)}</h2></div>
            <div className={`table-wrap ac-tab__table ac-tab__statement${tab === "changesInEquity" || tab === "cashFlow" ? " is-roomy" : ""}`}><table><tbody>
            {statement.sections?.map((section) => <Fragment key={section.category}>
              <tr className="is-section"><th colSpan={2}>{t(`accounting.statements.categories.${section.category}`)}</th></tr>
              {section.accounts.map((account) => <tr key={account.account_id}><td>{account.code} — {account.name}</td><td>{account.amount}</td></tr>)}
              <tr className="is-total"><th>{t("accounting.statements.total")}</th><th>{section.total}</th></tr>
            </Fragment>)}
            {tab === "profitOrLoss" && <tr className="is-strong"><th>{t("accounting.statements.profitOrLoss")}</th><th>{statement.profit_or_loss}</th></tr>}
            {tab === "financialPosition" && <>
              <tr className="is-strong"><th>{t("accounting.statements.currentPeriodEarnings")}</th><th>{statement.current_period_earnings}</th></tr>
              <tr className="is-strong"><th>{t("accounting.statements.equation")}</th><td><span className={`ac-tab__pill ${statement.accounting_equation?.balanced ? "is-balanced" : "is-unbalanced"}`}>{statement.accounting_equation?.balanced ? t("accounting.balanced") : t("accounting.unbalanced")}</span></td></tr>
            </>}
            {tab === "changesInEquity" && <>
              <tr><td>{t("accounting.statements.openingEquity")}</td><td>{statement.opening_equity}</td></tr>
              <tr><td>{t("accounting.statements.directEquityMovements")}</td><td>{statement.direct_equity_movements}</td></tr>
              {statement.equity_accounts?.map((account) => <tr key={account.account_id} className="is-detail"><td>{account.code} — {account.name}</td><td>{account.amount}</td></tr>)}
              <tr><td>{t("accounting.statements.currentPeriodEarnings")}</td><td>{statement.current_period_earnings}</td></tr>
              <tr className="is-strong"><th>{t("accounting.statements.closingEquity")}</th><th>{statement.closing_equity}</th></tr>
              <tr className="is-strong is-recon"><th>{t("accounting.statements.reconciliation")}</th><td><span className="ac-tab__recon"><span>{statement.reconciliation?.expected} / {statement.reconciliation?.actual} ({statement.reconciliation?.difference})</span><span className="ac-tab__sr"> — </span><span className={`ac-tab__pill ${statement.reconciliation?.balanced ? "is-balanced" : "is-unbalanced"}`}>{statement.reconciliation?.balanced ? t("accounting.balanced") : t("accounting.unbalanced")}</span></span></td></tr>
            </>}
            {tab === "cashFlow" && <>
              <tr><td>{t("accounting.statements.openingCash")}</td><td>{statement.opening_cash_and_cash_equivalents}</td></tr>
              <tr><td>{t("accounting.statements.netCashChange")}</td><td>{statement.net_change_in_cash_and_cash_equivalents}</td></tr>
              <tr className="is-strong"><th>{t("accounting.statements.closingCash")}</th><th>{statement.closing_cash_and_cash_equivalents}</th></tr>
              <tr className="is-strong is-recon"><th>{t("accounting.statements.cashReconciliation")}</th><td><span className="ac-tab__recon"><span>{statement.reconciliation?.expected} / {statement.reconciliation?.actual} ({statement.reconciliation?.difference})</span><span className="ac-tab__sr"> — </span><span className={`ac-tab__pill ${statement.reconciliation?.balanced ? "is-balanced" : "is-unbalanced"}`}>{statement.reconciliation?.balanced ? t("accounting.balanced") : t("accounting.unbalanced")}</span></span></td></tr>
            </>}
          </tbody></table></div></section>}
        </div>
      )}
    </section>
  );
}
