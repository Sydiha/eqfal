import { useMemo, useRef, useState } from 'react';

export interface CutoverRange { id: string; from_date: string; to_date: string }
export interface CutoverAccount { id: string; code: string; name: string; name_ar: string | null; name_en: string | null; is_active: boolean; account_type: string }
type Call = (url: string, init?: RequestInit) => Promise<Record<string, unknown>>;
type Blocker = { code: string; detail?: unknown };
type Summary = { line_count: number; total_debit: string; total_credit: string; cash_balance: string; profit_or_loss_to_date: string; retained_earnings_balance: string; warnings: Array<{ code: string }> };

export const CUTOVER_MESSAGES: Record<string, { ar: string; en: string }> = {
  CUTOVER_LINES_INVALID: { ar: 'سطور ميزان المراجعة غير صالحة (حساب مكرر أو سطر بمدين ودائن معاً أو أقل من حسابين).', en: 'The trial balance lines are not valid (duplicate account, a line with both debit and credit, or fewer than two accounts).' },
  CUTOVER_JOURNAL_UNBALANCED: { ar: 'ميزان المراجعة غير متوازن: إجمالي المدين لا يساوي إجمالي الدائن.', en: 'The trial balance is not balanced: total debit differs from total credit.' },
  CUTOVER_ACCOUNT_NOT_FOUND: { ar: 'أحد الحسابات غير موجود في دليل حسابات هذه الشركة.', en: 'An account does not exist in this company chart of accounts.' },
  CUTOVER_ACCOUNT_INACTIVE: { ar: 'أحد الحسابات غير نشط.', en: 'An account is inactive.' },
  CUTOVER_ACCOUNT_UNMAPPED: { ar: 'أحد الحسابات غير مربوط بتصنيف القوائم المالية.', en: 'An account has no financial statement classification.' },
  CUTOVER_RETAINED_ACCOUNT_INVALID: { ar: 'حساب الأرباح المبقاة يجب أن يكون حساب حقوق ملكية.', en: 'The retained earnings account must be an equity account.' },
  CUTOVER_CASH_CLASSIFICATION_UNCONFIRMED: { ar: 'حسابات تبدو نقداً أو بنكاً لكنها مصنفة غير نقدية. أكّد كل حساب على حدة.', en: 'Accounts that look like cash or bank are classified non-cash. Confirm each one individually.' },
  CUTOVER_CASH_CONFIRMATION_INVALID: { ar: 'تأكيد نقدي لحساب لا يستوجبه.', en: 'A cash confirmation was given for an account that does not need one.' },
  CUTOVER_DATE_NOT_MONTH_END: { ar: 'تاريخ القطع يجب أن يكون آخر يوم في الشهر.', en: 'The cutover date must be a month end.' },
  CUTOVER_DATE_IN_FUTURE: { ar: 'تاريخ القطع في المستقبل.', en: 'The cutover date is in the future.' },
  AUTHORITY_ALREADY_ACTIVE: { ar: 'هذا الإعداد مفعّل بالفعل.', en: 'This configuration is already active.' },
  AUTHORITY_NOT_DRAFT: { ar: 'هذا الإعداد ليس مسودة.', en: 'This configuration is not a draft.' },
  AUTHORITY_RANGE_CLOSED_PERIOD: { ar: 'الفترة أو السنة المالية مقفلة.', en: 'The period or fiscal year is closed.' },
  AUTHORITY_DRAFT_FISCAL_YEAR_INVALID: { ar: 'السنة المالية للإعداد غير صالحة.', en: 'The fiscal year of this configuration is not valid.' },
  AUTHORITY_IDEMPOTENCY_KEY_REUSED: { ar: 'مفتاح الطلب مستخدم من قبل.', en: 'The request key was already used.' },
  CUTOVER_JOURNAL_EXISTS: { ar: 'يوجد قيد قطع لهذه الشركة بالفعل.', en: 'A cutover journal already exists for this company.' },
  CUTOVER_JOURNAL_INVALID: { ar: 'تعذر ترحيل قيد القطع.', en: 'The cutover journal could not be posted.' },
  CONFIRMATION_REQUIRED: { ar: 'يلزم تأكيد صريح.', en: 'Explicit confirmation is required.' },
  FORBIDDEN: { ar: 'لا تملك صلاحية تفعيل القطع.', en: 'You do not have permission to activate a cutover.' },
};
const WARNINGS: Record<string, { ar: string; en: string }> = {
  CUTOVER_ACCOUNT_LEVEL_ONLY: { ar: 'الأرصدة على مستوى الحساب فقط، دون تفاصيل الفواتير أو الأطراف.', en: 'Balances are account-level only, without invoice or party detail.' },
  CUTOVER_RETAINED_EARNINGS_ZERO: { ar: 'رصيد الأرباح المبقاة صفر.', en: 'The retained earnings balance is zero.' },
  CUTOVER_EQUITY_MATCHES_PNL: { ar: 'يوجد حساب حقوق ملكية يطابق مبلغه ربح/خسارة الفترة؛ تأكد من عدم التكرار.', en: 'An equity account equals the period profit/loss; check it is not double counted.' },
  CUTOVER_PNL_EMPTY_WITH_RETAINED_EARNINGS: { ar: 'لا توجد أرصدة أرباح وخسائر رغم وجود أرباح مبقاة.', en: 'No profit-and-loss balances although retained earnings exist.' },
  CUTOVER_NO_CASH_BALANCE: { ar: 'لا يوجد رصيد نقدي أو بنكي.', en: 'There is no cash or bank balance.' },
  CUTOVER_CASH_FLOW_UNMAPPED: { ar: 'حسابات بلا تصنيف للتدفقات النقدية.', en: 'Accounts without a cash-flow classification.' },
};
const VAT_CODES = /VAT/i;

