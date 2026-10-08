import { slug, type ExportDocument } from './downloadExport';
import type { ExportCell, ExportRows } from './xlsx-builder';

type Kinds = { header?: number[]; total?: number[]; section?: number[] };

export const REPORT_CURRENCY = 'SAR';

type Labels = { ar: boolean; company: string; generatedAt: string; /** Overrides REPORT_CURRENCY when the source data carries its own currency. */ currency?: string };
const n = (v: string | null | undefined): ExportCell => (v === null || v === undefined || v === '' ? null : { num: v });
const ni = (v: string): ExportCell => ({ num: v, int: true });
const L = (ar: boolean, en: string, arText: string) => (ar ? arText : en);

export const generatedStamp = (date = new Date()) => date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

function meta(title: string, scope: Array<[string, string]>, x: Labels): ExportRows {
  return [
    [title], [L(x.ar, 'Company', 'الشركة'), x.company],
    ...scope.map(([k, v]) => [k, v] as ExportCell[]),
    [L(x.ar, 'Currency', 'العملة'), x.currency ?? REPORT_CURRENCY],
    [L(x.ar, 'Generated at', 'تاريخ الإنشاء'), x.generatedAt],
    [],
  ];
}
// Body-relative row kinds are shifted by the metadata block length.
const doc = (fileStem: string, title: string, x: Labels, metaRows: ExportRows, body: ExportRows, k: Kinds): ExportDocument => {
  const off = metaRows.length; const shift = (l?: number[]) => (l ?? []).map((i) => i + off);
  return { fileStem, sheetName: title, rtl: x.ar, rows: [...metaRows, ...body], layout: { metaEnd: off - 1, headerRows: shift(k.header), totalRows: shift(k.total), sectionRows: shift(k.section) } };
};

type T = (key: string) => string;
export type TrialRow = { id?: string; account_id?: string; code: string; name: string; name_ar?: string | null; name_en?: string | null; debit_movement: string; credit_movement: string; debit_balance: string; credit_balance: string };
export type LedgerRow = { accounting_date: string; journal_id: string; reference: string | null; description: string; debit: string; credit: string; running_balance: string };
export type StatementSection = { category: string; accounts: Array<{ account_id: string; code: string; name: string; name_ar?: string | null; name_en?: string | null; amount: string }>; total: string };
export type StatementData = { statement: string; sections?: StatementSection[]; equity_accounts?: StatementSection['accounts']; profit_or_loss?: string; opening_equity?: string; direct_equity_movements?: string; current_period_earnings?: string; closing_equity?: string; net_change_in_cash_and_cash_equivalents?: string; opening_cash_and_cash_equivalents?: string; closing_cash_and_cash_equivalents?: string; accounting_equation?: { balanced: boolean }; reconciliation?: { expected: string; actual: string; difference: string; balanced: boolean } };
type Sum = (values: string[]) => string;

export function trialBalanceExport(p: Labels & { t: T; accountName: (a: TrialRow) => string; sum: Sum; yearName: string; rows: TrialRow[] }): ExportDocument {
  const { t, rows } = p;
  const debit = p.sum(rows.map((r) => r.debit_balance)); const credit = p.sum(rows.map((r) => r.credit_balance));
  const body: ExportRows = [[t('accounting.account'), t('accounting.debitMovement'), t('accounting.creditMovement'), t('accounting.debit') + ' ' + t('accounting.balance'), t('accounting.credit') + ' ' + t('accounting.balance')],
    ...rows.map((r): ExportCell[] => [`${r.code} — ${p.accountName(r)}`, n(r.debit_movement), n(r.credit_movement), n(r.debit_balance), n(r.credit_balance)])];
  if (rows.length) body.push([t('accounting.statements.total'), n(p.sum(rows.map((r) => r.debit_movement))), n(p.sum(rows.map((r) => r.credit_movement))), n(debit), n(credit)], [t(debit === credit ? 'accounting.balanced' : 'accounting.unbalanced')]);
  else body.push([t('accounting.trialEmpty')]);
  const title = t('accounting.tabs.trial');
  return doc(`eqfal-trial-balance-${slug(p.yearName)}`, title, p, meta(title, [[t('accounting.fiscalYear'), p.yearName]], p), body, { header: [0], total: rows.length ? [rows.length + 1] : [] });
}

