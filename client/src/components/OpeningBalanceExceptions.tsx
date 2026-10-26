import { useEffect, useRef, useState } from 'react';
import { Dialog } from './Dialog';
import './OpeningBalanceExceptions.css';

// C4-P2b-2: evidence-exception workflow for the opening balance review. Reads GET /exceptions and /reconciliation; accepts and revokes
// through POST /exceptions and /exceptions/:id/revoke. An accepted exception is NEVER shown as verified: the fixed disclosure wording
// below is used everywhere. Blocked and mismatch findings are listed read-only and can never be accepted. The server remains the authority;
// every rule here is only a convenience that mirrors it.
type Klass = 'incomplete_evidence' | 'mismatch' | 'blocked';
type Status = 'verified' | Klass;
type Detail = Record<string, string>;
type ReconIssue = { code: string; class: Klass; section: string; item_id?: string; detail?: Detail };
type Recon = { status: Status; blocking: boolean; issues: ReconIssue[] };
type ExIssue = ReconIssue & { issue_key: string; evidence_fingerprint: string; acceptable: boolean; acceptance: 'none' | 'accepted_unverified' | 'stale'; exception_id?: string };
type ExRow = { id: string; issue_code: string; section: string; item_id: string | null; reason: string; accepted_by: string; accepted_at: string; status: 'active' | 'superseded' | 'revoked'; acknowledged_difference: string | null; ended_at: string | null; end_reason: string | null };
type Exceptions = { required_count: number; accepted_unverified_count: number; stale_count: number; issues: ExIssue[]; exceptions: ExRow[] };
export type ApprovalGate = { blocked: boolean };
type Props = { yearId: string; reviewStatus: string; canAccept: boolean; lang: 'ar' | 'en'; reloadToken: number; describeItem: (id: string) => string; onUnauthorized: () => void; onGate: (g: ApprovalGate) => void };

const REASON_MIN = 10, REASON_MAX = 1000;
const meaningful = (v: string) => v.length <= REASON_MAX && v.replace(/\s/g, '').length >= REASON_MIN;
const group = (v: string) => { const m = /^(-?)(\d+)(\.\d+)?$/.exec(v); return m ? `${m[1]}${m[2]!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${m[3] ?? ''}` : v; };
const AMOUNT_KEYS = ['expected', 'actual', 'difference', 'gl_total', 'subledger_total', 'amount'];

