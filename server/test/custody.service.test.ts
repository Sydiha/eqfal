import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Pool, PoolClient } from 'pg';

const audit = vi.hoisted(() => vi.fn());
vi.mock('../src/modules/audit-log/audit-log.repository', () => ({
  AuditLogRepository: class { logEvent = audit; },
}));

import { CustodyService } from '../src/modules/banking/custody.router';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const ACTOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CUSTODY = '22222222-2222-4222-8222-222222222222';
const TX = '33333333-3333-4333-8333-333333333333';
const DOC = '44444444-4444-4444-8444-444444444444';

const custody = (status: 'open' | 'closed' = 'open') => ({
  id: CUSTODY, company_id: COMPANY, holder_user_id: ACTOR, purpose: 'ops', status,
  created_by_user_id: ACTOR, created_at: new Date(),
  closed_by_user_id: status === 'closed' ? ACTOR : null,
  closed_at: status === 'closed' ? new Date() : null,
});
const tx = (amount: string, status: 'unmatched' | 'matched' | 'reconciled' = 'unmatched') => ({
  id: TX, company_id: COMPANY, amount, currency_code: 'SAR', transaction_date: '2026-08-16',
  description: 'bank movement', bank_reference: null, reconciliation_status: status,
});
const approvedDoc = (total = '40.00', status = 'approved') => ({ id: DOC, status, total_amount: total, original_filename: 'invoice.pdf' });

type Handler = (sql: string, params?: unknown[]) => { rows: unknown[] } | Promise<{ rows: unknown[] }>;
function makePool(handler: Handler) {
  const query = vi.fn((sql: string, params?: unknown[]) => Promise.resolve(handler(sql, params)));
  const client = { query, release: vi.fn() } as unknown as PoolClient;
  const pool = { query, connect: vi.fn(async () => client) } as unknown as Pool;
  return { pool, query, client };
}

function summaryHandler(options: { funding?: string; allocated?: string; returned?: string; custodyStatus?: 'open'|'closed' } = {}): Handler {
  const funding = options.funding ?? '-100.00';
  const allocated = options.allocated ?? '0';
  const returned = options.returned ?? '0';
  const status = options.custodyStatus ?? 'open';
  return (sql) => {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
    if (sql.includes('FROM custody_advances')) return { rows: [custody(status)] };
    if (sql.includes("m.match_type='custody_funding'")) return { rows: [{ ...tx(funding, 'matched'), amount: funding }] };
    if (sql.includes("m.match_type='custody_return'") && sql.includes('SUM(t.amount)')) return { rows: [{ total: returned }] };
    if (sql.includes("m.match_type='custody_return'")) return { rows: [] };
    if (sql.includes('SUM(amount)')) return { rows: [{ total: allocated }] };
    if (sql.includes('FROM custody_document_allocations a')) return { rows: [] };
    if (sql.startsWith('UPDATE custody_advances')) return { rows: [] };
    return { rows: [] };
  };
}

beforeEach(() => { audit.mockReset(); audit.mockResolvedValue({}); });