export function generalLedgerExport(p: Labels & { t: T; yearName: string; accountLabel: string; accountCode: string; rows: LedgerRow[]; sum: Sum }): ExportDocument {
  const { t, rows } = p;
  const body: ExportRows = [[t('accounting.date'), t('accounting.reference'), t('accounting.descriptionLabel'), t('accounting.debit'), t('accounting.credit'), t('accounting.balance')],
    ...rows.map((r): ExportCell[] => [r.accounting_date, r.reference ?? r.journal_id.slice(0, 8), r.description, n(r.debit), n(r.credit), n(r.running_balance)])];
  if (rows.length) body.push([t('accounting.ledgerTotals'), null, null, n(p.sum(rows.map((r) => r.debit))), n(p.sum(rows.map((r) => r.credit))), n(rows[rows.length - 1]!.running_balance)]);
  else body.push([t('accounting.ledgerEmpty')]);
  const title = t('accounting.tabs.ledger');
  const stem = ['eqfal-general-ledger', slug(p.accountCode), slug(p.yearName)].filter(Boolean).join('-');
  return doc(stem, title, p, meta(title, [[t('accounting.fiscalYear'), p.yearName], [t('accounting.account'), p.accountLabel]], p), body, { header: [0], total: rows.length ? [rows.length + 1] : [] });
}

export type StatementKind = 'financialPosition' | 'profitOrLoss' | 'changesInEquity' | 'cashFlow';
const statementSlug: Record<StatementKind, string> = { financialPosition: 'financial-position', profitOrLoss: 'profit-or-loss', changesInEquity: 'changes-in-equity', cashFlow: 'cash-flow' };

export function statementExport(p: Labels & { t: T; kind: StatementKind; accountName: (a: StatementSection['accounts'][number]) => string; yearName: string; startDate?: string; endDate?: string; asOfDate?: string; data: StatementData }): ExportDocument {
  const { t, data: s, kind } = p;
  const two = (a: ExportCell, b: ExportCell = null): ExportRows => [[a, b]];
  const rows: ExportRows = [[t('accounting.account'), L(p.ar, 'Amount', 'المبلغ')]];
  const sectionIdx: number[] = []; const totalIdx: number[] = [];
  for (const sec of s.sections ?? []) {
    sectionIdx.push(rows.length); rows.push([t(`accounting.statements.categories.${sec.category}`)]);
    for (const a of sec.accounts) rows.push([`${a.code} — ${p.accountName(a)}`, n(a.amount)]);
    totalIdx.push(rows.length); rows.push([t('accounting.statements.total'), n(sec.total)]);
  }
  const line = (key: string, v: string | undefined, strong = false) => { if (strong) totalIdx.push(rows.length); rows.push(...two(t(`accounting.statements.${key}`), n(v))); };
  const recon = () => rows.push([t(kind === 'cashFlow' ? 'accounting.statements.cashReconciliation' : 'accounting.statements.reconciliation'), s.reconciliation ? `${s.reconciliation.expected} / ${s.reconciliation.actual} (${s.reconciliation.difference}) — ${t(s.reconciliation.balanced ? 'accounting.balanced' : 'accounting.unbalanced')}` : null]);
  if (kind === 'profitOrLoss') line('profitOrLoss', s.profit_or_loss, true);
  if (kind === 'financialPosition') { line('currentPeriodEarnings', s.current_period_earnings); rows.push([t('accounting.statements.equation'), t(s.accounting_equation?.balanced ? 'accounting.balanced' : 'accounting.unbalanced')]); }
  if (kind === 'changesInEquity') {
    line('openingEquity', s.opening_equity); line('directEquityMovements', s.direct_equity_movements);
    for (const a of s.equity_accounts ?? []) rows.push([`${a.code} — ${p.accountName(a)}`, n(a.amount)]);
    line('currentPeriodEarnings', s.current_period_earnings); line('closingEquity', s.closing_equity, true); recon();
  }
  if (kind === 'cashFlow') { line('openingCash', s.opening_cash_and_cash_equivalents); line('netCashChange', s.net_change_in_cash_and_cash_equivalents); line('closingCash', s.closing_cash_and_cash_equivalents, true); recon(); }
  const title = t(`accounting.tabs.${kind}`);
  const scope: Array<[string, string]> = [[t('accounting.fiscalYear'), p.yearName]];
  if (kind === 'financialPosition') scope.push([t('accounting.statements.asOf'), p.asOfDate ?? '']);
  else scope.push([t('accounting.discovery.from'), p.startDate ?? ''], [t('accounting.discovery.to'), p.endDate ?? '']);
  const range = kind === 'financialPosition' ? `as-of-${p.asOfDate ?? ''}` : `${p.startDate ?? ''}-to-${p.endDate ?? ''}`;
  return doc(`eqfal-${statementSlug[kind]}-${slug(range)}`, title, p, meta(title, scope, p), rows, { header: [0], section: sectionIdx, total: totalIdx });
}

