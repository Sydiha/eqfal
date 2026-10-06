import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const mocks = vi.hoisted(() => ({ changeRoleCapabilities: vi.fn() }));
vi.mock('../src/db/pool', () => ({ default: { query: vi.fn(), connect: vi.fn() } as unknown as Pool }));
vi.mock('../src/shared/logger', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../src/modules/memberships/membership.service', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/modules/memberships/membership.service')>();
  return { ...original, MembershipService: class { changeRoleCapabilities = mocks.changeRoleCapabilities; } };
});

import { accessAdministrationRouter } from '../src/modules/memberships/access-administration.router';
import { SessionRepository } from '../src/modules/auth/session.repository';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';
import { MembershipService } from '../src/modules/memberships/membership.service';

const ROLE = '0e8574b6-5828-40c6-9b56-7dbd1c7e9def';
const app = express();
app.use(express.json());
app.use('/api', accessAdministrationRouter);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: String(error) }));
const session = { id: 's', user_id: 'user', user_email: 'u@example.com', token_hash: 'h', active_company_id: 'company-a', expires_at: new Date(Date.now() + 60_000), created_at: new Date(), updated_at: new Date() };
const companyA = { membership_id: 'ma', company_id: 'company-a', company_name: 'A', company_name_ar: null, role_id: 'r' };
const as = (caps: string[]) => {
  vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(session);
  vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue([companyA]);
  vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(caps);
};
const bulk = (body: unknown, id = ROLE) => request(app).post(`/api/access/roles/${id}/capabilities/bulk`).set('Origin', 'http://localhost').set('Host', 'localhost').set('Cookie', 'eqfal_session=t').send(body as object);
const GRANT = 'access.role.capability.grant';
const REVOKE = 'access.role.capability.revoke';

beforeEach(() => { vi.restoreAllMocks(); mocks.changeRoleCapabilities.mockReset().mockResolvedValue(undefined); });

describe('POST /access/roles/:id/capabilities/bulk — router', () => {
  it('requires authentication and same-origin (cross-origin is refused)', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(null);
    expect((await bulk({ grants: ['document.view'] })).status).toBe(401);
    as([GRANT, 'document.view']);
    const crossOrigin = await request(app).post(`/api/access/roles/${ROLE}/capabilities/bulk`).set('Origin', 'http://evil.example').set('Host', 'localhost').set('Cookie', 'eqfal_session=t').send({ grants: ['document.view'] });
    expect(crossOrigin.status).toBe(403);
    expect(mocks.changeRoleCapabilities).not.toHaveBeenCalled();
  });

  it('needs grant for grants and revoke for revokes (view alone is not enough)', async () => {
    as(['access.view']);
    expect((await bulk({ grants: ['document.view'] })).status).toBe(403);
    as([GRANT, 'document.view']);
    expect((await bulk({ revokes: ['document.view'] })).status).toBe(403);
    as([REVOKE]);
    expect((await bulk({ grants: ['document.view'], revokes: ['document.edit'] })).status).toBe(403);
    expect(mocks.changeRoleCapabilities).not.toHaveBeenCalled();
  });

  it('rejects malformed, empty, overlapping, unknown-key and oversized requests', async () => {
    as([GRANT, REVOKE]);
    for (const body of [{}, { grants: [] }, { grants: 'document.view' }, { grants: ['Not A Cap'] }, { grants: ['document.view'], revokes: ['document.view'] }, { grants: ['document.view'], extra: 1 }, { grants: Array.from({ length: 501 }, (_, i) => `a.b${i}`) }]) {
      expect((await bulk(body)).status).toBe(400);
    }
    expect((await bulk({ grants: ['document.view'] }, 'not-a-uuid')).status).toBe(400);
    expect(mocks.changeRoleCapabilities).not.toHaveBeenCalled();
  });

  it('passes the active company and actor to the service (tenant scope comes from the session, not the body)', async () => {
    as([GRANT, REVOKE]);
    const res = await bulk({ grants: ['document.view', 'document.view'], revokes: ['document.edit'] });
    expect(res.status).toBe(204);
    expect(mocks.changeRoleCapabilities).toHaveBeenCalledWith(ROLE, ['document.view'], ['document.edit'], 'company-a', 'user');
  });

  it('maps ceiling / cross-company / full-access errors to 403 and missing to 404', async () => {
    as([GRANT]);
    mocks.changeRoleCapabilities.mockRejectedValueOnce(new Error("Ceiling violation: granter lacks capability 'x.y'"));
    expect((await bulk({ grants: ['x.y'] })).status).toBe(403);
    mocks.changeRoleCapabilities.mockRejectedValueOnce(new Error('Role not found'));
    expect((await bulk({ grants: ['x.y'] })).status).toBe(404);
    mocks.changeRoleCapabilities.mockRejectedValueOnce(new Error('Full Access role capabilities cannot be changed'));
    expect((await bulk({ grants: ['x.y'] })).status).toBe(403);
  });
});

