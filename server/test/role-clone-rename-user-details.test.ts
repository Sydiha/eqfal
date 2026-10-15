import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';

const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() } as unknown as PoolClient;
vi.mock('../src/db/pool', () => ({ default: { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as Pool }));

import { accessAdministrationRouter } from '../src/modules/memberships/access-administration.router';
import { SessionRepository } from '../src/modules/auth/session.repository';
import { MembershipRepository, type UserMembershipRow } from '../src/modules/memberships/membership.repository';
import { AuditLogRepository } from '../src/modules/audit-log/audit-log.repository';
import type { Role } from '../src/modules/memberships/membership.types';

const A = 'company-a', B = 'company-b', C = 'company-c';
const now = new Date();
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const role = (n: number, company: string, name: string, full = false): Role => ({ id: uuid(n), company_id: company, name, is_full_access: full, created_at: now });

const FULL = uuid(1), MGR = uuid(2), ACCT = uuid(3), HRMGR = uuid(4), VIEWER = uuid(5), FOREIGN = uuid(6), B_VIEW = uuid(7);
const roles: Record<string, Role> = {
  [FULL]: role(1, A, 'Full Access', true), [MGR]: role(2, A, 'Company Manager'), [ACCT]: role(3, A, 'Accountant'),
  [HRMGR]: role(4, A, 'Delegated Manager'), [VIEWER]: role(5, A, 'Viewer'), [FOREIGN]: role(6, B, 'Foreign'), [B_VIEW]: role(7, B, 'B Viewer'),
};
const roleCaps: Record<string, string[]> = {
  [FULL]: [],
  [MGR]: ['access.view', 'access.role.create', 'access.role.capability.grant', 'access.membership.role.assign', 'invoice.view'],
  [ACCT]: ['accounting.journal.create', 'bank.reconcile', 'invoice.view'],
  [HRMGR]: ['access.view', 'access.role.create', 'access.membership.role.assign', 'access.full_access.grant', 'invoice.view'],
  [VIEWER]: ['invoice.view'], [FOREIGN]: ['invoice.view'], [B_VIEW]: ['access.view', 'invoice.view'],
};
const ALL = ['access.view', 'access.role.create', 'access.role.capability.grant', 'access.membership.role.assign', 'access.full_access.grant', 'accounting.journal.create', 'bank.reconcile', 'invoice.view'];

interface M { id: string; user: string; company: string; role: string | null; active: boolean }
const memberships: M[] = [
  { id: uuid(101), user: 'owner', company: A, role: FULL, active: true },
  { id: uuid(102), user: 'mgr', company: A, role: MGR, active: true },
  { id: uuid(103), user: 'mgr', company: B, role: B_VIEW, active: true },
  { id: uuid(104), user: 'multi', company: A, role: ACCT, active: true },
  { id: uuid(105), user: 'multi', company: B, role: B_VIEW, active: true },
  { id: uuid(106), user: 'multi', company: C, role: null, active: true },
  { id: uuid(107), user: 'dm', company: A, role: HRMGR, active: true },
  { id: uuid(108), user: 'staff', company: A, role: VIEWER, active: false },
  { id: uuid(109), user: 'sa', company: A, role: null, active: true },
  { id: uuid(110), user: 'foreigner', company: B, role: FOREIGN, active: true },
];
const names: Record<string, string> = { [A]: 'Alpha', [B]: 'Beta', [C]: 'Gamma' };
let actor = 'owner';
const systemAdmins = new Set(['sa']);

const capsOf = (userId: string, company: string): string[] => {
  if (systemAdmins.has(userId)) return ALL;
  const m = memberships.find((x) => x.user === userId && x.company === company);
  if (!m || !m.active || !m.role) return [];
  return roles[m.role]!.is_full_access ? ALL : roleCaps[m.role]!;
};

const app = express();
app.use(express.json());
app.use('/api', accessAdministrationRouter);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: String(error) }));
const session = () => ({ id: 's', user_id: actor, user_email: `${actor}@example.com`, token_hash: 'h', active_company_id: A, expires_at: new Date(Date.now() + 60_000), created_at: now, updated_at: now });
const cookie = 'eqfal_session=token';
const origin = { 'Sec-Fetch-Site': 'same-origin' };