export type AgingLabels = { title: string; asOf: string; receivables: string; payables: string; total: string; counterparty: string; dueOn: string; daysOverdue: string; outstanding: string; bucket: string; noDue: string; empty: string; buckets: Record<string, string> };
export type AgingSideData = { buckets: Array<{ bucket: string; amount: string; count: number }>; total_outstanding: string; item_count: number; items: Array<{ counterparty_name: string; due_on: string | null; days_overdue: number; bucket: string; outstanding_amount: string; obligation_id: string }> };

export function agingExport(p: Labels & { labels: AgingLabels; side: 'receivables' | 'payables'; asOf: string; data: AgingSideData }): ExportDocument {
  const { labels: X, data } = p;
  const sideName = X[p.side];
  const rows: ExportRows = [[X.bucket, X.outstanding, L(p.ar, 'Count', 'العدد')],
    ...data.buckets.map((b): ExportCell[] => [X.buckets[b.bucket] ?? b.bucket, n(b.amount), ni(String(b.count))]),
    [X.total, n(data.total_outstanding), ni(String(data.item_count))], [],
    [L(p.ar, 'Reference', 'المرجع'), X.counterparty, X.dueOn, X.daysOverdue, X.bucket, X.outstanding]];
  if (data.items.length === 0) rows.push([X.empty]);
  for (const i of data.items) rows.push([i.obligation_id, i.counterparty_name, i.due_on ?? X.noDue, ni(String(i.days_overdue)), X.buckets[i.bucket] ?? i.bucket, n(i.outstanding_amount)]);
  const bucketTotal = data.buckets.length + 1;
  rows.push([X.total, null, null, null, null, n(data.total_outstanding)]);
  const title = `${X.title} — ${sideName}`;
  return doc(`eqfal-${p.side === 'receivables' ? 'ar' : 'ap'}-aging-${slug(p.asOf)}`, p.side === 'receivables' ? 'AR Aging' : 'AP Aging', p, meta(title, [[X.asOf, p.asOf]], p), rows, { header: [0, bucketTotal + 2], total: [bucketTotal, rows.length - 1] });
}

// ---------------------------------------------------------------------------------------------
// Wave 2: Bank reconciliation, Monthly close, Fixed assets, Accruals & prepayments, Management summary.
// All builders only reshape data the screens already hold; no new calculation beyond cent-exact sums of listed rows.
// ---------------------------------------------------------------------------------------------

/** Cent-exact sum of decimal strings (same rule as the other report totals). */
export const sumDecimals = (values: string[]) => (values.reduce((total, v) => total + Math.round(Number(v) * 100), 0) / 100).toFixed(2);

