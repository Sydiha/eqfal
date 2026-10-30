import { FormEvent, useCallback, useEffect, useState } from 'react';
import type { CutoverAccount } from './CutoverActivation';
import { formatMoney } from '../money-format';

// Cutover S2: pre-cut-over historical supplements (cash flows, equity movements) for one ACTIVE range. Report data with external evidence only:
// nothing here posts to the ledger. Drafts need source_authority.supplement_manage; approval needs source_authority.supplement_approve.
// Every invariant is checked by the server (exact halalas); this screen only shows the server's evaluation.
type Call = (url: string, init?: RequestInit) => Promise<Record<string, unknown>>;
type Kind = 'cash_flow' | 'equity';
type LineType = 'cash_balance' | 'cash_flow' | 'equity_opening' | 'equity_movement';
export type SupplementLineDraft = { line_type: LineType; account_id: string; section: string; movement_type: string; label: string; amount: string; opening_amount: string; closing_amount: string; classification_override_reason: string };
type Issue = { code: string; account_id?: string; line_no?: number; detail?: Record<string, string> };
type Version = {
  id: string; kind: Kind; version_no: number; status: 'draft' | 'approved' | 'superseded' | 'voided'; row_version: number; source_system: string; evidence_reference: string;
  fx_translation_evidence: string | null; functional_currency: string; approved_at: string | null; superseded_at: string | null; void_reason: string | null;
  lines: Array<Record<string, string | null>>; evaluation: { valid: boolean; issues: Issue[]; totals: Record<string, string> } | null;
};

