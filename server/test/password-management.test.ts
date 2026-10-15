import bcrypt from 'bcrypt';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';

const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() } as unknown as PoolClient;
vi.mock('../src/db/pool', () => ({ default: { query: vi.fn(), connect: vi.fn(async () => client) } as unknown as Pool }));

import { authRouter, passwordChangeRateLimiter } from '../src/modules/auth/auth.router';
import { accessAdministrationRouter, passwordResetRateLimiter } from '../src/modules/memberships/access-administration.router';
import { requireAuth } from '../src/modules/auth/auth.middleware';
import { SessionRepository } from '../src/modules/auth/session.repository';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';
import { UserRepository } from '../src/modules/users/user.repository';
import { AuditLogRepository } from '../src/modules/audit-log/audit-log.repository';
import type { Membership, Role } from '../src/modules/memberships/membership.types';

const A = 'company-a';
const now = new Date();
const role = (id: string, full = false, companyId = A): Role => ({ id, company_id: companyId, name: id, is_full_access: full, created_at: now });
const member = (id: string, userId: string, roleId: string | null, companyId = A): Membership => ({ id, user_id: userId, company_id: companyId, role_id: roleId, is_active: true, created_at: now, updated_at: now });

const roles: Record<string, Role> = { full: role('full', true), mgr: role('mgr'), hr: role('hr'), staff: role('staff'), other: role('other', false, 'company-b') };
const roleCaps: Record<string, string[]> = { full: [], mgr: ['access.membership.status.edit', 'access.user.password.reset'], hr: ['access.user.password.reset'], staff: ['sales.view'], other: [] };
const members: Record<string, Membership> = {
  owner: member('00000000-0000-4000-8000-000000000001', 'owner', 'full'), mgr: member('00000000-0000-4000-8000-000000000002', 'mgr', 'mgr'), hr: member('00000000-0000-4000-8000-000000000003', 'hr', 'hr'), staff: member('00000000-0000-4000-8000-000000000004', 'staff', 'staff'),
  shared: member('00000000-0000-4000-8000-000000000005', 'shared', 'staff'), foreign: member('00000000-0000-4000-8000-000000000006', 'foreign', 'other', 'company-b'), sysadmin: member('00000000-0000-4000-8000-000000000007', 'sa', 'staff'),
};
let actor = 'owner';
let actorIsSystemAdmin = false;
let mustChange = false;
const capsOf = (userId: string) => {
  const m = Object.values(members).find((x) => x.user_id === userId && x.company_id === A);
  if (!m?.role_id) return [];
  return roles[m.role_id]!.is_full_access ? ['access.view', 'access.full_access.grant', 'access.user.password.reset', 'sales.view'] : roleCaps[m.role_id]!;
};

const app = express();
app.use(express.json());
app.use('/api', authRouter);
app.use('/api', accessAdministrationRouter);
app.get('/api/guarded', requireAuth, (_req, res) => { res.json({ ok: true }); });
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: String(error) }));

const session = () => ({ id: 's', user_id: actor, user_email: `${actor}@example.com`, token_hash: 'h', active_company_id: A, expires_at: new Date(Date.now() + 60_000), created_at: now, updated_at: now, user_is_system_admin: actorIsSystemAdmin, user_must_change_password: mustChange });
const cookie = 'eqfal_session=token';
const origin = { 'Sec-Fetch-Site': 'same-origin' };

let setPassword: ReturnType<typeof vi.spyOn>;
let deleteAll: ReturnType<typeof vi.spyOn>;
let logEvent: ReturnType<typeof vi.spyOn>;
let outsideCompany: Set<string>;

