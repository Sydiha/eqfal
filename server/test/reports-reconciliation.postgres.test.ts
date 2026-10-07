import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccountingService } from '../src/modules/accounting/accounting.router';
import { FinancialStatementsService } from '../src/modules/accounting/financial-statements';

const databaseUrl = process.env['DATABASE_URL'];
const describeDatabase = databaseUrl ? describe : describe.skip;

const cents = (values: string[]) => values.reduce((sum, value) => sum + Math.round(Number(value) * 100), 0);

// Real PostgreSQL (migrations applied): core reports reconcile to the same posted ledger.
describeDatabase('Core report reconciliation with PostgreSQL', () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const accounting = new AccountingService(pool);
  const statements = new FinancialStatementsService(pool);
  const userId = randomUUID();
  const companies: string[] = [];
  type World = { company: string; fy: string; accounts: Record<'cash' | 'payable' | 'capital' | 'revenue' | 'rent', string> };
  let main: World;

  async function world(label: string): Promise<World> {
    const company = randomUUID();
    companies.push(company);
    await pool.query('INSERT INTO companies(id,slug,name) VALUES($1,$2,$3)', [company, `reports-${company}`, label]);
    const fy = (await pool.query<{ id: string }>(
      "INSERT INTO fiscal_years(company_id,name,start_date,end_date) VALUES($1,'FY 2026','2026-01-01','2026-12-31') RETURNING id", [company])).rows[0]!.id;
    const account = async (code: string, type: string, category: string) => (await pool.query<{ id: string }>(
      'INSERT INTO accounts(company_id,code,name,account_type,statement_category) VALUES($1,$2,$2,$3,$4) RETURNING id', [company, code, type, category])).rows[0]!.id;
    return {
      company, fy,
      accounts: {
        cash: await account('1000', 'asset', 'current_asset'),
        payable: await account('2000', 'liability', 'current_liability'),
        capital: await account('3000', 'equity', 'equity'),
        revenue: await account('4000', 'revenue', 'revenue'),
        rent: await account('5000', 'expense', 'operating_expense'),
      },
    };
  }

  async function journal(w: World, date: string, lines: Array<[string, string, string]>, opts: { posted?: boolean; opening?: boolean } = {}) {
    const id = (await pool.query<{ id: string }>(
      'INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,entry_type,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [w.company, w.fy, date, `Entry ${date}`, opts.opening ? 'opening_balance' : 'standard', userId])).rows[0]!.id;
    for (const [index, [accountId, debit, credit]] of lines.entries()) {
      await pool.query('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence) VALUES($1,$2,$3,$4,$5,$6)',
        [w.company, id, accountId, debit, credit, index + 1]);
    }
    if (opts.posted !== false) {
      await pool.query("UPDATE journal_entries SET status='posted',posted_by=$3,posted_at=NOW() WHERE id=$1 AND company_id=$2", [id, w.company, userId]);
    }
  }

  beforeAll(async () => {
    await pool.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,'x')", [userId, `reports-${userId}@example.test`]);
    main = await world('Reports');
    const a = main.accounts;
    await journal(main, '2026-01-01', [[a.cash, '1000.00', '0'], [a.capital, '0', '1000.00']], { opening: true });
    await journal(main, '2026-03-15', [[a.cash, '500.00', '0'], [a.revenue, '0', '500.00']]);
    await journal(main, '2026-04-30', [[a.rent, '200.00', '0'], [a.payable, '0', '200.00']]);
    // Draft activity and another company's posted activity must never reach the reports.
    await journal(main, '2026-05-01', [[a.rent, '999.00', '0'], [a.cash, '0', '999.00']], { posted: false });
    const other = await world('Other');
    await journal(other, '2026-03-15', [[other.accounts.cash, '7777.00', '0'], [other.accounts.revenue, '0', '7777.00']]);
  });

  afterAll(async () => {
    // Posted journals are immutable by trigger, so cleanup is best-effort on a disposable database.
    try {
      await pool.query('DELETE FROM companies WHERE id = ANY($1)', [companies]);
      await pool.query('DELETE FROM users WHERE id=$1', [userId]);
    } catch { /* best-effort cleanup */ }
    await pool.end();
  });

  it('trial balance debits equal credits from posted, same-company activity only', async () => {
    const tb = await accounting.trialBalance(main.company, main.fy, undefined, undefined);
    const rows = tb.accounts as Array<Record<string, string>>;
    expect(cents(rows.map((r) => r.debit_movement!))).toBe(170000);
    expect(cents(rows.map((r) => r.credit_movement!))).toBe(170000);
    expect(cents(rows.map((r) => r.debit_balance!))).toBe(cents(rows.map((r) => r.credit_balance!)));
    expect(rows.find((r) => r.account_id === main.accounts.cash)).toMatchObject({ debit_balance: '1500.00', credit_balance: '0' });
  });

  it('general ledger totals and closing running balance tie to the trial balance for every account', async () => {
    const tb = (await accounting.trialBalance(main.company, main.fy, undefined, undefined)).accounts as Array<Record<string, string>>;
    for (const row of tb) {
      const gl = (await accounting.ledger(main.company, row.account_id!, main.fy, undefined, undefined)).activity as Array<Record<string, string>>;
      expect(cents(gl.map((l) => l.debit!))).toBe(cents([row.debit_movement!]));
      expect(cents(gl.map((l) => l.credit!))).toBe(cents([row.credit_movement!]));
      const closing = gl.length ? cents([gl[gl.length - 1]!.running_balance!]) : 0;
      expect(closing).toBe(cents([row.debit_movement!]) - cents([row.credit_movement!]));
    }
  });

  it('profit or loss uses only revenue and expense accounts and matches the trial balance', async () => {
    const pl = await statements.profitOrLoss(main.company, main.fy);
    expect(pl.profit_or_loss).toBe('300.00');
    const total = (category: string) => pl.sections.find((s) => s.category === category)?.total;
    expect(total('revenue')).toBe('500.00');
    expect(total('operating_expense')).toBe('200.00');
  });

  it('financial position balances on valid posted data', async () => {
    const bs = await statements.financialPosition(main.company, main.fy, '2026-12-31');
    expect(bs.total_assets).toBe('1500.00');
    expect(bs.total_liabilities).toBe('200.00');
    expect(bs.total_equity).toBe('1300.00');
    expect(bs.accounting_equation.balanced).toBe(true);
  });
});
