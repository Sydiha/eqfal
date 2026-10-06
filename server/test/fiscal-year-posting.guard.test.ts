import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { postJournalInTransaction, FiscalYearClosedError, JournalPostingConflictError } from '../src/modules/accounting/journal-posting';
import { AccountingPeriodClosedError } from '../src/modules/monthly-close/accounting-period.guard';

const COMPANY = 'c1', OTHER = 'c2', FY = 'fy1', JID = 'j1';

type World = { fyStatus: 'open' | 'closed'; monthClosed?: boolean; entryType?: string; sourceType?: string | null; date?: string };

function fakeClient(w: World) {
  const log: string[] = [];
  const state = { status: 'draft' };
  const client = {
    log,
    state,
    async query(sql: string, params: unknown[] = []) {
      log.push(sql);
      const rows = (r: unknown[]) => ({ rows: r, rowCount: r.length });
      if (sql.includes('FROM journal_entries WHERE id=$1')) {
        if (params[1] !== COMPANY) return rows([]);
        return rows([{ id: JID, company_id: COMPANY, fiscal_year_id: FY, accounting_date: w.date ?? '2025-03-01', source_type: w.sourceType ?? null, source_id: null, entry_type: w.entryType ?? 'standard', status: state.status }]);
      }
      if (sql.includes('FROM fiscal_years')) {
        if (params[0] !== FY || params[1] !== COMPANY) return rows([]);
        return rows([{ start_date: '2025-01-01', end_date: '2025-12-31', status: w.fyStatus }]);
      }
      if (sql.includes('CURRENT_DATE')) return rows([{ today: '2026-10-06' }]);
      if (sql.includes('monthly_close_periods')) return rows(w.monthClosed ? [{}] : []);
      if (sql.includes('FROM journal_lines l')) return rows([{ count: '2', debit: '10.00', credit: '10.00', active: '2' }]);
      if (sql.startsWith("UPDATE journal_entries SET status='posted'")) { state.status = 'posted'; return rows([{ id: JID, posted_at: new Date() }]); }
      return rows([]);
    },
  };
  return client as unknown as import('pg').PoolClient & { log: string[]; state: { status: string } };
}

describe('fiscal-year posting guard', () => {
  it('posts a manual journal in an OPEN fiscal year', async () => {
    const c = fakeClient({ fyStatus: 'open' });
    await expect(postJournalInTransaction(c, COMPANY, 'u', JID)).resolves.toMatchObject({ id: JID });
    expect(c.state.status).toBe('posted');
  });

  it('rejects posting in a CLOSED fiscal year without updating the journal', async () => {
    const c = fakeClient({ fyStatus: 'closed' });
    await expect(postJournalInTransaction(c, COMPANY, 'u', JID)).rejects.toBeInstanceOf(FiscalYearClosedError);
    expect(c.state.status).toBe('draft');
    expect(c.log.some(s => s.startsWith("UPDATE journal_entries"))).toBe(false);
    expect(c.log.some(s => s.includes('INSERT INTO audit'))).toBe(false);
  });

  it('draft created while open, year closes, later posting is rejected (state read at post time)', async () => {
    const w: World = { fyStatus: 'open' };
    const c = fakeClient(w);
    w.fyStatus = 'closed';
    await expect(postJournalInTransaction(c, COMPANY, 'u', JID)).rejects.toThrow('Fiscal year is closed');
  });

  it('closed-year error is a conflict so every caller maps it to 409', () => {
    expect(new FiscalYearClosedError()).toBeInstanceOf(JournalPostingConflictError);
  });

  it('opening-balance journal is rejected in a CLOSED fiscal year', async () => {
    const c = fakeClient({ fyStatus: 'closed', entryType: 'opening_balance', date: '2025-01-01' });
    await expect(postJournalInTransaction(c, COMPANY, 'u', JID)).rejects.toBeInstanceOf(FiscalYearClosedError);
  });

  it('source-backed journals (periodic adjustment / depreciation) are rejected in a CLOSED fiscal year', async () => {
    for (const sourceType of ['periodic_adjustment', 'asset_depreciation']) {
      const c = fakeClient({ fyStatus: 'closed', sourceType });
      await expect(postJournalInTransaction(c, COMPANY, 'u', JID)).rejects.toBeInstanceOf(FiscalYearClosedError);
    }
  });

  it('monthly closed-period guard still applies in an OPEN fiscal year', async () => {
    const c = fakeClient({ fyStatus: 'open', monthClosed: true });
    await expect(postJournalInTransaction(c, COMPANY, 'u', JID)).rejects.toBeInstanceOf(AccountingPeriodClosedError);
  });

  it('tenant isolation: another company cannot post this journal or see its fiscal year', async () => {
    const c = fakeClient({ fyStatus: 'open' });
    await expect(postJournalInTransaction(c, OTHER, 'u', JID)).rejects.toThrow();
    expect(c.state.status).toBe('draft');
  });

  it('already-posted journals are not mutated', async () => {
    const c = fakeClient({ fyStatus: 'closed' });
    c.state.status = 'posted';
    await expect(postJournalInTransaction(c, COMPANY, 'u', JID)).rejects.toBeInstanceOf(JournalPostingConflictError);
    expect(c.log.some(s => s.startsWith('UPDATE'))).toBe(false);
  });

  it('guard is shared: one status check in journal-posting, none duplicated in callers', () => {
    const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
    expect(read('../src/modules/accounting/journal-posting.ts')).toContain('assertFiscalYearOpen(');
    for (const p of ['accounting/accounting.router.ts', 'opening-balances/opening-balances.router.ts', 'periodic-adjustments/periodic-adjustments.router.ts']) {
      expect(read(`../src/modules/${p}`)).not.toContain('assertFiscalYearOpen');
    }
    expect(read('../src/modules/accounting/fiscal-year-posting.guard.ts')).toContain('FOR SHARE');
  });
});
