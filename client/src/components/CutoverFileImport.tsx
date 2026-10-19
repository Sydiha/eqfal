import { useMemo, useState } from 'react';
import type { CutoverAccount } from './CutoverActivation';

type Call = (url: string, init?: RequestInit) => Promise<Record<string, unknown>>;
type Mapping = { header_row: number; code: number; name?: number; debit?: number; credit?: number; balance?: number; currency?: number };
type Line = { row: number; code: string; name: string | null; debit: string; credit: string; account_id: string | null; status: 'ok' | 'unmatched' | 'inactive' | 'duplicate' | 'ambiguous' };
type Issue = { code: string; row?: number; detail?: string };
type Parsed = { status: 'parsed'; mapping: Mapping; lines: Line[]; total_debit: string; total_credit: string; balanced: boolean; errors: Issue[]; warnings: Issue[]; functional_currency: string | null };
type NeedsMapping = { status: 'needs_mapping'; headers: string[]; header_row: number; issues: Issue[] };

const TB_MESSAGES: Record<string, { ar: string; en: string }> = {
  TB_FILE_INVALID: { ar: 'الملف غير صالح أو غير آمن أو يتجاوز الحد المسموح (CSV أو XLSX حتى 2 ميغابايت).', en: 'The file is invalid, unsafe or too large (CSV or XLSX up to 2 MB).' },
  AUTHORITY_NOT_DRAFT: { ar: 'هذا الإعداد ليس مسودة.', en: 'This configuration is not a draft.' },
  FORBIDDEN: { ar: 'لا تملك صلاحية تفعيل القطع.', en: 'You do not have permission to activate a cutover.' },
  TB_COLUMNS_NOT_DETECTED: { ar: 'تعذر تحديد الأعمدة تلقائياً. حدّدها يدوياً.', en: 'Columns could not be detected. Please map them manually.' },
  TB_COLUMNS_AMBIGUOUS: { ar: 'الأعمدة غير واضحة أو متعارضة. حدّدها يدوياً.', en: 'Columns are ambiguous or conflicting. Please map them manually.' },
  TB_FORMULA_NOT_ALLOWED: { ar: 'الصيغ غير مسموحة في ملف ميزان المراجعة. استخدم قيماً ثابتة.', en: 'Formulas are not allowed in a trial balance file. Use plain values.' },
  TB_CODE_MISSING: { ar: 'سطر بمبلغ بدون رمز حساب.', en: 'A row has an amount but no account code.' },
  TB_CURRENCY_MISMATCH: { ar: 'عملة السطر ليست العملة الوظيفية للشركة (المسموح العملة الوظيفية فقط).', en: 'The row currency is not the company functional currency (only the functional currency is accepted).' },
  TB_CURRENCY_UNVERIFIABLE: { ar: 'لا يوجد ملف محاسبي معتمد يحدد العملة الوظيفية، فتعذر التحقق من عمود العملة.', en: 'No approved accounting profile defines the functional currency, so the currency column cannot be verified.' },
  TB_NEGATIVE_IN_DEBIT_CREDIT: { ar: 'مبلغ سالب في عمود المدين أو الدائن.', en: 'A negative amount in the debit or credit column.' },
  TB_BOTH_DEBIT_CREDIT: { ar: 'سطر فيه مدين ودائن معاً.', en: 'A row has both debit and credit.' },
  TB_AMOUNT_INVALID: { ar: 'مبلغ غير صالح (الحد الأقصى خانتان عشريتان، بلا تقريب).', en: 'Invalid amount (at most 2 decimals, never rounded).' },
  TB_TOO_MANY_ROWS: { ar: 'عدد السطور يتجاوز الحد المسموح (2000).', en: 'Too many rows (limit 2000).' },
  TB_TOO_FEW_LINES: { ar: 'يلزم حسابان على الأقل.', en: 'At least two accounts are required.' },
  TB_UNBALANCED: { ar: 'الملف غير متوازن: إجمالي المدين لا يساوي إجمالي الدائن.', en: 'The file is not balanced: total debit differs from total credit.' },
  TB_ACCOUNT_UNMATCHED: { ar: 'رمز غير موجود في دليل الحسابات.', en: 'Code not found in the chart of accounts.' },
  TB_ACCOUNT_INACTIVE: { ar: 'الحساب غير نشط.', en: 'Account is inactive.' },
  TB_ACCOUNT_AMBIGUOUS: { ar: 'الرمز يطابق أكثر من حساب؛ لا يمكن الاستيراد.', en: 'Code matches more than one account; cannot import.' },
  TB_ACCOUNT_DUPLICATE: { ar: 'الرمز مكرر في الملف.', en: 'Code is duplicated in the file.' },
  TB_TOTAL_ROW_IGNORED: { ar: 'تم تجاهل سطر إجماليات.', en: 'A totals row was ignored.' },
  TB_ZERO_ROW_SKIPPED: { ar: 'تم تخطي سطر برصيد صفري.', en: 'A zero-balance row was skipped.' },
  TB_CURRENCY_ASSUMED_FUNCTIONAL: { ar: 'لا يوجد عمود عملة: يُفترض أن الأرصدة بالعملة الوظيفية للشركة.', en: 'No currency column: balances are assumed to be in the company functional currency.' },
  TB_MULTIPLE_SHEETS: { ar: 'الملف يحوي أكثر من ورقة؛ لا يُقبل لتفادي استيراد ناقص. اترك ورقة ميزان المراجعة وحدها.', en: 'The workbook has several sheets and is rejected to avoid an incomplete import. Keep only the trial balance sheet.' },
  TB_TOTAL_ROW_MISMATCH: { ar: 'سطر إجماليات لا يطابق السطور المستوردة؛ قد يكون حساب فعلي أُسقط. أصلح الملف.', en: 'A totals row does not match the imported lines; a real account may have been dropped. Fix the file.' },
  TB_AMOUNT_MISSING: { ar: 'سطر بحساب لكن بلا أي مبلغ (اكتب 0 صراحةً إن كان الرصيد صفراً).', en: 'A row has an account but no amount (write 0 explicitly if the balance is zero).' },
};
const ROLES: Array<[keyof Omit<Mapping, 'header_row'>, string, string]> = [
  ['code', 'رمز الحساب', 'Account code'], ['name', 'اسم الحساب (اختياري)', 'Account name (optional)'], ['debit', 'مدين', 'Debit'],
  ['credit', 'دائن', 'Credit'], ['balance', 'رصيد موقّع (موجب = مدين، سالب = دائن)', 'Signed balance (positive = debit, negative = credit)'], ['currency', 'العملة (اختياري)', 'Currency (optional)'],
];