/** Deterministic filename fragment for a period: YYYY-MM for a whole month, YYYY for a whole calendar year, else the explicit range, else as-of date. */
export function periodStem(from: string | null | undefined, to: string | null | undefined, asOf: string): string {
  const f = from?.slice(0, 10) ?? '', e = to?.slice(0, 10) ?? '';
  if (f && e) {
    const [y, m] = f.split('-').map(Number) as [number, number];
    const lastOfMonth = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (f.endsWith('-01') && e === lastOfMonth) return f.slice(0, 7);
    if (f === `${y}-01-01` && e === `${y}-12-31`) return String(y);
    return `${f}-to-${e}`;
  }
  if (f) return `from-${f}`;
  if (e) return `to-${e}`;
  return `as-of-${asOf.slice(0, 10)}`;
}
const dash = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : v);

export type BankTxExportRow = { transaction_date: string; description: string | null; bank_reference: string | null; amount: string; currency_code: string; reconciliation_status: 'unmatched' | 'matched' | 'reconciled' };

export function bankReconciliationExport(p: Labels & { asOf: string; statusLabels: Record<BankTxExportRow['reconciliation_status'], string>; filters: Array<[string, string]>; from?: string; to?: string; rows: BankTxExportRow[] }): ExportDocument {
  const { rows } = p; const ar = p.ar;
  const currencies = [...new Set(rows.map((r) => r.currency_code))];
  const single = currencies.length <= 1; // amounts are only added up within one currency
  const x: Labels = { ...p, currency: currencies.length ? currencies.join(', ') : REPORT_CURRENCY };
  const order = ['unmatched', 'matched', 'reconciled'] as const;
  const body: ExportRows = [[L(ar, 'Match status', 'حالة المطابقة'), L(ar, 'Count', 'العدد'), L(ar, 'Amount', 'المبلغ')]];
  for (const s of order) { const part = rows.filter((r) => r.reconciliation_status === s); body.push([p.statusLabels[s], ni(String(part.length)), single && part.length ? n(sumDecimals(part.map((r) => r.amount))) : null]); }
  body.push([L(ar, 'Total', 'الإجمالي'), ni(String(rows.length)), single && rows.length ? n(sumDecimals(rows.map((r) => r.amount))) : null], []);
  const detailHeader = body.length;
  body.push([L(ar, 'Date', 'التاريخ'), L(ar, 'Description', 'البيان'), L(ar, 'Bank reference', 'المرجع البنكي'), L(ar, 'Amount', 'المبلغ'), L(ar, 'Currency', 'العملة'), L(ar, 'Match status', 'حالة المطابقة')]);
  if (rows.length === 0) body.push([L(ar, 'No bank transactions', 'لا توجد حركات بنكية')]);
  for (const r of rows) body.push([r.transaction_date.slice(0, 10), dash(r.description), dash(r.bank_reference), n(r.amount), r.currency_code, p.statusLabels[r.reconciliation_status]]);
  const title = L(ar, 'Bank reconciliation summary', 'ملخص المطابقة البنكية');
  const scope: Array<[string, string]> = [[L(ar, 'As of', 'كما في'), p.asOf], ...p.filters];
  return doc(`eqfal-bank-reconciliation-${slug(periodStem(p.from, p.to, p.asOf))}`, title, x, meta(title, scope, x), body, { header: [0, detailHeader], total: [4] });
}

export type CloseExportDomain = { label: string; count: number };

