import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { formatMoney } from '../money-format';

// G6-1 Zakat preparation worksheet (eligibility, balances, classifications, adjustments, evidence, review).
// It never shows a Zakat payable amount: the final calculation is blocked until the regulatory gates are verified.
type Doc = { id: string; original_filename: string };
type Classification = { account_id: string; account_code: string; account_name: string; statement_category: string; zakat_class: string; reg_article: string | null; evidence_document_id: string | null; note: string | null; status: 'suggested' | 'confirmed' };
type Adjustment = { id: string; description: string; direction: 'add' | 'deduct'; amount: string; reg_article: string; evidence_document_id: string; professional_review_required: boolean };
type Snapshot = { accounts: Array<{ account_id: string; code: string; name: string; statement_category: string; balance_halalas: string }>; book_net_profit: string; as_of: string };
type Worksheet = {
  id: string; revision_no: number; status: string; version: number; revision_reason: string | null; balance_snapshot: Snapshot; classifications: Classification[]; adjustments: Adjustment[];
  ownership_snapshot: { qualified: boolean; reasons: string[]; detail: { partners: Array<{ partner_id: string; name: string; percentage: string; ownership_class: string | null }>; total_percentage: string } } | null;
  blockers: Array<{ code: string; count: number }>; source_drift: boolean; approved_fingerprint: string | null;
};
type Eligibility = { id: string; partner_id: string; partner_name: string; ownership_class: string; effective_from: string; effective_to: string | null; status: string; version: number };
type Data = {
  workpaper: { id: string; tax_path: string } | null; scope_problems: string[]; worksheet: Worksheet | null;
  revisions: Array<{ id: string; revision_no: number; status: string; revision_reason: string | null; approved_fingerprint: string | null }>;
  eligibility: Eligibility[]; ownership_preview: { qualified: boolean; reasons: string[]; detail: { partners: Array<{ partner_id: string; name: string }> } };
  calculation: { status: string; blockers: Array<{ code: string; key: string; article: string; status: string }> };
};
const CLASSES: Record<string, string[]> = {
  equity: ['addition_equity', 'addition_provision_equity', 'addition_partner_loan_equity'],
  non_current_liability: ['addition_non_current_liability', 'addition_provision_non_current_liability', 'addition_provision_equity', 'addition_partner_loan_equity', 'addition_partner_loan_liability'],
  current_liability: ['current_liability', 'addition_provision_equity', 'addition_partner_loan_equity', 'addition_partner_loan_liability'],
  current_asset: ['not_deducted', 'not_deducted_inventory', 'deduction_other_article', 'investment_unsupported'],
  non_current_asset: ['deduction_fixed_assets', 'deduction_intangibles', 'deduction_other_article', 'not_deducted', 'investment_unsupported'],
};
const OWNERSHIP = ['saudi_natural', 'gcc_natural', 'saudi_entity_confirmed', 'gcc_entity_confirmed', 'other'];
const headers = { 'Content-Type': 'application/json' };
const halalasToMoney = (h: string) => { const n = BigInt(h); const abs = n < 0n ? -n : n; return formatMoney(`${n < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`); };

