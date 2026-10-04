import { randomUUID } from 'crypto';
import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;
const mocks = vi.hoisted(() => ({ context: null as null | { user: { id: string; email: string }; activeCompanyId: string; capabilities: string[]; allowedCompanies: never[] } }));

vi.mock('../src/modules/auth/origin.middleware', () => ({ requireSameOrigin: (_q: Request, _s: Response, n: NextFunction) => n() }));
vi.mock('../src/modules/auth/auth.middleware', () => ({
  getAuthenticatedContext: () => mocks.context,
  requireAuth: (_q: Request, _s: Response, n: NextFunction) => n(),
  requireActiveCompany: (_q: Request, _s: Response, n: NextFunction) => n(),
  requireCapability: () => (_q: Request, _s: Response, n: NextFunction) => n(),
}));

// Real PostgreSQL (the in-memory router test cannot see SQL errors such as an
// ambiguous ORDER BY column). Requires DATABASE_URL with migrations applied.
describeDatabase('Partner ownership history with PostgreSQL', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const company = randomUUID(), user = randomUUID(), partner = randomUUID();
  let app: express.Express;

  beforeAll(async () => {
    await pool.query("INSERT INTO companies(id,slug,name) VALUES($1,$2,'Ownership History')", [company, `ownership-history-${company}`]);
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'test-only')", [user, `ownership-history-${user}@example.test`]);
    await pool.query("INSERT INTO partners(id,company_id,name,created_by_user_id) VALUES($1,$2,'Partner',$3)", [partner, company, user]);
    mocks.context = { user: { id: user, email: 'u@example.test' }, activeCompanyId: company, capabilities: ['partner.view'], allowedCompanies: [] };
    const { partnerRouter } = await import('../src/modules/partners/partner.router');
    app = express();
    app.use(express.json());
    app.use('/api', partnerRouter);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
    await pool.end();
  });

  it('returns 200 with periods ordered newest first, undated last', async () => {
    const insert = (pct: string | null, from: string | null, to: string | null, status: string) =>
      pool.query('INSERT INTO partner_ownership_periods(company_id,partner_id,ownership_percentage,effective_from,effective_to,verification_status,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7)', [company, partner, pct, from, to, status, user]);
    await insert(null, null, null, 'unconfirmed');
    await insert('40', '2025-01-01', '2025-12-31', 'confirmed');
    await insert('60', '2026-01-01', null, 'confirmed');

    const res = await request(app).get(`/api/partners/${partner}/ownership`);

    expect(res.status).toBe(200);
    expect(res.body.ownership.map((o: { effective_from: string | null }) => o.effective_from)).toEqual(['2026-01-01', '2025-01-01', null]);
  });

  it('lists the partner with the current confirmed ownership', async () => {
    const res = await request(app).get('/api/partners');

    expect(res.status).toBe(200);
    expect(res.body.partners[0]).toMatchObject({ id: partner, current_ownership_percentage: '60.0000', current_effective_from: '2026-01-01' });
  });
});