export function monthlyCloseExport(p: Labels & { fiscalYear: string; periodStart: string; periodEnd: string; statusLabel: string; readinessLabel: string; hiddenBlockers: boolean; domains: CloseExportDomain[]; labels: { domain: string; status: string; count: string; needsAction: string; clear: string; total: string; hidden: string; empty: string; title: string; fiscalYear: string; period: string; periodStatus: string; readiness: string } }): ExportDocument {
  const { labels: X } = p;
  const body: ExportRows = [[X.domain, X.status, X.count]];
  if (p.domains.length === 0) body.push([X.empty]);
  for (const d of p.domains) body.push([d.label, d.count > 0 ? X.needsAction : X.clear, ni(String(d.count))]);
  const total = p.domains.reduce((s, d) => s + d.count, 0);
  const showTotal = !p.hiddenBlockers && p.domains.length > 0;
  if (showTotal) body.push([X.total, null, ni(String(total))]);
  if (p.hiddenBlockers) body.push([X.hidden]);
  const scope: Array<[string, string]> = [[X.fiscalYear, p.fiscalYear], [X.period, `${p.periodStart} — ${p.periodEnd}`], [X.periodStatus, p.statusLabel], [X.readiness, p.readinessLabel]];
  return doc(`eqfal-monthly-close-${slug(periodStem(p.periodStart, p.periodEnd, p.periodStart))}`, X.title, p, meta(X.title, scope, p), body, { header: [0], total: showTotal ? [p.domains.length + 1] : [] });
}

export type AssetExportRow = { asset_number: string; name: string; category: string; acquisition_date: string; placed_in_service_date: string; acquisition_cost: string; accumulated: string; net_book_value: string; status: string };

export function fixedAssetsExport(p: Labels & { asOf: string; from?: string; to?: string; filterNote?: string; rows: AssetExportRow[]; statusLabel: (s: string) => string }): ExportDocument {
  const { rows, ar } = p;
  const body: ExportRows = [[L(ar, 'Asset no.', 'رقم الأصل'), L(ar, 'Name', 'الاسم'), L(ar, 'Category', 'الفئة'), L(ar, 'Acquisition date', 'تاريخ الاقتناء'), L(ar, 'In-service date', 'تاريخ بدء الخدمة'), L(ar, 'Acquisition cost', 'تكلفة الاقتناء'), L(ar, 'Accumulated depreciation', 'مجمع الإهلاك'), L(ar, 'Net book value', 'صافي القيمة الدفترية'), L(ar, 'Status', 'الحالة')]];
  if (rows.length === 0) body.push([L(ar, 'No fixed assets', 'لا توجد أصول ثابتة')]);
  for (const r of rows) body.push([r.asset_number, r.name, r.category, r.acquisition_date, r.placed_in_service_date, n(r.acquisition_cost), n(r.accumulated), n(r.net_book_value), p.statusLabel(r.status)]);
  if (rows.length) body.push([L(ar, 'Total', 'الإجمالي'), null, null, null, null, n(sumDecimals(rows.map((r) => r.acquisition_cost))), n(sumDecimals(rows.map((r) => r.accumulated))), n(sumDecimals(rows.map((r) => r.net_book_value))), null]);
  const title = L(ar, 'Fixed assets register', 'سجل الأصول الثابتة');
  const scope: Array<[string, string]> = [[L(ar, 'As of', 'كما في'), p.asOf], [L(ar, 'Assets listed', 'عدد الأصول'), String(rows.length)]];
  if (p.from && p.to) scope.push([L(ar, 'Monthly close range', 'نطاق الإقفال الشهري'), `${p.from} — ${p.to}`]);
  if (p.filterNote) scope.push([L(ar, 'Filter', 'التصفية'), p.filterNote]);
  return doc(`eqfal-fixed-assets-${slug(p.from && p.to ? periodStem(p.from, p.to, p.asOf) : `as-of-${p.asOf}`)}`, title, p, meta(title, scope, p), body, { header: [0], total: rows.length ? [rows.length + 1] : [] });
}

export type AdjustmentExportRow = { typeLabel: string; description: string; reference: string; document: string; balanceAccount: string; pnlAccount: string; start: string; end: string; amount: string; posted: number; periods: number; statusLabel: string };