beforeEach(() => {
  vi.restoreAllMocks();
  passwordChangeRateLimiter.reset(); passwordResetRateLimiter.reset();
  actor = 'owner'; actorIsSystemAdmin = false; mustChange = false; outsideCompany = new Set(['shared']);
  vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockImplementation(async () => session());
  vi.spyOn(SessionRepository.prototype, 'updateActiveCompany').mockResolvedValue();
  vi.spyOn(SessionRepository.prototype, 'create').mockResolvedValue({} as never);
  deleteAll = vi.spyOn(SessionRepository.prototype, 'deleteAllForUser').mockResolvedValue();
  vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue([{ membership_id: 'x', company_id: A, company_name: 'A', company_name_ar: null, role_id: 'r' }]);
  vi.spyOn(MembershipRepository.prototype, 'listAllActiveCompaniesForSystemAdmin').mockResolvedValue([{ membership_id: 'x', company_id: A, company_name: 'A', company_name_ar: null, role_id: 'r' }]);
  vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockImplementation(async (userId) => (actorIsSystemAdmin && userId === actor ? [...capsOf('owner'), 'access.user.password.reset'] : capsOf(userId)));
  vi.spyOn(MembershipRepository.prototype, 'findMembershipById').mockImplementation(async (id) => Object.values(members).find((m) => m.id === id) ?? null);
  vi.spyOn(MembershipRepository.prototype, 'findRoleById').mockImplementation(async (id) => roles[id] ?? null);
  vi.spyOn(MembershipRepository.prototype, 'getRoleCapabilities').mockImplementation(async (id) => roleCaps[id] ?? []);
  vi.spyOn(MembershipRepository.prototype, 'isActiveSystemAdmin').mockImplementation(async (userId) => (userId === actor && actorIsSystemAdmin) || userId === 'sa');
  vi.spyOn(MembershipRepository.prototype, 'hasMembershipOutsideCompany').mockImplementation(async (userId) => outsideCompany.has(userId));
  setPassword = vi.spyOn(UserRepository.prototype, 'setPassword').mockResolvedValue();
  logEvent = vi.spyOn(AuditLogRepository.prototype, 'logEvent').mockResolvedValue({} as never);
});

const reset = (membershipId: string) => request(app).post(`/api/access/memberships/${membershipId}/reset-password`).set('Cookie', cookie).set(origin).send({});

describe('administrative password reset', () => {
  it('Full Access resets a staff member: temp password shown once, hash stored, must-change set, sessions ended, audit without secrets', async () => {
    const response = await reset('00000000-0000-4000-8000-000000000004');
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const { temporaryPassword, mustChangePassword } = response.body;
    expect(mustChangePassword).toBe(true);
    expect(temporaryPassword).toMatch(/^[A-Za-z2-9]{16}$/);
    const [userId, hash, flag] = setPassword.mock.calls[0]!;
    expect([userId, flag]).toEqual(['staff', true]);
    expect(hash).not.toBe(temporaryPassword);
    expect(await bcrypt.compare(temporaryPassword, hash as string)).toBe(true);
    expect(deleteAll).toHaveBeenCalledWith('staff', client);
    const audit = JSON.stringify(logEvent.mock.calls[0]![0]);
    expect(audit).toContain('access.user.password.reset');
    expect(audit).not.toContain(temporaryPassword);
    expect(audit).not.toContain(hash as string);
    expect(audit).not.toMatch(/password_hash|"password"/);
  });

  it('delegated holder can reset ordinary staff but not managers, Full Access, System Admins or itself', async () => {
    actor = 'hr';
    expect((await reset('00000000-0000-4000-8000-000000000004')).status).toBe(200);
    for (const id of ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000007']) {
      const response = await reset(id);
      expect([id, response.status]).toEqual([id, 403]);
      expect(response.body.code).toBe('ACCESS_TARGET_PRIVILEGE');
    }
    const self = await reset('00000000-0000-4000-8000-000000000003');
    expect(self.status).toBe(403);
    expect(self.body.code).toBe('ACCESS_SELF_PASSWORD_RESET');
    expect(setPassword).toHaveBeenCalledTimes(1);
  });

  it('refuses accounts that also belong to another company, unless the actor is a System Admin', async () => {
    const blocked = await reset('00000000-0000-4000-8000-000000000005');
    expect(blocked.status).toBe(403);
    expect(blocked.body.code).toBe('ACCESS_PASSWORD_RESET_CROSS_COMPANY');
    expect(setPassword).not.toHaveBeenCalled();
    actorIsSystemAdmin = true;
    expect((await reset('00000000-0000-4000-8000-000000000005')).status).toBe(200);
  });

  it('treats another company\'s or unknown memberships exactly like a missing one', async () => {
    const foreign = await reset('00000000-0000-4000-8000-000000000006');
    const unknown = await reset('00000000-0000-4000-8000-000000000008');
    expect([foreign.status, unknown.status]).toEqual([404, 404]);
    expect(foreign.body).toEqual(unknown.body);
    expect((await reset('not-a-uuid')).status).toBe(400);
  });

  it('requires the explicit capability, a same-origin request and an empty body', async () => {
    actor = 'staff';
    expect((await reset('00000000-0000-4000-8000-000000000003')).status).toBe(403);
    actor = 'owner';
    const noOrigin = await request(app).post('/api/access/memberships/00000000-0000-4000-8000-000000000004/reset-password').set('Cookie', cookie).send({});
    expect(noOrigin.status).toBe(403);
    expect(setPassword).not.toHaveBeenCalled();
  });

  it('rate limits repeated resets of one account without refunds', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await reset('00000000-0000-4000-8000-000000000004')).status);
    expect(statuses.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });
});

