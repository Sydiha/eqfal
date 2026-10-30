import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import './ZakatWorksheet.css';

// G6-1 preparation workflow inside the existing TaxWorkpaper page. It never shows a Zakat payable amount: the calculation is withheld
// until the regulatory gates are verified by the company's qualified accountant.
type Account = { account_id: string; code: string; name: string; name_ar: string | null; statement_category: string; amount_cents: string };
type Classification = { id: string; account_id: string; zakat_type: string; reg_article: string; evidence_document_id: string | null; note: string | null };
type Adjustment = { id: string; description: string; direction: 'add' | 'deduct'; amount: string; reg_article: string; evidence_document_id: string | null; evidence_note: string | null; version: number };
type Eligibility = { id: string; partner_id: string; partner_name: string; ownership_class: string; effective_from: string; effective_to: string | null; evidence_document_id: string; verification_status: string; entity_ultimate_ownership_note: string | null; version: number };
type Gate = { code: string; title: string; blocks_approval: boolean; status: string; article_ref: string };
type OwnershipPartner = { partner_id: string; name: string; ownership_bps4: string; eligibility: null | { ownership_class: string; evidence_document_id: string } };
type Data = {
  scope: { unsupported_reason: string | null; fiscal_year: { start_date: string; end_date: string } };
  worksheet: null | { id: string; revision_no: number; status: string; version: number; revision_reason: string | null; non_financing_confirmed: boolean; accounting_records_confirmed: boolean; snapshot_captured_at: string | null; balances_snapshot: { as_of_date: string; accounts: Account[] } | null };
  revisions: { id: string; revision_no: number; status: string; revision_reason: string | null; approved_at: string | null }[];
  classifications: Classification[]; adjustments: Adjustment[]; eligibility: Eligibility[];
  ownership_live: { qualified: boolean; blockers: string[]; as_of_date: string; total_ownership_bps4: string; partners: OwnershipPartner[] };
  gates: Gate[];
  readiness: { preparation_blockers: string[]; gate_blockers: string[]; unclassified_account_count: number; can_submit: boolean; can_approve: boolean };
};
export type ZakatWorksheetProps = {
  yearId: string; canCreate: boolean; canEdit: boolean; canCreateAdjustment: boolean; canEditAdjustment: boolean; canDeleteAdjustment: boolean;
  canSubmit: boolean; canReview: boolean; canApprove: boolean; canCreateOwnership?: boolean; canConfirmOwnership?: boolean; canEditOwnership?: boolean; canViewDocuments?: boolean;
  onUnauthorized: () => void; onChanged?: () => void;
};

const headers = { 'Content-Type': 'application/json' };
const TYPES = ['equity_capital', 'equity_reserve', 'retained_earnings', 'carried_forward_loss', 'treasury_shares', 'provision_equity_like', 'provision_eosb_leave', 'partner_loan_credit_liability', 'partner_loan_credit_equity', 'non_current_liability', 'current_liability', 'deductible_fixed_asset', 'deductible_intangible', 'deductible_spare_or_raw_material', 'statutory_deposit', 'deferred_tax_asset', 'deductible_investment', 'non_deductible_asset', 'other_manual'];
const CLASSES = ['saudi_natural', 'gcc_natural', 'saudi_entity', 'gcc_entity', 'other', 'unknown'];
const CLASSIFIABLE = ['current_asset', 'non_current_asset', 'current_liability', 'non_current_liability', 'equity'];

