import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

const query = vi.hoisted(() => vi.fn());
vi.mock('../src/db/pool', () => ({ default: { query, connect: vi.fn() } as unknown as Pool }));

import { auditLogRouter } from '../src/modules/audit-log/audit-log.router';
import { SessionRepository } from '../src/modules/auth/session.repository';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';

const app = express();
app.use(express.json());
app.use('/api', auditLogRouter);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: String(error) }));

const session = { id: 's', user_id: 'user', user_email: 'u@example.com', token_hash: 'h', active_company_id: 'company-a', expires_at: new Date(Date.now() + 60_000), created_at: new Date(), updated_at: new Date() };
const companies = [{ membership_id: 'm', company_id: 'company-a', company_name: 'A', company_name_ar: null, role_id: 'r' }];
const ID = '0e8574b6-5828-40c6-9b56-7dbd1c7e9def';
const cookie = ['Cookie', 'eqfal_session=token'] as const;

function login(caps: string[], activeCompanyId: string | null = 'company-a') {
  vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue({ ...session, active_company_id: activeCompanyId });
  vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(activeCompanyId ? companies : []);
  vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(caps);
}
const row = { id: 'e1', created_at: new Date('2026-10-01T10:00:00Z'), actor_user_id: 'user', actor_email: 'u@example.com', action: 'company.update', entity_type: 'company', entity_id: ID, company_id: 'company-a', company_name: 'A', company_name_ar: null, reason: 'fix', before_data: { name: 'x' }, after_data: { name: 'y' } };

beforeEach(() => {
  vi.restoreAllMocks();
  query.mockReset();
  query.mockImplementation(async (sql: string) => (/COUNT\(\*\)/.test(sql) ? { rows: [{ total: '1' }] } : { rows: [row] }));
});

describe('audit log access control', () => {
  it('requires authentication', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(null);
    expect((await request(app).get('/api/audit-log')).status).toBe(401);
    expect((await request(app).get('/api/audit-log/facets')).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it('requires an active company', async () => {
    login(['audit.view'], null);
    expect((await request(app).get('/api/audit-log').set(...cookie)).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('requires audit.view (other capabilities are not enough)', async () => {
    login(['company.view', 'access.view']);
    expect((await request(app).get('/api/audit-log').set(...cookie)).status).toBe(403);
    expect((await request(app).get('/api/audit-log/facets').set(...cookie)).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it('is read-only: no write verbs are routed', async () => {
    login(['audit.view']);
    for (const method of ['post', 'put', 'patch', 'delete'] as const) {
      expect((await request(app)[method]('/api/audit-log').set(...cookie).send({})).status).toBe(404);
      expect((await request(app)[method](`/api/audit-log/${ID}`).set(...cookie).send({})).status).toBe(404);
    }
    expect(query).not.toHaveBeenCalled();
  });
});

describe('audit log visibility and tenant isolation', () => {
  it('returns the entries with the required fields', async () => {
    login(['audit.view']);
    const res = await request(app).get('/api/audit-log').set(...cookie);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.entries[0]).toMatchObject({ created_at: '2026-10-01T10:00:00.000Z', actor_email: 'u@example.com', action: 'company.update', entity_type: 'company', entity_id: ID, company_id: 'company-a', company_name: 'A', reason: 'fix' });
  });

  it('binds every query to the session company, ignoring a client-supplied company_id', async () => {
    login(['audit.view']);
    await request(app).get('/api/audit-log?company_id=company-b&companyId=company-b').set(...cookie);
    expect(query).toHaveBeenCalled();
    for (const [sql, params] of query.mock.calls) {
      expect(sql).toContain('a.company_id = $1');
      expect((params as unknown[])[0]).toBe('company-a');
      expect(params).not.toContain('company-b');
    }
    query.mockClear();
    await request(app).get('/api/audit-log/facets').set(...cookie);
    for (const [sql, params] of query.mock.calls) {
      expect(sql).toContain('company_id = $1');
      expect((params as unknown[])[0]).toBe('company-a');
    }
  });

  it('never selects password material from users', async () => {
    login(['audit.view']);
    await request(app).get('/api/audit-log').set(...cookie);
    for (const [sql] of query.mock.calls) expect(sql).not.toMatch(/password/i);
  });
});

describe('audit log filtering and search', () => {
  it('passes filters as bound parameters, not interpolated SQL', async () => {
    login(['audit.view']);
    const evil = "x'; DROP TABLE audit_log;--";
    const res = await request(app).get('/api/audit-log').query({ action: evil, entity_type: 'company', entity_id: ID, actor_user_id: ID, from: '2026-10-01', to: '2026-10-05', q: '50%_off', limit: '25', offset: '50' }).set(...cookie);
    expect(res.status).toBe(200);
    const [sql, params] = query.mock.calls.find(([s]) => !/COUNT/.test(s))!;
    expect(sql).not.toContain('DROP TABLE');
    expect(params).toEqual(['company-a', evil, 'company', ID, ID, '2026-10-01', '2026-10-05', '%50\\%\\_off%', 25, 50]);
    expect(res.body).toMatchObject({ limit: 25, offset: 50 });
  });

  it('defaults to newest first, 50 per page', async () => {
    login(['audit.view']);
    await request(app).get('/api/audit-log').set(...cookie);
    const [sql, params] = query.mock.calls.find(([s]) => !/COUNT/.test(s))!;
    expect(sql).toMatch(/ORDER BY a\.created_at DESC/);
    expect((params as unknown[]).slice(-2)).toEqual([50, 0]);
  });

  it.each([
    ['entity_id=not-a-uuid'], ['actor_user_id=zzz'], ['from=2026-13-40'], ['to=yesterday'],
    ['from=2026-10-05&to=2026-10-01'], ['limit=0'], ['limit=101'], ['limit=abc'], ['offset=-1'], ['action=a&action=b'],
  ])('rejects invalid filter %s', async (qs) => {
    login(['audit.view']);
    expect((await request(app).get(`/api/audit-log?${qs}`).set(...cookie)).status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });

  it('returns facets for the dropdowns', async () => {
    login(['audit.view']);
    query.mockReset();
    query.mockResolvedValueOnce({ rows: [{ v: 'company.update' }] }).mockResolvedValueOnce({ rows: [{ v: 'company' }] }).mockResolvedValueOnce({ rows: [{ id: ID, email: 'u@example.com' }] });
    const res = await request(app).get('/api/audit-log/facets').set(...cookie);
    expect(res.body).toEqual({ actions: ['company.update'], entity_types: ['company'], actors: [{ id: ID, email: 'u@example.com' }] });
  });
});
