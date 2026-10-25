import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from './Dialog';
import { PageHeader, SectionCard, StatusBadge, WorkspacePage, WorkspaceState } from './SharedUI';
import './InvoiceAccountMappings.css';

type Account = { id: string; code: string; name: string; name_ar: string | null };
type Mapping = {
  key: string; section: 'sales' | 'purchases'; required_account_type: string; status: 'configured' | 'missing' | 'invalid';
  account: (Account & { is_active: boolean; account_type: string }) | null; eligible_accounts: Account[];
};
const SECTIONS = ['sales', 'purchases'] as const;
// Display order only: rows that block approvals come first. The server still decides every status.
const STATUS_ORDER: Record<Mapping['status'], number> = { missing: 0, invalid: 1, configured: 2 };
const STATUS_BADGE: Record<Mapping['status'], string> = { missing: 'incomplete', invalid: 'rejected', configured: 'approved' };

/**
 * Invoice account mappings. Accounts are always chosen explicitly by a person: nothing here proposes or pre-selects an account from codes or names.
 * The server enforces invoice.mapping.view / invoice.mapping.manage, the active company, account status and account type on every call.
 * Changing a mapping affects future approvals only; approved invoices and journals keep the accounts they were created with.
 * Only one save/clear runs at a time: each response carries the whole updated list, so concurrent writes could show stale rows.
 */
