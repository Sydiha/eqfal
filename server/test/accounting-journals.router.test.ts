import express, { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  context: {
    user: { id: 'user-1', email: 'user@example.com' },
    allowedCompanies: [{ id: 'co-a', name: 'Alpha', name_ar: null }],
    activeCompanyId: 'co-a',
    capabilities: ['accounting.view'],
  },
}));

vi.mock('../src/db/pool', () => ({
  default: { query: mocks.query, connect: vi.fn() },
}));

vi.mock('../src/modules/auth/auth.middleware', () => ({
  getAuthenticatedContext: vi.fn(() => mocks.context),
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireActiveCompany: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireCapability: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import { accountingRouter } from '../src/modules/accounting/accounting.router';

const app = express();
app.use(express.json());
app.use('/api', accountingRouter);
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  res.status(500).json({ error: error instanceof Error ? error.message : 'error' });
});

describe('PUT /api/journals/:id/lines', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it.each(['id', 'company_id', 'journal_entry_id', 'sequence'])(
    'rejects the server-owned %s field instead of weakening the write allowlist',
    async (serverField) => {
      const response = await request(app)
        .put('/api/journals/22222222-2222-4222-8222-222222222222/lines')
        .send({ lines: [{ account_id: '11111111-1111-4111-8111-111111111111', debit: '10.00', credit: '0.00', memo: null, [serverField]: 'server-value' }] });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({ error: 'Invalid request' });
      expect(mocks.query).not.toHaveBeenCalled();
    },
  );
});

describe('GET /api/journals', () => {
  beforeEach(() => {
    mocks.query.mockReset();
  });

  it('lists journals with table-qualified ordering despite the duplicate accounting_date output name', async () => {
    mocks.query.mockImplementation(async (sql: string, values: unknown[]) => {
      if (/ORDER BY accounting_date\b/.test(sql)) {
        const error = new Error('ORDER BY "accounting_date" is ambiguous') as Error & { code: string };
        error.code = '42702';
        throw error;
      }

      expect(sql).toContain(
        'ORDER BY journal_entries.accounting_date DESC,journal_entries.created_at DESC,journal_entries.id',
      );
      expect(values).toEqual(['co-a']);
      return { rows: [{ id: 'journal-1', accounting_date: '2026-08-19' }], rowCount: 1 };
    });

    const response = await request(app).get('/api/journals');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      journals: [{ id: 'journal-1', accounting_date: '2026-08-19' }],
    });
    expect(mocks.query).toHaveBeenCalledOnce();
  });
});