export function accrualsExport(p: Labels & { scopeRange: { from: string; to: string } | null; scopeLabel: string; filters: Array<[string, string]>; pending: number; postedEntries: number; asOf: string; rows: AdjustmentExportRow[] }): ExportDocument {
  const { rows, ar } = p;
  const body: ExportRows = [[L(ar, 'Type', 'النوع'), L(ar, 'Count', 'العدد'), L(ar, 'Total amount', 'إجمالي المبلغ')]];
  const types = [...new Set(rows.map((r) => r.typeLabel))];
  for (const type of types) { const part = rows.filter((r) => r.typeLabel === type); body.push([type, ni(String(part.length)), n(sumDecimals(part.map((r) => r.amount)))]); }
  if (rows.length === 0) body.push([L(ar, 'No periodic adjustments', 'لا توجد تعديلات دورية')]);
  body.push([]);
  const detailHeader = body.length;
  body.push([L(ar, 'Type', 'النوع'), L(ar, 'Description', 'الوصف'), L(ar, 'Reference', 'المرجع'), L(ar, 'Linked document', 'المستند المرتبط'), L(ar, 'Balance-sheet account', 'حساب الميزانية'), L(ar, 'P&L account', 'حساب الربح والخسارة'), L(ar, 'Recognition start', 'بداية الاعتراف'), L(ar, 'Recognition end', 'نهاية الاعتراف'), L(ar, 'Total amount', 'إجمالي المبلغ'), L(ar, 'Posted periods', 'الفترات المرحّلة'), L(ar, 'Total periods', 'إجمالي الفترات'), L(ar, 'Status', 'الحالة')]);
  for (const r of rows) body.push([r.typeLabel, r.description, dash(r.reference), dash(r.document), dash(r.balanceAccount), dash(r.pnlAccount), r.start, r.end, n(r.amount), ni(String(r.posted)), ni(String(r.periods)), r.statusLabel]);
  const title = L(ar, 'Accruals & prepayments', 'الاستحقاقات والمقدمات');
  const scope: Array<[string, string]> = [[L(ar, 'Accounting period', 'الفترة المحاسبية'), p.scopeLabel], [L(ar, 'Pending schedule entries', 'قيود الجدولة المعلقة'), String(p.pending)], [L(ar, 'Posted schedule entries', 'قيود الجدولة المرحّلة'), String(p.postedEntries)], ...p.filters];
  return doc(`eqfal-accruals-prepayments-${slug(p.scopeRange ? periodStem(p.scopeRange.from, p.scopeRange.to, p.asOf) : 'all-periods')}`, title, p, meta(title, scope, p), body, { header: [0, detailHeader] });
}

export type ManagementMetric = { label: string; scope: string | null; state: 'available' | 'hidden' | 'unavailable' | 'mixed'; amount?: string };
export type ManagementBankAccount = { name: string; currency: string; amount: string | null };

export function managementSummaryExport(p: Labels & { periodLabel: string; from?: string; to?: string; asOf: string; metrics: ManagementMetric[]; bankAccounts: ManagementBankAccount[]; closeRows: Array<[string, ExportCell]>; hiddenText: string; unavailableText: string; mixedText?: string }): ExportDocument {
  const { ar } = p;
  const body: ExportRows = [[L(ar, 'Metric', 'المؤشر'), L(ar, 'Scope', 'النطاق'), L(ar, 'Amount', 'المبلغ')]];
  for (const m of p.metrics) body.push([m.label, m.scope, m.state === 'available' && m.amount !== undefined ? n(m.amount) : m.state === 'hidden' ? p.hiddenText : m.state === 'mixed' ? (p.mixedText ?? p.unavailableText) : p.unavailableText]);
  let accountsHeader = -1;
  if (p.bankAccounts.length) {
    body.push([]); accountsHeader = body.length;
    body.push([L(ar, 'Bank account', 'الحساب البنكي'), L(ar, 'Currency', 'العملة'), L(ar, 'Balance', 'الرصيد')]);
    for (const a of p.bankAccounts) body.push([a.name, a.currency, a.amount === null ? p.unavailableText : n(a.amount)]);
  }
  let closeHeader = -1;
  if (p.closeRows.length) {
    body.push([]); closeHeader = body.length;
    body.push([L(ar, 'Monthly close', 'الإقفال الشهري'), L(ar, 'Value', 'القيمة')]);
    for (const [k, v] of p.closeRows) body.push([k, v]);
  }
  const title = L(ar, 'Management financial summary', 'ملخص الإدارة المالي');
  const scope: Array<[string, string]> = [[L(ar, 'Period', 'الفترة'), p.periodLabel], [L(ar, 'As of', 'كما في'), p.asOf]];
  return doc(`eqfal-management-summary-${slug(periodStem(p.from, p.to, p.asOf))}`, title, p, meta(title, scope, p), body, { header: [0, accountsHeader, closeHeader].filter((i) => i >= 0) });
}

