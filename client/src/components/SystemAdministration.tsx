import { FormEvent, useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, apiErrorMessage, parseApiError, toApiError } from '../api/apiError';
import { Dialog } from './Dialog';
import { StatusBadge, WorkspaceState } from './SharedUI';
import { SensitivityMap, grantImpact, roleChangeImpact } from './accessRisk';
import { GrantConfirmDialog, PendingGrant } from './GrantConfirmDialog';

interface AdminUser { id: string; email: string; is_active: boolean; is_system_admin: boolean; active_memberships: number }
interface AdminCompany { id: string; slug: string; name: string; name_ar: string | null; is_active: boolean }
interface AdminRole { id: string; name: string; is_full_access: boolean; capabilities: string[] }
interface AdminMembership { id: string; company_id: string; company_name: string; company_name_ar: string | null; company_is_active: boolean; role_id: string | null; role_name: string | null; is_active: boolean }
type View = 'users' | 'companies';
type Dialogs = 'createUser' | 'createCompany' | null;

async function request(url: string, options: RequestInit, onUnauthorized: () => void) {
  let response: Response;
  try { response = await fetch(url, { credentials: 'same-origin', ...options }); }
  catch (reason) { throw toApiError(reason); }
  if (response.status === 401) onUnauthorized();
  if (!response.ok) throw await parseApiError(response);
  return response;
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/**
 * Global administration for a System Admin: user accounts, System Admin status, company access across companies
 * (a separate role per company, enable/disable per membership) and companies. Every action is authorized again by the
 * server (/api/admin/* re-checks System Admin; ceilings, Full Access and last-admin rules apply server-side).
 */
export function SystemAdministration({ currentUserId, onUnauthorized }: { currentUserId: string; onUnauthorized: () => void }) {
  const { t, i18n } = useTranslation();
  const rtl = i18n.language.startsWith('ar');
  const companyLabel = (c: { name: string; name_ar: string | null }) => (rtl && c.name_ar ? c.name_ar : c.name);
  const [view, setView] = useState<View>('users');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [companies, setCompanies] = useState<AdminCompany[]>([]);
  const [catalog, setCatalog] = useState<{ capabilities: string[]; sensitivity: SensitivityMap }>({ capabilities: [], sensitivity: {} });
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [memberships, setMemberships] = useState<AdminMembership[]>([]);
  const [rolesByCompany, setRolesByCompany] = useState<Record<string, AdminRole[]>>({});
  const [addCompanyId, setAddCompanyId] = useState('');
  const [addRoleId, setAddRoleId] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [pending, setPending] = useState<PendingGrant | null>(null);

  const fail = useCallback((reason: unknown) => {
    if (reason instanceof ApiError && reason.status === 401) return;
    setError((reason instanceof ApiError && apiErrorMessage(reason, t)) || t('systemAdmin.error'));
  }, [t]);

  const loadUsers = useCallback(async (q: string) => {
    const response = await request(`/api/admin/users${q ? `?q=${encodeURIComponent(q)}` : ''}`, {}, onUnauthorized);
    setUsers(((await response.json()) as { users: AdminUser[] }).users);
  }, [onUnauthorized]);
  const loadCompanies = useCallback(async () => {
    const response = await request('/api/admin/companies', {}, onUnauthorized);
    setCompanies(((await response.json()) as { companies: AdminCompany[] }).companies);
  }, [onUnauthorized]);
  const loadRoles = useCallback(async (companyId: string) => {
    const response = await request(`/api/admin/companies/${companyId}/roles`, {}, onUnauthorized);
    const roles = ((await response.json()) as { roles: AdminRole[] }).roles;
    setRolesByCompany((current) => ({ ...current, [companyId]: roles }));
    return roles;
  }, [onUnauthorized]);
  const loadMemberships = useCallback(async (userId: string) => {
    const response = await request(`/api/admin/users/${userId}/memberships`, {}, onUnauthorized);
    const list = ((await response.json()) as { memberships: AdminMembership[] }).memberships;
    setMemberships(list);
    await Promise.all([...new Set(list.map((m) => m.company_id))].map((id) => loadRoles(id)));
  }, [onUnauthorized, loadRoles]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [c] = await Promise.all([request('/api/admin/capabilities', {}, onUnauthorized), loadUsers(''), loadCompanies()]);
        if (!cancelled) setCatalog((await c.json()) as { capabilities: string[]; sensitivity: SensitivityMap });
      } catch (reason) { if (!cancelled) fail(reason); }
      finally { if (!cancelled) setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [onUnauthorized, loadUsers, loadCompanies, fail]);

  const selected = users.find((user) => user.id === selectedId) ?? null;
  const select = (userId: string) => {
    setSelectedId(userId); setAddCompanyId(''); setAddRoleId(''); setError(null);
    void loadMemberships(userId).catch(fail);
  };

  const mutate = async (work: () => Promise<unknown>, after?: () => void) => {
    setBusy(true); setError(null);
    try {
      await work(); after?.();
      await Promise.all([loadUsers(search), loadCompanies(), selectedId ? loadMemberships(selectedId) : Promise.resolve()]);
    } catch (reason) { fail(reason); }
    finally { setBusy(false); setPending(null); }
  };
  const confirmThen = (pendingGrant: Omit<PendingGrant, 'run'>, run: () => void) => {
    if (pendingGrant.impact.risk === 'normal') { run(); return; }
    setPending({ ...pendingGrant, run });
  };

  const companyName = (id: string) => { const c = companies.find((x) => x.id === id); return c ? companyLabel(c) : ''; };
  const roleOf = (companyId: string, roleId: string | null) => (rolesByCompany[companyId] ?? []).find((r) => r.id === roleId) ?? null;

  const changeRole = (m: AdminMembership, roleId: string) => {
    const next = roleOf(m.company_id, roleId);
    const run = () => void mutate(() => request(`/api/admin/memberships/${m.id}/role`, json('PUT', { role_id: roleId }), onUnauthorized));
    if (!next || !selected) { run(); return; }
    confirmThen({ impact: roleChangeImpact(roleOf(m.company_id, m.role_id), next, catalog.capabilities, catalog.sensitivity), subject: selected.email, subjectKind: 'user', companyName: companyName(m.company_id) }, run);
  };
  const addAccess = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selected || !addCompanyId) return;
    const role = roleOf(addCompanyId, addRoleId || null);
    const body = { user_id: selected.id, company_id: addCompanyId, role_id: addRoleId || null };
    const run = () => void mutate(() => request('/api/admin/memberships', json('POST', body), onUnauthorized), () => { setAddCompanyId(''); setAddRoleId(''); });
    if (!role) { run(); return; }
    confirmThen({ impact: roleChangeImpact(null, role, catalog.capabilities, catalog.sensitivity), subject: selected.email, subjectKind: 'user', companyName: companyName(addCompanyId) }, run);
  };
  const toggleSystemAdmin = (user: AdminUser) => {
    const run = () => void mutate(() => request(`/api/admin/users/${user.id}/system-admin`, json('PUT', { is_system_admin: !user.is_system_admin }), onUnauthorized));
    if (user.is_system_admin) { run(); return; }
    confirmThen({ impact: { ...grantImpact([], {}, true), risk: 'full_access' }, subject: user.email, subjectKind: 'user', companyName: t('systemAdmin.allCompanies') }, run);
  };
  const createUser = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    void mutate(() => request('/api/admin/users', json('POST', { email: String(data.get('email') ?? '').trim(), password: String(data.get('password') ?? '') }), onUnauthorized), () => setDialog(null));
  };
  const createCompany = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const nameAr = String(data.get('name_ar') ?? '').trim();
    void mutate(() => request('/api/admin/companies', json('POST', { slug: String(data.get('slug') ?? '').trim(), name: String(data.get('name') ?? '').trim(), ...(nameAr ? { name_ar: nameAr } : {}) }), onUnauthorized), () => setDialog(null));
  };

  if (loading) return <WorkspaceState>{t('access.loading')}</WorkspaceState>;
  const memberCompanyIds = new Set(memberships.map((m) => m.company_id));
  const addable = companies.filter((c) => c.is_active && !memberCompanyIds.has(c.id));
  const dialogError = error && dialog ? <div role="alert" className="acc-alert">{error}</div> : null;

  return <div className="acc-global">
    <p className="acc-hint">{t('systemAdmin.description')}</p>
    <div role="tablist" aria-label={t('systemAdmin.tab')} className="acc-tabs acc-subtabs">
      <button role="tab" aria-selected={view === 'users'} className={view === 'users' ? 'is-active' : ''} onClick={() => setView('users')}>{t('systemAdmin.usersTab')}</button>
      <button role="tab" aria-selected={view === 'companies'} className={view === 'companies' ? 'is-active' : ''} onClick={() => setView('companies')}>{t('systemAdmin.companiesTab')}</button>
    </div>
    {error && !dialog && <WorkspaceState tone="error">{error}</WorkspaceState>}
    {view === 'users' && <div className="acc-roles">
      <div className="acc-card">
        <form className="acc-search" role="search" onSubmit={(event) => { event.preventDefault(); void loadUsers(search).catch(fail); }}>
          <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t('systemAdmin.searchUsers')} aria-label={t('systemAdmin.searchUsers')} dir="ltr" maxLength={254} />
          <button type="submit" className="acc-ghost">{t('systemAdmin.search')}</button>
          <button type="button" className="acc-primary" onClick={() => { setError(null); setDialog('createUser'); }}>{t('access.createUser')}</button>
        </form>
        <ul className="acc-role-list" aria-label={t('systemAdmin.usersTab')}>
          {users.length === 0 ? <li className="acc-empty">{t('systemAdmin.noUsers')}</li> : users.map((user) => <li key={user.id}>
            <button className={user.id === selectedId ? 'is-active' : ''} aria-pressed={user.id === selectedId} onClick={() => select(user.id)}>
              <strong dir="ltr">{user.email}</strong>
              <span>{[user.is_system_admin ? t('systemAdmin.systemAdmin') : null, !user.is_active ? t('access.userDisabled') : null, t('systemAdmin.companyCount', { count: user.active_memberships })].filter(Boolean).join(' · ')}</span>
            </button>
          </li>)}
        </ul>
      </div>
      <div className="acc-card">
        {!selected ? <p className="acc-hint">{t('systemAdmin.selectUser')}</p> : <>
          <h3 dir="ltr" className="acc-user-title">{selected.email}</h3>
          <div className="acc-bulk">
            <button type="button" className="acc-ghost" disabled={busy || selected.id === currentUserId} onClick={() => void mutate(() => request(`/api/admin/users/${selected.id}/active`, json('PATCH', { is_active: !selected.is_active }), onUnauthorized))}>{t(selected.is_active ? 'systemAdmin.disableUser' : 'systemAdmin.enableUser')}</button>
            <button type="button" className="acc-ghost" disabled={busy || !selected.is_active} onClick={() => toggleSystemAdmin(selected)}>{t(selected.is_system_admin ? 'systemAdmin.revokeAdmin' : 'systemAdmin.grantAdmin')}</button>
          </div>
          <p className="acc-hint">{t('systemAdmin.membershipsHint')}</p>
          <div className="acc-table"><table><thead><tr><th>{t('systemAdmin.company')}</th><th>{t('access.role')}</th><th>{t('access.status')}</th><th>{t('access.actions')}</th></tr></thead>
            <tbody>{memberships.length === 0 ? <tr><td colSpan={4} className="acc-empty">{t('systemAdmin.noMemberships')}</td></tr> : memberships.map((m) => <tr key={m.id}>
              <td>{companyLabel({ name: m.company_name, name_ar: m.company_name_ar })}{!m.company_is_active && <small> · {t('systemAdmin.companyDisabled')}</small>}</td>
              <td><select aria-label={`${t('access.role')} ${companyLabel({ name: m.company_name, name_ar: m.company_name_ar })}`} value={m.role_id ?? ''} disabled={busy || !m.company_is_active} onChange={(event) => event.target.value && changeRole(m, event.target.value)}>
                <option value="" disabled>{t('access.noRole')}</option>
                {(rolesByCompany[m.company_id] ?? []).map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
              </select></td>
              <td><StatusBadge status={m.is_active ? 'open' : 'closed'}>{t(m.is_active ? 'access.active' : 'access.inactive')}</StatusBadge></td>
              <td><button className="acc-ghost" disabled={busy || !m.company_is_active} onClick={() => void mutate(() => request(`/api/admin/memberships/${m.id}/active`, json('PATCH', { is_active: !m.is_active }), onUnauthorized))}>{t(m.is_active ? 'access.disable' : 'access.enable')}</button></td>
            </tr>)}</tbody></table></div>
          <form className="acc-add-access" onSubmit={addAccess} aria-label={t('systemAdmin.addAccess')}>
            <label>{t('systemAdmin.company')}<select value={addCompanyId} disabled={busy || addable.length === 0} onChange={(event) => { setAddCompanyId(event.target.value); setAddRoleId(''); if (event.target.value && !rolesByCompany[event.target.value]) void loadRoles(event.target.value).catch(fail); }}>
              <option value="">{t('systemAdmin.chooseCompany')}</option>
              {addable.map((c) => <option key={c.id} value={c.id}>{companyLabel(c)}</option>)}
            </select></label>
            <label>{t('access.role')}<select value={addRoleId} disabled={busy || !addCompanyId} onChange={(event) => setAddRoleId(event.target.value)}>
              <option value="">{t('access.noRole')}</option>
              {(rolesByCompany[addCompanyId] ?? []).map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
            </select></label>
            <button type="submit" className="acc-primary" disabled={busy || !addCompanyId}>{t('systemAdmin.addAccess')}</button>
          </form>
        </>}
      </div>
    </div>}
    {view === 'companies' && <div className="acc-card">
      <div className="acc-bulk"><button type="button" className="acc-primary" onClick={() => { setError(null); setDialog('createCompany'); }}>{t('systemAdmin.createCompany')}</button></div>
      <div className="acc-table"><table><thead><tr><th>{t('systemAdmin.company')}</th><th>{t('systemAdmin.slug')}</th><th>{t('access.status')}</th><th>{t('access.actions')}</th></tr></thead>
        <tbody>{companies.map((c) => <tr key={c.id}>
          <td>{companyLabel(c)}</td><td dir="ltr">{c.slug}</td>
          <td><StatusBadge status={c.is_active ? 'open' : 'closed'}>{t(c.is_active ? 'access.active' : 'access.inactive')}</StatusBadge></td>
          <td><button className="acc-ghost" disabled={busy} onClick={() => void mutate(() => request(`/api/admin/companies/${c.id}/active`, json('PATCH', { is_active: !c.is_active }), onUnauthorized))}>{t(c.is_active ? 'systemAdmin.disableCompany' : 'systemAdmin.enableCompany')}</button></td>
        </tr>)}</tbody></table></div>
    </div>}
    {pending && <GrantConfirmDialog pending={pending} busy={busy} onCancel={() => setPending(null)} />}
    {dialog === 'createUser' && <Dialog title={t('systemAdmin.createUserTitle')} busy={busy} onClose={() => setDialog(null)}>{dialogError}
      <form onSubmit={createUser} className="acc-form"><label>{t('access.email')}<input name="email" type="email" required maxLength={254} dir="ltr" /></label>
        <label>{t('access.password')}<input name="password" type="password" required minLength={8} maxLength={256} dir="ltr" autoComplete="new-password" /></label><small>{t('access.passwordHint')}</small>
        <div className="modal-actions"><button type="button" className="acc-ghost" onClick={() => setDialog(null)}>{t('common.cancel')}</button><button className="acc-primary" type="submit" disabled={busy}>{busy ? t('access.saving') : t('access.create')}</button></div></form></Dialog>}
    {dialog === 'createCompany' && <Dialog title={t('systemAdmin.createCompany')} busy={busy} onClose={() => setDialog(null)}>{dialogError}
      <form onSubmit={createCompany} className="acc-form">
        <label>{t('systemAdmin.slug')}<input name="slug" required maxLength={64} pattern="[a-z0-9]+(-[a-z0-9]+)*" dir="ltr" /></label>
        <label>{t('systemAdmin.nameEn')}<input name="name" required maxLength={200} /></label>
        <label>{t('systemAdmin.nameAr')}<input name="name_ar" maxLength={200} dir="rtl" /></label>
        <small>{t('systemAdmin.createCompanyHint')}</small>
        <div className="modal-actions"><button type="button" className="acc-ghost" onClick={() => setDialog(null)}>{t('common.cancel')}</button><button className="acc-primary" type="submit" disabled={busy}>{busy ? t('access.saving') : t('access.create')}</button></div></form></Dialog>}
  </div>;
}