/** Parses "code, debit, credit" lines (comma, tab or semicolon). Pure client-side check; the server stays authoritative. */
export function parseTrialBalance(text: string, accounts: CutoverAccount[]) {
  const byCode = new Map(accounts.map((a) => [a.code.trim(), a]));
  const lines: Array<{ account_id: string; debit: string; credit: string; code: string }> = [];
  const problems: Array<{ row: number; kind: 'format' | 'unknown' | 'duplicate' }> = [];
  const seen = new Set<string>();
  text.split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const [code = '', d = '', c = ''] = raw.split(/[,\t;]/).map((x) => x.trim());
    const debit = d === '' ? '0' : d, credit = c === '' ? '0' : c;
    if (/^(code|account)/i.test(code) && i === 0) return;
    if (!/^\d{1,16}(\.\d{1,2})?$/.test(debit) || !/^\d{1,16}(\.\d{1,2})?$/.test(credit) || (Number(debit) > 0) === (Number(credit) > 0)) { problems.push({ row: i + 1, kind: 'format' }); return; }
    const acc = byCode.get(code);
    if (!acc) { problems.push({ row: i + 1, kind: 'unknown' }); return; }
    if (seen.has(acc.id)) { problems.push({ row: i + 1, kind: 'duplicate' }); return; }
    seen.add(acc.id);
    lines.push({ account_id: acc.id, debit, credit, code });
  });
  const cents = (v: string) => { const [w, f = ''] = v.split('.'); return BigInt(w!) * 100n + BigInt((f + '00').slice(0, 2)); };
  let dr = 0n, cr = 0n;
  for (const l of lines) { dr += cents(l.debit); cr += cents(l.credit); }
  const fmt = (v: bigint) => `${v / 100n}.${String(v % 100n).padStart(2, '0')}`;
  return { lines, problems, totalDebit: fmt(dr), totalCredit: fmt(cr), balanced: lines.length >= 2 && dr === cr && dr > 0n };
}

