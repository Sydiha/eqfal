// I1: pure, read-only trial balance file reader for the cut-over form. It never touches the database, never posts anything and never creates accounts.
// Accounts are resolved by EXACT code only. The cut-over preview/activate services stay the authority for every accounting control.
export type RawCell = string | number | null;
export type RawRow = { sourceRowNumber: number; cells: RawCell[] };
export type TbAccount = { id: string; code: string; is_active: boolean };
export type TbMapping = { header_row: number; code: number; name?: number; debit?: number; credit?: number; balance?: number; currency?: number };
export type TbRowStatus = 'ok' | 'unmatched' | 'inactive' | 'duplicate' | 'ambiguous';
export type TbLine = { row: number; code: string; name: string | null; debit: string; credit: string; account_id: string | null; status: TbRowStatus };
export type TbIssue = { code: string; row?: number; detail?: string };
export type TbParseResult =
  | { status: 'needs_mapping'; headers: string[]; header_row: number; issues: TbIssue[] }
  | { status: 'parsed'; mapping: TbMapping; lines: TbLine[]; total_debit: string; total_credit: string; balanced: boolean; errors: TbIssue[]; warnings: TbIssue[] };

export const TB_MAX_LINES = 2000;
const ALIASES: Record<'code' | 'name' | 'debit' | 'credit' | 'balance' | 'currency', RegExp> = {
  code: /^(account\s*(code|no\.?|number)?|code|acc\.?\s*(code|no\.?)|رقم\s*الحساب|كود\s*الحساب|رمز\s*الحساب|الحساب)$/i,
  name: /^(account\s*name|name|description|اسم\s*الحساب|البيان|الاسم)$/i,
  debit: /^(debit|dr\.?|مدين|المدين)$/i,
  credit: /^(credit|cr\.?|دائن|الدائن)$/i,
  balance: /^(balance|net|net\s*balance|amount|الرصيد|صافي\s*الرصيد|الصافي)$/i,
  currency: /^(currency|ccy|العملة)$/i,
};
const TOTAL_ROW = /^(total|totals|grand\s*total|الإجمالي|اجمالي|الاجمالي|المجموع|إجمالي)/i;
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

const text = (v: RawCell | undefined): string => (v === null || v === undefined ? '' : String(v).trim());
const isBlank = (r: RawRow) => r.cells.every((c) => text(c) === '');
const fmt = (c: bigint) => { const neg = c < 0n; const a = neg ? -c : c; return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };

/** Returns signed cents, null for an empty cell, or throws on anything that is not an exact amount with at most 2 decimals. */
export function parseAmount(v: RawCell | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  let s: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('amount');
    if (Math.abs(v * 100 - Math.round(v * 100)) > 1e-6) throw new Error('amount');
    s = (Math.round(v * 100) / 100).toFixed(2);
  } else s = v.trim();
  if (s === '') return null;
  s = s.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d))).replace(/٫/g, '.').replace(/[٬\s]/g, '').replace(/‏|‎/g, '');
  let neg = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) { neg = true; s = paren[1]!; }
  if (s.endsWith('-')) { neg = !neg; s = s.slice(0, -1); }
  if (s.startsWith('-')) { neg = !neg; s = s.slice(1); } else if (s.startsWith('+')) s = s.slice(1);
  if (!/^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/.test(s)) throw new Error('amount');
  const [w, f = ''] = s.replace(/,/g, '').split('.');
  if (w!.length > 16) throw new Error('amount');
  const c = BigInt(w!) * 100n + BigInt((f + '00').slice(0, 2));
  return neg ? -c : c;
}

function detectHeader(rows: RawRow[]): { headerRow: number; headers: string[]; found: Partial<Record<keyof typeof ALIASES, number[]>> } | null {
  for (const r of rows.slice(0, 30)) {
    const found: Partial<Record<keyof typeof ALIASES, number[]>> = {};
    r.cells.forEach((c, i) => {
      const t = text(c).replace(/\s+/g, ' ');
      for (const k of Object.keys(ALIASES) as Array<keyof typeof ALIASES>) if (t && ALIASES[k].test(t)) (found[k] ??= []).push(i);
    });
    if (found.code && (found.debit || found.credit || found.balance)) return { headerRow: r.sourceRowNumber, headers: r.cells.map(text), found };
  }
  return null;
}

