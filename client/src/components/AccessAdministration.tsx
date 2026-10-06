import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Dialog } from './Dialog';
import { StatusBadge, WorkspaceState } from './SharedUI';
import { capabilityGroupKey, capabilityGroupLabel, capabilityLabel, langOf } from '../labels/capabilityLabels';
import './AccessAdministration.css';

export interface AccessMembership { id: string; user_id: string; user_email: string; user_is_active: boolean; role_id: string | null; role_name: string | null; is_active: boolean }
export interface AccessRole { id: string; name: string; is_full_access: boolean; capabilities: string[] }
interface Props {
  capabilities: readonly string[];
  currentUserId: string;
  onUnauthorized: () => void;
}
type ErrorKey = 'error' | 'invalidRequest' | 'forbidden' | 'notFound' | 'conflict';
type Tab = 'members' | 'roles';
type Dialogs = 'addMember' | 'createUser' | 'createRole' | null;

class ApiError extends Error { constructor(readonly status: number) { super(`Access API returned ${status}`); } }
async function request(url: string, options: RequestInit, onUnauthorized: () => void) {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  if (response.status === 401) { onUnauthorized(); throw new ApiError(401); }
  if (!response.ok) throw new ApiError(response.status);
  return response;
}
function errorKeyFor(reason: unknown): ErrorKey {
  if (!(reason instanceof ApiError)) return 'error';
  if (reason.status === 400) return 'invalidRequest';
  if (reason.status === 403) return 'forbidden';
  if (reason.status === 404) return 'notFound';
  if (reason.status === 409) return 'conflict';
  return 'error';
}
const json = (method: string, body: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function GroupCheckbox({ label, checked, indeterminate, disabled, onChange }: { label: string; checked: boolean; indeterminate: boolean; disabled: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = indeterminate; }, [indeterminate]);
  return <label className="acc-group-check"><input ref={ref} type="checkbox" checked={checked} disabled={disabled} aria-checked={indeterminate ? 'mixed' : checked} onChange={onChange} />{label}</label>;
}

/**
 * Operational UI for memberships, roles and role capabilities of the ACTIVE company.
 * Every action is also enforced server-side (capability, tenant scope and ceiling checks);
 * hiding controls here is only a convenience.
 */