// ---------------------------------------------------------------------------------------------
// Annual closing: the readiness tab (domains + package manifest) and the governed package table, exactly as shown.
// ---------------------------------------------------------------------------------------------
export type AnnualReadinessRow = { name: string; state: string; items: number };
export type AnnualManifestRow = { name: string; state: string; items: number | string | null };

export function annualClosingExport(p: Labels & { fiscalYear: string; startDate: string; endDate: string; labels: { title: string; fiscalYear: string; range: string; overall: string; unresolved: string; fsReadiness: string; zakat: string; domains: string; domainsNote: string; manifest: string; manifestNote: string; domain: string; section: string; state: string; items: string; total: string }; overall: string; unresolvedTotal: number; fsReadinessState: string; zakatState: string; domains: AnnualReadinessRow[]; manifest: AnnualManifestRow[] }): ExportDocument {
  const { labels: X } = p;
  const body: ExportRows = []; const header: number[] = []; const section: number[] = []; const total: number[] = [];
  section.push(body.length); body.push([X.domains]); body.push([X.domainsNote]);
  header.push(body.length); body.push([X.domain, X.state, X.items]);
  for (const d of p.domains) body.push([d.name, d.state, ni(String(d.items))]);
  total.push(body.length); body.push([X.total, null, ni(String(p.unresolvedTotal))]);
  body.push([]);
  section.push(body.length); body.push([X.manifest]); body.push([X.manifestNote]);
  header.push(body.length); body.push([X.section, X.state, X.items]);
  for (const m of p.manifest) body.push([m.name, m.state, m.items === null ? '—' : typeof m.items === 'number' ? ni(String(m.items)) : m.items]);
  const scope: Array<[string, string]> = [[X.fiscalYear, p.fiscalYear], [X.range, `${p.startDate} — ${p.endDate}`], [X.overall, p.overall], [X.unresolved, String(p.unresolvedTotal)], [X.fsReadiness, p.fsReadinessState], [X.zakat, p.zakatState]];
  return doc(`eqfal-annual-closing-${slug(p.fiscalYear) || 'year'}`, X.title, p, meta(X.title, scope, p), body, { header, section, total });
}

export type AnnualPackageRow = { name: string; state: string; source: string; blockers: string };

export function annualPackageExport(p: Labels & { fiscalYear: string; startDate: string; endDate: string; title: string; labels: { fiscalYear: string; range: string; packageState: string; section: string; state: string; source: string; blockers: string; snapshot: string }; packageState: string; snapshotLines: string[]; rows: AnnualPackageRow[] }): ExportDocument {
  const { labels: X } = p;
  const body: ExportRows = [[X.section, X.state, X.source, X.blockers], ...p.rows.map((r): ExportCell[] => [r.name, r.state, r.source, r.blockers || '—'])];
  for (const line of p.snapshotLines) body.push([line]);
  const scope: Array<[string, string]> = [[X.fiscalYear, p.fiscalYear], [X.range, `${p.startDate} — ${p.endDate}`], [X.packageState, p.packageState]];
  return doc(`eqfal-annual-closing-package-${slug(p.fiscalYear) || 'year'}`, p.title, p, meta(p.title, scope, p), body, { header: [0] });
}