describe('own password change', () => {
  let hash: string;
  beforeEach(async () => {
    hash = await bcrypt.hash('OldPassw0rd!', 4);
    actor = 'staff';
    vi.spyOn(UserRepository.prototype, 'findById').mockResolvedValue({ id: 'staff', email: 'staff@example.com', password_hash: hash, is_active: true, created_at: now, updated_at: now });
  });
  const change = (body: unknown) => request(app).post('/api/auth/change-password').set('Cookie', cookie).set(origin).send(body as object);

  it('requires authentication and same origin', async () => {
    expect((await request(app).post('/api/auth/change-password').set(origin).send({})).status).toBe(401);
    expect((await request(app).post('/api/auth/change-password').set('Cookie', cookie).send({ currentPassword: 'a', newPassword: 'b' })).status).toBe(403);
  });

  it('requires the current password and never stores anything on failure', async () => {
    const wrong = await change({ currentPassword: 'wrong-password', newPassword: 'Brand-new-pass-1' });
    expect(wrong.status).toBe(400);
    expect(wrong.body.code).toBe('INVALID_CURRENT_PASSWORD');
    expect(setPassword).not.toHaveBeenCalled();
    expect((await change({ newPassword: 'Brand-new-pass-1' })).status).toBe(400);
    expect((await change({ currentPassword: 'OldPassw0rd!', newPassword: 'Brand-new-pass-1', is_active: true })).status).toBe(400);
  });

  it('enforces the password policy on the server', async () => {
    expect((await change({ currentPassword: 'OldPassw0rd!', newPassword: 'short' })).body.code).toBe('PASSWORD_TOO_SHORT');
    expect((await change({ currentPassword: 'OldPassw0rd!', newPassword: 'OldPassw0rd!' })).body.code).toBe('PASSWORD_SAME_AS_CURRENT');
    expect(setPassword).not.toHaveBeenCalled();
  });

  it('changes the password, ends every session, rotates this browser\'s session and returns no secrets', async () => {
    const response = await change({ currentPassword: 'OldPassw0rd!', newPassword: 'Brand-new-pass-1' });
    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(setPassword.mock.calls[0]![0]).toBe('staff');
    expect(setPassword.mock.calls[0]![2]).toBe(false);
    expect(await bcrypt.compare('Brand-new-pass-1', setPassword.mock.calls[0]![1] as string)).toBe(true);
    expect(deleteAll).toHaveBeenCalledWith('staff', client);
    expect(response.headers['set-cookie']?.[0]).toMatch(/^eqfal_session=[\w-]{20,}.*HttpOnly/);
    expect(response.headers['set-cookie']?.[0]).not.toContain('token;');
    expect(JSON.stringify(response.body)).not.toMatch(/password_hash|"password"|\$2[aby]\$/i);
    expect(JSON.stringify(logEvent.mock.calls)).not.toMatch(/Brand-new|OldPass|\$2[aby]\$/);
  });

  it('throttles repeated wrong current passwords', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i += 1) statuses.push((await change({ currentPassword: 'nope-nope-1', newPassword: 'Brand-new-pass-1' })).status);
    expect(statuses).toEqual([400, 400, 400, 400, 400, 429, 429]);
  });
});

describe('required password change gate', () => {
  it('blocks every authenticated API route and company switching until the password is changed, but not session read or logout', async () => {
    mustChange = true;
    actor = 'staff';
    const guarded = await request(app).get('/api/guarded').set('Cookie', cookie);
    expect(guarded.status).toBe(403);
    expect(guarded.body.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await reset('00000000-0000-4000-8000-000000000003')).status).toBe(403);
    expect((await request(app).post('/api/auth/switch-company').set('Cookie', cookie).set(origin).send({ companyId: A })).status).toBe(403);
    const read = await request(app).get('/api/auth/session').set('Cookie', cookie);
    expect(read.status).toBe(200);
    expect(read.body.user.mustChangePassword).toBe(true);
    expect((await request(app).post('/api/auth/logout').set('Cookie', cookie).set(origin)).status).toBe(204);
    mustChange = false;
    expect((await request(app).get('/api/guarded').set('Cookie', cookie)).status).toBe(200);
  });
});