let logEvent: ReturnType<typeof vi.spyOn>;
let createRole: ReturnType<typeof vi.spyOn>;
let addCap: ReturnType<typeof vi.spyOn>;
let renameRole: ReturnType<typeof vi.spyOn>;
let created: Role[];

beforeEach(() => {
  vi.restoreAllMocks();
  actor = 'owner'; created = [];
  vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockImplementation(async () => session());
  vi.spyOn(SessionRepository.prototype, 'updateActiveCompany').mockResolvedValue();
  vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue([{ membership_id: 'x', company_id: A, company_name: 'A', company_name_ar: null, role_id: 'r' }]);
  vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockImplementation(async (u, c) => [...capsOf(u, c)]);
  vi.spyOn(MembershipRepository.prototype, 'findMembershipById').mockImplementation(async (id) => {
    const m = memberships.find((x) => x.id === id);
    return m ? { id: m.id, user_id: m.user, company_id: m.company, role_id: m.role, is_active: m.active, created_at: now, updated_at: now } : null;
  });
  vi.spyOn(MembershipRepository.prototype, 'findRoleById').mockImplementation(async (id) => roles[id] ?? created.find((r) => r.id === id) ?? null);
  vi.spyOn(MembershipRepository.prototype, 'getRoleCapabilities').mockImplementation(async (id) => roleCaps[id] ?? []);
  vi.spyOn(MembershipRepository.prototype, 'isActiveSystemAdmin').mockImplementation(async (u) => systemAdmins.has(u));
  vi.spyOn(MembershipRepository.prototype, 'findUserSummary').mockImplementation(async (id) => ({ id, email: `${id}@example.com`, is_active: true, is_system_admin: systemAdmins.has(id) }));
  vi.spyOn(MembershipRepository.prototype, 'listMembershipsOfUser').mockImplementation(async (userId) => memberships.filter((m) => m.user === userId).map((m): UserMembershipRow => ({
    membership_id: m.id, company_id: m.company, company_name: names[m.company]!, company_name_ar: null, company_is_active: true, is_active: m.active,
    role_id: m.role, role_name: m.role ? roles[m.role]!.name : null, role_is_full_access: m.role ? roles[m.role]!.is_full_access : false,
  })));
  createRole = vi.spyOn(MembershipRepository.prototype, 'createRole').mockImplementation(async (input) => { const r = { id: uuid(900 + created.length), company_id: input.company_id, name: input.name, is_full_access: false, created_at: now }; created.push(r); return r; });
  addCap = vi.spyOn(MembershipRepository.prototype, 'addCapabilityToRole').mockResolvedValue();
  renameRole = vi.spyOn(MembershipRepository.prototype, 'renameRole').mockImplementation(async (id, company, name) => { const r = roles[id]; return r && r.company_id === company ? { ...r, name } : null; });
  logEvent = vi.spyOn(AuditLogRepository.prototype, 'logEvent').mockResolvedValue({} as never);
});

const details = (id: string) => request(app).get(`/api/access/memberships/${id}/details`).set('Cookie', cookie);
const clone = (id: string, body: unknown) => request(app).post(`/api/access/roles/${id}/clone`).set('Cookie', cookie).set(origin).send(body as object);
const rename = (id: string, body: unknown) => request(app).patch(`/api/access/roles/${id}`).set('Cookie', cookie).set(origin).send(body as object);

