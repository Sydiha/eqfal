import { FormEvent, useEffect, useState } from 'react';

type CashItem = { item_id: string; evidence_reference: string | null; document_id: string | null; document_filename: string | null; document_accessible: boolean; status: 'pending_verification' | 'reviewer_verified' | 'rejected' | 'conflicting' | 'stale'; issue: { issue_key: string; evidence_fingerprint: string } | null; latest: { reviewed_by: string; reviewed_at: string; rationale: string; decision: string } | null };
type Props = { yearId: string; reloadToken: number; reviewStatus: string; canVerify: boolean; lang: 'ar' | 'en'; describeItem: (id: string) => string; onChanged: () => void };
const words = {
  ar: { title: 'مراجعة أدلة النقد في الصندوق', pending_verification: 'بانتظار مراجعة المستند', reviewer_verified: 'تحقق بشري من المستند', rejected: 'مرفوض', conflicting: 'دليل متعارض', stale: 'تحقق قديم — تغير المستند أو البند', reference: 'مرجع محضر الجرد', rationale: 'سبب القرار (10 أحرف على الأقل)', reviewer: 'المراجع', date: 'وقت القرار', verified: 'تحققت من المستند والجرد', reject: 'رفض الدليل', conflict: 'تعارض الدليل', save: 'حفظ القرار', error: 'تعذر تحميل أو حفظ قرار التحقق.', empty: 'لا توجد بنود نقد في الصندوق.', open: 'فتح محضر الجرد لفحصه', referenceOnly: 'المرجع النصي وحده غير كافٍ للتحقق. يمكن قبول الدليل غير المتحقق عبر مسار الاستثناءات.', human: 'هذا قرار مراجعة بشرية للمستند والجرد، وليس إثباتاً آلياً لأصالة المستند.', choose: 'اختر قرار المراجعة' },
  en: { title: 'Physical cash evidence review', pending_verification: 'Pending document review', reviewer_verified: 'Human reviewer verified', rejected: 'Rejected', conflicting: 'Conflicting evidence', stale: 'Stale verification — item or document changed', reference: 'Physical count record reference', rationale: 'Decision rationale (at least 10 characters)', reviewer: 'Reviewer', date: 'Decision time', verified: 'I reviewed the document and count', reject: 'Reject evidence', conflict: 'Conflicting evidence', save: 'Save decision', error: 'Could not load or save the verification decision.', empty: 'No physical cash items.', open: 'Open count document for inspection', referenceOnly: 'A typed reference alone cannot be verified. The unverified exception path remains available.', human: 'This is a human review of the document and count, not automatic proof of document authenticity.', choose: 'Choose review decision' },
};
export function OpeningCashVerification({ yearId, reloadToken, reviewStatus, canVerify, lang, describeItem, onChanged }: Props) {
  const [items, setItems] = useState<CashItem[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const w = words[lang];
  const load = async () => { try { const r = await fetch(`/api/opening-balances/${yearId}/cash-verifications`, { credentials: 'same-origin' }); if (!r.ok) throw new Error(); const body = await r.json() as { items?: CashItem[] }; if (!Array.isArray(body.items)) throw new Error(); setItems(body.items); setError(''); } catch { setError(w.error); } };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [yearId, reloadToken]);
  const submit = async (event: FormEvent<HTMLFormElement>, item: CashItem) => {
    event.preventDefault(); if (!item.issue || !item.evidence_reference) return;
    const form = event.currentTarget; const data = new FormData(form); setBusy(true); setError('');
    try {
      const r = await fetch(`/api/opening-balances/${yearId}/cash-verifications/${item.item_id}`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ issue_key: item.issue.issue_key, evidence_fingerprint: item.issue.evidence_fingerprint, evidence_reference: item.evidence_reference, decision: data.get('decision'), rationale: data.get('rationale') }) });
      if (!r.ok) throw new Error(); await load(); onChanged();
    } catch { setError(w.error); await load(); } finally { setBusy(false); }
  };
  if (!items.length && !error) return null;
  return <section dir={lang === 'ar' ? 'rtl' : 'ltr'} aria-label={w.title}>
    <h3>{w.title}</h3>{error && <p role="alert">{error}</p>}
    {!items.length && <p>{w.empty}</p>}
    {items.map(item => <article key={item.item_id} className="ob-card">
      <h4>{describeItem(item.item_id)}</h4><p>{w[item.status]}</p><p>{w.human}</p>
      <p>{w.reference}: <bdi dir="auto">{item.evidence_reference ?? '—'}</bdi></p>
      {item.document_accessible && item.document_id ? <p><a href={`/api/documents/${item.document_id}/file`} target="_blank" rel="noopener noreferrer">{w.open}: <bdi dir="auto">{item.document_filename}</bdi></a></p> : <p>{w.referenceOnly}</p>}
      {item.latest && <p>{w.reviewer}: <bdi dir="ltr">{item.latest.reviewed_by}</bdi> · {w.date}: <time dateTime={item.latest.reviewed_at}>{new Date(item.latest.reviewed_at).toLocaleString(lang)}</time> · {item.latest.rationale}</p>}
      {canVerify && reviewStatus === 'in_review' && item.issue && item.evidence_reference && <form onSubmit={e => void submit(e, item)}>
        <label>{w.rationale}<textarea name="rationale" required minLength={10} maxLength={1000}/></label>
        <select name="decision" aria-label={w.title} required defaultValue=""><option value="" disabled>{w.choose}</option>{item.document_accessible && item.document_id && <option value="verified">{w.verified}</option>}<option value="rejected">{w.reject}</option><option value="conflicting">{w.conflict}</option></select>
        <button type="submit" disabled={busy}>{w.save}</button>
      </form>}
    </article>)}
  </section>;
}
