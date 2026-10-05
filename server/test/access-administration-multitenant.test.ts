import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';

const mocks = vi.hoisted(() => ({
  createMembershipByEmail: vi.fn(),
  createMembershipForCompany: vi.fn(),
  listCapabilities: vi.fn(),
  listMemberships: vi.fn(),
}));

vi.mock('../src/db/pool', () => ({ default: { query: vi.fn(), connect: vi.fn() } as unknown as Pool }));
vi.mock('../src/modules/memberships/membership.service', () => ({
  MembershipService: class {
    createMembershipByEmail = mocks.createMembershipByEmail;
    createMembershipForCompany = mocks.createMembershipForCompany;
    listCapabilities = mocks.listCapabilities;
    listMemberships = mocks.listMemberships;
  },
}));

import { accessAdministrationRouter } from '../src/modules/memberships/access-administration.router';
import { SessionRepository } from '../src/modules/auth/session.repository';
import { SessionService } from '../src/modules/auth/session.service';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';

const app = express();
app.use(express.json());
app.use('/api', accessAdministrationRouter);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: String(error) }));

const session = { id: 's', user_id: 'user', user_email: 'u@example.com', token_hash: 'h', active_company_id: 'company-a', expires_at: new Date(Date.now() + 60_000), created_at: new Date(), updated_at: new Date() };
const companyA = { membership_id: 'ma', company_id: 'company-a', company_name: 'A', company_name_ar: null, role_id: 'r' };
const grant = (caps: string[]) => {
  vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(session);
  vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue([companyA]);
  vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(caps);
};
const post = (body: unknown) => request(app).post('/api/access/memberships').set('Origin', 'http://localhost').set('Host', 'localhost').set('Cookie', 'eqfal_session=t').send(body as object);

beforeEach(() => { vi.restoreAllMocks(); Object.values(mocks).forEach((m) => m.mockReset()); });

describe('role/capability enforcement (server-side)', () => {
  it('rejects member creation without access.membership.create even with access.view', async () => {
    grant(['access.view']);
    expect((await post({ email: 'x@example.com' })).status).toBe(403);
    expect(mocks.createMembershipByEmail).not.toHaveBeenCalled();
  });

  it('requires access.view for the capability catalogue', async () => {
    grant([]);
    expect((await request(app).get('/api/access/capabilities').set('Cookie', 'eqfal_session=t')).status).toBe(403);
    grant(['access.view']);
    mocks.listCapabilities.mockResolvedValue(['a.b']);
    const ok = await request(app).get('/api/access/capabilities').set('Cookie', 'eqfal_session=t');
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ capabilities: ['a.b'] });
  });
});