const ISSUES: Record<string, { ar: string; en: string }> = {
  SUPPLEMENT_CASH_CLOSING_MISMATCH: { ar: 'رصيد نهاية حساب نقدي لا يطابق قيد القطع.', en: 'A cash account closing balance differs from the cutover journal.' },
  SUPPLEMENT_CASH_ROLLFORWARD_MISMATCH: { ar: 'الافتتاحي + التدفقات لا يساوي رصيد النقد في تاريخ القطع.', en: 'Opening cash plus flows does not equal cash at the cutover date.' },
  SUPPLEMENT_CASH_ACCOUNT_MISSING: { ar: 'حساب نقدي في قيد القطع بلا سطر رصيد.', en: 'A cash account of the cutover journal has no balance line.' },
  SUPPLEMENT_CASH_ACCOUNT_EXTRA: { ar: 'حساب نقدي غير موجود في قيد القطع.', en: 'A cash account that is not in the cutover journal.' },
  SUPPLEMENT_INTERNAL_TRANSFER_LINE: { ar: 'سطر مقابله حساب نقدي (تحويل داخلي) غير مسموح.', en: 'A line against a cash account (internal transfer) is not allowed.' },
  SUPPLEMENT_CLASSIFICATION_OVERRIDE_REQUIRED: { ar: 'القسم يخالف تصنيف الحساب: يلزم مبرر مكتوب.', en: 'The section differs from the account classification: a written justification is required.' },
  SUPPLEMENT_FX_EFFECT_NOT_ALLOWED: { ar: 'أثر الصرف غير مسموح: كل الحسابات بالعملة الوظيفية.', en: 'FX effect is not allowed: all accounts are in the functional currency.' },
  SUPPLEMENT_FX_EVIDENCE_REQUIRED: { ar: 'يلزم دليل ترجمة العملة لأثر الصرف.', en: 'FX translation evidence is required for the FX effect.' },
  SUPPLEMENT_CURRENCY_MISMATCH: { ar: 'العملة لا تطابق العملة الوظيفية المعتمدة.', en: 'The currency differs from the approved functional currency.' },
  SUPPLEMENT_EQUITY_ROLLFORWARD_MISMATCH: { ar: 'الافتتاحي + الحركات لا يساوي رصيد الحساب في قيد القطع.', en: 'Opening plus movements does not equal the account balance in the cutover journal.' },
  SUPPLEMENT_RETAINED_EARNINGS_MISMATCH: { ar: 'الأرباح المبقاة لا تطابق قيد القطع.', en: 'Retained earnings do not match the cutover journal.' },
  SUPPLEMENT_EQUITY_ACCOUNT_MISSING: { ar: 'حساب حقوق ملكية في قيد القطع بلا رصيد افتتاحي.', en: 'An equity account of the cutover journal has no opening balance.' },
  SUPPLEMENT_EQUITY_ACCOUNT_EXTRA: { ar: 'حساب حقوق ملكية زائد برصيد غير صفري.', en: 'An extra equity account with a non-zero balance.' },
  SUPPLEMENT_ACCOUNT_NOT_EQUITY: { ar: 'الحساب ليس حساب حقوق ملكية.', en: 'The account is not an equity account.' },
  SUPPLEMENT_EQUITY_TRANSFERS_UNBALANCED: { ar: 'مجموع التحويلات بين حسابات الملكية لا يساوي صفراً.', en: 'Transfers between equity accounts do not sum to zero.' },
  SUPPLEMENT_MOVEMENT_SIGN_INVALID: { ar: 'إشارة الحركة غير صحيحة (المساهمة موجبة والتوزيع سالب).', en: 'Wrong sign (contribution positive, distribution negative).' },
  SUPPLEMENT_DUPLICATE_ACCOUNT: { ar: 'حساب مكرر.', en: 'Duplicate account.' },
  SUPPLEMENT_LINES_REQUIRED: { ar: 'لا توجد سطور.', en: 'There are no lines.' },
};
const ERRORS: Record<string, { ar: string; en: string }> = {
  SUPPLEMENT_INVARIANTS_FAILED: { ar: 'لم يُعتمد: توجد فروقات. راجع القائمة أدناه.', en: 'Not approved: there are differences. See the list below.' },
  SUPPLEMENT_STALE_WRITE: { ar: 'غيّر مستخدم آخر هذه المسودة. أُعيد التحميل.', en: 'Another user changed this draft. It was reloaded.' },
  SUPPLEMENT_DRAFT_EXISTS: { ar: 'توجد مسودة لهذا النوع بالفعل.', en: 'A draft of this kind already exists.' },
  SUPPLEMENT_LINES_INVALID: { ar: 'بيانات غير صالحة (مبالغ بخانتين عشريتين، والمبرر 10 أحرف على الأقل).', en: 'Invalid data (two-decimal amounts; justification at least 10 characters).' },
  SUPPLEMENT_ACCOUNT_NOT_FOUND: { ar: 'حساب غير موجود في هذه الشركة.', en: 'An account does not exist in this company.' },
  SUPPLEMENT_FISCAL_YEAR_CLOSED: { ar: 'لا يمكن اعتماد الملحق لأن السنة المالية لهذه الفترة مقفلة. الأرقام المقفلة لا تتغير.', en: 'The supplement cannot be approved because the fiscal year of this period is closed. Closed figures cannot change.' },
  SUPPLEMENT_CONCURRENT_CHANGE: { ar: 'تغيّر الإصدار المعتمد أثناء العملية. أعد المحاولة.', en: 'The approved version changed meanwhile. Try again.' },
};

const blank = (line_type: LineType): SupplementLineDraft => ({ line_type, account_id: '', section: line_type === 'cash_flow' ? 'operating' : '', movement_type: line_type === 'equity_movement' ? 'contribution' : '', label: '', amount: '', opening_amount: '', closing_amount: '', classification_override_reason: '' });
/**
 * Accepts thousands separators only in their well-formed position ("100,000.00" -> "100000.00"); anything else is returned trimmed and
 * unchanged so the server's strict two-decimal validation still rejects it ("1,00", "1,,000", "12,34.5"). Digits are never altered.
 */