export function InvoiceAccountMappings({ canView, canManage, onUnauthorized }: { canView: boolean; canManage: boolean; onUnauthorized: () => void }) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const [rows, setRows] = useState<Mapping[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<{ key: string; method: 'PUT' | 'DELETE' } | null>(null);
  const busyRef = useRef(false);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState<Mapping | null>(null);
  const accountName = (a: Account) => ar ? (a.name_ar ?? a.name) : a.name;
  const optionLabel = (a: Account) => `${a.code} — ${accountName(a)}`;
  const accountLabel = (account: Account) => <span className="invoice-mappings__account-label"><bdi className="invoice-mappings__code">{account.code}</bdi> — <bdi>{accountName(account)}</bdi></span>;
  const keyName = (key: string) => t(`invoiceMappings.keys.${key}`);
  const typeName = (type: string) => t(`invoiceMappings.types.${type}`, { defaultValue: type });

  const errorText = (status: number) => status === 403 ? t('invoiceMappings.forbidden') : status === 400 ? t('invoiceMappings.invalid') : t('invoiceMappings.error');

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const response = await fetch('/api/invoice-account-mappings', { credentials: 'same-origin' });
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) { setLoadError(true); return; }
      setRows(((await response.json()) as { mappings: Mapping[] }).mappings);
    } catch { setLoadError(true); }
  }, [onUnauthorized]);
  useEffect(() => { if (canView) void load(); }, [canView, load]);

  const send = async (row: Mapping, method: 'PUT' | 'DELETE') => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy({ key: row.key, method }); setNotice(null);
    try {
      const response = await fetch(`/api/invoice-account-mappings/${row.key}`, {
        method, credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        ...(method === 'PUT' ? { body: JSON.stringify({ account_id: choice[row.key] }) } : {}),
      });
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) { setNotice({ tone: 'error', text: errorText(response.status) }); return; }
      setRows(((await response.json()) as { mappings: Mapping[] }).mappings);
      setChoice((c) => { const { [row.key]: _drop, ...rest } = c; return rest; });
      setNotice({ tone: 'success', text: t(method === 'PUT' ? 'invoiceMappings.saved' : 'invoiceMappings.cleared', { name: keyName(row.key) }) });
    } catch { setNotice({ tone: 'error', text: t('invoiceMappings.error') }); }
    finally { busyRef.current = false; setBusy(null); setConfirmClear(null); }
  };

  if (!canView) return <WorkspacePage labelledBy="invoice-mappings-title"><WorkspaceState tone="error">{t('invoiceMappings.forbidden')}</WorkspaceState></WorkspacePage>;
  const list = (status: Mapping['status']) => (rows ?? []).filter((r) => r.status === status).map((r) => keyName(r.key)).join(t('invoiceMappings.listSeparator'));
  const missing = list('missing'), invalid = list('invalid');
  const incomplete = (rows ?? []).filter((r) => r.status !== 'configured').length;

  const reason = (row: Mapping) => {
    if (row.status === 'missing') return t('invoiceMappings.reasonMissing');
    if (row.status !== 'invalid' || !row.account) return null;
    return !row.account.is_active ? t('invoiceMappings.reasonInactive')
      : t('invoiceMappings.reasonType', { actual: typeName(row.account.account_type), required: typeName(row.required_account_type) });
  };

  const actions = (row: Mapping) => {
    const name = keyName(row.key);
    const selectedId = choice[row.key] ?? '';
    const options = row.eligible_accounts.filter((a) => a.id !== row.account?.id);
    const selected = options.find((a) => a.id === selectedId) ?? null;
    const rowBusy = busy?.key === row.key;
    const locked = busy !== null;
    return <div className="invoice-mappings__actions">
      {options.length === 0
        ? <p className={`invoice-mappings__note${row.status === 'configured' ? '' : ' is-warning'}`} data-testid={`mapping-no-eligible-${row.key}`}>
          {row.status === 'configured' ? t('invoiceMappings.noAlternative', { type: typeName(row.required_account_type) }) : t('invoiceMappings.noEligible', { type: typeName(row.required_account_type) })}</p>
        : <select className="invoice-mappings__select" aria-label={t('invoiceMappings.chooseFor', { name })} value={selected ? selectedId : ''} onChange={(e) => setChoice({ ...choice, [row.key]: e.target.value })} disabled={locked}>
          <option value="">{t('invoiceMappings.chooseAccount')}</option>
          {options.map((a) => <option key={a.id} value={a.id}>{optionLabel(a)}</option>)}
        </select>}
      {selected && <div className="invoice-mappings__compare" data-testid={`mapping-compare-${row.key}`}>
        {row.account && <><div><span className="invoice-mappings__compare-label">{t('invoiceMappings.from')}</span>{accountLabel(row.account)}</div><span className="invoice-mappings__arrow" aria-hidden="true">→</span></>}
        <div><span className="invoice-mappings__compare-label">{t('invoiceMappings.to')}</span>{accountLabel(selected)}{!row.account && <small>{t('invoiceMappings.firstTime')}</small>}</div>
      </div>}
      <div className="invoice-mappings__buttons">
        {options.length > 0 && <button type="button" className="primary invoice-mappings__save" aria-label={t('invoiceMappings.saveFor', { name })} disabled={!selected || locked} onClick={() => void send(row, 'PUT')}>
          {rowBusy && busy.method === 'PUT' ? <><span className="invoice-mappings__spinner" aria-hidden="true" />{t('invoiceMappings.saving')}</> : t('invoiceMappings.save')}</button>}
        {row.account && <button type="button" className="invoice-mappings__clear" aria-label={t('invoiceMappings.clearFor', { name })} disabled={locked} onClick={() => setConfirmClear(row)}>
          {rowBusy && busy.method === 'DELETE' ? <><span className="invoice-mappings__spinner" aria-hidden="true" />{t('invoiceMappings.clearing')}</> : t('invoiceMappings.clear')}</button>}
        {selected && !rowBusy && <span className="badge invoice-mappings__unsaved" data-testid={`mapping-unsaved-${row.key}`}>{t('invoiceMappings.unsaved')}</span>}
      </div>
    </div>;
  };

  return <WorkspacePage labelledBy="invoice-mappings-title" className="invoice-mappings">
    <PageHeader titleId="invoice-mappings-title" title={t('invoiceMappings.title')} description={t('invoiceMappings.intro')} />
    {loadError && <WorkspaceState tone="error" action={<button type="button" onClick={() => void load()}>{t('invoiceMappings.retry')}</button>}>{t('invoiceMappings.error')}</WorkspaceState>}
    {!loadError && rows === null && <WorkspaceState>{t('invoiceMappings.loading')}</WorkspaceState>}
    {rows && (incomplete > 0
      ? <div role="status" className="invoice-mappings__summary is-warning" data-testid="mapping-incomplete"><strong>{t('invoiceMappings.incomplete', { count: incomplete })}</strong>
        {missing && <span>{t('invoiceMappings.missingKeys', { keys: missing })}</span>}{invalid && <span>{t('invoiceMappings.invalidKeys', { keys: invalid })}</span>}</div>
      : <div role="status" className="invoice-mappings__summary" data-testid="mapping-complete">{t('invoiceMappings.allConfigured')}</div>)}
    {rows && !canManage && <p className="invoice-mappings__summary" data-testid="mapping-readonly">{t('invoiceMappings.readOnly')}</p>}
    {busy && <p role="status" className="invoice-mappings__summary" data-testid="mapping-busy">{t(busy.method === 'PUT' ? 'invoiceMappings.savingNotice' : 'invoiceMappings.clearingNotice')}</p>}
    {notice && <p role={notice.tone === 'error' ? 'alert' : 'status'} className={`invoice-mappings__summary ${notice.tone === 'error' ? 'is-error' : 'is-success'}`} data-testid="mapping-notice">{notice.text}</p>}
    {rows && SECTIONS.map((section) => <SectionCard key={section} className="invoice-mappings__section">
      <h3 id={`invoice-mappings-${section}`}>{t(`invoiceMappings.sections.${section}`)}</h3>
      <ul className="invoice-mappings__rows" aria-labelledby={`invoice-mappings-${section}`}>
        {rows.filter((r) => r.section === section).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status]).map((row) => {
          const why = reason(row);
          return <li key={row.key} className={`invoice-mappings__row is-${row.status}`} data-testid={`mapping-${row.key}`} aria-busy={busy?.key === row.key || undefined}>
            <div className="invoice-mappings__role">
              <strong>{keyName(row.key)}</strong>
              <span className="invoice-mappings__muted">{t('invoiceMappings.requiredType')}: {typeName(row.required_account_type)}</span>
              <StatusBadge status={STATUS_BADGE[row.status]}>{t(`invoiceMappings.statuses.${row.status}`)}</StatusBadge>
            </div>
            <div className="invoice-mappings__current">
              <span className="invoice-mappings__muted">{t('invoiceMappings.current')}</span>
              {row.account ? <>
                {accountLabel(row.account)}
                <span className="invoice-mappings__facts">
                  <span className="badge">{t('invoiceMappings.actualType')}: {typeName(row.account.account_type)}</span>
                  <span className={`badge ${row.account.is_active ? 'approved' : 'rejected'}`}>{t(row.account.is_active ? 'invoiceMappings.active' : 'invoiceMappings.inactive')}</span>
                </span>
              </> : <span className="invoice-mappings__muted">{t('invoiceMappings.noAccount')}</span>}
              {why && <p className="invoice-mappings__reason">{why}</p>}
            </div>
            {canManage && actions(row)}
          </li>;
        })}
      </ul>
    </SectionCard>)}
    {confirmClear && <Dialog title={t('invoiceMappings.confirmClearTitle')} busy={busy !== null} onClose={() => setConfirmClear(null)}>
      <p>{t('invoiceMappings.confirmClearBody', { name: keyName(confirmClear.key) })}</p>
      {confirmClear.account && <p>{t('invoiceMappings.current')}: {accountLabel(confirmClear.account)}</p>}
      <div className="modal-actions"><button type="button" onClick={() => setConfirmClear(null)} disabled={busy !== null}>{t('common.cancel')}</button>
        <button type="button" className="primary" onClick={() => void send(confirmClear, 'DELETE')} disabled={busy !== null}>{t('invoiceMappings.confirmClear')}</button></div>
    </Dialog>}
  </WorkspacePage>;
}