describe('tenant leakage prevention', () => {
  it('adds members to the server-trusted active company and ignores/rejects a body company_id', async () => {
    grant(['access.membership.create']);
    mocks.createMembershipByEmail.mockResolvedValue({ id: 'm' });
    expect((await post({ email: 'x@example.com' })).status).toBe(201);
    expect(mocks.createMembershipByEmail).toHaveBeenCalledWith('x@example.com', 'company-a', 'user');
    const spoof = await post({ email: 'x@example.com', company_id: 'company-b' });
    expect(spoof.status).toBe(400);
    expect(mocks.createMembershipByEmail).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed email/user_id payloads and answers 404 for unknown users', async () => {
    grant(['access.membership.create']);
    expect((await post({ email: 'not-an-email' })).status).toBe(400);
    expect((await post({ email: 'a@b.co', user_id: '00000000-0000-1000-8000-000000000000' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    mocks.createMembershipByEmail.mockRejectedValue(new Error('User not found'));
    expect((await post({ email: 'ghost@example.com' })).status).toBe(404);
  });

  it('scopes membership and role listings by company_id in SQL', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const repo = new MembershipRepository({ query } as unknown as Pool);
    await repo.listMemberships('company-a');
    await repo.listRoles('company-a');
    for (const [sql, params] of query.mock.calls) {
      expect(sql).toMatch(/company_id = \$1/);
      expect(params).toEqual(['company-a']);
    }
    expect(query.mock.calls[0][0]).toMatch(/r\.company_id = m\.company_id/);
  });
});

describe('multi-company membership isolation', () => {
  it('evaluates capabilities per company with membership/role/company scope in SQL', async () => {
    const query = vi.fn().mockImplementation(async (_sql: string, params: string[]) => ({
      rows: params[1] === 'company-a' ? [{ capability_id: 'document.view' }] : [{ capability_id: 'vat.view' }, { capability_id: 'vat.edit' }],
    }));
    const repo = new MembershipRepository({ query } as unknown as Pool);
    expect(await repo.getActiveCapabilities('user', 'company-a')).toEqual(['document.view']);
    expect(await repo.getActiveCapabilities('user', 'company-b')).toEqual(['vat.view', 'vat.edit']);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('m.is_active  = TRUE');
    expect(sql).toContain('r.company_id = m.company_id');
    expect(sql).toContain('m.company_id = $2');
  });

  it('refuses to switch into a company whose membership is disabled, keeping the other company usable', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(session);
    // listActiveCompaniesForUser only returns active memberships: company-b is disabled.
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue([companyA]);
    const service = new SessionService({} as Pool);
    expect(await service.switchCompany('t', 'company-b')).toBe('forbidden');
  });
});

describe('disabled membership and permission change behavior', () => {
  it('drops the company and all capabilities on the next request once the membership is disabled', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(session);
    const update = vi.spyOn(SessionRepository.prototype, 'updateActiveCompany').mockResolvedValue(undefined as never);
    const list = vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue([companyA]);
    const caps = vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(['access.view']);
    const service = new SessionService({} as Pool);
    expect((await service.getContext('t'))?.capabilities).toEqual(['access.view']);

    list.mockResolvedValue([]); // membership disabled; the user account itself is untouched
    caps.mockClear();
    const after = await service.getContext('t');
    expect(after).toMatchObject({ activeCompanyId: null, capabilities: [], user: { id: 'user' } });
    expect(update).toHaveBeenCalledWith('s', null);
    expect(caps).not.toHaveBeenCalled();
  });

  it('applies role capability changes on the very next request (no cached permissions)', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(session);
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue([companyA]);
    const caps = vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(['access.view', 'document.view']);
    const service = new SessionService({} as Pool);
    expect((await service.getContext('t'))?.capabilities).toContain('document.view');
    caps.mockResolvedValue(['access.view']); // capability revoked from the role
    expect((await service.getContext('t'))?.capabilities).not.toContain('document.view');
  });

  it('revokes a capability inside a transaction with an audit record and no ceiling requirement', async () => {
    const { MembershipService } = await vi.importActual<typeof import('../src/modules/memberships/membership.service')>('../src/modules/memberships/membership.service');
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() } as unknown as PoolClient;
    const service = new MembershipService({ connect: vi.fn().mockResolvedValue(client), query: vi.fn() } as unknown as Pool);
    const repo = (service as unknown as { repo: MembershipRepository }).repo;
    const audit = (service as unknown as { audit: { logEvent: ReturnType<typeof vi.fn> } }).audit;
    audit.logEvent = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(repo, 'findRoleById').mockResolvedValue({ id: 'r', company_id: 'company-a', name: 'Clerk', is_full_access: false, created_at: new Date() });
    vi.spyOn(repo, 'getActiveCapabilities').mockResolvedValue([]);
    vi.spyOn(repo, 'getRoleCapabilities').mockResolvedValue(['document.view', 'document.edit']);
    const remove = vi.spyOn(repo, 'removeCapabilityFromRole').mockResolvedValue(undefined);
    await service.changeRoleCapability('r', 'document.edit', 'company-a', 'user', false);
    expect(remove).toHaveBeenCalledWith('r', 'document.edit', client);
    expect(audit.logEvent).toHaveBeenCalledWith(expect.objectContaining({ company_id: 'company-a', action: 'access.role.capability.remove', after_data: { capabilities: ['document.view'] } }), client);
    // A role of another company is never editable from company-a.
    vi.spyOn(repo, 'findRoleById').mockResolvedValue({ id: 'r', company_id: 'company-b', name: 'X', is_full_access: false, created_at: new Date() });
    await expect(service.changeRoleCapability('r', 'document.edit', 'company-a', 'user', false)).rejects.toThrow(/not found/i);
  });

  it('looks users up by email case-insensitively and fails closed when unknown', async () => {
    const { MembershipService } = await vi.importActual<typeof import('../src/modules/memberships/membership.service')>('../src/modules/memberships/membership.service');
    const service = new MembershipService({ connect: vi.fn(), query: vi.fn() } as unknown as Pool);
    const repo = (service as unknown as { repo: MembershipRepository }).repo;
    vi.spyOn(repo, 'findUserIdByEmail').mockResolvedValue(null);
    const create = vi.spyOn(repo, 'createMembership');
    await expect(service.createMembershipByEmail('ghost@example.com', 'company-a', 'user')).rejects.toThrow(/not found/i);
    expect(create).not.toHaveBeenCalled();
    const query = vi.fn().mockResolvedValue({ rows: [{ id: 'u' }] });
    await new MembershipRepository({ query } as unknown as Pool).findUserIdByEmail('A@B.co');
    expect(query.mock.calls[0][0]).toMatch(/LOWER\(email\) = LOWER\(\$1\)/);
  });
});