describe('CustodyService behavioural rules', () => {
  it('creates custody only from an outbound active-company transaction and locks it', async () => {
    const handler: Handler = (sql, params) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('FROM bank_transactions') && sql.includes('FOR UPDATE')) {
        expect(params).toEqual([TX, COMPANY]);
        return { rows: [tx('-100.00')] };
      }
      if (sql.includes('FROM bank_transaction_matches') && sql.includes('bank_transaction_id=$1')) return { rows: [] };
      if (sql.startsWith('INSERT INTO custody_advances')) return { rows: [custody()] };
      if (sql.startsWith('INSERT INTO bank_transaction_matches') || sql.startsWith('UPDATE bank_transactions')) return { rows: [] };
      if (sql.includes("m.match_type='custody_funding'")) return { rows: [{ ...tx('-100.00', 'matched'), amount: '-100.00' }] };
      if (sql.includes("m.match_type='custody_return'") && sql.includes('SUM(t.amount)')) return { rows: [{ total: '0' }] };
      if (sql.includes("m.match_type='custody_return'")) return { rows: [] };
      if (sql.includes('SUM(amount)')) return { rows: [{ total: '0' }] };
      if (sql.includes('FROM custody_document_allocations a')) return { rows: [] };
      return { rows: [] };
    };
    const { pool, query } = makePool(handler);
    const result = await new CustodyService(pool).create(COMPANY, ACTOR, TX, 'ops');
    expect(result.funded_amount).toBe('100.00');
    expect(result.remaining_amount).toBe('100.00');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FOR UPDATE'), [TX, COMPANY]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'custody.create', company_id: COMPANY }), expect.anything());
  });

  it('returns safe not-found semantics for a bank transaction outside the active company', async () => {
    const { pool, query } = makePool((sql, params) => {
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM bank_transactions')) { expect(params).toEqual([TX, COMPANY]); return { rows: [] }; }
      return { rows: [] };
    });
    await expect(new CustodyService(pool).create(COMPANY, ACTOR, TX, null)).rejects.toThrow('Bank transaction not found');
    expect(query).not.toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(['co-b']));
  });

  it('rejects inbound funding and reuse of an already matched transaction', async () => {
    for (const mode of ['inbound', 'matched'] as const) {
      const { pool } = makePool((sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('FROM bank_transactions')) return { rows: [tx(mode === 'inbound' ? '100.00' : '-100.00', mode === 'matched' ? 'matched' : 'unmatched')] };
        if (sql.includes('FROM bank_transaction_matches')) return { rows: mode === 'matched' ? [{ id: 'm' }] : [] };
        return { rows: [] };
      });
      await expect(new CustodyService(pool).create(COMPANY, ACTOR, TX, null)).rejects.toThrow(mode === 'inbound' ? 'outbound bank transaction' : 'already matched');
    }
  });

  it('allocates only an approved document for its exact total and within custody remaining balance', async () => {
    const handler: Handler = (sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('FROM custody_advances')) return { rows: [custody()] };
      if (sql.includes('FROM documents') && sql.includes('FOR UPDATE')) return { rows: [approvedDoc('40.00')] };
      if (sql.includes('FROM document_settlements')) return { rows: [] };
      if (sql.includes('FROM custody_document_allocations WHERE document_id')) return { rows: [] };
      if (sql.includes("m.match_type='custody_funding'")) return { rows: [{ ...tx('-100.00', 'matched'), amount: '-100.00' }] };
      if (sql.includes("m.match_type='custody_return'") && sql.includes('SUM(t.amount)')) return { rows: [{ total: '0' }] };
      if (sql.includes("m.match_type='custody_return'")) return { rows: [] };
      if (sql.includes('SUM(amount)')) return { rows: [{ total: '0' }] };
      if (sql.includes('FROM custody_document_allocations a')) return { rows: [] };
      if (sql.startsWith('INSERT INTO custody_document_allocations')) return { rows: [{ id: '55555555-5555-4555-8555-555555555555', company_id: COMPANY, custody_id: CUSTODY, document_id: DOC, amount: '40.00', created_by_user_id: ACTOR, created_at: new Date(), note: null }] };
      return { rows: [] };
    };
    const { pool, query } = makePool(handler);
    const result = await new CustodyService(pool).allocate(CUSTODY, COMPANY, ACTOR, DOC, '40.00', null);
    expect(result.remaining_amount).toBe('100.00');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM documents WHERE id=$1 AND company_id=$2'), [DOC, COMPANY]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'custody.document.allocate' }), expect.anything());
  });

  it('rejects non-approved, partial, existing-funded, and over-remaining document allocations', async () => {
    const cases = [
      { name: 'non-approved', doc: approvedDoc('40.00', 'needs_review'), existing: false, amount: '40.00', funding: '-100.00', message: 'approved with a total amount' },
      { name: 'partial', doc: approvedDoc('40.00'), existing: false, amount: '20.00', funding: '-100.00', message: 'must equal document total' },
      { name: 'existing', doc: approvedDoc('40.00'), existing: true, amount: '40.00', funding: '-100.00', message: 'already has a funding source' },
      { name: 'over remaining', doc: approvedDoc('40.00'), existing: false, amount: '40.00', funding: '-30.00', message: 'exceeds custody remaining amount' },
    ];
    for (const c of cases) {
      const { pool } = makePool((sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('FROM custody_advances')) return { rows: [custody()] };
        if (sql.includes('FROM documents')) return { rows: [c.doc] };
        if (sql.includes('FROM document_settlements')) return { rows: c.existing ? [{ id: 's' }] : [] };
        if (sql.includes('FROM custody_document_allocations WHERE document_id')) return { rows: [] };
        if (sql.includes("m.match_type='custody_funding'")) return { rows: [{ ...tx(c.funding, 'matched'), amount: c.funding }] };
        if (sql.includes("m.match_type='custody_return'") && sql.includes('SUM(t.amount)')) return { rows: [{ total: '0' }] };
        if (sql.includes("m.match_type='custody_return'")) return { rows: [] };
        if (sql.includes('SUM(amount)')) return { rows: [{ total: '0' }] };
        if (sql.includes('FROM custody_document_allocations a')) return { rows: [] };
        return { rows: [] };
      });
      await expect(new CustodyService(pool).allocate(CUSTODY, COMPANY, ACTOR, DOC, c.amount, null)).rejects.toThrow(c.message);
    }
  });

  it('links an inbound return and rejects over-return or duplicate reuse', async () => {
    const success = makePool((sql) => {
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [] };
      if (sql.includes('FROM custody_advances')) return { rows: [custody()] };
      if (sql.includes('FROM bank_transactions')) return { rows: [tx('25.00')] };
      if (sql.includes('FROM bank_transaction_matches') && sql.includes('bank_transaction_id=$1')) return { rows: [] };
      if (sql.includes("m.match_type='custody_funding'")) return { rows: [{ ...tx('-100.00', 'matched'), amount: '-100.00' }] };
      if (sql.includes("m.match_type='custody_return'") && sql.includes('SUM(t.amount)')) return { rows: [{ total: '0' }] };
      if (sql.includes("m.match_type='custody_return'")) return { rows: [] };
      if (sql.includes('SUM(amount)')) return { rows: [{ total: '0' }] };
      if (sql.includes('FROM custody_document_allocations a')) return { rows: [] };
      if (sql.startsWith('INSERT INTO bank_transaction_matches') || sql.startsWith('UPDATE bank_transactions')) return { rows: [] };
      return { rows: [] };
    });
    await expect(new CustodyService(success.pool).addReturn(CUSTODY, COMPANY, ACTOR, TX, null)).resolves.toBeTruthy();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'custody.return.link' }), expect.anything());

    for (const mode of ['over', 'duplicate'] as const) {
      const { pool } = makePool((sql) => {
        if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
        if (sql.includes('FROM custody_advances')) return { rows: [custody()] };
        if (sql.includes('FROM bank_transactions')) return { rows: [tx(mode === 'over' ? '101.00' : '25.00', mode === 'duplicate' ? 'matched' : 'unmatched')] };
        if (sql.includes('FROM bank_transaction_matches') && sql.includes('bank_transaction_id=$1')) return { rows: mode === 'duplicate' ? [{ id: 'm', match_type: 'custody_return', custody_id: CUSTODY }] : [] };
        if (sql.includes("m.match_type='custody_funding'")) return { rows: [{ ...tx('-100.00', 'matched'), amount: '-100.00' }] };
        if (sql.includes("m.match_type='custody_return'") && sql.includes('SUM(t.amount)')) return { rows: [{ total: '0' }] };
        if (sql.includes("m.match_type='custody_return'")) return { rows: [] };
        if (sql.includes('SUM(amount)')) return { rows: [{ total: '0' }] };
        if (sql.includes('FROM custody_document_allocations a')) return { rows: [] };
        return { rows: [] };
      });
      await expect(new CustodyService(pool).addReturn(CUSTODY, COMPANY, ACTOR, TX, null)).rejects.toThrow(mode === 'over' ? 'Return exceeds custody remaining amount' : 'already matched');
    }
  });

  it('blocks close with a balance, closes exactly at zero with large exact cents, and audits closure', async () => {
    const nonzero = makePool(summaryHandler({ funding: '-100.00', allocated: '99.99' }));
    await expect(new CustodyService(nonzero.pool).close(CUSTODY, COMPANY, ACTOR)).rejects.toThrow('balance remains');

    const exact = makePool(summaryHandler({ funding: '-9999999999999999.99', allocated: '9999999999999999.99' }));
    await expect(new CustodyService(exact.pool).close(CUSTODY, COMPANY, ACTOR)).resolves.toEqual({ status: 'closed' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'custody.close', after_data: expect.objectContaining({ remaining_amount: '0.00' }) }), expect.anything());
  });

  it('prevents mutation after close and reopens a closed custody with an audited reason', async () => {
    const closed = makePool(summaryHandler({ custodyStatus: 'closed' }));
    await expect(new CustodyService(closed.pool).allocate(CUSTODY, COMPANY, ACTOR, DOC, '10.00', null)).rejects.toThrow('Custody is closed');
    audit.mockClear();
    await expect(new CustodyService(closed.pool).reopen(CUSTODY, COMPANY, ACTOR, 'correction')).resolves.toEqual({ status: 'open' });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ action: 'custody.reopen', after_data: expect.objectContaining({ reason: 'correction' }) }), expect.anything());
  });

  it('detects inconsistent negative balance instead of silently clamping it to zero', async () => {
    const inconsistent = makePool(summaryHandler({ funding: '-100.00', allocated: '100.01' }));
    await expect(new CustodyService(inconsistent.pool).detail(CUSTODY, COMPANY)).rejects.toThrow('Custody balances are inconsistent');
  });
});