const TEXT = {
  en: {
    title: 'Evidence review', accepted: 'Accepted — not verified.', status: 'Reconciliation status', loading: 'Loading evidence review…', retry: 'Retry',
    loadError: 'Could not load the evidence review.', none: 'No evidence findings. Nothing needs acceptance.',
    st: { verified: 'Verified', incomplete_evidence: 'Incomplete evidence', mismatch: 'Mismatch', blocked: 'Blocked' },
    stHelp: { verified: 'Every opening balance is supported by matching evidence.', incomplete_evidence: 'Evidence is missing or only an aggregate. Each finding must be accepted with a reason before approval; acceptance does not verify it.', mismatch: 'An amount or side does not match its evidence. Correct the item; it cannot be accepted.', blocked: 'A reference or link is invalid. Correct the item; it cannot be accepted.' },
    counts: (a: number, r: number, s: number) => `${a} of ${r} accepted — not verified · ${s} need re-acceptance`,
    needs: 'Needs acceptance', section: { bank: 'Bank', receivable: 'Receivables', payable: 'Payables' } as Record<string, string>,
    item: 'Affected item', noItem: 'Whole section (no single item)', fixTitle: 'Findings that cannot be accepted — correct them first',
    d: { expected: 'Expected', actual: 'Actual', difference: 'Difference', gl_total: 'Ledger total', subledger_total: 'Sub-ledger total', amount: 'Amount', reference: 'Missing link', bank_currency: 'Bank currency', functional_currency: 'Functional currency', statement_currency: 'Statement currency', expected_side: 'Expected side', actual_side: 'Actual side' } as Record<string, string>,
    refVal: { bank_account_id: 'Bank account', obligation_id: 'Obligation' } as Record<string, string>,
    accept: 'Accept…', reaccept: 'Re-accept…', revoke: 'Revoke…', by: 'Accepted by', at: 'Accepted at', reason: 'Reason', ack: 'Acknowledged difference',
    state: { accepted_unverified: 'Accepted — not verified.', stale: 'Stale — evidence changed after acceptance', none: 'Not accepted' } as Record<string, string>,
    staleHelp: 'The evidence changed after this exception was accepted, so it no longer counts. Review the new figures and accept again, or revoke it.',
    history: 'Ended exceptions', ended: { revoked: 'Revoked', superseded: 'Superseded', active: '' } as Record<string, string>, endedAt: 'Ended at', endReason: 'Reason ended',
    acceptTitle: 'Accept this finding', revokeTitle: 'Revoke this acceptance', reasonLabel: 'Reason (at least 10 characters)', reasonHint: 'Explain why this can be carried into the opening balance without full evidence.',
    revokeHint: 'Explain why the acceptance is withdrawn.', ackLabel: (v: string) => `I acknowledge that the unexplained difference of ${v} stays in the opening balance and is not verified.`,
    notVerified: 'Accepting records your decision and reason. It does not verify the balance, and the item stays "Accepted — not verified".', confirmAccept: 'Accept — not verified', confirmRevoke: 'Revoke acceptance', cancel: 'Cancel', working: 'Saving…',
    gateTitle: 'Final approval is unavailable', gateBlocking: 'Blocked or mismatched findings must be corrected first; they cannot be accepted.', gateMissing: (n: number) => `${n} finding(s) still need an accepted reason.`, gateStale: (n: number) => `${n} accepted exception(s) are stale and must be accepted again.`, gateOk: 'All required findings are accepted. Approval is available to authorized approvers; accepted items remain not verified.',
    gateChecking: 'Evidence is being checked. Approval stays unavailable until the check completes.', gateFailed: 'Evidence could not be verified, so final approval is unavailable. Retry the evidence review.', gateDraft: 'Findings can be accepted only after the review is submitted (in review).', viewOnly: 'You can view these findings but you do not have permission to accept or revoke.', needReviewState: 'Acceptance and revocation are available only while the review is in review.',
    errors: { FORBIDDEN: 'You do not have permission to accept or revoke evidence exceptions.', OB_EXCEPTION_REVIEW_STATE: 'Exceptions can be changed only while the review is in review.', OB_EXCEPTION_REASON_REQUIRED: 'Enter a meaningful reason of at least 10 characters.', OB_EXCEPTION_NOT_ELIGIBLE: 'This finding cannot be accepted.', OB_EXCEPTION_STALE: 'The evidence changed. The list was refreshed; review the new figures.', OB_EXCEPTION_DIFFERENCE_ACK_REQUIRED: 'The displayed difference must be acknowledged.', OB_EXCEPTION_ALREADY_ACTIVE: 'This finding is already accepted.', OB_EXCEPTION_NOT_ACTIVE: 'This exception is no longer active.', OB_EXCEPTION_NOT_FOUND: 'Exception not found.', OB_EXCEPTION_ISSUE_NOT_FOUND: 'This finding no longer exists. The list was refreshed.', FISCAL_YEAR_CLOSED: 'The fiscal year is closed.', generic: 'The change could not be saved.' } as Record<string, string>,
    codes: {
      OB_BANK_AGGREGATE_ONLY: 'Bank balance imported as a single total, with no bank account link', OB_REFERENCE_MISSING: 'Not linked to its bank account or obligation', OB_BANK_EVIDENCE_MISSING: 'No confirmed bank statement balance', OB_BANK_CURRENCY_NOT_COMPARABLE: 'Bank currency differs, so it cannot be compared', OB_FUNCTIONAL_CURRENCY_UNKNOWN: 'Company functional currency is not set',
      OB_CONTROL_ACCOUNT_UNMAPPED: 'No control account is mapped for this section', OB_SUBLEDGER_AGGREGATE_ONLY: 'Receivable/payable imported as a single total, with no obligation link', OB_SUBLEDGER_UNLINKED_OBLIGATION: 'An opening obligation has no matching opening balance item', OB_SUBLEDGER_TOTAL_DIFFERENCE: 'Ledger total differs from the sub-ledger total',
      OB_REFERENCE_INVALID: 'The linked bank account is invalid', OB_BANK_LEDGER_LINK_MISSING: 'The bank account is not linked to a ledger account', OB_BANK_ACCOUNT_GL_MISMATCH: 'The item account differs from the bank account\'s ledger account', OB_BANK_DUPLICATE: 'The same bank account appears more than once', OB_BANK_AMOUNT_MISMATCH: 'Amount differs from the bank statement balance',
      OB_OBLIGATION_INVALID: 'The linked obligation is cancelled or not found', OB_OBLIGATION_NOT_OPENING: 'The linked obligation is not an opening obligation', OB_OBLIGATION_DIRECTION_MISMATCH: 'The obligation direction does not match the section', OB_OBLIGATION_DUPLICATE: 'The same obligation is used more than once', OB_OBLIGATION_AMOUNT_MISMATCH: 'Amount differs from the obligation balance', OB_OBLIGATION_SIDE_MISMATCH: 'Debit/credit side differs from the expected side', OB_COUNTERPARTY_MISMATCH: 'Counterparty differs from the obligation\'s counterparty', OB_CONTROL_ACCOUNT_MISMATCH: 'The item account is not the mapped control account',
    } as Record<string, string>,
  },
  ar: {
    title: 'مراجعة الأدلة', accepted: 'مقبول — غير موثّق.', status: 'حالة المطابقة', loading: 'جارٍ تحميل مراجعة الأدلة…', retry: 'إعادة المحاولة',
    loadError: 'تعذر تحميل مراجعة الأدلة.', none: 'لا توجد ملاحظات على الأدلة. لا شيء يحتاج إلى قبول.',
    st: { verified: 'موثّق', incomplete_evidence: 'أدلة غير مكتملة', mismatch: 'عدم تطابق', blocked: 'محجوب' },
    stHelp: { verified: 'كل رصيد افتتاحي مدعوم بدليل مطابق.', incomplete_evidence: 'الدليل ناقص أو إجمالي فقط. يجب قبول كل ملاحظة مع سبب قبل الاعتماد، والقبول لا يجعلها موثّقة.', mismatch: 'مبلغ أو جانب لا يطابق دليله. صحّح البند؛ ولا يمكن قبول هذه الملاحظة.', blocked: 'مرجع أو ربط غير صالح. صحّح البند؛ ولا يمكن قبول هذه الملاحظة.' },
    counts: (a: number, r: number, s: number) => `${a} من ${r} مقبول — غير موثّق · ${s} تحتاج إلى قبول جديد`,
    needs: 'تحتاج إلى قبول', section: { bank: 'البنوك', receivable: 'الذمم المدينة', payable: 'الذمم الدائنة' } as Record<string, string>,
    item: 'البند المتأثر', noItem: 'القسم كله (لا يوجد بند محدد)', fixTitle: 'ملاحظات لا يمكن قبولها — صحّحها أولاً',
    d: { expected: 'المتوقع', actual: 'الفعلي', difference: 'الفرق', gl_total: 'إجمالي الدفتر', subledger_total: 'إجمالي الحسابات الفرعية', amount: 'المبلغ', reference: 'الربط الناقص', bank_currency: 'عملة البنك', functional_currency: 'العملة الوظيفية', statement_currency: 'عملة الكشف', expected_side: 'الجانب المتوقع', actual_side: 'الجانب الفعلي' } as Record<string, string>,
    refVal: { bank_account_id: 'الحساب البنكي', obligation_id: 'الالتزام' } as Record<string, string>,
    accept: 'قبول…', reaccept: 'قبول مجدداً…', revoke: 'سحب القبول…', by: 'قبله', at: 'وقت القبول', reason: 'السبب', ack: 'الفرق المُقرّ به',
    state: { accepted_unverified: 'مقبول — غير موثّق.', stale: 'قديم — تغيّر الدليل بعد القبول', none: 'غير مقبول' } as Record<string, string>,
    staleHelp: 'تغيّر الدليل بعد قبول هذا الاستثناء فلم يعد معتدّاً به. راجع الأرقام الجديدة ثم اقبله مجدداً أو اسحبه.',
    history: 'استثناءات منتهية', ended: { revoked: 'مسحوب', superseded: 'مستبدل', active: '' } as Record<string, string>, endedAt: 'وقت الانتهاء', endReason: 'سبب الانتهاء',
    acceptTitle: 'قبول هذه الملاحظة', revokeTitle: 'سحب هذا القبول', reasonLabel: 'السبب (10 أحرف على الأقل)', reasonHint: 'اشرح لماذا يمكن ترحيل هذا الرصيد إلى الأرصدة الافتتاحية دون دليل كامل.',
    revokeHint: 'اشرح سبب سحب القبول.', ackLabel: (v: string) => `أُقرّ بأن الفرق غير المبرَّر البالغ ${v} يبقى ضمن الرصيد الافتتاحي وأنه غير موثّق.`,
    notVerified: 'القبول يسجّل قرارك وسببك فقط. لا يوثّق الرصيد، ويبقى البند «مقبول — غير موثّق».', confirmAccept: 'قبول — غير موثّق', confirmRevoke: 'سحب القبول', cancel: 'إلغاء', working: 'جارٍ الحفظ…',
    gateTitle: 'الاعتماد النهائي غير متاح', gateBlocking: 'يجب تصحيح الملاحظات المحجوبة أو غير المتطابقة أولاً؛ ولا يمكن قبولها.', gateMissing: (n: number) => `${n} ملاحظة ما زالت تحتاج إلى قبول مع سبب.`, gateStale: (n: number) => `${n} استثناء مقبول أصبح قديماً ويجب قبوله مجدداً.`, gateOk: 'كل الملاحظات المطلوبة مقبولة. الاعتماد متاح للمعتمدين المخوّلين، وتبقى البنود المقبولة غير موثّقة.',
    gateChecking: 'جارٍ فحص الأدلة. يبقى الاعتماد غير متاح حتى يكتمل الفحص.', gateFailed: 'تعذر التحقق من الأدلة، لذا الاعتماد النهائي غير متاح. أعد محاولة مراجعة الأدلة.', gateDraft: 'يمكن قبول الملاحظات فقط بعد إرسال المراجعة (قيد المراجعة).', viewOnly: 'يمكنك عرض هذه الملاحظات، لكن ليست لديك صلاحية القبول أو السحب.', needReviewState: 'القبول والسحب متاحان فقط أثناء حالة «قيد المراجعة».',
    errors: { FORBIDDEN: 'ليست لديك صلاحية قبول استثناءات الأدلة أو سحبها.', OB_EXCEPTION_REVIEW_STATE: 'يمكن تغيير الاستثناءات فقط أثناء حالة «قيد المراجعة».', OB_EXCEPTION_REASON_REQUIRED: 'أدخل سبباً واضحاً من 10 أحرف على الأقل.', OB_EXCEPTION_NOT_ELIGIBLE: 'لا يمكن قبول هذه الملاحظة.', OB_EXCEPTION_STALE: 'تغيّر الدليل. تم تحديث القائمة؛ راجع الأرقام الجديدة.', OB_EXCEPTION_DIFFERENCE_ACK_REQUIRED: 'يجب الإقرار بالفرق المعروض.', OB_EXCEPTION_ALREADY_ACTIVE: 'هذه الملاحظة مقبولة بالفعل.', OB_EXCEPTION_NOT_ACTIVE: 'هذا الاستثناء لم يعد فعّالاً.', OB_EXCEPTION_NOT_FOUND: 'الاستثناء غير موجود.', OB_EXCEPTION_ISSUE_NOT_FOUND: 'لم تعد هذه الملاحظة موجودة. تم تحديث القائمة.', FISCAL_YEAR_CLOSED: 'السنة المالية مغلقة.', generic: 'تعذر حفظ التغيير.' } as Record<string, string>,
    codes: {
      OB_BANK_AGGREGATE_ONLY: 'رصيد البنك مستورد كإجمالي واحد دون ربط بحساب بنكي', OB_REFERENCE_MISSING: 'غير مرتبط بحسابه البنكي أو بالتزامه', OB_BANK_EVIDENCE_MISSING: 'لا يوجد رصيد كشف بنكي مؤكد', OB_BANK_CURRENCY_NOT_COMPARABLE: 'عملة البنك مختلفة فلا يمكن المقارنة', OB_FUNCTIONAL_CURRENCY_UNKNOWN: 'العملة الوظيفية للشركة غير محددة',
      OB_CONTROL_ACCOUNT_UNMAPPED: 'لا يوجد حساب رقابة مربوط بهذا القسم', OB_SUBLEDGER_AGGREGATE_ONLY: 'الذمم مستوردة كإجمالي واحد دون ربط بالتزام', OB_SUBLEDGER_UNLINKED_OBLIGATION: 'يوجد التزام افتتاحي بلا بند رصيد افتتاحي مقابل', OB_SUBLEDGER_TOTAL_DIFFERENCE: 'إجمالي الدفتر يختلف عن إجمالي الحسابات الفرعية',
      OB_REFERENCE_INVALID: 'الحساب البنكي المرتبط غير صالح', OB_BANK_LEDGER_LINK_MISSING: 'الحساب البنكي غير مرتبط بحساب في دليل الحسابات', OB_BANK_ACCOUNT_GL_MISMATCH: 'حساب البند يختلف عن حساب الدفتر للحساب البنكي', OB_BANK_DUPLICATE: 'نفس الحساب البنكي مكرر', OB_BANK_AMOUNT_MISMATCH: 'المبلغ يختلف عن رصيد الكشف البنكي',
      OB_OBLIGATION_INVALID: 'الالتزام المرتبط ملغى أو غير موجود', OB_OBLIGATION_NOT_OPENING: 'الالتزام المرتبط ليس التزاماً افتتاحياً', OB_OBLIGATION_DIRECTION_MISMATCH: 'اتجاه الالتزام لا يطابق القسم', OB_OBLIGATION_DUPLICATE: 'نفس الالتزام مستخدم أكثر من مرة', OB_OBLIGATION_AMOUNT_MISMATCH: 'المبلغ يختلف عن رصيد الالتزام', OB_OBLIGATION_SIDE_MISMATCH: 'جانب المدين/الدائن يختلف عن الجانب المتوقع', OB_COUNTERPARTY_MISMATCH: 'الطرف المقابل يختلف عن طرف الالتزام', OB_CONTROL_ACCOUNT_MISMATCH: 'حساب البند ليس حساب الرقابة المربوط',
    } as Record<string, string>,
  },
} as const;

