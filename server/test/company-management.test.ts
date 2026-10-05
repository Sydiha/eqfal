import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';
import { readFileSync } from 'node:fs';

const mocks = vi.hoisted(() => ({ listForUser: vi.fn(), create: vi.fn(), update: vi.fn(), setActive: vi.fn() }));

vi.mock('../src/db/pool', () => ({ default: { query: vi.fn(), connect: vi.fn() } as unknown as Pool }));
vi.mock('../src/modules/companies/company.service', async () => {
  const actual = await vi.importActual<typeof import('../src/modules/companies/company.service')>('../src/modules/companies/company.service');
  return {
    CompanyAccessError: actual.CompanyAccessError,
    CompanyManagementService: class {
      listForUser = mocks.listForUser; create = mocks.create; update = mocks.update; setActive = mocks.setActive;
    },
  };
});

import { companyRouter } from '../src/modules/companies/company.router';
import { CompanyAccessError, CompanyManagementService as RealService } from '../src/modules/companies/company.service';
import { SessionRepository } from '../src/modules/auth/session.repository';
import { MembershipRepository } from '../src/modules/memberships/membership.repository';

const app = express();
app.use(express.json());
app.use('/api', companyRouter);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => res.status(500).json({ error: String(error) }));

const session = { id: 's', user_id: 'user', user_email: 'u@example.com', token_hash: 'h', active_company_id: 'company-a', expires_at: new Date(Date.now() + 60_000), created_at: new Date(), updated_at: new Date() };
const companies = [{ membership_id: 'm', company_id: 'company-a', company_name: 'A', company_name_ar: null, role_id: 'r' }];
const COMPANY_ID = '0e8574b6-5828-40c6-9b56-7dbd1c7e9def';
const cookie = ['Cookie', 'eqfal_session=token'] as const;

function login(caps: string[], activeCompanyId: string | null = 'company-a') {
  vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue({ ...session, active_company_id: activeCompanyId });
  vi.spyOn(MembershipRepository.prototype, 'listActiveCompaniesForUser').mockResolvedValue(activeCompanyId ? companies : []);
  vi.spyOn(MembershipRepository.prototype, 'getActiveCapabilities').mockResolvedValue(caps);
}

beforeEach(() => {
  vi.restoreAllMocks();
  Object.values(mocks).forEach((m) => m.mockReset());
  mocks.listForUser.mockResolvedValue([]);
  mocks.create.mockResolvedValue({ id: COMPANY_ID });
  mocks.update.mockResolvedValue({ id: COMPANY_ID });
  mocks.setActive.mockResolvedValue({ id: COMPANY_ID });
});

