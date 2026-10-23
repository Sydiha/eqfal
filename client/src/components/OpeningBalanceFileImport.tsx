import { useMemo, useState } from 'react';
import { ROLES, TB_MESSAGES } from './CutoverFileImport';

// T7.2: annual opening balances from a CSV / XLSX trial balance. The server parses with the cut-over parser (read-only preview);
// the accountant chooses a category (and partner where required) for every row, confirms, and the rows are saved as DRAFT items only.
// Nothing is inferred, approved or posted here. Import is allowed only into an empty draft.
type Mapping = { header_row: number; code: number; name?: number; debit?: number; credit?: number; balance?: number; currency?: number };
type Line = { row: number; code: string; name: string | null; debit: string; credit: string; account_id: string | null; status: string };
type Issue = { code: string; row?: number; detail?: string };
type Parsed = { status: 'parsed'; lines: Line[]; total_debit: string; total_credit: string; balanced: boolean; errors: Issue[]; warnings: Issue[]; import_allowed: boolean };
type NeedsMapping = { status: 'needs_mapping'; headers: string[]; header_row: number; issues: Issue[] };
type Account = { id: string; code: string; name: string };
type Partner = { id: string; name: string; is_active: boolean };

const PARTNER_CATEGORIES = ['partner_capital', 'partner_current', 'partner_loan'];
const IMPORT_MESSAGES: Record<string, { ar: string; en: string }> = {
  IMPORT_NOT_DRAFT: { ar: 'الاستيراد متاح فقط والأرصدة الافتتاحية في حالة مسودة.', en: 'Import is available only while the opening balance is a draft.' },
  IMPORT_DRAFT_NOT_EMPTY: { ar: 'توجد بنود في المسودة. الاستيراد متاح فقط لمسودة فارغة، ولا يستبدل أو يحذف أي بند.', en: 'The draft already has items. Import is allowed only into an empty draft and never replaces or deletes items.' },
  IMPORT_PARTNER_INVALID: { ar: 'بنود الشركاء تتطلب اختيار شريك نشط، وغيرها لا يقبل شريكاً.', en: 'Partner items need an active partner; other categories cannot have one.' },
  IMPORT_INVALID: { ar: 'طلب الاستيراد غير صالح.', en: 'The import request is invalid.' },
  FISCAL_YEAR_CLOSED: { ar: 'السنة المالية مغلقة.', en: 'The fiscal year is closed.' },
  ACCOUNTING_PERIOD_CLOSED: { ar: 'الفترة المحاسبية لبداية السنة مغلقة.', en: 'The accounting period at the year start is closed.' },
  ONBOARDING_PATH_CUTOVER_ACTIVE: { ar: 'هذه السنة تتبع مسار القطع (Cutover)، فلا تُستورد لها أرصدة افتتاحية.', en: 'This fiscal year follows the cut-over path, so opening balances cannot be imported.' },
};