export function normalizeAmount(value: string) {
  const v = value.trim();
  return /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(v) ? v.replace(/,/g, '') : v;
}
const TOTALS: Record<string, { ar: string; en: string }> = {
  opening: { ar: 'الافتتاحي 1/1', en: 'Opening 1 Jan' }, operating: { ar: 'التشغيلية', en: 'Operating' }, investing: { ar: 'الاستثمارية', en: 'Investing' },
  financing: { ar: 'التمويلية', en: 'Financing' }, fx_effect: { ar: 'أثر الصرف', en: 'FX effect' }, net_change: { ar: 'صافي التغير', en: 'Net change' },
  closing: { ar: 'في تاريخ القطع', en: 'At cutover date' }, movements: { ar: 'الحركات', en: 'Movements' }, retained_earnings_difference: { ar: 'فرق الأرباح المبقاة', en: 'Retained earnings difference' },
};
/** Builds the strict request lines (only the keys the server accepts for each line type). Exported for unit tests. */
export function toRequestLines(lines: SupplementLineDraft[]) {
  return lines.map((l) => {
    if (l.line_type === 'cash_balance') return { line_type: l.line_type, account_id: l.account_id, opening_amount: normalizeAmount(l.opening_amount), closing_amount: normalizeAmount(l.closing_amount) };
    if (l.line_type === 'equity_opening') return { line_type: l.line_type, account_id: l.account_id, opening_amount: normalizeAmount(l.opening_amount) };
    if (l.line_type === 'equity_movement') return { line_type: l.line_type, account_id: l.account_id, movement_type: l.movement_type, label: l.label.trim(), amount: normalizeAmount(l.amount) };
    return { line_type: l.line_type, section: l.section, label: l.label.trim(), amount: normalizeAmount(l.amount), ...(l.account_id ? { account_id: l.account_id } : {}), ...(l.classification_override_reason.trim() ? { classification_override_reason: l.classification_override_reason.trim() } : {}) };
  });
}