describe('company management permission enforcement', () => {
  it('requires authentication', async () => {
    vi.spyOn(SessionRepository.prototype, 'findActiveByTokenHash').mockResolvedValue(null);
    expect((await request(app).get('/api/companies')).status).toBe(401);
    expect((await request(app).post('/api/companies').send({})).status).toBe(401);
    expect((await request(app).patch(`/api/companies/${COMPANY_ID}`).send({ name: 'x' })).status).toBe(401);
    expect((await request(app).patch(`/api/companies/${COMPANY_ID}/active`).send({ is_active: false })).status).toBe(401);
  });

  it('requires an active company', async () => {
    login([], null);
    expect((await request(app).get('/api/companies').set(...cookie)).status).toBe(403);
  });

  it('requires company.view for listing and company.create for creating', async () => {
    login([]);
    expect((await request(app).get('/api/companies').set(...cookie)).status).toBe(403);
    login(['company.view']);
    expect((await request(app).post('/api/companies').set(...cookie).send({ slug: 'new-co', name: 'New' })).status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it('lists with company.view and uses the session user, never request input', async () => {
    login(['company.view']);
    const res = await request(app).get('/api/companies?user_id=attacker').set(...cookie);
    expect(res.status).toBe(200);
    expect(mocks.listForUser).toHaveBeenCalledWith('user');
  });

  it('creates a company with company.create and validates the body strictly', async () => {
    login(['company.create']);
    const ok = await request(app).post('/api/companies').set(...cookie).send({ slug: 'new-co', name: ' New Co ', name_ar: 'شركة' });
    expect(ok.status).toBe(201);
    expect(mocks.create).toHaveBeenCalledWith({ slug: 'new-co', name: 'New Co', name_ar: 'شركة' }, 'user');
    for (const body of [{}, { slug: 'Bad Slug', name: 'x' }, { slug: 'ok', name: '' }, { slug: 'ok', name: 'x', is_active: false }, { slug: 'ok', name: 'x', name_ar: 5 }]) {
      expect((await request(app).post('/api/companies').set(...cookie).send(body)).status).toBe(400);
    }
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  it('maps duplicate slugs to 409', async () => {
    login(['company.create']);
    mocks.create.mockRejectedValue(Object.assign(new Error('dup'), { code: '23505' }));
    expect((await request(app).post('/api/companies').set(...cookie).send({ slug: 'dup', name: 'Dup' })).status).toBe(409);
  });

  it('edits only name fields; slug and is_active are rejected', async () => {
    login([]);
    expect((await request(app).patch(`/api/companies/${COMPANY_ID}`).set(...cookie).send({ name: 'New' })).status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(COMPANY_ID, { name: 'New' }, 'user');
    expect((await request(app).patch(`/api/companies/${COMPANY_ID}`).set(...cookie).send({ slug: 'x' })).status).toBe(400);
    expect((await request(app).patch(`/api/companies/${COMPANY_ID}`).set(...cookie).send({ is_active: false })).status).toBe(400);
    expect((await request(app).patch(`/api/companies/${COMPANY_ID}`).set(...cookie).send({})).status).toBe(400);
    expect((await request(app).patch('/api/companies/not-a-uuid').set(...cookie).send({ name: 'x' })).status).toBe(400);
    const clear = await request(app).patch(`/api/companies/${COMPANY_ID}`).set(...cookie).send({ name_ar: '' });
    expect(clear.status).toBe(200);
    expect(mocks.update).toHaveBeenLastCalledWith(COMPANY_ID, { name_ar: null }, 'user');
  });

  it('translates service authorization outcomes (403 / 404 / 409)', async () => {
    login([]);
    mocks.update.mockRejectedValueOnce(new CompanyAccessError('forbidden'));
    expect((await request(app).patch(`/api/companies/${COMPANY_ID}`).set(...cookie).send({ name: 'x' })).status).toBe(403);
    mocks.setActive.mockRejectedValueOnce(new CompanyAccessError('not_found'));
    expect((await request(app).patch(`/api/companies/${COMPANY_ID}/active`).set(...cookie).send({ is_active: true })).status).toBe(404);
    mocks.setActive.mockRejectedValueOnce(new CompanyAccessError('conflict'));
    expect((await request(app).patch(`/api/companies/${COMPANY_ID}/active`).set(...cookie).send({ is_active: false })).status).toBe(409);
  });

  it('validates the enable/disable body and exposes no delete route', async () => {
    login([]);
    expect((await request(app).patch(`/api/companies/${COMPANY_ID}/active`).set(...cookie).send({ is_active: 'no' })).status).toBe(400);
    expect((await request(app).patch(`/api/companies/${COMPANY_ID}/active`).set(...cookie).send({ is_active: false, extra: 1 })).status).toBe(400);
    expect((await request(app).patch(`/api/companies/${COMPANY_ID}/active`).set(...cookie).send({ is_active: false })).status).toBe(200);
    expect((await request(app).delete(`/api/companies/${COMPANY_ID}`).set(...cookie)).status).toBe(404);
  });

  it('rejects cross-origin writes', async () => {
    login(['company.create']);
    const res = await request(app).post('/api/companies').set(...cookie).set('Origin', 'https://evil.example').send({ slug: 'x-co', name: 'X' });
    expect(res.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

type Rows = Record<string, unknown>[];
function fakePool(handler: (sql: string, params: unknown[]) => Rows) {
  const sqls: string[] = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => { sqls.push(sql); return { rows: handler(sql, params) }; });
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { query, connect: vi.fn().mockResolvedValue(client) } as unknown as Pool;
  return { pool, query, sqls };
}
const row = { id: COMPANY_ID, slug: 's', name: 'N', name_ar: null, is_active: true, created_at: new Date() };

describe('company management service: tenant isolation and audit', () => {
  it('treats a company without an active membership as not found, before any write', async () => {
    const { pool, sqls } = fakePool((sql) => (sql.includes('FROM memberships WHERE') ? [] : []));
    const service = new (await vi.importActual<typeof import('../src/modules/companies/company.service')>('../src/modules/companies/company.service')).CompanyManagementService(pool);
    await expect(service.update(COMPANY_ID, { name: 'x' }, 'user')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(service.setActive(COMPANY_ID, true, 'user')).rejects.toMatchObject({ kind: 'not_found' });
    expect(sqls.some((s) => /UPDATE companies/.test(s))).toBe(false);
    expect(sqls.filter((s) => s === 'ROLLBACK')).toHaveLength(2);
  });

  it('forbids edit/toggle when the capability is missing in the target company', async () => {
    const { pool, sqls } = fakePool((sql) => (sql.includes('FROM memberships WHERE') ? [{ role_id: 'r' }] : sql.includes('capability_id') ? [{ capability_id: 'company.view' }] : []));
    const service = new (await vi.importActual<typeof import('../src/modules/companies/company.service')>('../src/modules/companies/company.service')).CompanyManagementService(pool);
    await expect(service.update(COMPANY_ID, { name: 'x' }, 'user')).rejects.toMatchObject({ kind: 'forbidden' });
    await expect(service.setActive(COMPANY_ID, false, 'user')).rejects.toMatchObject({ kind: 'forbidden' });
    expect(sqls.some((s) => /UPDATE companies/.test(s))).toBe(false);
  });

  it('refuses to disable the actor\'s last active company', async () => {
    const { pool, sqls } = fakePool((sql) => {
      if (sql.includes('FROM memberships WHERE')) return [{ role_id: 'r' }];
      if (sql.includes('capability_id')) return [{ capability_id: 'company.status.edit' }];
      if (sql.includes('FOR UPDATE')) return [row];
      return [];
    });
    const service = new (await vi.importActual<typeof import('../src/modules/companies/company.service')>('../src/modules/companies/company.service')).CompanyManagementService(pool);
    await expect(service.setActive(COMPANY_ID, false, 'user')).rejects.toMatchObject({ kind: 'conflict' });
    expect(sqls.some((s) => /UPDATE companies/.test(s))).toBe(false);
  });

  it('disables with audit in the same transaction, never deleting', async () => {
    const { pool, sqls } = fakePool((sql) => {
      if (sql.includes('FROM memberships WHERE')) return [{ role_id: 'r' }];
      if (sql.includes('capability_id')) return [{ capability_id: 'company.status.edit' }];
      if (sql.includes('FOR UPDATE')) return [row];
      if (sql.includes('company_id <>')) return [{ '?column?': 1 }];
      if (sql.includes('UPDATE companies')) return [{ ...row, is_active: false }];
      return [];
    });
    const service = new (await vi.importActual<typeof import('../src/modules/companies/company.service')>('../src/modules/companies/company.service')).CompanyManagementService(pool);
    const after = await service.setActive(COMPANY_ID, false, 'user');
    expect(after.is_active).toBe(false);
    expect(sqls.some((s) => /INSERT INTO audit_log/i.test(s))).toBe(true);
    expect(sqls.some((s) => /DELETE/i.test(s))).toBe(false);
    expect(sqls).toContain('COMMIT');
  });

  it('creates company + Full Access role + creator membership + audit atomically', async () => {
    const { pool, sqls } = fakePool((sql) => {
      if (sql.includes('INSERT INTO companies')) return [row];
      if (sql.includes('INSERT INTO roles')) return [{ id: 'role-1' }];
      return [];
    });
    const service = new (await vi.importActual<typeof import('../src/modules/companies/company.service')>('../src/modules/companies/company.service')).CompanyManagementService(pool);
    await service.create({ slug: 's', name: 'N', name_ar: null }, 'user');
    expect(sqls.findIndex((s) => s.includes('INSERT INTO companies'))).toBeLessThan(sqls.findIndex((s) => s.includes('INSERT INTO memberships')));
    expect(sqls.some((s) => /INSERT INTO audit_log/i.test(s))).toBe(true);
    expect(sqls).toContain('COMMIT');
  });

  it('lists only companies the user has an active membership in', async () => {
    const { pool, query } = fakePool((sql) => {
      if (sql.includes('FROM companies c')) return [row];
      if (sql.includes('FROM memberships WHERE')) return [{ role_id: 'r' }];
      if (sql.includes('capability_id')) return [{ capability_id: 'company.edit' }];
      return [];
    });
    const service = new (await vi.importActual<typeof import('../src/modules/companies/company.service')>('../src/modules/companies/company.service')).CompanyManagementService(pool);
    const list = await service.listForUser('user');
    expect(list[0]).toMatchObject({ can_edit: true, can_toggle: false });
    expect(String(query.mock.calls[0][0])).toContain('m.user_id = $1');
  });
});

describe('company management capability migration', () => {
  const sql = readFileSync(new URL('../migrations/056_company_management_capabilities.sql', import.meta.url), 'utf8');
  it('registers the four capabilities without granting them to ordinary roles', () => {
    for (const id of ['company.view', 'company.create', 'company.edit', 'company.status.edit']) expect(sql).toContain(`'${id}'`);
    expect(sql).not.toMatch(/INSERT\s+INTO\s+role_capabilities/i);
  });
});

void RealService;