export function ZakatWorksheet({ yearId, canView, canCreate, canEdit, canSubmit, canReview, canApprove, onUnauthorized, onChanged }: {
  yearId: string; canView: boolean; canCreate: boolean; canEdit: boolean; canSubmit: boolean; canReview: boolean; canApprove: boolean; onUnauthorized: () => void; onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [data, setData] = useState<Data | null>(null);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [error, setError] = useState('');
  const [declared, setDeclared] = useState(false);
  const [draft, setDraft] = useState<Record<string, { zakat_class: string; reg_article: string; evidence: string; note: string }>>({});
  const [elig, setElig] = useState({ partner_id: '', ownership_class: 'saudi_natural', effective_from: '', effective_to: '', evidence: '', note: '' });
  const [adj, setAdj] = useState({ description: '', direction: 'add', amount: '', reg_article: '', evidence: '' });

  const base = `/api/zakat-worksheets/${encodeURIComponent(yearId)}`;
  const load = useCallback(async () => {
    if (!canView || !yearId) return;
    const r = await fetch(base);
    if (r.status === 401) { onUnauthorized(); return; }
    if (!r.ok) throw new Error();
    const body = (await r.json()) as Data;
    if (!body || typeof body !== 'object' || !('calculation' in body)) return;
    setData(body);
  }, [base, canView, yearId, onUnauthorized]);
  useEffect(() => { void load().catch(() => setError(t('zakatWorksheet.error'))); }, [load, t]);
  useEffect(() => {
    if (!canView || !yearId) return;
    void fetch('/api/documents').then((r) => (r.ok ? r.json() : null)).then((b: { documents?: Doc[] } | null) => setDocs(Array.isArray(b?.documents) ? b!.documents! : [])).catch(() => setDocs([]));
  }, [canView, yearId]);

  const message = (code?: string, fallback?: string) => (code && t(`zakatWorksheet.errors.${code}`, { defaultValue: '' })) || fallback || t('zakatWorksheet.error');
  const send = async (path: string, method: string, body: object, root = base) => {
    setError('');
    const r = await fetch(`${root}${path}`, { method, headers, body: JSON.stringify(body) });
    if (r.status === 401) { onUnauthorized(); return false; }
    const b = (await r.json().catch(() => ({}))) as { error?: string; code?: string; blockers?: string[] };
    if (!r.ok) {
      const list = (b.blockers ?? []).map((c) => t(`zakatWorksheet.blockers.${c}`, { defaultValue: c })).join('، ');
      setError(`${message(b.code, b.error)}${list ? ` — ${list}` : ''}`);
      return false;
    }
    await load(); onChanged();
    return true;
  };
  if (!canView) return null;
  const ws = data?.worksheet ?? null;
  const editable = canEdit && ws?.status === 'draft';
  const act = (name: string, extra: object = {}) => send(`/${name}`, 'POST', { version: ws!.version, ...extra });
  const docName = (id: string | null) => (id ? docs.find((d) => d.id === id)?.original_filename ?? id.slice(0, 8) : '—');
  const docSelect = (value: string, onChange: (v: string) => void, label: string) => (
    <label>{label}{docs.length ? (
      <select value={value} onChange={(e) => onChange(e.target.value)}><option value="">—</option>{docs.map((d) => <option key={d.id} value={d.id}>{d.original_filename}</option>)}</select>
    ) : <input dir="ltr" value={value} onChange={(e) => onChange(e.target.value)} placeholder={t('zakatWorksheet.documentId')} />}</label>
  );
  const rowDraft = (k: Classification) => draft[k.account_id] ?? { zakat_class: k.zakat_class, reg_article: k.reg_article ?? '', evidence: k.evidence_document_id ?? '', note: k.note ?? '' };
  const setRow = (k: Classification, patch: Partial<ReturnType<typeof rowDraft>>) => setDraft((d) => ({ ...d, [k.account_id]: { ...rowDraft(k), ...patch } }));
  const saveRow = async (k: Classification) => { const r = rowDraft(k); if (await send(`/classifications/${k.account_id}`, 'PUT', { zakat_class: r.zakat_class, reg_article: r.reg_article, evidence_document_id: r.evidence || null, note: r.note || null, version: ws!.version })) setDraft((d) => { const { [k.account_id]: _x, ...rest } = d; return rest; }); };
  const balanceOf = (id: string) => ws?.balance_snapshot.accounts.find((a) => a.account_id === id)?.balance_halalas ?? '0';
  const askReason = async (name: string, key: string) => { const reason = window.prompt(t(key)); if (reason && reason.trim()) await act(name, { reason: reason.trim() }); };
  const label = (group: string, v: string) => t(`zakatWorksheet.${group}.${v}`, { defaultValue: v });

  return (
    <section aria-labelledby="zakat-worksheet-title" className="zakat-worksheet">
      <h2 id="zakat-worksheet-title">{t('zakatWorksheet.title')}</h2>
      <p role="note" className="ac-muted">{t('zakatWorksheet.disclaimer')}</p>
      {error && <p role="alert">{error}</p>}
      {data && <section aria-labelledby="zw-calc"><h3 id="zw-calc">{t('zakatWorksheet.calculation.title')}</h3>
        <p role="status"><strong>{t('zakatWorksheet.calculation.blocked')}</strong> {t('zakatWorksheet.calculation.noAmount')}</p>
        <ul>{data.calculation.blockers.map((b) => <li key={b.code}><bdi>{b.code}</bdi> — {t(`zakatWorksheet.gates.${b.key}`, { defaultValue: b.key })} <bdi dir="ltr">({b.article})</bdi> — {t('zakatWorksheet.calculation.unverified')}</li>)}</ul>
      </section>}
      {data && !ws && <>
        <p>{t('zakatWorksheet.notStarted')}</p>
        {data.scope_problems.length > 0 && <p role="alert">{data.scope_problems.map((c) => t(`zakatWorksheet.blockers.${c}`, { defaultValue: c })).join('، ')}</p>}
        {data.workpaper && data.workpaper.tax_path !== 'zakat' && <p role="alert">{t('zakatWorksheet.blockers.tax_path_not_zakat')}</p>}
        {!data.workpaper && <p role="alert">{t('zakatWorksheet.errors.ZAKAT_WORKPAPER_REQUIRED')}</p>}
        {canCreate && data.workpaper && <><label><input type="checkbox" checked={declared} onChange={(e) => setDeclared(e.target.checked)} /> {t('zakatWorksheet.declaration')}</label>
          <button disabled={!declared} onClick={() => void send('', 'POST', { non_financing_entity_declared: declared })}>{t('zakatWorksheet.create')}</button></>}
      </>}
      {data && <section aria-labelledby="zw-own"><h3 id="zw-own">{t('zakatWorksheet.ownership.title')}</h3>
        {ws?.ownership_snapshot ? <>
          <p role="status">{ws.ownership_snapshot.qualified ? t('zakatWorksheet.ownership.qualified') : t('zakatWorksheet.ownership.notQualified')} — {t('zakatWorksheet.ownership.total')} <bdi dir="ltr">{ws.ownership_snapshot.detail.total_percentage}%</bdi></p>
          {ws.ownership_snapshot.reasons.length > 0 && <ul>{ws.ownership_snapshot.reasons.map((r) => <li key={r}>{t(`zakatWorksheet.blockers.${r}`, { defaultValue: r })}</li>)}</ul>}
          <div className="table-wrap"><table><thead><tr><th>{t('zakatWorksheet.partner')}</th><th>%</th><th>{t('zakatWorksheet.ownership.class')}</th></tr></thead>
            <tbody>{ws.ownership_snapshot.detail.partners.map((p) => <tr key={p.partner_id}><td>{p.name}</td><td dir="ltr">{p.percentage}</td><td>{p.ownership_class ? label('ownershipClasses', p.ownership_class) : t('zakatWorksheet.ownership.unknown')}</td></tr>)}</tbody></table></div>
        </> : <p>{t('zakatWorksheet.ownership.help')}</p>}
        <div className="table-wrap"><table><thead><tr><th>{t('zakatWorksheet.partner')}</th><th>{t('zakatWorksheet.ownership.class')}</th><th>{t('zakatWorksheet.from')}</th><th>{t('zakatWorksheet.to')}</th><th>{t('zakatWorksheet.status')}</th><th>{t('taxWorkpaper.actions')}</th></tr></thead>
          <tbody>{data.eligibility.map((e) => <tr key={e.id}><td>{e.partner_name}</td><td>{label('ownershipClasses', e.ownership_class)}</td><td dir="ltr">{e.effective_from}</td><td dir="ltr">{e.effective_to ?? '—'}</td><td>{label('statuses', e.status)}</td>
            <td>{canReview && e.status === 'active' && <button onClick={() => { const reason = window.prompt(t('zakatWorksheet.reasonPrompt')); if (reason?.trim()) void send(`/${e.id}/revoke`, 'POST', { version: e.version, reason: reason.trim() }, '/api/zakat-eligibility'); }}>{t('zakatWorksheet.revoke')}</button>}</td></tr>)}</tbody></table></div>
        {canReview && <form onSubmit={(ev) => { ev.preventDefault(); void send('', 'POST', { partner_id: elig.partner_id, ownership_class: elig.ownership_class, effective_from: elig.effective_from, effective_to: elig.effective_to || null, evidence_document_id: elig.evidence, ultimate_ownership_note: elig.note || null }, '/api/zakat-eligibility').then((ok) => ok && setElig({ ...elig, evidence: '', note: '' })); }}>
          <h4>{t('zakatWorksheet.ownership.record')}</h4>
          <label>{t('zakatWorksheet.partner')}<select required value={elig.partner_id} onChange={(e) => setElig({ ...elig, partner_id: e.target.value })}><option value="">—</option>{data.ownership_preview.detail.partners.map((p) => <option key={p.partner_id} value={p.partner_id}>{p.name}</option>)}</select></label>
          <label>{t('zakatWorksheet.ownership.class')}<select value={elig.ownership_class} onChange={(e) => setElig({ ...elig, ownership_class: e.target.value })}>{OWNERSHIP.map((c) => <option key={c} value={c}>{label('ownershipClasses', c)}</option>)}</select></label>
          <label>{t('zakatWorksheet.from')}<input required type="date" dir="ltr" value={elig.effective_from} onChange={(e) => setElig({ ...elig, effective_from: e.target.value })} /></label>
          <label>{t('zakatWorksheet.to')}<input type="date" dir="ltr" value={elig.effective_to} onChange={(e) => setElig({ ...elig, effective_to: e.target.value })} /></label>
          {docSelect(elig.evidence, (v) => setElig({ ...elig, evidence: v }), t('zakatWorksheet.evidence'))}
          <label>{t('zakatWorksheet.ownership.note')}<input value={elig.note} onChange={(e) => setElig({ ...elig, note: e.target.value })} /></label>
          <button type="submit" disabled={!elig.partner_id || !elig.effective_from || !elig.evidence}>{t('zakatWorksheet.ownership.recordButton')}</button>
        </form>}
      </section>}
      {ws && <>
        <section aria-labelledby="zw-bal"><h3 id="zw-bal">{t('zakatWorksheet.balances.title')}</h3>
          <p>{t('zakatWorksheet.balances.asOf')} <bdi dir="ltr">{ws.balance_snapshot.as_of}</bdi> — {t('zakatWorksheet.balances.bookProfit')}: <bdi dir="ltr">{formatMoney(ws.balance_snapshot.book_net_profit)}</bdi></p>
          {ws.source_drift && <p role="alert">{t('zakatWorksheet.balances.drift')}</p>}
          {editable && <button onClick={() => void act('refresh')}>{t('zakatWorksheet.refresh')}</button>}
        </section>
        <section aria-labelledby="zw-cls"><h3 id="zw-cls">{t('zakatWorksheet.classifications.title')}</h3>
          <div className="table-wrap"><table><thead><tr><th>{t('zakatWorksheet.account')}</th><th>{t('zakatWorksheet.balances.balance')}</th><th>{t('zakatWorksheet.classifications.class')}</th><th>{t('zakatWorksheet.article')}</th><th>{t('zakatWorksheet.evidence')}</th><th>{t('zakatWorksheet.status')}</th><th>{t('taxWorkpaper.actions')}</th></tr></thead>
            <tbody>{ws.classifications.map((k) => { const r = rowDraft(k); return <tr key={k.account_id}>
              <td><bdi dir="auto">{k.account_code} {k.account_name}</bdi></td><td dir="ltr">{halalasToMoney(balanceOf(k.account_id))}</td>
              <td>{editable ? <select aria-label={t('zakatWorksheet.classifications.class')} value={r.zakat_class} onChange={(e) => setRow(k, { zakat_class: e.target.value })}>{(CLASSES[k.statement_category] ?? [r.zakat_class]).map((c) => <option key={c} value={c}>{label('classes', c)}</option>)}</select> : label('classes', k.zakat_class)}</td>
              <td>{editable ? <input aria-label={t('zakatWorksheet.article')} dir="auto" value={r.reg_article} onChange={(e) => setRow(k, { reg_article: e.target.value })} /> : k.reg_article ?? '—'}</td>
              <td>{editable ? docSelect(r.evidence, (v) => setRow(k, { evidence: v }), '') : docName(k.evidence_document_id)}</td>
              <td><span className={`zw-badge zw-badge--${k.status}`}>{k.status === 'confirmed' ? t('zakatWorksheet.classifications.confirmed') : t('zakatWorksheet.classifications.unconfirmed')}</span></td>
              <td>{editable && <button onClick={() => void saveRow(k)}>{t('zakatWorksheet.save')}</button>} {canReview && ws.status === 'draft' && k.status === 'suggested' && !draft[k.account_id] && <button onClick={() => void act(`classifications/${k.account_id}/confirm`)}>{t('zakatWorksheet.classifications.confirm')}</button>}</td></tr>; })}</tbody></table></div>
        </section>
        <section aria-labelledby="zw-adj"><h3 id="zw-adj">{t('zakatWorksheet.adjustments.title')}</h3>
          <div className="table-wrap"><table><thead><tr><th>{t('taxWorkpaper.description')}</th><th>{t('taxWorkpaper.direction')}</th><th>{t('taxWorkpaper.amount')}</th><th>{t('zakatWorksheet.article')}</th><th>{t('zakatWorksheet.evidence')}</th><th>{t('taxWorkpaper.actions')}</th></tr></thead>
            <tbody>{ws.adjustments.map((a) => <tr key={a.id}><td>{a.description}{a.professional_review_required ? ` — ${t('taxWorkpaper.reviewRequired')}` : ''}</td><td>{t(`taxWorkpaper.directions.${a.direction}`)}</td><td dir="ltr">{formatMoney(a.amount)}</td><td>{a.reg_article}</td><td>{docName(a.evidence_document_id)}</td>
              <td>{editable && <button onClick={() => void send(`/adjustments/${a.id}`, 'DELETE', { version: ws.version })}>{t('taxWorkpaper.remove')}</button>}</td></tr>)}</tbody></table></div>
          {editable && <form onSubmit={(ev) => { ev.preventDefault(); void send('/adjustments', 'POST', { description: adj.description, direction: adj.direction, amount: adj.amount, reg_article: adj.reg_article, evidence_document_id: adj.evidence, version: ws.version }).then((ok) => ok && setAdj({ description: '', direction: 'add', amount: '', reg_article: '', evidence: '' })); }}>
            <label>{t('taxWorkpaper.description')}<input required value={adj.description} onChange={(e) => setAdj({ ...adj, description: e.target.value })} /></label>
            <label>{t('taxWorkpaper.direction')}<select value={adj.direction} onChange={(e) => setAdj({ ...adj, direction: e.target.value })}><option value="add">{t('taxWorkpaper.directions.add')}</option><option value="deduct">{t('taxWorkpaper.directions.deduct')}</option></select></label>
            <label>{t('taxWorkpaper.amount')}<input required dir="ltr" inputMode="decimal" pattern="\d+\.\d{2}" placeholder="0.00" value={adj.amount} onChange={(e) => setAdj({ ...adj, amount: e.target.value })} /></label>
            <label>{t('zakatWorksheet.article')}<input required dir="auto" value={adj.reg_article} onChange={(e) => setAdj({ ...adj, reg_article: e.target.value })} /></label>
            {docSelect(adj.evidence, (v) => setAdj({ ...adj, evidence: v }), t('zakatWorksheet.evidence'))}
            <button type="submit" disabled={!adj.evidence}>{t('taxWorkpaper.add')}</button>
          </form>}
        </section>
        <section aria-labelledby="zw-rev"><h3 id="zw-rev">{t('zakatWorksheet.review.title')}</h3>
          <p>{t('zakatWorksheet.revision')} <bdi dir="ltr">#{ws.revision_no}</bdi> — {label('statuses', ws.status)}</p>
          {ws.blockers.length > 0 && ws.status !== 'approved' && <><p>{t('zakatWorksheet.review.blockers')}</p><ul>{ws.blockers.map((b) => <li key={b.code}>{t(`zakatWorksheet.blockers.${b.code}`, { defaultValue: b.code })} (<bdi dir="ltr">{b.count}</bdi>)</li>)}</ul></>}
          {ws.status === 'approved' && ws.approved_fingerprint && <p>{t('zakatWorksheet.review.fingerprint')}: <bdi dir="ltr">{ws.approved_fingerprint.slice(0, 16)}…</bdi></p>}
          <div className="ac-actions">
            {canSubmit && ws.status === 'draft' && <button onClick={() => void act('submit-review')}>{t('taxWorkpaper.submit')}</button>}
            {canReview && ws.status === 'needs_review' && <button onClick={() => void act('review')}>{t('taxWorkpaper.review')}</button>}
            {canApprove && ws.status === 'reviewed' && <button onClick={() => void act('approve')}>{t('zakatWorksheet.review.approve')}</button>}
            {canEdit && ['needs_review', 'reviewed'].includes(ws.status) && <button onClick={() => void askReason('return-to-draft', 'zakatWorksheet.reasonPrompt')}>{t('zakatWorksheet.review.returnToDraft')}</button>}
            {canCreate && ws.status === 'approved' && <button onClick={() => { const reason = window.prompt(t('zakatWorksheet.review.revisionReason')); if (reason?.trim()) void send('/revisions', 'POST', { version: ws.version, reason: reason.trim() }); }}>{t('zakatWorksheet.review.newRevision')}</button>}
          </div>
          <div className="table-wrap"><table><thead><tr><th>{t('zakatWorksheet.revision')}</th><th>{t('zakatWorksheet.status')}</th><th>{t('zakatWorksheet.review.reason')}</th></tr></thead>
            <tbody>{data!.revisions.map((r) => <tr key={r.id}><td dir="ltr">#{r.revision_no}</td><td>{label('statuses', r.status)}</td><td>{r.revision_reason ?? '—'}</td></tr>)}</tbody></table></div>
        </section>
      </>}
    </section>
  );
}