export function CutoverSupplements({ rangeId, call, tx, canManage, canApprove }: { rangeId: string; call: Call; tx: (a: string, e: string) => string; canManage: boolean; canApprove: boolean }) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [accounts, setAccounts] = useState<CutoverAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ kind: Kind; version: Version | null } | null>(null);
  const [form, setForm] = useState({ source_system: '', evidence_reference: '', fx_translation_evidence: '', confirm: false });
  const [lines, setLines] = useState<SupplementLineDraft[]>([]);
  const base = `/api/ledger-source-authority/${rangeId}/supplements`;
  const load = useCallback(async () => {
    try { setVersions(((await call(base)).versions as Version[]) ?? []); } catch { setError(tx('تعذر تحميل البيانات التاريخية.', 'The historical supplements could not be loaded.')); }
  }, [base, call, tx]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (canManage) void call('/api/accounts').then((r) => setAccounts((r.accounts as CutoverAccount[]) ?? [])).catch(() => setAccounts([])); }, [call, canManage]);
  const fail = (e: unknown) => { const code = (e as { code?: string }).code ?? ''; const m = ERRORS[code] ?? ISSUES[code]; setError(m ? tx(m.ar, m.en) : tx('تعذر تنفيذ الطلب.', 'The request could not be completed.')); };
  const run = async (fn: () => Promise<unknown>) => { setBusy(true); setError(null); try { await fn(); } catch (e) { fail(e); } finally { setBusy(false); await load(); } };
  const post = (url: string, body: unknown, method = 'POST') => call(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  const open = (kind: Kind, version: Version | null) => {
    setEditing({ kind, version }); setError(null);
    setForm({ source_system: version?.source_system ?? '', evidence_reference: version?.evidence_reference ?? '', fx_translation_evidence: version?.fx_translation_evidence ?? '', confirm: false });
    setLines(version ? version.lines.map((l) => ({ ...blank(l['line_type'] as LineType), ...Object.fromEntries(Object.entries(l).map(([k, v]) => [k, v ?? ''])) }) as SupplementLineDraft)
      : kind === 'cash_flow' ? [blank('cash_balance'), blank('cash_flow')] : [blank('equity_opening')]);
  };
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (!editing) return;
    const body = { source_system: form.source_system, evidence_reference: form.evidence_reference, ...(editing.kind === 'cash_flow' && form.fx_translation_evidence.trim() ? { fx_translation_evidence: form.fx_translation_evidence } : {}), lines: toRequestLines(lines), confirm: true };
    void run(async () => {
      if (editing.version) await post(`${base}/${editing.version.id}`, { ...body, expected_row_version: editing.version.row_version }, 'PUT');
      else await post(`${base}/${editing.kind}/drafts`, body);
      setEditing(null);
    });
  };
  const set = (i: number, patch: Partial<SupplementLineDraft>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const name = (id: string | null | undefined) => { const a = accounts.find((x) => x.id === id); return a ? `${a.code} — ${tx(a.name_ar ?? a.name, a.name_en ?? a.name)}` : id ?? '—'; };
  const status = (s: Version['status']) => ({ draft: tx('مسودة', 'Draft'), approved: tx('معتمد', 'Approved'), superseded: tx('مُستبدل', 'Superseded'), voided: tx('ملغى', 'Voided') })[s];
  const cash = editing?.kind === 'cash_flow';
  const kindLabel = (k: Kind) => (k === 'cash_flow' ? tx('التدفقات النقدية قبل القطع', 'Pre-cutover cash flows') : tx('حركات حقوق الملكية قبل القطع', 'Pre-cutover equity movements'));

  return <section className="sa-card" aria-label={tx('البيانات التاريخية قبل القطع', 'Pre-cutover historical supplements')}>
    <div className="sa-card__head"><h3>{tx('البيانات التاريخية قبل القطع', 'Pre-cutover historical supplements')}</h3></div>
    <p className="sa-muted">{tx('بيانات تقرير بأدلة خارجية، لا تُرحَّل إلى الدفتر. يُحفظ كل تصحيح كإصدار جديد يحل محل السابق بعد اعتماده.', 'Report data with external evidence; never posted to the ledger. Each correction is a new version that replaces the previous one once approved.')}</p>
    {error && <div className="sa-error" role="alert">{error}</div>}
    {(['cash_flow', 'equity'] as const).map((kind) => {
      const list = versions.filter((v) => v.kind === kind);
      const draft = list.find((v) => v.status === 'draft');
      return <div key={kind} className="sa-supplement">
        <h4>{kindLabel(kind)}</h4>
        {list.length === 0 ? <p className="sa-state">{tx('لا يوجد إصدار. القوائم السنوية الكاملة محجوبة حتى الاعتماد.', 'No version. The full-year statements package stays blocked until one is approved.')}</p> :
          <div className="sa-table"><table><thead><tr><th>{tx('الإصدار', 'Version')}</th><th>{tx('الحالة', 'Status')}</th><th>{tx('الدليل', 'Evidence')}</th><th>{tx('المجاميع', 'Totals')}</th><th /></tr></thead>
            <tbody>{list.map((v) => <tr key={v.id}><td>{v.version_no}</td><td><span className={`sa-badge is-${v.status === 'approved' ? 'active' : v.status === 'draft' ? 'draft' : 'voided'}`}>{status(v.status)}</span></td>
              <td className="sa-reason">{v.source_system} · {v.evidence_reference}</td>
              <td>{v.evaluation ? <dl className="sa-totals">{Object.entries(v.evaluation.totals).map(([k, x]) => <div key={k}><dt>{TOTALS[k] ? tx(TOTALS[k]!.ar, TOTALS[k]!.en) : k}</dt><dd><bdi dir="ltr">{formatMoney(x)}</bdi></dd></div>)}</dl> : '—'}</td>
              <td>{v.status === 'draft' && canManage && <button type="button" className="sa-ghost" disabled={busy} onClick={() => open(kind, v)}>{tx('تعديل', 'Edit')}</button>}
                {v.status === 'draft' && canApprove && <button type="button" className="sa-primary" disabled={busy || !v.evaluation?.valid} onClick={() => void run(() => post(`${base}/${v.id}/approve`, { confirm: true, expected_row_version: v.row_version }))}>{tx('اعتماد', 'Approve')}</button>}
                {v.status === 'draft' && canManage && <button type="button" className="sa-ghost" disabled={busy} onClick={() => { const reason = window.prompt(tx('سبب إلغاء المسودة', 'Reason for voiding the draft')); if (reason?.trim()) void run(() => post(`${base}/${v.id}/void`, { confirm: true, expected_row_version: v.row_version, reason })); }}>{tx('إلغاء', 'Void')}</button>}</td></tr>)}</tbody></table></div>}
        {draft?.evaluation && !draft.evaluation.valid && <ul className="sa-issues" aria-label={tx('فروقات المسودة', 'Draft differences')}>{draft.evaluation.issues.map((i, n) => <li key={n}>{ISSUES[i.code] ? tx(ISSUES[i.code]!.ar, ISSUES[i.code]!.en) : i.code}{i.account_id ? ` — ${name(i.account_id)}` : ''}{i.detail?.['difference'] ? <bdi dir="ltr"> ({formatMoney(i.detail['difference'])})</bdi> : null}</li>)}</ul>}
        {canManage && !draft && <button type="button" className="sa-ghost" disabled={busy} onClick={() => open(kind, null)}>{list.some((v) => v.status === 'approved') ? tx('إصدار تصحيحي جديد', 'New correcting version') : tx('إدخال البيانات', 'Enter data')}</button>}
      </div>;
    })}
    {editing && <form onSubmit={save} className="sa-form" aria-label={kindLabel(editing.kind)}>
      <div className="sa-fields">
        <label>{tx('النظام المصدر', 'Source system')}<input value={form.source_system} maxLength={200} onChange={(e) => setForm({ ...form, source_system: e.target.value })} required /></label>
        <label>{tx('مرجع الدليل', 'Evidence reference')}<input value={form.evidence_reference} maxLength={200} onChange={(e) => setForm({ ...form, evidence_reference: e.target.value })} required /></label>
        {editing.kind === 'cash_flow' && <label>{tx('دليل ترجمة العملة (لأثر الصرف فقط)', 'FX translation evidence (FX effect only)')}<input value={form.fx_translation_evidence} maxLength={500} onChange={(e) => setForm({ ...form, fx_translation_evidence: e.target.value })} /></label>}
      </div>
      <div className={`sa-table sa-lines${cash ? '' : ' sa-lines--equity'}`}><table><thead><tr><th>{tx('النوع', 'Type')}</th><th>{tx('الحساب', 'Account')}</th><th>{cash ? tx('القسم', 'Section') : tx('نوع الحركة', 'Movement type')}</th><th>{tx('البيان', 'Label')}</th><th>{tx('المبلغ', 'Amount')}</th><th>{tx('افتتاحي 1/1', 'Opening 1 Jan')}</th>{cash && <><th>{tx('في تاريخ القطع', 'At cutover date')}</th><th>{tx('مبرر التصنيف', 'Classification justification')}</th></>}<th /></tr></thead>
        <tbody>{lines.map((l, i) => <tr key={i}>
          <td><select aria-label={tx('النوع', 'Type')} value={l.line_type} onChange={(e) => set(i, blank(e.target.value as LineType))}>{(editing.kind === 'cash_flow' ? ['cash_balance', 'cash_flow'] : ['equity_opening', 'equity_movement']).map((x) => <option key={x} value={x}>{({ cash_balance: tx('رصيد حساب نقدي', 'Cash account balance'), cash_flow: tx('تدفق نقدي', 'Cash flow'), equity_opening: tx('رصيد ملكية افتتاحي', 'Equity opening'), equity_movement: tx('حركة ملكية', 'Equity movement') } as Record<string, string>)[x]}</option>)}</select></td>
          <td><select aria-label={tx('الحساب', 'Account')} value={l.account_id} onChange={(e) => set(i, { account_id: e.target.value })} required={l.line_type !== 'cash_flow'}><option value="">{l.line_type === 'cash_flow' ? tx('بدون', 'None') : tx('اختر', 'Choose')}</option>{accounts.map((a) => <option key={a.id} value={a.id}>{name(a.id)}</option>)}</select></td>
          <td>{l.line_type === 'cash_flow' ? <select aria-label={tx('القسم', 'Section')} value={l.section} onChange={(e) => set(i, { section: e.target.value })}>{['operating', 'investing', 'financing', 'fx_effect'].map((x) => <option key={x} value={x}>{({ operating: tx('تشغيلية', 'Operating'), investing: tx('استثمارية', 'Investing'), financing: tx('تمويلية', 'Financing'), fx_effect: tx('أثر الصرف', 'FX effect') } as Record<string, string>)[x]}</option>)}</select>
            : l.line_type === 'equity_movement' ? <select aria-label={tx('نوع الحركة', 'Movement type')} value={l.movement_type} onChange={(e) => set(i, { movement_type: e.target.value })}>{['contribution', 'distribution', 'transfer', 'other'].map((x) => <option key={x} value={x}>{({ contribution: tx('مساهمة', 'Contribution'), distribution: tx('توزيع', 'Distribution'), transfer: tx('تحويل', 'Transfer'), other: tx('أخرى', 'Other') } as Record<string, string>)[x]}</option>)}</select> : '—'}</td>
          <td>{(l.line_type === 'cash_flow' || l.line_type === 'equity_movement') && <input aria-label={tx('البيان', 'Label')} value={l.label} maxLength={200} onChange={(e) => set(i, { label: e.target.value })} required />}</td>
          <td>{(l.line_type === 'cash_flow' || l.line_type === 'equity_movement') && <input aria-label={tx('المبلغ', 'Amount')} dir="ltr" inputMode="decimal" value={l.amount} onChange={(e) => set(i, { amount: e.target.value })} required />}</td>
          <td>{(l.line_type === 'cash_balance' || l.line_type === 'equity_opening') && <input aria-label={tx('افتتاحي 1/1', 'Opening 1 Jan')} dir="ltr" inputMode="decimal" value={l.opening_amount} onChange={(e) => set(i, { opening_amount: e.target.value })} required />}</td>
          {cash && <td>{l.line_type === 'cash_balance' && <input aria-label={tx('في تاريخ القطع', 'At cutover date')} dir="ltr" inputMode="decimal" value={l.closing_amount} onChange={(e) => set(i, { closing_amount: e.target.value })} required />}</td>}
          {cash && <td>{l.line_type === 'cash_flow' && l.account_id && <input aria-label={tx('مبرر التصنيف', 'Classification justification')} value={l.classification_override_reason} maxLength={500} onChange={(e) => set(i, { classification_override_reason: e.target.value })} />}</td>}
          <td><button type="button" className="sa-ghost" onClick={() => setLines(lines.filter((_, j) => j !== i))}>{tx('حذف السطر', 'Remove line')}</button></td></tr>)}</tbody></table></div>
      <p className="sa-scroll-hint">{tx('مرّر الجدول أفقياً لعرض كل الأعمدة.', 'Scroll the table sideways to see all columns.')}</p>
      <div className="sa-actions"><button type="button" className="sa-ghost" onClick={() => setLines([...lines, blank(editing.kind === 'cash_flow' ? 'cash_flow' : 'equity_movement')])}>{tx('إضافة سطر', 'Add line')}</button></div>
      <p className="sa-muted">{tx('المبالغ بالعملة الوظيفية بخانتين عشريتين (تُقبل فواصل الآلاف مثل 100,000.00). التدفق الداخل موجب. المساهمة موجبة والتوزيع سالب. لا تُدخل ربح السنة كحركة ملكية.', 'Amounts in the functional currency, two decimals (thousands separators such as 100,000.00 are accepted). Cash inflow positive. Contribution positive, distribution negative. Do not enter the year\'s profit as an equity movement.')}</p>
      <label className="sa-check"><input type="checkbox" checked={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.checked })} /><span>{tx('أؤكد أن هذه البيانات مأخوذة من الأدلة المذكورة، وأنها تُحفظ مسودة حتى تُعتمد.', 'I confirm these figures come from the stated evidence and are saved as a draft until approved.')}</span></label>
      <div className="sa-actions"><button type="button" className="sa-ghost" onClick={() => setEditing(null)}>{tx('رجوع', 'Back')}</button>
        <button type="submit" className="sa-primary" disabled={busy || !form.confirm}>{busy ? tx('جارٍ الحفظ…', 'Saving…') : tx('حفظ المسودة', 'Save draft')}</button></div>
    </form>}
  </section>;
}