export function OpeningBalanceFileImport({ yearId, accounts, partners, categories, tx, onImported, onUnauthorized }: {
  yearId: string; accounts: Account[]; partners: Partner[]; categories: Record<string, string>; tx: (a: string, e: string) => string;
  onImported: () => void; onUnauthorized: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Parsed | NeedsMapping | null>(null);
  const [draftMap, setDraftMap] = useState<Partial<Record<string, number>>>({});
  const [category, setCategory] = useState<Record<number, string>>({});
  const [partner, setPartner] = useState<Record<number, string>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const all = { ...TB_MESSAGES, ...IMPORT_MESSAGES };
  const m = (code: string) => (all[code] ? tx(all[code]!.ar, all[code]!.en) : code);
  const byId = useMemo(() => new Map(accounts.map((a) => [a.id, a])), [accounts]);
  const activePartners = useMemo(() => partners.filter((p) => p.is_active), [partners]);

  const request = async (url: string, init: RequestInit) => {
    const r = await fetch(url, { credentials: 'same-origin', ...init });
    if (r.status === 401) { onUnauthorized(); throw new Error('Unauthorized'); }
    const body = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok) throw Object.assign(new Error(String(body['error'] ?? 'Request failed')), { code: body['code'], row: body['row'] });
    return body;
  };
  const fail = (e: unknown) => { const x = e as { code?: string; row?: number }; setError(`${x.row ? `${tx('سطر', 'Row')} ${x.row}: ` : ''}${x.code && all[x.code] ? m(x.code) : tx('تعذر تنفيذ الطلب.', 'The request could not be completed.')}`); };

  const upload = async (f: File, mapping?: Mapping) => {
    setBusy(true); setError(null); setDone(false); setCategory({}); setPartner({}); setConfirmed(false);
    try {
      setResult(await request(`/api/opening-balances/${yearId}/import/parse-file`, { method: 'POST', body: f, headers: {
        'content-type': f.type || (f.name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'application/octet-stream'), 'x-file-name': encodeURIComponent(f.name),
        ...(mapping ? { 'x-tb-mapping': encodeURIComponent(JSON.stringify(mapping)) } : {}) } }) as unknown as Parsed | NeedsMapping);
    } catch (e) { setResult(null); fail(e); } finally { setBusy(false); }
  };

  const parsed = result?.status === 'parsed' ? result : null;
  const needs = result?.status === 'needs_mapping' ? result : null;
  const rowsReady = !!parsed && parsed.lines.every((l) => l.status === 'ok' && category[l.row] && (!PARTNER_CATEGORIES.includes(category[l.row]!) || partner[l.row]));
  const canSave = !!parsed && parsed.import_allowed && parsed.balanced && parsed.errors.length === 0 && rowsReady && confirmed && !busy && !!file;

  const save = async () => {
    if (!parsed || !canSave || !file) return;
    setBusy(true); setError(null);
    try {
      await request(`/api/opening-balances/${yearId}/import`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
        confirm: true, file_name: file.name,
        items: parsed.lines.map((l) => ({ row: l.row, account_id: l.account_id, debit: l.debit, credit: l.credit, category: category[l.row],
          partner_id: PARTNER_CATEGORIES.includes(category[l.row]!) ? partner[l.row] : null })) }) });
      setDone(true); setResult(null); setFile(null); onImported();
    } catch (e) { fail(e); } finally { setBusy(false); }
  };

  const signed = draftMap['balance'] !== undefined;
  const mapReady = draftMap['code'] !== undefined && (signed ? draftMap['debit'] === undefined && draftMap['credit'] === undefined : draftMap['debit'] !== undefined && draftMap['credit'] !== undefined);
  const mapping = (): Mapping => ({ header_row: needs!.header_row, code: draftMap['code']!,
    ...Object.fromEntries((['name', 'debit', 'credit', 'balance', 'currency'] as const).filter((k) => draftMap[k] !== undefined).map((k) => [k, draftMap[k]])) });

  return <section className="ob-card ob-import" aria-labelledby="ob-import-title">
    <h3 id="ob-import-title">{tx('استيراد من Excel/CSV', 'Import from Excel/CSV')}</h3>
    <p className="ob-muted">{tx('ارفع ميزان مراجعة افتتاحي (CSV أو XLSX حتى 2 ميغابايت، ورقة واحدة، بلا صيغ). تُطابق الحسابات برمزها الحرفي في دليل حسابات الشركة، ولا يُنشأ أي حساب. اختر الفئة لكل سطر، ثم أكّد. تُحفظ البنود كمسودة فقط ولا يُعتمد أو يُرحّل شيء.', 'Upload an opening trial balance (CSV or XLSX up to 2 MB, one sheet, no formulas). Accounts match the company chart by exact code; no account is created. Choose a category for every row, then confirm. Items are saved as draft only; nothing is approved or posted.')}</p>
    <input type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" disabled={busy} aria-label={tx('ملف الأرصدة الافتتاحية', 'Opening balance file')}
      onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); setResult(null); setError(null); setDone(false); setDraftMap({}); if (f) void upload(f); }} />
    {busy && <p role="status">{tx('جارٍ المعالجة…', 'Processing…')}</p>}
    {error && <div className="ob-import__error" role="alert">{error}</div>}
    {done && <p role="status" className="ob-muted">{tx('تم حفظ البنود كمسودة. راجعها ثم أرسلها للمراجعة عند الجاهزية.', 'Items were saved as draft. Review them, then submit for review when ready.')}</p>}
    {needs && <div className="ob-import__map">
      <p role="note">{needs.issues.map((i) => m(i.code)).join(' ')}</p>
      <div className="form-grid">{ROLES.map(([k, ar, en]) => <label key={k}>{tx(ar, en)}
        <select value={draftMap[k] ?? ''} onChange={(e) => setDraftMap({ ...draftMap, [k]: e.target.value === '' ? undefined : Number(e.target.value) })}>
          <option value="">{tx('— لا شيء —', '— none —')}</option>{needs.headers.map((h, i) => <option key={i} value={i}>{h || `#${i + 1}`}</option>)}</select></label>)}</div>
      <button type="button" className="primary" disabled={busy || !mapReady || !file} onClick={() => file && void upload(file, mapping())}>{tx('قراءة الملف بهذا الربط', 'Read file with this mapping')}</button>
    </div>}
    {parsed && <div className="ob-import__preview">
      {!parsed.import_allowed && <div className="ob-import__error" role="alert">{m('IMPORT_DRAFT_NOT_EMPTY')}</div>}
      {parsed.errors.length > 0 && <ul className="ob-import__error" role="alert">{parsed.errors.map((e, i) => <li key={i}>{e.row ? `${tx('سطر', 'Row')} ${e.row}: ` : ''}{m(e.code)}{e.detail ? ` (${e.detail})` : ''}</li>)}</ul>}
      {parsed.warnings.length > 0 && <ul className="ob-muted">{parsed.warnings.map((w, i) => <li key={i}>{w.row ? `${tx('سطر', 'Row')} ${w.row}: ` : ''}{m(w.code)}</li>)}</ul>}
      <p className="ob-muted">{tx('الذمم المدينة والدائنة تُستورد كرصيد إجمالي على حساب المراقبة فقط، ولا تُنشأ أي التزامات أو أطراف مقابلة.', 'Receivables and payables are imported as aggregate control-account balances only; no obligations or counterparties are created.')}</p>
      <div className="table-wrap ob-table"><table><thead><tr><th>{tx('سطر', 'Row')}</th><th>{tx('الرمز', 'Code')}</th><th>{tx('الاسم في الملف', 'Name in file')}</th><th>{tx('الحساب', 'Account')}</th><th>{tx('مدين', 'Debit')}</th><th>{tx('دائن', 'Credit')}</th><th>{tx('الفئة', 'Category')}</th><th>{tx('الشريك', 'Partner')}</th></tr></thead>
        <tbody>{parsed.lines.map((l) => { const a = l.account_id ? byId.get(l.account_id) : undefined; const cat = category[l.row] ?? ''; return <tr key={l.row}>
          <td><bdi dir="ltr">{l.row}</bdi></td><td><bdi dir="ltr">{l.code}</bdi></td><td>{l.name ?? '—'}</td>
          <td>{l.status === 'ok' ? (a ? a.name : '—') : <span className="ob-import__error">{m(`TB_ACCOUNT_${l.status.toUpperCase()}`)}</span>}</td>
          <td className="ob-num"><bdi dir="ltr">{l.debit}</bdi></td><td className="ob-num"><bdi dir="ltr">{l.credit}</bdi></td>
          <td><select aria-label={`${tx('الفئة للسطر', 'Category for row')} ${l.row}`} value={cat} disabled={l.status !== 'ok'} onChange={(e) => setCategory({ ...category, [l.row]: e.target.value })}>
            <option value="">{tx('اختر', 'Select')}</option>{Object.entries(categories).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></td>
          <td>{PARTNER_CATEGORIES.includes(cat) ? <select aria-label={`${tx('الشريك للسطر', 'Partner for row')} ${l.row}`} value={partner[l.row] ?? ''} onChange={(e) => setPartner({ ...partner, [l.row]: e.target.value })}>
            <option value="">{tx('اختر', 'Select')}</option>{activePartners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select> : '—'}</td></tr>; })}</tbody></table></div>
      <dl className="ob-import__totals"><div><dt>{tx('إجمالي المدين', 'Total debit')}</dt><dd><bdi dir="ltr">{parsed.total_debit}</bdi></dd></div><div><dt>{tx('إجمالي الدائن', 'Total credit')}</dt><dd><bdi dir="ltr">{parsed.total_credit}</bdi></dd></div>
        <div><dt>{tx('التوازن', 'Balance')}</dt><dd>{parsed.balanced ? tx('متوازن', 'Balanced') : tx('غير متوازن — لا يمكن الاستيراد', 'Not balanced — cannot import')}</dd></div></dl>
      <label><input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} /> {tx('راجعت السطور والفئات، وأفهم أنها ستُحفظ كمسودة فقط.', 'I reviewed the rows and categories and understand they will be saved as draft only.')}</label>
      <button type="button" className="primary" disabled={!canSave} onClick={() => void save()}>{tx('حفظ كمسودة', 'Save as draft')}</button>
    </div>}
  </section>;
}