export function CutoverFileImport({ rangeId, accounts, call, tx, onApply }: {
  rangeId: string; accounts: CutoverAccount[]; call: Call; tx: (a: string, e: string) => string; onApply: (text: string) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Parsed | NeedsMapping | null>(null);
  const [pick, setPick] = useState<Record<number, string>>({});
  const [draftMap, setDraftMap] = useState<Partial<Record<string, number>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const m = (code: string) => (TB_MESSAGES[code] ? tx(TB_MESSAGES[code]!.ar, TB_MESSAGES[code]!.en) : code);
  const active = useMemo(() => accounts.filter((a) => a.is_active), [accounts]);
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);

  const upload = async (f: File, mapping?: Mapping) => {
    setBusy(true); setError(null); setApplied(false); setPick({});
    try {
      const r = await call(`/api/ledger-source-authority/${rangeId}/cutover/parse-file`, { method: 'POST', body: f, headers: {
        'content-type': f.type || (f.name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'application/octet-stream'), 'x-file-name': encodeURIComponent(f.name),
        ...(mapping ? { 'x-tb-mapping': encodeURIComponent(JSON.stringify(mapping)) } : {}) } });
      setResult(r as unknown as Parsed | NeedsMapping);
    } catch (e) { setResult(null); { const c = (e as { code?: string }).code ?? ''; setError(TB_MESSAGES[c] ? m(c) : tx('تعذر تنفيذ الطلب.', 'The request could not be completed.')); }; }
    finally { setBusy(false); }
  };

  const parsed = result?.status === 'parsed' ? result : null;
  // Effective account per row: the server's exact-code match, else the accountant's explicit manual choice (active accounts only).
  const effective = (l: Line): CutoverAccount | null => (l.status === 'ok' ? byId.get(l.account_id!) ?? null : l.status === 'unmatched' || l.status === 'inactive' ? byId.get(pick[l.row] ?? '') ?? null : null);
  const review = useMemo(() => {
    if (!parsed) return null;
    const used = new Map<string, number>();
    for (const l of parsed.lines) { const a = effective(l); if (a) used.set(a.id, (used.get(a.id) ?? 0) + 1); }
    const rows = parsed.lines.map((l) => { const a = effective(l); return { l, a, dup: !!a && (used.get(a.id) ?? 0) > 1, blocked: l.status === 'duplicate' || l.status === 'ambiguous' }; });
    const blocking = parsed.errors.filter((e) => !e.code.startsWith('TB_ACCOUNT_'));
    const ok = !blocking.length && rows.length >= 2 && parsed.balanced && rows.every((r) => r.a && !r.dup && !r.blocked);
    return { rows, blocking, ok };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed, pick, byId]);

  const apply = () => {
    if (!review?.ok) return;
    onApply(review.rows.map(({ l, a }) => `${a!.code}, ${l.debit}, ${l.credit}`).join('\n'));
    setApplied(true);
  };
  const needs = result?.status === 'needs_mapping' ? result : null;
  const signed = draftMap['balance'] !== undefined;
  const mapReady = draftMap['code'] !== undefined && (signed ? draftMap['debit'] === undefined && draftMap['credit'] === undefined : draftMap['debit'] !== undefined && draftMap['credit'] !== undefined);
  const colSelect = (k: string, ar: string, en: string) => <label key={k}>{tx(ar, en)}
    <select value={draftMap[k] ?? ''} onChange={(e) => setDraftMap({ ...draftMap, [k]: e.target.value === '' ? undefined : Number(e.target.value) })}>
      <option value="">{tx('— لا شيء —', '— none —')}</option>{needs!.headers.map((h, i) => <option key={i} value={i}>{h || `#${i + 1}`}</option>)}</select></label>;

  return <fieldset className="ca-acks ca-file" aria-label={tx('استيراد ميزان المراجعة من ملف', 'Import trial balance from file')}>
    <legend>{tx('استيراد من ملف CSV / XLSX (اختياري)', 'Import from CSV / XLSX file (optional)')}</legend>
    <p className="sa-muted">{tx('يملأ الملف حقل ميزان المراجعة أدناه فقط، ولا يرحّل أي قيد. تبقى المراجعة والتفعيل كما هما. تُقبل العملة الوظيفية فقط؛ الصيغ ممنوعة.', 'The file only fills the trial balance field below and posts nothing. Review and activation are unchanged. Only the functional currency is accepted; formulas are not allowed.')}</p>
    <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} aria-label={tx('ملف ميزان المراجعة', 'Trial balance file')}
      onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); setResult(null); setError(null); setApplied(false); setDraftMap({}); if (f) void upload(f); }} />
    {busy && <p role="status">{tx('جارٍ قراءة الملف…', 'Reading file…')}</p>}
    {error && <div className="sa-error" role="alert">{error}</div>}
    {needs && <div className="ca-file-map">
      <div className="sa-warning" role="note">{needs.issues.map((i) => m(i.code)).join(' ')}</div>
      <div className="sa-fields">{ROLES.map(([k, ar, en]) => colSelect(k, ar, en))}</div>
      <div className="sa-actions"><button type="button" className="sa-primary" disabled={busy || !mapReady || !file}
        onClick={() => file && void upload(file, { header_row: needs.header_row, code: draftMap['code']!, ...(draftMap['name'] !== undefined ? { name: draftMap['name'] } : {}), ...(draftMap['debit'] !== undefined ? { debit: draftMap['debit'] } : {}), ...(draftMap['credit'] !== undefined ? { credit: draftMap['credit'] } : {}), ...(draftMap['balance'] !== undefined ? { balance: draftMap['balance'] } : {}), ...(draftMap['currency'] !== undefined ? { currency: draftMap['currency'] } : {}) })}>{tx('تطبيق الأعمدة', 'Apply columns')}</button></div>
    </div>}
    {parsed && review && <div className="ca-file-review">
      {review.blocking.length > 0 && <ul className="sa-error" role="alert">{review.blocking.map((e, i) => <li key={i}>{e.row ? `${tx('سطر', 'Row')} ${e.row}: ` : ''}{m(e.code)}{e.detail ? ` (${e.detail})` : ''}</li>)}</ul>}
      {parsed.warnings.length > 0 && <ul className="sa-warning">{parsed.warnings.map((w, i) => <li key={i}>{w.row ? `${tx('سطر', 'Row')} ${w.row}: ` : ''}{m(w.code)}</li>)}</ul>}
      <div className="ca-table-wrap"><table className="sa-table"><thead><tr><th>{tx('سطر', 'Row')}</th><th>{tx('الرمز', 'Code')}</th><th>{tx('الاسم في الملف', 'Name in file')}</th><th>{tx('مدين', 'Debit')}</th><th>{tx('دائن', 'Credit')}</th><th>{tx('الحساب المربوط', 'Mapped account')}</th></tr></thead>
        <tbody>{review.rows.map(({ l, a, dup, blocked }) => <tr key={l.row}>
          <td className="sa-date">{l.row}</td><td className="sa-date" dir="ltr">{l.code}</td><td>{l.name ?? '—'}</td><td className="sa-date">{l.debit}</td><td className="sa-date">{l.credit}</td>
          <td>{l.status === 'ok' ? <span>{a ? `${a.code} — ${tx(a.name_ar ?? a.name, a.name_en ?? a.name)}` : '—'}</span>
            : blocked ? <span className="sa-error">{m(`TB_ACCOUNT_${l.status.toUpperCase()}`)}</span>
            : <label><span className="sa-error">{m(`TB_ACCOUNT_${l.status.toUpperCase()}`)} </span>
              <select aria-label={`${tx('اختر حساباً للسطر', 'Choose an account for row')} ${l.row}`} value={pick[l.row] ?? ''} onChange={(e) => setPick({ ...pick, [l.row]: e.target.value })}>
                <option value="">{tx('اختر حساباً', 'Choose an account')}</option>{active.map((x) => <option key={x.id} value={x.id}>{x.code} — {tx(x.name_ar ?? x.name, x.name_en ?? x.name)}</option>)}</select></label>}
            {dup && <span className="sa-error"> {tx('حساب مكرر بعد الربط', 'Account used more than once')}</span>}</td></tr>)}</tbody></table></div>
      <dl className="ca-totals"><div><dt>{tx('إجمالي المدين', 'Total debit')}</dt><dd className="sa-date">{parsed.total_debit}</dd></div><div><dt>{tx('إجمالي الدائن', 'Total credit')}</dt><dd className="sa-date">{parsed.total_credit}</dd></div>
        <div><dt>{tx('التوازن', 'Balance')}</dt><dd><span className={`sa-badge ${parsed.balanced ? 'is-active' : ''}`}>{parsed.balanced ? tx('متوازن', 'Balanced') : tx('غير متوازن', 'Not balanced')}</span></dd></div></dl>
      <div className="sa-actions"><button type="button" className="sa-primary" disabled={!review.ok} onClick={apply}>{tx('استخدام هذه السطور في النموذج', 'Use these lines in the form')}</button></div>
      {applied && <p role="status" className="sa-muted">{tx('تم ملء حقل ميزان المراجعة. لم يُرحّل أي قيد؛ تابع الفحص والمراجعة.', 'The trial balance field was filled. Nothing was posted; continue with the check and review.')}</p>}
    </div>}
  </fieldset>;
}
