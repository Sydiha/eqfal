import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from './Dialog';
import { PageHeader, SectionCard, StatusBadge, WorkspacePage, WorkspaceState } from './SharedUI';

type Account = { id: string; code: string; name: string; name_ar: string | null };
type Mapping = {
  key: string; section: 'sales' | 'purchases'; required_account_type: string; status: 'configured' | 'missing' | 'invalid';
  account: (Account & { is_active: boolean; account_type: string }) | null; eligible_accounts: Account[];
};
const SECTIONS = ['sales', 'purchases'] as const;

/**
 * Invoice account mappings. Accounts are always chosen explicitly by a person: nothing here proposes or pre-selects an account from codes or names.
 * The server enforces invoice.mapping.view / invoice.mapping.manage, the active company, account status and account type on every call.
 * Changing a mapping affects future approvals only; approved invoices and journals keep the accounts they were created with.
 */
export function InvoiceAccountMappings({ canView, canManage, onUnauthorized }: { canView: boolean; canManage: boolean; onUnauthorized: () => void }) {
  const { t, i18n } = useTranslation();
  const ar = i18n.language === 'ar';
  const [rows, setRows] = useState<Mapping[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [confirmClear, setConfirmClear] = useState<Mapping | null>(null);
  const label = (a: { code: string; name: string; name_ar: string | null }) => `${a.code} — ${ar ? (a.name_ar ?? a.name) : a.name}`;

  const errorText = (status: number) => status === 403 ? t('invoiceMappings.forbidden') : status === 400 ? t('invoiceMappings.invalid') : t('invoiceMappings.error');

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/invoice-account-mappings', { credentials: 'same-origin' });
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) { setLoadError(true); return; }
      setRows(((await response.json()) as { mappings: Mapping[] }).mappings);
      setLoadError(false);
    } catch { setLoadError(true); }
  }, [onUnauthorized]);
  useEffect(() => { if (canView) void load(); }, [canView, load]);

  const send = async (row: Mapping, method: 'PUT' | 'DELETE') => {
    setBusyKey(row.key); setNotice(null);
    try {
      const response = await fetch(`/api/invoice-account-mappings/${row.key}`, {
        method, credentials: 'same-origin', headers: { 'content-type': 'application/json' },
        ...(method === 'PUT' ? { body: JSON.stringify({ account_id: choice[row.key] }) } : {}),
      });
      if (response.status === 401) { onUnauthorized(); return; }
      if (!response.ok) { setNotice({ tone: 'error', text: errorText(response.status) }); return; }
      setRows(((await response.json()) as { mappings: Mapping[] }).mappings);
      setChoice((c) => { const { [row.key]: _drop, ...rest } = c; return rest; });
      setNotice({ tone: 'success', text: t(method === 'PUT' ? 'invoiceMappings.saved' : 'invoiceMappings.cleared', { name: t(`invoiceMappings.keys.${row.key}`) }) });
    } catch { setNotice({ tone: 'error', text: t('invoiceMappings.error') }); }
    finally { setBusyKey(null); setConfirmClear(null); }
  };

  if (!canView) return <WorkspacePage labelledBy="invoice-mappings-title"><WorkspaceState tone="error">{t('invoiceMappings.forbidden')}</WorkspaceState></WorkspacePage>;
  const incomplete = (rows ?? []).filter((r) => r.status !== 'configured').length;

  return <WorkspacePage labelledBy="invoice-mappings-title" className="invoice-mappings">
    <PageHeader titleId="invoice-mappings-title" title={t('invoiceMappings.title')} description={t('invoiceMappings.intro')} />
    {loadError && <WorkspaceState tone="error">{t('invoiceMappings.error')}</WorkspaceState>}
    {!loadError && rows === null && <WorkspaceState>{t('invoiceMappings.loading')}</WorkspaceState>}
    {rows && incomplete > 0 && <p role="status" className="shared-state" data-testid="mapping-incomplete">{t('invoiceMappings.incomplete', { count: incomplete })}</p>}
    {rows && !canManage && <p className="shared-state" data-testid="mapping-readonly">{t('invoiceMappings.readOnly')}</p>}
    {notice && <p role={notice.tone === 'error' ? 'alert' : 'status'} className="shared-state" data-testid="mapping-notice">{notice.text}</p>}
    {rows && SECTIONS.map((section) => <SectionCard key={section}>
      <h3>{t(`invoiceMappings.sections.${section}`)}</h3>
      <table className="data-table">
        <thead><tr><th>{t('invoiceMappings.mapping')}</th><th>{t('invoiceMappings.requiredType')}</th><th>{t('invoiceMappings.current')}</th><th>{t('invoiceMappings.status')}</th>{canManage && <th>{t('invoiceMappings.actions')}</th>}</tr></thead>
        <tbody>{rows.filter((r) => r.section === section).map((row) => {
          const selected = choice[row.key] ?? '';
          return <tr key={row.key} data-testid={`mapping-${row.key}`}>
            <td>{t(`invoiceMappings.keys.${row.key}`)}</td>
            <td>{t(`invoiceMappings.types.${row.required_account_type}`)}</td>
            <td>{row.account ? label(row.account) : '—'}</td>
            <td><StatusBadge status={row.status === 'configured' ? 'approved' : 'rejected'}>{t(`invoiceMappings.statuses.${row.status}`)}</StatusBadge>
              {row.status === 'invalid' && <small> {t('invoiceMappings.invalidHint')}</small>}</td>
            {canManage && <td>
              <select aria-label={t('invoiceMappings.chooseFor', { name: t(`invoiceMappings.keys.${row.key}`) })} value={selected} onChange={(e) => setChoice({ ...choice, [row.key]: e.target.value })} disabled={busyKey !== null}>
                <option value="">{t('invoiceMappings.chooseAccount')}</option>
                {row.eligible_accounts.map((a) => <option key={a.id} value={a.id}>{label(a)}</option>)}
              </select>
              <button type="button" className="primary" disabled={!selected || busyKey !== null} onClick={() => void send(row, 'PUT')}>{t('invoiceMappings.save')}</button>
              {row.account && <button type="button" disabled={busyKey !== null} onClick={() => setConfirmClear(row)}>{t('invoiceMappings.clear')}</button>}
            </td>}
          </tr>;
        })}</tbody>
      </table>
    </SectionCard>)}
    {confirmClear && <Dialog title={t('invoiceMappings.confirmClearTitle')} busy={busyKey !== null} onClose={() => setConfirmClear(null)}>
      <p>{t('invoiceMappings.confirmClearBody', { name: t(`invoiceMappings.keys.${confirmClear.key}`) })}</p>
      <div className="modal-actions"><button type="button" onClick={() => setConfirmClear(null)} disabled={busyKey !== null}>{t('common.cancel')}</button>
        <button type="button" className="primary" onClick={() => void send(confirmClear, 'DELETE')} disabled={busyKey !== null}>{t('invoiceMappings.confirmClear')}</button></div>
    </Dialog>}
  </WorkspacePage>;
}