describe('consolidated user details and cross-company isolation', () => {
  it('shows only companies the administrator may view; hides the rest without any count or name', async () => {
    actor = 'mgr'; // access.view in A and B, no membership in C
    const response = await details(uuid(104));
    expect(response.status).toBe(200);
    expect(response.body.companies.map((c: { company_id: string }) => c.company_id)).toEqual([A, B]);
    expect(JSON.stringify(response.body)).not.toMatch(/Gamma|company-c/);
    expect(Object.keys(response.body)).toEqual(['user', 'companies']);
  });

  it('a company without access.view in the other company never leaks it', async () => {
    actor = 'dm'; // access.view in A only
    const response = await details(uuid(105));
    expect(response.status).toBe(404); // membership of B is not in the active company A
    const ok = await details(uuid(104));
    expect(ok.body.companies.map((c: { company_id: string }) => c.company_id)).toEqual([A]);
  });

  it('a membership id from another company is indistinguishable from an unknown id', async () => {
    const foreign = await details(uuid(110));
    const unknown = await details(uuid(999));
    expect(foreign.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(foreign.body).toEqual(unknown.body);
  });

  it('requires access.view and a valid id; the company comes from the session only', async () => {
    actor = 'staff';
    expect((await details(uuid(104))).status).toBe(403);
    actor = 'mgr';
    expect((await details('not-a-uuid')).status).toBe(400);
    expect((await request(app).get(`/api/access/memberships/${uuid(104)}/details?company_id=${C}`).set('Cookie', cookie)).body.companies.map((c: { company_id: string }) => c.company_id)).toEqual([A, B]);
  });

  it('separates role capabilities from effective permissions: explicit rows vs Full Access wildcard vs System Admin global', async () => {
    const acct = (await details(uuid(104))).body.companies[0];
    expect(acct).toMatchObject({ effective_source: 'role', is_current_company: true, role: { name: 'Accountant', is_full_access: false } });
    expect(acct.role_capabilities).toEqual(['accounting.journal.create', 'bank.reconcile', 'invoice.view']);
    expect(acct.effective_capabilities).toEqual(['accounting.journal.create', 'bank.reconcile', 'invoice.view']);

    const owner = (await details(uuid(101))).body.companies[0];
    expect(owner).toMatchObject({ effective_source: 'full_access_wildcard', role_capabilities: [] });
    expect(owner.effective_capabilities).toEqual([...ALL].sort());

    const sa = (await details(uuid(109))).body;
    expect(sa.user.is_system_admin).toBe(true);
    expect(sa.companies[0].effective_source).toBe('system_admin_global');
  });

  it('a disabled membership and a member without a role have no effective capabilities', async () => {
    const disabled = (await details(uuid(108))).body.companies[0];
    expect(disabled).toMatchObject({ is_active: false, effective_source: 'none', effective_capabilities: [] });
    actor = 'mgr';
    const noRole = (await details(uuid(104))).body.companies.find((c: { company_id: string }) => c.company_id === B);
    expect(noRole.role.name).toBe('B Viewer');
  });
});

describe('role cloning', () => {
  it('copies functional capabilities into a new role of the same company, assigns it to nobody and audits it', async () => {
    const response = await clone(ACCT, { name: 'Accountant copy' });
    expect(response.status).toBe(201);
    expect(response.body.copied_capabilities).toEqual(['accounting.journal.create', 'bank.reconcile', 'invoice.view']);
    expect(response.body.omitted_capabilities).toEqual([]);
    expect(createRole).toHaveBeenCalledWith({ company_id: A, name: 'Accountant copy' }, expect.anything());
    expect(addCap).toHaveBeenCalledTimes(3);
    expect(memberships.every((m) => m.role !== response.body.role.id)).toBe(true);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'access.role.clone', company_id: A, actor_user_id: 'owner', entity_id: response.body.role.id }), expect.anything());
  });

  it('never silently duplicates privileged administrative capabilities: they are omitted and reported', async () => {
    const response = await clone(HRMGR, { name: 'Manager copy' });
    expect(response.status).toBe(201);
    expect(response.body.copied_capabilities).toEqual(['access.view', 'invoice.view']); // read-only access.view is not administrative authority
    expect(response.body.omitted_capabilities).toEqual(['access.full_access.grant', 'access.membership.role.assign', 'access.role.create']);
    const granted = addCap.mock.calls.map((c) => c[1]);
    expect(granted).toEqual(['access.view', 'invoice.view']);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'access.role.clone', after_data: expect.objectContaining({ omitted_administrative_capabilities: expect.arrayContaining(['access.full_access.grant']) }) }), expect.anything());
  });

  it('refuses to clone the protected Full Access role', async () => {
    const response = await clone(FULL, { name: 'Another Full Access' });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ACCESS_FULL_ACCESS_IMMUTABLE');
    expect(createRole).not.toHaveBeenCalled();
  });

  it('a role of another company is not found, and nothing is written', async () => {
    const response = await clone(FOREIGN, { name: 'Steal' });
    expect(response.status).toBe(404);
    expect(createRole).not.toHaveBeenCalled();
  });

  it('a Company Manager can clone without gaining the cloned functional capabilities personally', async () => {
    actor = 'mgr';
    const response = await clone(ACCT, { name: 'Accountant 2' });
    expect(response.status).toBe(201);
    expect(memberships.find((m) => m.user === 'mgr' && m.company === A)!.role).toBe(MGR);
    expect(capsOf('mgr', A)).not.toContain('accounting.journal.create');
  });

  it('self-escalation through a clone is still blocked: a manager cannot assign themselves the cloned functional role', async () => {
    actor = 'mgr';
    const assign = vi.spyOn(MembershipRepository.prototype, 'assignRoleToMembership');
    vi.spyOn(MembershipRepository.prototype, 'getRoleCapabilities').mockImplementation(async (id) => roleCaps[id] ?? (created.some((r) => r.id === id) ? ['accounting.journal.create'] : []));
    const copy = (await clone(ACCT, { name: 'Accountant 3' })).body.role;
    const response = await request(app).put(`/api/access/memberships/${uuid(102)}/role`).set('Cookie', cookie).set(origin).send({ role_id: copy.id });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ACCESS_ROLE_CEILING');
    expect(assign).not.toHaveBeenCalled();
  });

  it('requires access.role.create, same origin and a valid body', async () => {
    actor = 'staff';
    expect((await clone(ACCT, { name: 'x' })).status).toBe(403);
    actor = 'owner';
    expect((await request(app).post(`/api/access/roles/${ACCT}/clone`).set('Cookie', cookie).send({ name: 'x' })).status).toBe(403);
    expect((await clone(ACCT, { name: '  ' })).status).toBe(400);
    expect((await clone(ACCT, { name: 'x', is_full_access: true })).status).toBe(400);
    expect((await clone(ACCT, { name: 'x'.repeat(101) })).status).toBe(400);
    expect((await clone('bad', { name: 'x' })).status).toBe(400);
    expect(createRole).not.toHaveBeenCalled();
  });
});