export function AccessAdministration({ capabilities, currentUserId, onUnauthorized }: Props) {
  const { t, i18n } = useTranslation();
  const lang = langOf(i18n.language);
  const can = (capability: string) => capabilities.includes(capability);
  const canView = can('access.view');
  const [tab, setTab] = useState<Tab>('members');
  const [members, setMembers] = useState<AccessMembership[]>([]);
  const [roles, setRoles] = useState<AccessRole[]>([]);
  const [allCapabilities, setAllCapabilities] = useState<string[]>([]);
  const [loading, setLoading] = useState(canView);
  const [loaded, setLoaded] = useState(false);
  const [errorKey, setErrorKey] = useState<ErrorKey | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [busy, setBusy] = useState(false);
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true); setErrorKey(null);
    try {
      const [m, r, c] = await Promise.all([
        request('/api/access/memberships', { signal }, onUnauthorized),
        request('/api/access/roles', { signal }, onUnauthorized),
        request('/api/access/capabilities', { signal }, onUnauthorized),
      ]);
      setMembers(((await m.json()) as { memberships: AccessMembership[] }).memberships);
      setRoles(((await r.json()) as { roles: AccessRole[] }).roles);
      setAllCapabilities(((await c.json()) as { capabilities: string[] }).capabilities);
      setLoaded(true);
    } catch (reason) {
      const aborted = reason instanceof DOMException && reason.name === 'AbortError';
      const unauthorized = reason instanceof ApiError && reason.status === 401;
      if (!aborted && !unauthorized) setErrorKey(errorKeyFor(reason));
    } finally { if (!signal?.aborted) setLoading(false); }
  }, [onUnauthorized]);

  useEffect(() => {
    if (!canView) return;
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [canView, load]);

  const mutate = async (work: () => Promise<unknown>, afterSuccess?: () => void) => {
    setBusy(true); setErrorKey(null);
    try { await work(); afterSuccess?.(); await load(); }
    catch (reason) { if (!(reason instanceof ApiError && reason.status === 401)) setErrorKey(errorKeyFor(reason)); }
    finally { setBusy(false); }
  };

  const selectedRole = roles.find((role) => role.id === selectedRoleId) ?? null;
  const groupedCapabilities = useMemo(() => {
    const groups = new Map<string, string[]>();
    for (const id of allCapabilities) {
      const group = capabilityGroupKey(id);
      groups.set(group, [...(groups.get(group) ?? []), id]);
    }
    return [...groups.entries()];
  }, [allCapabilities]);

  if (!canView) return <section className="panel"><WorkspaceState>{t('access.noAccess')}</WorkspaceState></section>;

  const addMember = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const email = String(new FormData(event.currentTarget).get('email') ?? '').trim();
    void mutate(() => request('/api/access/memberships', json('POST', { email }), onUnauthorized), () => setDialog(null));
  };
  const createUser = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const body: Record<string, string> = { email: String(data.get('email') ?? '').trim(), password: String(data.get('password') ?? '') };
    const roleId = String(data.get('role_id') ?? '');
    if (roleId) body.role_id = roleId;
    void mutate(() => request('/api/access/users', json('POST', body), onUnauthorized), () => setDialog(null));
  };
  const createRole = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get('name') ?? '').trim();
    void mutate(() => request('/api/access/roles', json('POST', { name }), onUnauthorized), () => setDialog(null));
  };
  const setActive = (member: AccessMembership, isActive: boolean) =>
    mutate(() => request(`/api/access/memberships/${member.id}/active`, json('PATCH', { is_active: isActive }), onUnauthorized));
  const assignRole = (member: AccessMembership, roleId: string) =>
    mutate(() => request(`/api/access/memberships/${member.id}/role`, json('PUT', { role_id: roleId }), onUnauthorized));
  const toggleCapability = (role: AccessRole, capabilityId: string, grant: boolean) =>
    mutate(() => request(`/api/access/roles/${role.id}/capabilities/${encodeURIComponent(capabilityId)}`, { method: grant ? 'PUT' : 'DELETE' }, onUnauthorized));

  /** Applies several grants/revokes one by one (same endpoints as a single checkbox); the list is always reloaded afterwards. */
  const bulkChange = (role: AccessRole, grants: string[], revokes: string[]) => {
    if (grants.length + revokes.length === 0) return;
    void mutate(async () => {
      try {
        for (const id of grants) await request(`/api/access/roles/${role.id}/capabilities/${encodeURIComponent(id)}`, { method: 'PUT' }, onUnauthorized);
        for (const id of revokes) await request(`/api/access/roles/${role.id}/capabilities/${encodeURIComponent(id)}`, { method: 'DELETE' }, onUnauthorized);
      } catch (reason) { await load(); throw reason; }
    });
  };
  const canGrantId = (id: string) => can('access.role.capability.grant') && can(id);
  const canRevokeId = () => can('access.role.capability.revoke');

  const dialogError = errorKey && dialog ? <div role="alert" className="acc-alert">{t(`access.${errorKey}`)}</div> : null;

  return <section className="panel acc-view" aria-labelledby="access-title">
    <header className="acc-header">
      <div><h2 id="access-title">{t('access.title')}</h2><p>{t('access.description')}</p></div>
      {tab === 'members' && can('access.membership.create') && <button className="acc-ghost" onClick={() => { setErrorKey(null); setDialog('createUser'); }}>{t('access.createUser')}</button>}
      {tab === 'members' && can('access.membership.create') && <button className="acc-primary" onClick={() => { setErrorKey(null); setDialog('addMember'); }}>{t('access.addMember')}</button>}
      {tab === 'roles' && can('access.role.create') && <button className="acc-primary" onClick={() => { setErrorKey(null); setDialog('createRole'); }}>{t('access.createRole')}</button>}
    </header>
    <div role="tablist" aria-label={t('access.tabs')} className="acc-tabs">
      <button role="tab" aria-selected={tab === 'members'} className={tab === 'members' ? 'is-active' : ''} onClick={() => setTab('members')}>{t('access.membersTab')}</button>
      <button role="tab" aria-selected={tab === 'roles'} className={tab === 'roles' ? 'is-active' : ''} onClick={() => setTab('roles')}>{t('access.rolesTab')}</button>
    </div>
    {errorKey && !dialog && <WorkspaceState tone="error" action={<button onClick={() => void load()}>{t('access.retry')}</button>}>{t(`access.${errorKey}`)}</WorkspaceState>}
    {loading && !loaded ? <WorkspaceState>{t('access.loading')}</WorkspaceState> : loaded && tab === 'members' && <div className="acc-card">
      <p className="acc-hint">{t('access.disableHint')}</p>
      <div className="acc-table"><table><thead><tr><th>{t('access.user')}</th><th>{t('access.role')}</th><th>{t('access.status')}</th><th>{t('access.actions')}</th></tr></thead>
        <tbody>{members.length === 0 ? <tr><td colSpan={4} className="acc-empty">{t('access.membersEmpty')}</td></tr> : members.map((member) => <tr key={member.id}>
          <td dir="ltr" className="acc-user">{member.user_email}{!member.user_is_active && <small> · {t('access.userDisabled')}</small>}</td>
          <td>{can('access.membership.role.assign')
            ? <select aria-label={`${t('access.role')} ${member.user_email}`} value={member.role_id ?? ''} disabled={busy} onChange={(event) => event.target.value && void assignRole(member, event.target.value)}>
                <option value="" disabled>{t('access.noRole')}</option>
                {roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}
              </select>
            : (member.role_name ?? t('access.noRole'))}</td>
          <td><StatusBadge status={member.is_active ? 'open' : 'closed'}>{t(member.is_active ? 'access.active' : 'access.inactive')}</StatusBadge></td>
          <td>{can('access.membership.status.edit') && <button className="acc-ghost" disabled={busy || (member.is_active && member.user_id === currentUserId)} onClick={() => void setActive(member, !member.is_active)}>{t(member.is_active ? 'access.disable' : 'access.enable')}</button>}</td>
        </tr>)}</tbody></table></div>
    </div>}
    {loaded && tab === 'roles' && <div className="acc-roles">
      <ul className="acc-role-list" aria-label={t('access.rolesTab')}>
        {roles.length === 0 ? <li className="acc-empty">{t('access.rolesEmpty')}</li> : roles.map((role) => <li key={role.id}>
          <button className={role.id === selectedRoleId ? 'is-active' : ''} aria-pressed={role.id === selectedRoleId} onClick={() => setSelectedRoleId(role.id)}>
            <strong>{role.name}</strong>
            <span>{role.is_full_access ? t('access.fullAccess') : t('access.capabilityCount', { count: role.capabilities.length })}</span>
          </button>
        </li>)}
      </ul>
      <div className="acc-card acc-capabilities">
        {!selectedRole ? <p className="acc-hint">{t('access.selectRole')}</p> : <>
          <h3>{t('access.capabilities')} — {selectedRole.name}</h3>
          {selectedRole.is_full_access ? <p className="acc-hint">{t('access.fullAccessNote')}</p> : <>
            <p className="acc-hint">{t('access.ceilingNote')}</p>
            {(() => {
              const grantable = allCapabilities.filter((id) => !selectedRole.capabilities.includes(id) && canGrantId(id));
              const revocable = allCapabilities.filter((id) => selectedRole.capabilities.includes(id) && canRevokeId());
              return <div className="acc-bulk" role="group" aria-label={t('access.bulkActions')}>
                <button type="button" className="acc-ghost" disabled={busy || grantable.length === 0} onClick={() => bulkChange(selectedRole, grantable, [])}>{t('access.selectAll')}</button>
                <button type="button" className="acc-ghost" disabled={busy || revocable.length === 0} onClick={() => bulkChange(selectedRole, [], revocable)}>{t('access.clearAll')}</button>
              </div>;
            })()}
            {groupedCapabilities.map(([group, ids]) => {
              const groupLabel = capabilityGroupLabel(group, lang);
              const grantedIds = ids.filter((id) => selectedRole.capabilities.includes(id));
              const grantable = ids.filter((id) => !grantedIds.includes(id) && canGrantId(id));
              const revocable = canRevokeId() ? grantedIds : [];
              const all = grantedIds.length === ids.length;
              return <fieldset key={group}><legend>
                <GroupCheckbox label={groupLabel} checked={all} indeterminate={grantedIds.length > 0 && !all}
                  disabled={busy || (all ? revocable.length === 0 : grantable.length === 0)}
                  onChange={() => all ? bulkChange(selectedRole, [], revocable) : bulkChange(selectedRole, grantable, [])} />
              </legend>
              {ids.map((id) => {
                const granted = grantedIds.includes(id);
                const canToggle = granted ? can('access.role.capability.revoke') : canGrantId(id);
                return <div key={id} className="acc-cap"><label><input type="checkbox" checked={granted} disabled={busy || !canToggle} onChange={() => void toggleCapability(selectedRole, id, !granted)} />{capabilityLabel(id, lang)}</label><small dir="ltr">{id}</small></div>;
              })}
            </fieldset>;
            })}
          </>}
        </>}
      </div>
    </div>}
    {dialog === 'addMember' && <Dialog title={t('access.addMemberTitle')} busy={busy} onClose={() => setDialog(null)}>{dialogError}
      <form onSubmit={addMember} className="acc-form"><label>{t('access.email')}<input name="email" type="email" required maxLength={254} dir="ltr" /></label><small>{t('access.emailHint')}</small>
        <div className="modal-actions"><button type="button" className="acc-ghost" onClick={() => setDialog(null)}>{t('common.cancel')}</button><button className="acc-primary" type="submit" disabled={busy}>{busy ? t('access.saving') : t('access.add')}</button></div></form></Dialog>}
    {dialog === 'createUser' && <Dialog title={t('access.createUserTitle')} busy={busy} onClose={() => setDialog(null)}>{dialogError}
      <form onSubmit={createUser} className="acc-form"><label>{t('access.email')}<input name="email" type="email" required maxLength={254} dir="ltr" /></label>
        <label>{t('access.password')}<input name="password" type="password" required minLength={8} maxLength={256} dir="ltr" autoComplete="new-password" /></label><small>{t('access.passwordHint')}</small>
        {can('access.membership.role.assign') && <label>{t('access.role')}<select name="role_id" defaultValue=""><option value="">{t('access.noRole')}</option>{roles.map((role) => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label>}
        <div className="modal-actions"><button type="button" className="acc-ghost" onClick={() => setDialog(null)}>{t('common.cancel')}</button><button className="acc-primary" type="submit" disabled={busy}>{busy ? t('access.saving') : t('access.create')}</button></div></form></Dialog>}
    {dialog === 'createRole' && <Dialog title={t('access.createRoleTitle')} busy={busy} onClose={() => setDialog(null)}>{dialogError}
      <form onSubmit={createRole} className="acc-form"><label>{t('access.roleName')}<input name="name" required maxLength={100} /></label>
        <div className="modal-actions"><button type="button" className="acc-ghost" onClick={() => setDialog(null)}>{t('common.cancel')}</button><button className="acc-primary" type="submit" disabled={busy}>{busy ? t('access.saving') : t('access.create')}</button></div></form></Dialog>}
  </section>;
}
