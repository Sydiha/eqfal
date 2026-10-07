import { slug, type ExportDocument } from './downloadExport';
import type { ExportCell, ExportRows } from './xlsx-builder';

type Kinds = { header?: number[]; total?: number[]; section?: number[] };

export const REPORT_CURRENCY = 'SAR';

type Labels = { ar: boolean; company: string; generatedAt: string };
const n = (v: string | null | undefined): ExportCell => (v === null || v === undefined || v === '' ? null : { num: v });
const ni = (v: string): ExportCell => ({ num: v, int: true });
const L = (ar: boolean, en: string, arText: string) => (ar ? arText : en);

export const generatedStamp = (date = new Date()) => date.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

function meta(title: string, scope: Array<[string, string]>, x: Labels): ExportRows {
  return [
    [title], [L(x.ar, 'Company', 'الشركة'), x.company],
    ...scope.map(([k, v]) => [k, v] as ExportCell[]),
    [L(x.ar, 'Currency', 'العملة'), REPORT_CURRENCY],
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