describe('role renaming', () => {
  it('renames an ordinary role, leaving capabilities and memberships alone, with an audit record', async () => {
    const response = await rename(ACCT, { name: ' Senior Accountant ' });
    expect(response.status).toBe(200);
    expect(response.body.name).toBe('Senior Accountant');
    expect(addCap).not.toHaveBeenCalled();
    expect(memberships.find((m) => m.id === uuid(104))!.role).toBe(ACCT);
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'access.role.rename', before_data: expect.objectContaining({ name: 'Accountant' }), after_data: expect.objectContaining({ name: 'Senior Accountant' }) }), expect.anything());
  });

  it('cannot rename the protected Full Access role, even for Full Access itself', async () => {
    const response = await rename(FULL, { name: 'Boss' });
    expect(response.status).toBe(403);
    expect(response.body.code).toBe('ACCESS_FULL_ACCESS_IMMUTABLE');
    expect(renameRole).not.toHaveBeenCalled();
  });

  it('a Company Manager may rename functional roles but not roles that carry administrative authority', async () => {
    actor = 'mgr';
    expect((await rename(ACCT, { name: 'Accounts' })).status).toBe(200);
    const blocked = await rename(HRMGR, { name: 'Renamed manager' });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('ACCESS_TARGET_PRIVILEGE');
    actor = 'dm'; // holds access.full_access.grant
    expect((await rename(HRMGR, { name: 'Renamed manager' })).status).toBe(200);
  });

  it('is company scoped: a foreign role is not found; unchanged name writes no audit; invalid bodies are rejected', async () => {
    expect((await rename(FOREIGN, { name: 'x' })).status).toBe(404);
    logEvent.mockClear();
    expect((await rename(ACCT, { name: 'Accountant' })).status).toBe(200);
    expect(logEvent).not.toHaveBeenCalled();
    expect((await rename(ACCT, { name: '' })).status).toBe(400);
    expect((await rename(ACCT, { name: 'x', is_full_access: true })).status).toBe(400);
    actor = 'staff';
    expect((await rename(ACCT, { name: 'x' })).status).toBe(403);
  });

  it('a duplicate name maps to a conflict', async () => {
    renameRole.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: '23505' }));
    expect((await rename(ACCT, { name: 'Viewer' })).status).toBe(409);
  });
});