export function ZakatWorksheet(p: ZakatWorksheetProps) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Data | null>(null);
  const [documents, setDocuments] = useState<{ id: string; original_filename: string }[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState('');
  const [entityClass, setEntityClass] = useState('saudi_natural');

  const money = (cents: string) => (Number(BigInt(cents)) / 100).toLocaleString(ar ? 'ar-SA' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (bps4: string) => (Number(bps4) / 10000).toLocaleString(ar ? 'ar-SA' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const blockerLabel = (code: string) => t(`zakatWorksheet.blockers.${code}`, { defaultValue: code });

  const load = useCallback(async () => {
    const r = await fetch(`/api/zakat-worksheets/${encodeURIComponent(p.yearId)}`);
    if (r.status === 401) { p.onUnauthorized(); return; }
    if (!r.ok) throw new Error();
    setData((await r.json()) as Data);
  }, [p.yearId]);
  useEffect(() => {
    if (!open || !p.yearId) return;
    void load().catch(() => setError(t('zakatWorksheet.error')));
    if (p.canViewDocuments) {
      void fetch('/api/documents').then(async (r) => { if (r.ok) setDocuments(((await r.json()) as { documents: { id: string; original_filename: string }[] }).documents); }).catch(() => undefined);
    }
  }, [open, p.yearId, p.canViewDocuments]);

  const call = async (path: string, method: string, body?: object) => {
    setBusy(true); setError('');
    try {
      const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
      if (r.status === 401) { p.onUnauthorized(); return false; }
      if (!r.ok) { const j = (await r.json().catch(() => ({}))) as { error?: string; code?: string }; setError(j.code ? t(`zakatWorksheet.errors.${j.code}`, { defaultValue: j.error ?? t('zakatWorksheet.error') }) : (j.error ?? t('zakatWorksheet.error'))); return false; }
      await load(); p.onChanged?.(); return true;
    } finally { setBusy(false); }
  };
  const ws = (path: string, method: string, body?: object) => call(`/api/zakat-worksheets/${encodeURIComponent(p.yearId)}${path}`, method, body);

  const docSelect = (name: string, required = false, defaultValue = '') => (
    p.canViewDocuments
      ? <select name={name} defaultValue={defaultValue} required={required} aria-label={t('zakatWorksheet.evidenceDoc')}><option value="">{t('zakatWorksheet.selectDoc')}</option>{documents.map((d) => <option key={d.id} value={d.id}>{d.original_filename}</option>)}</select>
      : <span className="zw-muted">{t('zakatWorksheet.noDocPermission')}</span>
  );
  const val = (f: FormData, k: string) => { const v = f.get(k); return typeof v === 'string' && v.trim() ? v.trim() : null; };

  const toggle = (
    <button type="button" className="ac-btn" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
      {open ? t('zakatWorksheet.hide') : t('zakatWorksheet.show')}
    </button>
  );
  if (!open) return <section className="zw" aria-labelledby="zw-title"><h3 id="zw-title">{t('zakatWorksheet.title')}</h3><p className="zw-muted">{t('zakatWorksheet.intro')}</p>{toggle}</section>;
  if (!data) return <section className="zw" aria-labelledby="zw-title"><h3 id="zw-title">{t('zakatWorksheet.title')}</h3>{toggle}{error ? <p role="alert">{error}</p> : <p>{t('zakatWorksheet.loading')}</p>}</section>;

  const w = data.worksheet;
  const draft = w?.status === 'draft';
  const classByAccount = new Map(data.classifications.map((c) => [c.account_id, c]));
  const accounts = (w?.balances_snapshot?.accounts ?? []).filter((a) => CLASSIFIABLE.includes(a.statement_category));
  const r = data.readiness;

  const addEligibility = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    if (await call('/api/zakat-eligibility', 'POST', { partner_id: val(f, 'partner_id'), ownership_class: val(f, 'ownership_class'), effective_from: val(f, 'effective_from'), effective_to: val(f, 'effective_to'), evidence_document_id: val(f, 'evidence_document_id'), entity_ultimate_ownership_note: val(f, 'entity_note'), note: null })) (e.target as HTMLFormElement).reset();
  };
  const saveClassification = (a: Account) => async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    await ws(`/classifications/${a.account_id}`, 'PUT', { zakat_type: val(f, 'zakat_type'), reg_article: val(f, 'reg_article'), evidence_document_id: val(f, 'evidence_document_id'), note: null, version: w!.version });
  };
  const addAdjustment = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    if (await ws('/adjustments', 'POST', { description: val(f, 'description'), direction: val(f, 'direction'), amount: val(f, 'amount'), reg_article: val(f, 'reg_article'), evidence_document_id: val(f, 'evidence_document_id'), evidence_note: val(f, 'evidence_note'), version: w!.version })) (e.target as HTMLFormElement).reset();
  };
  const workflow = (name: string, extra: object = {}) => ws(`/${name}`, 'POST', { version: w!.version, ...extra });

  return (
    <section className="zw" aria-labelledby="zw-title">
      <h3 id="zw-title">{t('zakatWorksheet.title')}</h3>{toggle}
      {error && <p role="alert" className="zw-error">{error}</p>}

      <div className="zw-card" role="status">
        <h4>{t('zakatWorksheet.readinessTitle')}</h4>
        <p><strong>{t('zakatWorksheet.payableWithheld')}</strong></p>
        {data.scope.unsupported_reason && <p className="zw-error">{blockerLabel(data.scope.unsupported_reason)}</p>}
        {r.preparation_blockers.length === 0 ? <p>{t('zakatWorksheet.noPrepBlockers')}</p> : <><p>{t('zakatWorksheet.prepBlockers')}</p><ul>{r.preparation_blockers.map((c) => <li key={c}>{blockerLabel(c)}</li>)}</ul></>}
        <div className="table-wrap"><table className="ac-table"><caption className="zw-caption">{t('zakatWorksheet.gatesTitle')}</caption><thead><tr><th>{t('zakatWorksheet.gate')}</th><th>{t('zakatWorksheet.reference')}</th><th>{t('zakatWorksheet.statusLabel')}</th><th>{t('zakatWorksheet.blocksApproval')}</th></tr></thead>
          <tbody>{data.gates.map((g) => <tr key={g.code}><td>{t(`zakatWorksheet.gates.${g.code}`, { defaultValue: g.title })}</td><td>{g.article_ref}</td><td><span className={`ac-badge ${g.status === 'verified' ? 'ac-badge--ok' : 'ac-badge--warn'}`}>{t(`zakatWorksheet.gateStatus.${g.status}`)}</span></td><td>{g.blocks_approval ? t('zakatWorksheet.yes') : t('zakatWorksheet.no')}</td></tr>)}</tbody></table></div>
      </div>

      <div className="zw-card">
        <h4>{t('zakatWorksheet.ownershipTitle')}</h4>
        <p>{t('zakatWorksheet.asOf')}: <bdi>{data.ownership_live.as_of_date}</bdi> · <span className={`ac-badge ${data.ownership_live.qualified ? 'ac-badge--ok' : 'ac-badge--bad'}`}>{data.ownership_live.qualified ? t('zakatWorksheet.qualified') : t('zakatWorksheet.notQualified')}</span></p>
        {data.ownership_live.blockers.length > 0 && <ul>{data.ownership_live.blockers.map((c) => <li key={c}>{blockerLabel(c)}</li>)}</ul>}
        {data.ownership_live.partners.length > 0 && <div className="table-wrap"><table className="ac-table"><thead><tr><th>{t('zakatWorksheet.partner')}</th><th>{t('zakatWorksheet.percent')}</th><th>{t('zakatWorksheet.ownershipClass')}</th></tr></thead>
          <tbody>{data.ownership_live.partners.map((o) => <tr key={o.partner_id}><td>{o.name}</td><td>{pct(o.ownership_bps4)}%</td><td>{o.eligibility ? t(`zakatWorksheet.classes.${o.eligibility.ownership_class}`) : t('zakatWorksheet.noEligibility')}</td></tr>)}</tbody></table></div>}
        <h5>{t('zakatWorksheet.eligibilityTitle')}</h5>
        {data.eligibility.length === 0 ? <p className="zw-muted">{t('zakatWorksheet.noEligibilityRows')}</p> :
          <div className="table-wrap"><table className="ac-table"><thead><tr><th>{t('zakatWorksheet.partner')}</th><th>{t('zakatWorksheet.ownershipClass')}</th><th>{t('zakatWorksheet.effectiveFrom')}</th><th>{t('zakatWorksheet.effectiveTo')}</th><th>{t('zakatWorksheet.statusLabel')}</th><th /></tr></thead>
            <tbody>{data.eligibility.map((e) => <tr key={e.id}><td>{e.partner_name}</td><td>{t(`zakatWorksheet.classes.${e.ownership_class}`)}</td><td><bdi>{e.effective_from}</bdi></td><td><bdi>{e.effective_to ?? '—'}</bdi></td><td>{t(`zakatWorksheet.verification.${e.verification_status}`)}</td>
              <td className="zw-actions">
                {e.verification_status === 'unconfirmed' && p.canConfirmOwnership && <button type="button" className="ac-btn" disabled={busy} onClick={() => void call(`/api/zakat-eligibility/${e.id}/confirm`, 'POST', { version: e.version })}>{t('zakatWorksheet.confirm')}</button>}
                {e.verification_status === 'unconfirmed' && p.canEditOwnership && <button type="button" className="ac-btn" disabled={busy} onClick={() => void call(`/api/zakat-eligibility/${e.id}`, 'DELETE', { version: e.version })}>{t('zakatWorksheet.remove')}</button>}
                {e.verification_status === 'confirmed' && !e.effective_to && p.canEditOwnership && <button type="button" className="ac-btn" disabled={busy} onClick={() => { const d = window.prompt(t('zakatWorksheet.endDatePrompt'), data.ownership_live.as_of_date); if (d) void call(`/api/zakat-eligibility/${e.id}/end`, 'POST', { version: e.version, effective_to: d }); }}>{t('zakatWorksheet.end')}</button>}
              </td></tr>)}</tbody></table></div>}
        {p.canCreateOwnership && <form className="zw-form" onSubmit={(e) => void addEligibility(e)}>
          <label>{t('zakatWorksheet.partner')}<select name="partner_id" required>{data.ownership_live.partners.map((o) => <option key={o.partner_id} value={o.partner_id}>{o.name}</option>)}</select></label>
          <label>{t('zakatWorksheet.ownershipClass')}<select name="ownership_class" value={entityClass} onChange={(e) => setEntityClass(e.target.value)}>{CLASSES.map((c) => <option key={c} value={c}>{t(`zakatWorksheet.classes.${c}`)}</option>)}</select></label>
          <label>{t('zakatWorksheet.effectiveFrom')}<input name="effective_from" type="date" required /></label>
          <label>{t('zakatWorksheet.effectiveTo')}<input name="effective_to" type="date" /></label>
          <label>{t('zakatWorksheet.evidenceDoc')}{docSelect('evidence_document_id', true)}</label>
          {entityClass.endsWith('_entity') && <label>{t('zakatWorksheet.entityNote')}<textarea name="entity_note" required maxLength={2000} /></label>}
          <button className="ac-btn ac-btn--primary" disabled={busy || !p.canViewDocuments}>{t('zakatWorksheet.addEligibility')}</button>
        </form>}
      </div>

      <div className="zw-card">
        <h4>{t('zakatWorksheet.worksheetTitle')}</h4>
        {!w ? <>{p.canCreate && !data.scope.unsupported_reason && <button type="button" className="ac-btn ac-btn--primary" disabled={busy} onClick={() => void ws('', 'POST', {})}>{t('zakatWorksheet.create')}</button>}{!p.canCreate && <p className="zw-muted">{t('zakatWorksheet.notStarted')}</p>}</> : <>
          <p>{t('zakatWorksheet.revision')} <bdi>{w.revision_no}</bdi> · <span className="ac-badge">{t(`zakatWorksheet.statuses.${w.status}`)}</span>{w.revision_reason && <> · {t('zakatWorksheet.revisionReason')}: {w.revision_reason}</>}</p>
          {w.snapshot_captured_at && <p className="zw-muted">{t('zakatWorksheet.capturedAt')}: <bdi>{w.snapshot_captured_at}</bdi></p>}
          <fieldset disabled={!draft || !p.canEdit || busy}><legend>{t('zakatWorksheet.declarations')}</legend>
            <label><input type="checkbox" checked={w.non_financing_confirmed} onChange={(e) => void ws('/declarations', 'PATCH', { non_financing_confirmed: e.target.checked, accounting_records_confirmed: w.accounting_records_confirmed, version: w.version })} /> {t('zakatWorksheet.nonFinancing')}</label>
            <label><input type="checkbox" checked={w.accounting_records_confirmed} onChange={(e) => void ws('/declarations', 'PATCH', { non_financing_confirmed: w.non_financing_confirmed, accounting_records_confirmed: e.target.checked, version: w.version })} /> {t('zakatWorksheet.accountingRecords')}</label>
          </fieldset>
          {draft && p.canEdit && <button type="button" className="ac-btn" disabled={busy} onClick={() => void ws('/refresh', 'POST', { version: w.version })}>{t('zakatWorksheet.refresh')}</button>}
        </>}
      </div>

      {w && <div className="zw-card">
        <h4>{t('zakatWorksheet.classTitle')}</h4>
        <p className="zw-muted">{t('zakatWorksheet.classHelp')}</p>
        <div className="table-wrap"><table className="ac-table"><thead><tr><th>{t('zakatWorksheet.account')}</th><th>{t('zakatWorksheet.category')}</th><th>{t('zakatWorksheet.balance')}</th><th>{t('zakatWorksheet.classification')}</th></tr></thead>
          <tbody>{accounts.map((a) => { const c = classByAccount.get(a.account_id); const name = ar ? (a.name_ar || a.name) : a.name; return (
            <tr key={`${a.account_id}-${c?.zakat_type ?? 'none'}-${w.version}`}><td><bdi>{a.code}</bdi> {name}</td><td>{t(`zakatWorksheet.categories.${a.statement_category}`)}</td><td className="zw-num"><bdi>{money(a.amount_cents)}</bdi></td>
              <td>{draft && p.canEdit ? <form className="zw-inline" onSubmit={(e) => void saveClassification(a)(e)}>
                <select name="zakat_type" defaultValue={c?.zakat_type ?? ''} required aria-label={t('zakatWorksheet.classification')}><option value="">{t('zakatWorksheet.unclassified')}</option>{TYPES.map((x) => <option key={x} value={x}>{t(`zakatWorksheet.types.${x}`)}</option>)}</select>
                <input name="reg_article" defaultValue={c?.reg_article ?? ''} required maxLength={100} placeholder={t('zakatWorksheet.article')} aria-label={t('zakatWorksheet.article')} />
                {docSelect('evidence_document_id', false, c?.evidence_document_id ?? '')}
                <button className="ac-btn" disabled={busy}>{t('zakatWorksheet.save')}</button>
                {c && <button type="button" className="ac-btn" disabled={busy} onClick={() => void ws(`/classifications/${a.account_id}`, 'DELETE', { version: w.version })}>{t('zakatWorksheet.clear')}</button>}
              </form> : c ? <span>{t(`zakatWorksheet.types.${c.zakat_type}`)} — <bdi>{c.reg_article}</bdi></span> : <span className="ac-badge ac-badge--warn">{t('zakatWorksheet.unclassified')}</span>}</td></tr>); })}</tbody></table></div>
      </div>}

      {w && <div className="zw-card">
        <h4>{t('zakatWorksheet.adjTitle')}</h4>
        {data.adjustments.length === 0 ? <p className="zw-muted">{t('zakatWorksheet.noAdjustments')}</p> :
          <div className="table-wrap"><table className="ac-table"><thead><tr><th>{t('zakatWorksheet.description')}</th><th>{t('zakatWorksheet.direction')}</th><th>{t('zakatWorksheet.amount')}</th><th>{t('zakatWorksheet.article')}</th><th>{t('zakatWorksheet.evidence')}</th><th /></tr></thead>
            <tbody>{data.adjustments.map((a) => <tr key={a.id}><td>{a.description}</td><td>{t(`zakatWorksheet.directions.${a.direction}`)}</td><td className="zw-num"><bdi>{a.amount}</bdi></td><td><bdi>{a.reg_article}</bdi></td><td>{a.evidence_document_id ? documents.find((d) => d.id === a.evidence_document_id)?.original_filename ?? t('zakatWorksheet.document') : a.evidence_note}</td>
              <td>{draft && p.canDeleteAdjustment && <button type="button" className="ac-btn" disabled={busy} onClick={() => void ws(`/adjustments/${a.id}`, 'DELETE', { version: w.version })}>{t('zakatWorksheet.delete')}</button>}</td></tr>)}</tbody></table></div>}
        {draft && p.canCreateAdjustment && <form className="zw-form" onSubmit={(e) => void addAdjustment(e)}>
          <label>{t('zakatWorksheet.description')}<input name="description" required maxLength={500} /></label>
          <label>{t('zakatWorksheet.direction')}<select name="direction"><option value="add">{t('zakatWorksheet.directions.add')}</option><option value="deduct">{t('zakatWorksheet.directions.deduct')}</option></select></label>
          <label>{t('zakatWorksheet.amount')}<input name="amount" required inputMode="decimal" pattern="(?:0|[1-9][0-9]{0,15})\.[0-9]{2}" placeholder="0.00" dir="ltr" /></label>
          <label>{t('zakatWorksheet.article')}<input name="reg_article" required maxLength={100} /></label>
          <label>{t('zakatWorksheet.evidenceDoc')}{docSelect('evidence_document_id')}</label>
          <label>{t('zakatWorksheet.evidenceNote')}<input name="evidence_note" maxLength={2000} /></label>
          <button className="ac-btn ac-btn--primary" disabled={busy}>{t('zakatWorksheet.addAdjustment')}</button>
        </form>}
      </div>}

      {w && <div className="zw-card">
        <h4>{t('zakatWorksheet.reviewTitle')}</h4>
        {(['in_review', 'reviewed', 'approved'].includes(w.status)) && <label>{t('zakatWorksheet.reason')}<input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={2000} /></label>}
        <div className="zw-actions">
          {w.status === 'draft' && p.canSubmit && <button type="button" className="ac-btn ac-btn--primary" disabled={busy || !r.can_submit} onClick={() => void workflow('submit')}>{t('zakatWorksheet.submit')}</button>}
          {w.status === 'in_review' && p.canReview && <button type="button" className="ac-btn ac-btn--primary" disabled={busy || !r.can_submit} onClick={() => void workflow('review')}>{t('zakatWorksheet.review')}</button>}
          {w.status === 'reviewed' && p.canApprove && <button type="button" className="ac-btn ac-btn--primary" disabled={busy || !r.can_approve} onClick={() => void workflow('approve')}>{t('zakatWorksheet.approve')}</button>}
          {['in_review', 'reviewed'].includes(w.status) && p.canReview && <button type="button" className="ac-btn" disabled={busy || !reason.trim()} onClick={() => void workflow('return', { reason }).then((ok) => { if (ok) setReason(''); })}>{t('zakatWorksheet.return')}</button>}
          {w.status === 'approved' && p.canApprove && <button type="button" className="ac-btn" disabled={busy || !reason.trim()} onClick={() => void workflow('revise', { reason }).then((ok) => { if (ok) setReason(''); })}>{t('zakatWorksheet.revise')}</button>}
        </div>
        {w.status === 'reviewed' && r.gate_blockers.length > 0 && <p className="zw-error">{t('zakatWorksheet.approvalBlocked', { gates: r.gate_blockers.map((c) => t(`zakatWorksheet.gates.${c}`, { defaultValue: c })).join('، ') })}</p>}
        <h5>{t('zakatWorksheet.revisionsTitle')}</h5>
        <ul>{data.revisions.map((v) => <li key={v.id}><bdi>#{v.revision_no}</bdi> — {t(`zakatWorksheet.statuses.${v.status}`)}{v.revision_reason ? ` — ${v.revision_reason}` : ''}</li>)}</ul>
      </div>}
    </section>
  );
}