export function parseTrialBalanceTable(
  rows: RawRow[], formulaCells: Set<string>, accounts: TbAccount[],
  opts: { mapping?: TbMapping; functionalCurrency: string | null },
): TbParseResult {
  const errors: TbIssue[] = []; const warnings: TbIssue[] = [];
  let mapping = opts.mapping;
  if (!mapping) {
    const d = detectHeader(rows);
    const single = (k: keyof typeof ALIASES) => (d?.found[k]?.length === 1 ? d.found[k]![0] : undefined);
    const ambiguous = !d || (Object.values(d.found) as number[][]).some((v) => v.length > 1) || (!!single('balance') && (!!single('debit') || !!single('credit'))) || (!single('balance') && !(single('debit') !== undefined && single('credit') !== undefined));
    if (!d) return { status: 'needs_mapping', headers: (rows.find((r) => !isBlank(r))?.cells ?? []).map(text), header_row: rows.find((r) => !isBlank(r))?.sourceRowNumber ?? 1, issues: [{ code: 'TB_COLUMNS_NOT_DETECTED' }] };
    if (ambiguous) return { status: 'needs_mapping', headers: d.headers, header_row: d.headerRow, issues: [{ code: 'TB_COLUMNS_AMBIGUOUS' }] };
    mapping = { header_row: d.headerRow, code: single('code')!, ...(single('name') !== undefined ? { name: single('name')! } : {}), ...(single('debit') !== undefined ? { debit: single('debit')! } : {}), ...(single('credit') !== undefined ? { credit: single('credit')! } : {}), ...(single('balance') !== undefined ? { balance: single('balance')! } : {}), ...(single('currency') !== undefined ? { currency: single('currency')! } : {}) };
  }
  const m = mapping;
  const signed = m.balance !== undefined;
  const cols = [m.code, m.name, m.debit, m.credit, m.balance, m.currency].filter((x): x is number => x !== undefined);
  if ((signed && (m.debit !== undefined || m.credit !== undefined)) || (!signed && (m.debit === undefined || m.credit === undefined)) || new Set(cols).size !== cols.length) {
    return { status: 'needs_mapping', headers: rows.find((r) => r.sourceRowNumber === m.header_row)?.cells.map(text) ?? [], header_row: m.header_row, issues: [{ code: 'TB_COLUMNS_AMBIGUOUS' }] };
  }
  const byCode = new Map<string, TbAccount[]>();
  for (const a of accounts) { const k = a.code.trim(); byCode.set(k, [...(byCode.get(k) ?? []), a]); }

  const lines: TbLine[] = [];
  const data = rows.filter((r) => r.sourceRowNumber > m.header_row && !isBlank(r));
  const codeCount = new Map<string, number>();
  // Rows ignored as totals are only safe if they agree with the imported lines; otherwise a real balance could be dropped silently.
  const totalRows: Array<{ row: number; d: bigint; c: bigint } | { row: number; bad: true }> = [];
  const readSides = (r: RawRow): { d: bigint; c: bigint } | null => {
    try {
      if (signed) { const b = parseAmount(r.cells[m.balance!]) ?? 0n; return b > 0n ? { d: b, c: 0n } : { d: 0n, c: -b }; }
      return { d: parseAmount(r.cells[m.debit!]) ?? 0n, c: parseAmount(r.cells[m.credit!]) ?? 0n };
    } catch { return null; }
  };
  let dr = 0n, cr = 0n;
  for (const r of data) {
    const row = r.sourceRowNumber;
    const bad = cols.some((c) => formulaCells.has(`${row}:${c}`));
    if (bad) { errors.push({ code: 'TB_FORMULA_NOT_ALLOWED', row }); continue; }
    const rawCode = r.cells[m.code];
    const code = typeof rawCode === 'number' ? String(rawCode) : text(rawCode);
    const label = text(m.name !== undefined ? r.cells[m.name] : null);
    const anyAmount = [m.debit, m.credit, m.balance].some((c) => c !== undefined && text(r.cells[c]) !== '');
    if (!code) {
      if (!anyAmount) continue;
      if (TOTAL_ROW.test(label)) { const sd = readSides(r); totalRows.push(sd ? { row, ...sd } : { row, bad: true }); continue; }
      errors.push({ code: 'TB_CODE_MISSING', row }); continue;
    }
    if (TOTAL_ROW.test(code)) { const sd = readSides(r); totalRows.push(sd ? { row, ...sd } : { row, bad: true }); continue; }
    if (m.currency !== undefined) {
      const cur = text(r.cells[m.currency]).toUpperCase();
      if (cur && opts.functionalCurrency === null) { errors.push({ code: 'TB_CURRENCY_UNVERIFIABLE', row }); continue; }
      if (cur && cur !== opts.functionalCurrency) { errors.push({ code: 'TB_CURRENCY_MISMATCH', row, detail: cur }); continue; }
    }
    let d = 0n, c = 0n;
    if (!anyAmount) { errors.push({ code: 'TB_AMOUNT_MISSING', row }); continue; }
    try {
      if (signed) { const b = parseAmount(r.cells[m.balance!]) ?? 0n; if (b > 0n) d = b; else c = -b; }
      else {
        const a = parseAmount(r.cells[m.debit!]) ?? 0n, b = parseAmount(r.cells[m.credit!]) ?? 0n;
        if (a < 0n || b < 0n) { errors.push({ code: 'TB_NEGATIVE_IN_DEBIT_CREDIT', row }); continue; }
        if (a > 0n && b > 0n) { errors.push({ code: 'TB_BOTH_DEBIT_CREDIT', row }); continue; }
        d = a; c = b;
      }
    } catch { errors.push({ code: 'TB_AMOUNT_INVALID', row }); continue; }
    if (d === 0n && c === 0n) { warnings.push({ code: 'TB_ZERO_ROW_SKIPPED', row }); continue; }
    codeCount.set(code, (codeCount.get(code) ?? 0) + 1);
    const hits = byCode.get(code) ?? [];
    const status: TbRowStatus = hits.length === 0 ? 'unmatched' : hits.length > 1 ? 'ambiguous' : !hits[0]!.is_active ? 'inactive' : 'ok';
    lines.push({ row, code, name: label || null, debit: fmt(d), credit: fmt(c), account_id: hits.length === 1 && hits[0]!.is_active ? hits[0]!.id : null, status });
    dr += d; cr += c;
  }
  for (const l of lines) if ((codeCount.get(l.code) ?? 0) > 1) { l.status = 'duplicate'; l.account_id = null; }
  if (lines.length > TB_MAX_LINES) errors.push({ code: 'TB_TOO_MANY_ROWS' });
  if (lines.length < 2) errors.push({ code: 'TB_TOO_FEW_LINES' });
  for (const l of lines) if (l.status !== 'ok') errors.push({ code: `TB_ACCOUNT_${l.status.toUpperCase()}`, row: l.row, detail: l.code });
  for (const t of totalRows) {
    const agrees = !('bad' in t) && ((t.d === dr && t.c === cr) || (signed && t.d === 0n && t.c === 0n));
    if (agrees) warnings.push({ code: 'TB_TOTAL_ROW_IGNORED', row: t.row }); else errors.push({ code: 'TB_TOTAL_ROW_MISMATCH', row: t.row });
  }
  const balanced = dr === cr && dr > 0n;
  if (!balanced && lines.length) errors.push({ code: 'TB_UNBALANCED' });
  if (m.currency === undefined) warnings.push({ code: 'TB_CURRENCY_ASSUMED_FUNCTIONAL' });
  return { status: 'parsed', mapping: m, lines, total_debit: fmt(dr), total_credit: fmt(cr), balanced, errors, warnings };
}