describe('MembershipService.changeRoleCapabilities — atomic validation', () => {
  const actual = async () => (await vi.importActual<typeof import('../src/modules/memberships/membership.service')>('../src/modules/memberships/membership.service')).MembershipService;
  async function setup(opts: { role?: object | null; actor?: string[]; known?: string[] } = {}) {
    const Service = await actual();
    const client = { query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }), release: vi.fn() };
    const service = new Service({ query: vi.fn(), connect: vi.fn().mockResolvedValue(client) } as unknown as Pool);
    const repo = (service as unknown as { repo: MembershipRepository }).repo;
    const audit = (service as unknown as { audit: { logEvent: ReturnType<typeof vi.fn> } }).audit;
    audit.logEvent = vi.fn();
    vi.spyOn(repo, 'listCapabilities').mockResolvedValue(opts.known ?? ['document.view', 'document.edit', 'vat.view']);
    vi.spyOn(repo, 'findRoleById').mockResolvedValue((opts.role === undefined ? { id: ROLE, company_id: 'company-a', name: 'r', is_full_access: false, created_at: new Date() } : opts.role) as never);
    vi.spyOn(repo, 'getActiveCapabilities').mockResolvedValue(opts.actor ?? ['document.view', 'document.edit']);
    vi.spyOn(repo, 'getRoleCapabilities').mockResolvedValue(['document.view']);
    const add = vi.spyOn(repo, 'addCapabilityToRole').mockResolvedValue();
    const remove = vi.spyOn(repo, 'removeCapabilityFromRole').mockResolvedValue();
    return { service, client, add, remove, audit };
  }
  void MembershipService;

  it('applies grants and revokes in one transaction with one audit event', async () => {
    const { service, client, add, remove, audit } = await setup();
    await service.changeRoleCapabilities(ROLE, ['document.edit'], ['document.view'], 'company-a', 'user');
    expect(add).toHaveBeenCalledTimes(1); expect(remove).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'COMMIT']);
    expect(audit.logEvent).toHaveBeenCalledTimes(1);
    expect(audit.logEvent.mock.calls[0][0]).toMatchObject({ company_id: 'company-a', before_data: { capabilities: ['document.view'] }, after_data: { capabilities: ['document.edit'] } });
  });

  it('writes nothing when any grant is above the actor ceiling (all-or-nothing)', async () => {
    const { service, client, add, remove } = await setup();
    await expect(service.changeRoleCapabilities(ROLE, ['document.edit', 'vat.view'], [], 'company-a', 'user')).rejects.toThrow(/ceiling violation.*vat\.view/i);
    expect(add).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
    expect(client.query.mock.calls.map((c) => c[0])).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('rejects unknown capabilities before opening a transaction', async () => {
    const { service, client, add } = await setup();
    await expect(service.changeRoleCapabilities(ROLE, ['nope.nothing'], [], 'company-a', 'user')).rejects.toThrow(/not found/i);
    expect(client.query).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled();
  });

  it('rejects another company\'s role and Full Access roles', async () => {
    const other = await setup({ role: { id: ROLE, company_id: 'company-b', name: 'r', is_full_access: false, created_at: new Date() } });
    await expect(other.service.changeRoleCapabilities(ROLE, ['document.view'], [], 'company-a', 'user')).rejects.toThrow(/not found/i);
    const full = await setup({ role: { id: ROLE, company_id: 'company-a', name: 'r', is_full_access: true, created_at: new Date() } });
    await expect(full.service.changeRoleCapabilities(ROLE, ['document.view'], [], 'company-a', 'user')).rejects.toThrow(/full access/i);
    expect(other.add).not.toHaveBeenCalled(); expect(full.add).not.toHaveBeenCalled();
  });
});