export function CutoverActivation({ range, accounts, accountsFailed, call, tx, ar, onDone, onCancel }: {
  range: CutoverRange; accounts: CutoverAccount[]; accountsFailed: boolean; call: Call; tx: (a: string, e: string) => string; ar: boolean; onDone: () => void; onCancel: () => void;
}) {
  const [text, setText] = useState('');
  const [reference, setReference] = useState('');
  const [preparedBy, setPreparedBy] = useState('');
  const [reId, setReId] = useState('');
  const [cashIds, setCashIds] = useState<string[]>([]);
  const [acks, setAcks] = useState({ retained_earnings: false, current_year_pnl: false, cash_balances: false, account_level_limitations: false });
  const [preview, setPreview] = useState<{ valid: boolean; blockers: Blocker[]; summary: Summary | null } | null>(null);
  const [finalConfirm, setFinalConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ journal_id: string | null; replayed: boolean } | null>(null);
  const inFlight = useRef(false);
  const key = useRef(`cutover-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`);

  const tb = useMemo(() => parseTrialBalance(text, accounts), [text, accounts]);
  const equity = accounts.filter((a) => a.account_type === 'equity' && a.is_active);
  const name = (a: CutoverAccount) => (ar ? a.name_ar ?? a.name : a.name_en ?? a.name);
  const allAcked = Object.values(acks).every(Boolean);
  const inputsReady = tb.balanced && tb.problems.length === 0 && reference.trim() && preparedBy.trim() && reId && allAcked;
  const body = () => ({
    lines: tb.lines.map(({ account_id, debit, credit }) => ({ account_id, debit, credit })), retained_earnings_account_id: reId,
    tb_reference: reference.trim(), tb_prepared_by: preparedBy.trim(), acknowledgements: { retained_earnings: true, current_year_pnl: true, cash_balances: true, account_level_limitations: true },
    cash_non_cash_confirmed_account_ids: cashIds,
  });
  const reset = () => { setPreview(null); setFinalConfirm(false); setError(null); };
  const send = async (path: 'cutover/preview' | 'activate', extra: object) => call(`/api/ledger-source-authority/${range.id}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body(), ...extra }) });
  const msg = (code: string) => { const m = CUTOVER_MESSAGES[code]; return m ? tx(m.ar, m.en) : tx('تعذر تنفيذ الطلب.', 'The request could not be completed.'); };

  const runPreview = async () => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null); setFinalConfirm(false);
    try { setPreview((await send('cutover/preview', {})) as never); }
    catch (e) { setError(msg((e as { code?: string }).code ?? 'UNKNOWN')); }
    finally { inFlight.current = false; setBusy(false); }
  };
  const activate = async () => {
    if (inFlight.current || !preview?.valid || !finalConfirm) return;
    inFlight.current = true; setBusy(true); setError(null);
    try { const r = await send('activate', { confirm: true, idempotency_key: key.current }); setDone({ journal_id: (r.journal_id as string | null) ?? null, replayed: r.replayed === true }); }
    catch (e) { setError(msg((e as { code?: string }).code ?? 'UNKNOWN')); }
    finally { inFlight.current = false; setBusy(false); }
  };

  const cashBlocker = preview?.blockers.find((b) => b.code === 'CUTOVER_CASH_CLASSIFICATION_UNCONFIRMED');
  const cashAccounts = ((cashBlocker?.detail as { accounts?: Array<{ id: string; code: string; name: string }> } | undefined)?.accounts) ?? [];
  const label = (code: string) => (WARNINGS[code] ? tx(WARNINGS[code]!.ar, WARNINGS[code]!.en) : code);

  if (done) return <section className="sa-card ca" role="status" aria-labelledby="ca-done">
    <h3 id="ca-done">{tx('تم تفعيل القطع', 'Cutover activated')}</h3>
    <p>{done.replayed ? tx('هذا الطلب نُفّذ سابقاً؛ عُرضت نتيجته المحفوظة.', 'This request was already processed; the stored outcome is shown.') : tx('رُحّل قيد القطع وأصبح الإعداد فعّالاً.', 'The cutover journal was posted and the configuration is now active.')}</p>
    <p className="sa-muted">{tx('رقم القيد', 'Journal')}: <span className="sa-date">{done.journal_id}</span> · {tx('تاريخ السريان', 'Effective date')}: <span className="sa-date">{range.to_date}</span></p>
    <div className="sa-actions"><button type="button" className="sa-primary" onClick={onDone}>{tx('إغلاق', 'Close')}</button></div>
  </section>;

  return <section className="sa-card ca" aria-labelledby="ca-title">
    <div className="sa-card__head"><h3 id="ca-title">{tx('تفعيل القطع', 'Activate cutover')}</h3><span className="sa-muted sa-date">{range.from_date} → {range.to_date}</span></div>
    <div className="sa-warning" role="note"><div>{tx('التفعيل يرحّل قيد قطع واحداً بتاريخ القطع ويجعل ما قبله مرجعاً خارجياً فقط، ولا يمكن التراجع عنه. توازن الميزان لا يثبت صحته؛ الإقرارات مسجّلة وليست محقَّقة.', 'Activation posts one cutover journal at the cutover date and makes everything before it external reference only. It cannot be undone. A balanced trial balance does not prove it is correct; acknowledgements are recorded, not verified.')}</div></div>
    {accountsFailed && <div className="sa-error" role="alert">{tx('تعذر تحميل دليل الحسابات (يلزم صلاحية عرض المحاسبة).', 'The chart of accounts could not be loaded (accounting view permission is required).')}</div>}
    {error && <div className="sa-error" role="alert">{error}</div>}
    <div className="sa-fields">
      <label>{tx('الشركة', 'Company')}<input value={tx('الشركة النشطة', 'Active company')} readOnly /></label>
      <label>{tx('تاريخ القطع', 'Cutover date')}<input value={range.to_date} readOnly dir="ltr" /></label>
      <label>{tx('مرجع ميزان المراجعة المعتمد', 'Approved trial balance reference')}<input value={reference} maxLength={200} onChange={(e) => { setReference(e.target.value); reset(); }} /></label>
      <label>{tx('أعدّه', 'Prepared by')}<input value={preparedBy} maxLength={200} onChange={(e) => { setPreparedBy(e.target.value); reset(); }} /></label>
      <label>{tx('حساب الأرباح المبقاة', 'Retained earnings account')}
        <select value={reId} onChange={(e) => { setReId(e.target.value); reset(); }}><option value="">{tx('اختر', 'Choose')}</option>{equity.map((a) => <option key={a.id} value={a.id}>{a.code} — {name(a)}</option>)}</select></label>
    </div>
    <label>{tx('ميزان المراجعة (رمز الحساب، مدين، دائن — سطر لكل حساب)', 'Trial balance (account code, debit, credit — one line per account)')}
      <textarea value={text} dir="ltr" rows={8} placeholder="1010, 5000.00, 0" onChange={(e) => { setText(e.target.value); reset(); }} /></label>
    {tb.problems.length > 0 && <div className="sa-error" role="alert">{tb.problems.map((p) => `${tx('سطر', 'Row')} ${p.row}: ${p.kind === 'unknown' ? tx('رمز حساب غير معروف', 'unknown account code') : p.kind === 'duplicate' ? tx('حساب مكرر', 'duplicate account') : tx('صيغة غير صالحة', 'invalid format')}`).join(' · ')}</div>}
    <dl className="ca-totals" aria-label={tx('إجماليات', 'Totals')}>
      <div><dt>{tx('إجمالي المدين', 'Total debit')}</dt><dd className="sa-date">{tb.totalDebit}</dd></div>
      <div><dt>{tx('إجمالي الدائن', 'Total credit')}</dt><dd className="sa-date">{tb.totalCredit}</dd></div>
      <div><dt>{tx('التوازن', 'Balance')}</dt><dd><span className={`sa-badge ${tb.balanced ? 'is-active' : ''}`}>{tb.lines.length === 0 ? tx('لا توجد سطور', 'No lines') : tb.balanced ? tx('متوازن', 'Balanced') : tx('غير متوازن', 'Not balanced')}</span></dd></div>
    </dl>
    <fieldset className="ca-acks"><legend>{tx('إقرارات المحاسب (الأربعة إلزامية)', 'Accountant acknowledgements (all four required)')}</legend>
      {([
        ['retained_earnings', 'أُقرّ بأن رصيد الأرباح المبقاة صحيح.', 'I acknowledge the retained earnings balance is correct.'],
        ['current_year_pnl', 'أُقرّ بأن أرباح/خسائر السنة حتى تاريخ القطع صحيحة ومشمولة.', 'I acknowledge the year-to-date profit or loss is correct and included.'],
        ['cash_balances', 'أُقرّ بصحة الأرصدة النقدية والبنكية.', 'I acknowledge the cash and bank balances are correct.'],
        ['account_level_limitations', 'أفهم أن الأرصدة على مستوى الحساب فقط دون تفاصيل الفواتير أو الأطراف.', 'I understand balances are account-level only, without invoice or party detail.'],
      ] as const).map(([k, a, e]) => <label key={k} className="sa-check"><input type="checkbox" checked={acks[k]} onChange={(ev) => { setAcks({ ...acks, [k]: ev.target.checked }); reset(); }} /><span>{tx(a, e)}</span></label>)}
    </fieldset>
    {cashAccounts.length > 0 && <fieldset className="ca-acks"><legend>{tx('تأكيد تصنيف النقد/البنك', 'Cash / bank classification confirmation')}</legend>
      <p className="sa-muted">{msg('CUTOVER_CASH_CLASSIFICATION_UNCONFIRMED')}</p>
      {cashAccounts.map((a) => <label key={a.id} className="sa-check"><input type="checkbox" checked={cashIds.includes(a.id)} onChange={(ev) => { setCashIds(ev.target.checked ? [...cashIds, a.id] : cashIds.filter((x) => x !== a.id)); reset(); }} />
        <span>{tx(`أؤكد أن الحساب ${a.code} — ${a.name} غير نقدي فعلاً.`, `I confirm account ${a.code} — ${a.name} is really non-cash.`)}</span></label>)}
    </fieldset>}
    <div className="sa-actions"><button type="button" className="sa-ghost" onClick={onCancel} disabled={busy}>{tx('رجوع', 'Back')}</button>
      <button type="button" className="sa-primary" disabled={busy || !inputsReady} onClick={() => void runPreview()}>{busy && !preview ? tx('جارٍ الفحص…', 'Checking…') : tx('فحص ومراجعة', 'Check and review')}</button></div>
    {preview && <section className="ca-review" aria-label={tx('مراجعة قبل التفعيل', 'Review before activation')}>
      <h4>{tx('مراجعة قبل التفعيل', 'Review before activation')}</h4>
      {preview.blockers.length > 0 && <ul className="sa-error" role="alert">{preview.blockers.map((b) => <li key={b.code}>{VAT_CODES.test(b.code) ? `${tx('ضريبة القيمة المضافة', 'VAT')}: ` : ''}{msg(b.code)} <span className="sa-muted">({b.code})</span></li>)}</ul>}
      {preview.summary && <>
        <dl className="ca-totals">
          <div><dt>{tx('عدد الحسابات', 'Accounts')}</dt><dd>{preview.summary.line_count}</dd></div>
          <div><dt>{tx('الرصيد النقدي', 'Cash balance')}</dt><dd className="sa-date">{preview.summary.cash_balance}</dd></div>
          <div><dt>{tx('الربح/الخسارة حتى التاريخ', 'Profit/loss to date')}</dt><dd className="sa-date">{preview.summary.profit_or_loss_to_date}</dd></div>
          <div><dt>{tx('الأرباح المبقاة', 'Retained earnings')}</dt><dd className="sa-date">{preview.summary.retained_earnings_balance}</dd></div>
        </dl>
        <p className="sa-muted">{tx('الأثر: يبدأ الترحيل داخل إقفال في اليوم التالي لتاريخ القطع؛ الفترة السابقة مرجع خارجي فقط. فحص ملف الضريبة والفترات تم على الخادم، وأي مانع يظهر أعلاه.', 'Effect: EQFAL posting starts the day after the cutover date; the earlier period is external reference only. The VAT profile and period checks run on the server and any blocker shows above.')}</p>
        {preview.summary.warnings.length > 0 && <ul className="sa-warning">{preview.summary.warnings.map((w) => <li key={w.code}>{label(w.code)}</li>)}</ul>}
      </>}
      {preview.valid && <><label className="sa-check"><input type="checkbox" checked={finalConfirm} onChange={(e) => setFinalConfirm(e.target.checked)} />
        <span>{tx('أؤكد التفعيل النهائي وأفهم أنه لا يمكن التراجع عنه.', 'I give final confirmation to activate and understand it cannot be undone.')}</span></label>
        <div className="sa-actions"><button type="button" className="sa-dark" disabled={busy || !finalConfirm} onClick={() => void activate()}>{busy ? tx('جارٍ التفعيل…', 'Activating…') : tx('تفعيل القطع', 'Activate cutover')}</button></div></>}
    </section>}
  </section>;
}