class ApiErr extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
async function call(url: string, init: RequestInit, onUnauthorized: () => void) {
  const r = await fetch(url, { credentials: 'same-origin', ...init });
  if (r.status === 401) { onUnauthorized(); throw new ApiErr(401, 'UNAUTHORIZED'); }
  if (!r.ok) { let code = ''; try { code = ((await r.json()) as { code?: string }).code ?? ''; } catch { /* body is optional */ } throw new ApiErr(r.status, code || (r.status === 403 ? 'FORBIDDEN' : 'generic')); }
  return r.json();
}
const when = (v: string) => v.slice(0, 16).replace('T', ' ');

export function OpeningBalanceExceptions({ yearId, reviewStatus, canAccept, lang, reloadToken, describeItem, onUnauthorized, onGate }: Props) {
  const t = TEXT[lang];
  const [recon, setRecon] = useState<Recon | null>(null);
  const [ex, setEx] = useState<Exceptions | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [dialog, setDialog] = useState<{ kind: 'accept'; issue: ExIssue } | { kind: 'revoke'; row: ExRow } | null>(null);
  const [reason, setReason] = useState('');
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [validatedKey, setValidatedKey] = useState<string | null>(null);
  const request = useRef(0);
  const key = `${yearId}|${reviewStatus}|${reloadToken}`;
  const base = `/api/opening-balances/${yearId}`;

  const load = async () => {
    const mine = ++request.current;
    const key = `${yearId}|${reviewStatus}|${reloadToken}`;
    setLoading(true); setFailed(false); setValidatedKey(null);
    try {
      const [r, e] = await Promise.all([call(`${base}/reconciliation`, {}, onUnauthorized), call(`${base}/exceptions`, {}, onUnauthorized)]);
      if (mine !== request.current) return;
      if (!Array.isArray((r as Recon)?.issues) || !Array.isArray((e as Exceptions)?.issues) || !Array.isArray((e as Exceptions)?.exceptions)) throw new ApiErr(200, 'generic');
      setRecon(r as Recon); setEx(e as Exceptions); setValidatedKey(key);
    } catch (err) {
      if (mine === request.current && !(err instanceof ApiErr && err.status === 401)) { setFailed(true); setRecon(null); setEx(null); }
    } finally { if (mine === request.current) setLoading(false); }
  };
  // Reload on year, review-status or parent-refresh changes; company switches remount the whole page.
  useEffect(() => { void load(); return () => { request.current++; }; /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [yearId, reviewStatus, reloadToken]);

  const inReview = reviewStatus === 'in_review';
  const missing = ex ? ex.issues.filter(i => i.acceptance === 'none').length : 0;
  const stale = ex ? ex.issues.filter(i => i.acceptance === 'stale').length : 0;
  const blocking = recon?.blocking ?? false;
  // Fail closed: approval stays blocked until a response for exactly this year, review status and refresh has been validated.
  const gateBlocked = loading || failed || !ex || !recon || validatedKey !== key || blocking || missing > 0 || stale > 0;
  useEffect(() => { onGate({ blocked: gateBlocked }); }, [gateBlocked]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onGate({ blocked: true }), []); // eslint-disable-line react-hooks/exhaustive-deps

  const closeDialog = () => { if (busy) return; setDialog(null); setReason(''); setAck(false); setDialogError(null); };
  const open = (d: NonNullable<typeof dialog>) => { setReason(''); setAck(false); setDialogError(null); setDialog(d); };
  const difference = (i: ExIssue) => i.detail?.difference ?? '';
  const needsAck = dialog?.kind === 'accept' && dialog.issue.code === 'OB_SUBLEDGER_TOTAL_DIFFERENCE';
  const valid = dialog !== null && meaningful(reason) && (!needsAck || (ack && difference(dialog.issue) !== ''));

  const submit = async () => {
    if (!dialog || !valid) return;
    setBusy(true); setDialogError(null);
    try {
      if (dialog.kind === 'accept') {
        const i = dialog.issue;
        await call(`${base}/exceptions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify([{ issue_key: i.issue_key, evidence_fingerprint: i.evidence_fingerprint, reason: reason.trim(), ...(needsAck ? { acknowledged_difference: difference(i) } : {}) }]) }, onUnauthorized);
      } else {
        await call(`${base}/exceptions/${dialog.row.id}/revoke`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: reason.trim() }) }, onUnauthorized);
      }
      setBusy(false); setDialog(null); setReason(''); setAck(false);
      await load();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiErr && err.status === 401) return;
      const code = err instanceof ApiErr ? err.code : 'generic';
      setDialogError(t.errors[code] ?? t.errors.generic!);
      if (err instanceof ApiErr && [409, 404].includes(err.status)) void load();
    }
  };

  const detailRows = (d?: Detail) => Object.entries(d ?? {}).filter(([k]) => t.d[k]).map(([k, v]) => {
    const text = k === 'reference' ? (t.refVal[v] ?? v) : AMOUNT_KEYS.includes(k) ? group(v) : v;
    return <div key={k}><dt>{t.d[k]}</dt><dd><bdi dir="ltr" className={AMOUNT_KEYS.includes(k) ? 'ob-amount' : undefined}>{text}</bdi></dd></div>;
  });
  const itemLine = (id?: string | null) => id ? describeItem(id) : t.noItem;
  const codeText = (c: string) => t.codes[c] ?? c;

  if (loading && !ex && !recon) return <section className="ob-card ob-ex" aria-busy="true"><p className="ob-muted" role="status">{t.loading}</p></section>;
  if (failed) return <section className="ob-card ob-ex"><h3>{t.title}</h3><p role="alert">{t.loadError}</p>{inReview && <p role="status"><strong>{t.gateTitle}</strong> {t.gateFailed}</p>}<button type="button" onClick={() => void load()}>{t.retry}</button></section>;
  if (!recon || !ex) return null;

  const status = recon.status;
  const unfixable = recon.issues.filter(i => i.class !== 'incomplete_evidence');
  const active = new Map(ex.exceptions.filter(e => e.status === 'active').map(e => [e.id, e]));
  const ended = ex.exceptions.filter(e => e.status !== 'active');
  const canAct = canAccept && inReview;
  const tone = status === 'verified' ? 'ok' : status === 'incomplete_evidence' ? 'warn' : 'bad';

  return <section className="ob-card ob-ex" aria-labelledby="ob-ex-title">
    <div className="ob-ex__head"><h3 id="ob-ex-title">{t.title}</h3><span className="ob-muted">{t.status}</span><span className={`ob-badge ob-badge--${tone}`}>{t.st[status]}</span></div>
    <p className="ob-muted">{t.stHelp[status]}</p>
    {ex.required_count > 0 && <p className="ob-ex__counts"><strong>{t.counts(ex.accepted_unverified_count, ex.required_count, ex.stale_count)}</strong></p>}
    {ex.required_count === 0 && unfixable.length === 0 && <p>{t.none}</p>}
    {!canAccept && (ex.required_count > 0) && <p className="ob-muted">{t.viewOnly}</p>}
    {canAccept && !inReview && ex.required_count > 0 && <p className="ob-muted">{reviewStatus === 'draft' ? t.gateDraft : t.needReviewState}</p>}

    {unfixable.length > 0 && <div className="ob-ex__fix" role="group" aria-label={t.fixTitle}>
      <h4>{t.fixTitle}</h4>
      <ul>{unfixable.map((i, n) => <li key={`${i.code}-${i.item_id ?? n}`}>
        <div className="ob-ex__row"><span className={`ob-badge ob-badge--${i.class === 'blocked' ? 'bad' : 'warn'}`}>{t.st[i.class]}</span><strong>{codeText(i.code)}</strong></div>
        <p className="ob-muted">{t.section[i.section] ?? i.section} · {t.item}: {itemLine(i.item_id)}</p>
        <dl className="ob-ex__detail">{detailRows(i.detail)}</dl>
      </li>)}</ul>
    </div>}

    {ex.issues.length > 0 && <ul className="ob-ex__list">{ex.issues.map(i => {
      const row = i.exception_id ? active.get(i.exception_id) : undefined;
      return <li key={i.issue_key} className={`ob-ex__issue ob-ex__issue--${i.acceptance}`}>
        <div className="ob-ex__row"><span className={`ob-badge ob-badge--${i.acceptance === 'accepted_unverified' ? 'neutral' : 'warn'}`}>{t.state[i.acceptance]}</span><strong>{codeText(i.code)}</strong></div>
        <p className="ob-muted">{t.section[i.section] ?? i.section} · {t.item}: {itemLine(i.item_id)}</p>
        <dl className="ob-ex__detail">{detailRows(i.detail)}</dl>
        {i.acceptance === 'stale' && <p className="ob-ex__stale" role="note">{t.staleHelp}</p>}
        {row && <dl className="ob-ex__detail ob-ex__audit">
          <div><dt>{t.by}</dt><dd><bdi dir="ltr">{row.accepted_by}</bdi></dd></div>
          <div><dt>{t.at}</dt><dd><bdi dir="ltr">{when(row.accepted_at)}</bdi></dd></div>
          {row.acknowledged_difference && <div><dt>{t.ack}</dt><dd><bdi dir="ltr" className="ob-amount">{group(row.acknowledged_difference)}</bdi></dd></div>}
          <div className="ob-ex__reason"><dt>{t.reason}</dt><dd>{row.reason}</dd></div>
        </dl>}
        {canAct && i.acceptable && <div className="ob-ex__actions">
          {i.acceptance !== 'accepted_unverified' && <button type="button" className="primary" onClick={() => open({ kind: 'accept', issue: i })}>{i.acceptance === 'stale' ? t.reaccept : t.accept}</button>}
          {row && <button type="button" onClick={() => open({ kind: 'revoke', row })}>{t.revoke}</button>}
        </div>}
      </li>;
    })}</ul>}

    {ended.length > 0 && <details className="ob-ex__history"><summary>{t.history} (<bdi dir="ltr">{ended.length}</bdi>)</summary>
      <ul>{ended.map(e => <li key={e.id}>
        <div className="ob-ex__row"><span className="ob-badge ob-badge--neutral">{t.ended[e.status]}</span><strong>{codeText(e.issue_code)}</strong></div>
        <p className="ob-muted">{t.section[e.section] ?? e.section} · {t.item}: {itemLine(e.item_id)}</p>
        <dl className="ob-ex__detail ob-ex__audit">
          <div><dt>{t.by}</dt><dd><bdi dir="ltr">{e.accepted_by}</bdi></dd></div><div><dt>{t.at}</dt><dd><bdi dir="ltr">{when(e.accepted_at)}</bdi></dd></div>
          <div className="ob-ex__reason"><dt>{t.reason}</dt><dd>{e.reason}</dd></div>
          {e.ended_at && <div><dt>{t.endedAt}</dt><dd><bdi dir="ltr">{when(e.ended_at)}</bdi></dd></div>}
          {e.end_reason && <div className="ob-ex__reason"><dt>{t.endReason}</dt><dd>{e.end_reason}</dd></div>}
        </dl>
      </li>)}</ul></details>}

    {inReview && <div className={`ob-ex__gate ob-ex__gate--${gateBlocked ? 'blocked' : 'ok'}`} role="status">
      {gateBlocked ? <><strong>{t.gateTitle}</strong><ul>
        {(loading || validatedKey !== key) && <li>{t.gateChecking}</li>}{blocking && <li>{t.gateBlocking}</li>}{missing > 0 && <li>{t.gateMissing(missing)}</li>}{stale > 0 && <li>{t.gateStale(stale)}</li>}
      </ul></> : <span>{t.gateOk}</span>}
    </div>}

    {dialog && <Dialog title={dialog.kind === 'accept' ? t.acceptTitle : t.revokeTitle} busy={busy} onClose={closeDialog} className="ob-ex__dialog">
      <div className="ob-ex__dialog-body">
        <p><strong>{codeText(dialog.kind === 'accept' ? dialog.issue.code : dialog.row.issue_code)}</strong></p>
        {dialog.kind === 'accept' && <dl className="ob-ex__detail">{detailRows(dialog.issue.detail)}</dl>}
        <p className="ob-muted">{t.item}: {itemLine(dialog.kind === 'accept' ? dialog.issue.item_id : dialog.row.item_id)}</p>
        {dialog.kind === 'accept' && <p className="ob-ex__disclosure" role="note">{t.notVerified}</p>}
        <label htmlFor="ob-ex-reason">{t.reasonLabel}</label>
        <textarea id="ob-ex-reason" value={reason} maxLength={REASON_MAX} rows={4} aria-describedby="ob-ex-reason-hint" aria-invalid={reason !== '' && !meaningful(reason)} onChange={e => setReason(e.target.value)} />
        <p id="ob-ex-reason-hint" className="ob-muted">{dialog.kind === 'accept' ? t.reasonHint : t.revokeHint}</p>
        {needsAck && dialog.kind === 'accept' && <label className="ob-ex__ack"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} /><span>{t.ackLabel(group(difference(dialog.issue)))}</span></label>}
        {dialogError && <p role="alert" className="ob-ex__error">{dialogError}</p>}
      </div>
      <div className="modal-actions">
        <button type="button" onClick={closeDialog} disabled={busy}>{t.cancel}</button>
        <button type="button" className="primary" disabled={!valid || busy} onClick={() => void submit()}>{busy ? t.working : dialog.kind === 'accept' ? t.confirmAccept : t.confirmRevoke}</button>
      </div>
    </Dialog>}
  </section>;
}
