import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({
  listMemberships: vi.fn(),
}));

vi.mock('../src/db/pool', () => ({ default: { query: vi.fn(), connect: vi.fn() } as unknown as Pool }));
vi.mock('../src/modules/memberships/membership.service', () => ({
  MembershipService: class { listMemberships = mocks.listMemberships; },
}));

import { accessAdministrationRouter } from '../src/modules/memberships/access-administration.router';
import { SessionRepository } from '../src/modules/auth/session.repository';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';

const app = express();
app.use(express.json());
app.use('/api', accessAdministrationRouter);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: String(error) }));

const session = { id: 'session', user_id: 'user', user_email: 'u@example.com', token_hash: 'hash', active_company_id: 'company-a', expires_at: new Date(Date.now() + 60_000), created_at: new Date(), updated_at: new Date() };
const companies = [{ membership_id: 'membership', company_id: 'company-a', company_name: 'A', company_name_ar: null, role_id: 'role' }];

describe('access administration authorization boundary', () => {
  beforeEach(() => { vi.restoreAllMocks(); mocks.listMemberships.mockReset().mockResolvedValue([]); });

  it('requires authentication', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(null);
    expect((await request(app).get('/api/access/memberships')).status).toBe(401);
  });

  it('requires an active company', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue({ ...session, active_company_id: null });
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue([]);
    expect((await request(app).get('/api/access/memberships').set('Cookie', 'eqfal_session=token')).status).toBe(403);
  });

  it('requires access.view for reads', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(session);
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(companies);
    vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue([]);
    expect((await request(app).get('/api/access/memberships').set('Cookie', 'eqfal_session=token')).status).toBe(403);
  });

  it('does not accept legacy access.manage as a runtime fallback', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(session);
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(companies);
    vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(['access.manage']);
    expect((await request(app).get('/api/access/memberships').set('Cookie', 'eqfal_session=token')).status).toBe(403);
  });

  it('uses the server-trusted active company on the happy path', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(session);
    vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(companies);
    vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(['access.view']);
    const response = await request(app).get('/api/access/memberships?company_id=attacker-company').set('Cookie', 'eqfal_session=token');
    expect(response.status).toBe(200);
    expect(mocks.listMemberships).toHaveBeenCalledWith('company-a');
  });
});

describe('access administration capability migration', () => {
  const sql = readFileSync(new URL('../migrations/038_access_administration_capability.sql', import.meta.url), 'utf8');
  it('creates the dedicated legacy capability without granting it to ordinary roles', () => {
    expect(sql).toContain("'access.manage'");
    expect(sql).not.toMatch(/INSERT\s+INTO\s+role_capabilities/i);
  });
});

describe('membership administration service security and audit', () => {
  it('rejects a cross-company role before writing', async () => {
    const { MembershipService } = await vi.importActual<typeof import('../src/modules/memberships/membership.service')>('../src/modules/memberships/membership.service');
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() } as unknown as Pool;
    const service = new MembershipService(pool);
    const repo = (service as unknown as { repo: MembershipRepository }).repo;
    vi.spyOn(repo, 'findMembershipById').mockResolvedValue({ id: 'membership', user_id: 'target', company_id: 'company-a', role_id: null, is_active: true, created_at: new Date(), updated_at: new Date() });
    vi.spyOn(repo, 'findRoleById').mockResolvedValue({ id: 'role', company_id: 'company-b', name: 'Other', is_full_access: false, created_at: new Date() });
    const write = vi.spyOn(repo, 'assignRoleToMembership');
    await expect(service.assignRoleForCompany('membership', 'role', 'company-a', 'actor')).rejects.toThrow(/Role not found/);
    expect(write).not.toHaveBeenCalled();
  });

  it('enforces the capability ceiling and Full Access authority', async () => {
    const { MembershipService } = await vi.importActual<typeof import('../src/modules/memberships/membership.service')>('../src/modules/memberships/membership.service');
    const pool = { query: vi.fn(), connect: vi.fn() } as unknown as Pool;
    const service = new MembershipService(pool);
    const repo = (service as unknown as { repo: MembershipRepository }).repo;
    vi.spyOn(repo, 'findMembershipById').mockResolvedValue({ id: 'membership', user_id: 'actor', company_id: 'company-a', role_id: null, is_active: true, created_at: new Date(), updated_at: new Date() });
    vi.spyOn(repo, 'findRoleById').mockResolvedValue({ id: 'role', company_id: 'company-a', name: 'Elevated', is_full_access: false, created_at: new Date() });
    vi.spyOn(repo, 'getActiveCapabilities').mockResolvedValue(['access.manage']);
    vi.spyOn(repo, 'getRoleCapabilities').mockResolvedValue(['payments.manage']);
    await expect(service.assignRole('membership', 'role', 'actor')).rejects.toThrow(/ceiling/i);
    vi.spyOn(repo, 'findRoleById').mockResolvedValue({ id: 'role', company_id: 'company-a', name: 'Full Access', is_full_access: true, created_at: new Date() });
    vi.spyOn(repo, 'hasActiveFullAccessRole').mockResolvedValue(false);
    await expect(service.assignRole('membership', 'role', 'actor')).rejects.toThrow(/Full Access/i);
  });

  it('writes membership state and its permanent audit record in one transaction', async () => {
    const { MembershipService } = await vi.importActual<typeof import('../src/modules/memberships/membership.service')>('../src/modules/memberships/membership.service');
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() } as unknown as PoolClient;
    const pool = { connect: vi.fn().mockResolvedValue(client), query: vi.fn() } as unknown as Pool;
    const service = new MembershipService(pool);
    const repo = (service as unknown as { repo: MembershipRepository }).repo;
    const audit = (service as unknown as { audit: { logEvent: ReturnType<typeof vi.fn> } }).audit;
    const before = { id: 'membership', user_id: 'target', company_id: 'company-a', role_id: null, is_active: true, created_at: new Date(), updated_at: new Date() };
    vi.spyOn(repo, 'findMembershipById').mockResolvedValue(before);
    vi.spyOn(repo, 'setMembershipActive').mockResolvedValue({ ...before, is_active: false });
    const auditSpy = vi.spyOn(audit, 'logEvent').mockResolvedValue({} as never);
    await service.setMembershipActive('membership', 'company-a', false, 'actor');
    expect(auditSpy).toHaveBeenCalledWith(expect.objectContaining({ company_id: 'company-a', actor_user_id: 'actor', action: 'access.membership.disable', entity_id: 'membership' }), client);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });
});
