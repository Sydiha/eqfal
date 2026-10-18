import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { postJournalInTransaction } from '../accounting/journal-posting';
import { assertAccountingDateWritable } from '../monthly-close/accounting-period.guard';
import {
  PARTNER_MAPPING_ACCOUNT_TYPES, PartnerMappingKey, PartnerTransactionType, inflow, isPartnerMappingKey, isPartnerTransactionType,
  journalSides, loadPartnerPostingAccounts, mappingKeyFor,
} from '../accounting/partner-transaction-posting';

/** Stable, client-readable failure. `code` never changes; `message` is for logs and support. */
export class PartnerTransactionError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
const invalid = (message: string, code = 'PARTNER_TRANSACTION_INVALID') => new PartnerTransactionError(400, code, message);
const conflict = (code: string, message: string) => new PartnerTransactionError(409, code, message);
const notFound = (what = 'Not found') => new PartnerTransactionError(404, 'PARTNER_TRANSACTION_NOT_FOUND', what);

export type Channel = 'bank' | 'cash';
export type PartnerTransactionInput = {
  partnerId: string; type: PartnerTransactionType; date: string; amount: string; channel: Channel; bankAccountId: string | null;
  bankTransactionId: string | null; documentId: string | null; reference: string | null; description: string | null;
};
export type PartnerTransactionRow = {
  id: string; company_id: string; partner_id: string; partner_name?: string; transaction_type: PartnerTransactionType; transaction_date: string; amount: string;
  channel: Channel; bank_account_id: string | null; bank_transaction_id: string | null; document_id: string | null; reference: string | null; description: string | null;
  status: 'draft' | 'posted' | 'reversed'; journal_entry_id: string | null; reversal_journal_id: string | null; posted_at: string | null; reversed_at: string | null;
  reversal_date: string | null; reversal_reason: string | null; version: number; created_at: string;
};
type Class = PartnerMappingKey;
export type LedgerMovement = {
  date: string; kind: 'opening_balance' | 'transaction' | 'reversal'; account_class: Class; transaction_id: string | null; transaction_type: PartnerTransactionType | null;
  effect: string; running_balance: string; reference: string | null; description: string | null; channel: Channel | null; journal_entry_id: string | null;
  bank_transaction_id: string | null; document_id: string | null;
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const validDate = (v: unknown): v is string =>
  typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const COLUMNS = `t.id,t.company_id,t.partner_id,t.transaction_type,t.transaction_date::text,t.amount::text,t.channel,t.bank_account_id,t.bank_transaction_id,t.document_id,
  t.reference,t.description,t.status,t.journal_entry_id,t.reversal_journal_id,t.posted_at,t.reversed_at,t.reversal_date::text,t.reversal_reason,t.version,t.created_at`;
const toHalalas = (v: string): bigint => { const [w, f = ''] = v.split('.'); return BigInt(w!) * 100n + BigInt(f.padEnd(2, '0').slice(0, 2)); };
const fromHalalas = (h: bigint): string => { const neg = h < 0n; const a = neg ? -h : h; return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };

export class PartnerTransactionService {
  private readonly audit = new AuditLogRepository();
  constructor(private readonly db: Pool) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.db.connect();
    try {
      await c.query('BEGIN');
      const value = await fn(c);
      await c.query('COMMIT');
      return value;
    } catch (e) {
      await c.query('ROLLBACK');
      const code = (e as { code?: string }).code;
      // Final backstops of migration 087: a bank statement row already explained elsewhere / a second live link to the same row.
      if (code === '23505') throw conflict('PARTNER_BANK_TRANSACTION_ALREADY_EXPLAINED', 'The bank transaction is already linked or explained');
      if (code === '23503') throw notFound();
      throw e;
    } finally {
      c.release();
    }
  }

  // ---------------------------------------------------------------- account mappings (accountant configuration)

  /** The mapping lists plus the bank accounts. The chart-of-accounts picker list is included only for those who may manage mappings. */
  async mappings(companyId: string, includeAccounts = false) {
    const partnerRows = (await this.db.query(
      `SELECT m.partner_id, p.name partner_name, m.mapping_key, m.account_id, a.code account_code, a.name account_name, a.account_type, a.is_active,
              (a.is_active AND a.account_type = ANY (CASE m.mapping_key WHEN 'capital' THEN ARRAY['equity'] WHEN 'current' THEN ARRAY['equity','liability'] ELSE ARRAY['liability'] END)) AS valid
         FROM partner_account_mappings m JOIN partners p ON p.id=m.partner_id AND p.company_id=m.company_id JOIN accounts a ON a.id=m.account_id AND a.company_id=m.company_id
        WHERE m.company_id=$1 ORDER BY p.name, m.mapping_key`, [companyId])).rows;
    const cashRows = (await this.db.query(
      `SELECT m.bank_account_id, b.display_name bank_account_name, m.account_id, a.code account_code, a.name account_name, a.account_type, a.is_active,
              (a.is_active AND a.account_type = 'asset') AS valid
         FROM partner_cash_account_mappings m JOIN accounts a ON a.id=m.account_id AND a.company_id=m.company_id LEFT JOIN bank_accounts b ON b.id=m.bank_account_id AND b.company_id=m.company_id
        WHERE m.company_id=$1 ORDER BY b.display_name NULLS FIRST`, [companyId])).rows;
    const bankAccounts = (await this.db.query(
      'SELECT id, display_name, currency_code, is_active FROM bank_accounts WHERE company_id=$1 ORDER BY is_active DESC, display_name', [companyId])).rows;
    const accounts = includeAccounts
      ? (await this.db.query('SELECT id, code, name, account_type FROM accounts WHERE company_id=$1 AND is_active ORDER BY code', [companyId])).rows
      : undefined;
    return { partner_mappings: partnerRows, cash_mappings: cashRows, bank_accounts: bankAccounts, ...(accounts ? { accounts } : {}) };
  }

  private async accountFor(c: PoolClient, companyId: string, accountId: string, allowed: readonly string[], label: string) {
    const account = (await c.query<{ is_active: boolean; account_type: string }>(
      'SELECT is_active, account_type FROM accounts WHERE id=$1 AND company_id=$2 FOR SHARE', [accountId, companyId])).rows[0];
    if (!account || !account.is_active) throw invalid('Account not found or inactive for this company', 'PARTNER_MAPPING_ACCOUNT_INVALID');
    if (!allowed.includes(account.account_type)) throw invalid(`${label} requires an account of type ${allowed.join(' or ')}`, 'PARTNER_MAPPING_ACCOUNT_TYPE');
  }

  async setPartnerMapping(companyId: string, actor: string, partnerId: string, key: unknown, accountId: string) {
    if (!isPartnerMappingKey(key)) throw invalid('Unknown mapping key', 'PARTNER_MAPPING_KEY_INVALID');
    return this.tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM partners WHERE id=$1 AND company_id=$2 FOR SHARE', [partnerId, companyId])).rowCount) throw notFound('Partner not found');
      await this.accountFor(c, companyId, accountId, PARTNER_MAPPING_ACCOUNT_TYPES[key], `Mapping ${key}`);
      const before = (await c.query('SELECT account_id FROM partner_account_mappings WHERE company_id=$1 AND partner_id=$2 AND mapping_key=$3 FOR UPDATE', [companyId, partnerId, key])).rows[0] ?? null;
      await c.query(
        `INSERT INTO partner_account_mappings(company_id,partner_id,mapping_key,account_id,updated_by_user_id) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (company_id,partner_id,mapping_key) DO UPDATE SET account_id=EXCLUDED.account_id, updated_by_user_id=EXCLUDED.updated_by_user_id, updated_at=NOW()`,
        [companyId, partnerId, key, accountId, actor]);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'partner_account_mapping.set', entity_type: 'partner', entity_id: partnerId,
        before_data: before as never, after_data: { mapping_key: key, account_id: accountId } as never }, c);
    });
  }

  async clearPartnerMapping(companyId: string, actor: string, partnerId: string, key: unknown) {
    if (!isPartnerMappingKey(key)) throw invalid('Unknown mapping key', 'PARTNER_MAPPING_KEY_INVALID');
    return this.tx(async (c) => {
      const before = (await c.query('DELETE FROM partner_account_mappings WHERE company_id=$1 AND partner_id=$2 AND mapping_key=$3 RETURNING account_id', [companyId, partnerId, key])).rows[0];
      if (before) {
        await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'partner_account_mapping.clear', entity_type: 'partner', entity_id: partnerId,
          before_data: { mapping_key: key, account_id: before.account_id } as never, after_data: null as never }, c);
      }
    });
  }

  async setCashMapping(companyId: string, actor: string, bankAccountId: string | null, accountId: string) {
    return this.tx(async (c) => {
      if (bankAccountId && !(await c.query('SELECT 1 FROM bank_accounts WHERE id=$1 AND company_id=$2 FOR SHARE', [bankAccountId, companyId])).rowCount) throw notFound('Bank account not found');
      await this.accountFor(c, companyId, accountId, PARTNER_MAPPING_ACCOUNT_TYPES.cash, 'The cash/bank mapping');
      const before = (await c.query('SELECT account_id FROM partner_cash_account_mappings WHERE company_id=$1 AND bank_account_id IS NOT DISTINCT FROM $2::uuid FOR UPDATE', [companyId, bankAccountId])).rows[0] ?? null;
      if (before) {
        await c.query('UPDATE partner_cash_account_mappings SET account_id=$3, updated_by_user_id=$4, updated_at=NOW() WHERE company_id=$1 AND bank_account_id IS NOT DISTINCT FROM $2::uuid', [companyId, bankAccountId, accountId, actor]);
      } else {
        await c.query('INSERT INTO partner_cash_account_mappings(company_id,bank_account_id,account_id,updated_by_user_id) VALUES($1,$2,$3,$4)', [companyId, bankAccountId, accountId, actor]);
      }
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'partner_account_mapping.set', entity_type: 'company', entity_id: companyId,
        before_data: before as never, after_data: { mapping_key: 'cash', bank_account_id: bankAccountId, account_id: accountId } as never }, c);
    });
  }

  async clearCashMapping(companyId: string, actor: string, bankAccountId: string | null) {
    return this.tx(async (c) => {
      const before = (await c.query('DELETE FROM partner_cash_account_mappings WHERE company_id=$1 AND bank_account_id IS NOT DISTINCT FROM $2::uuid RETURNING account_id', [companyId, bankAccountId])).rows[0];
      if (before) {
        await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'partner_account_mapping.clear', entity_type: 'company', entity_id: companyId,
          before_data: { mapping_key: 'cash', bank_account_id: bankAccountId, account_id: before.account_id } as never, after_data: null as never }, c);
      }
    });
  }

  // ---------------------------------------------------------------- transactions

  /** Validates everything knowable at draft time. Posting re-validates dates, periods, mappings and the journal itself. */
  private async validate(c: PoolClient, companyId: string, input: PartnerTransactionInput) {
    const partner = (await c.query<{ is_active: boolean }>('SELECT is_active FROM partners WHERE id=$1 AND company_id=$2 FOR SHARE', [input.partnerId, companyId])).rows[0];
    if (!partner) throw notFound('Partner not found');
    if (!partner.is_active) throw conflict('PARTNER_INACTIVE', 'The partner is inactive');

    const years = (await c.query<{ status: string }>('SELECT status FROM fiscal_years WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date', [companyId, input.date])).rows;
    if (years.length !== 1) throw conflict('PARTNER_FISCAL_YEAR_UNRESOLVED', years.length === 0 ? 'No fiscal year covers the transaction date' : 'More than one fiscal year covers the transaction date');
    if (years[0]!.status !== 'open') throw conflict('PARTNER_FISCAL_YEAR_CLOSED', 'The fiscal year of the transaction date is closed');
    await assertAccountingDateWritable(companyId, input.date, c);

    if (input.channel === 'bank') {
      if (!input.bankAccountId) throw invalid('A bank transaction needs its bank account');
      const bank = (await c.query<{ is_active: boolean; currency_code: string }>('SELECT is_active, currency_code FROM bank_accounts WHERE id=$1 AND company_id=$2 FOR SHARE', [input.bankAccountId, companyId])).rows[0];
      if (!bank) throw notFound('Bank account not found');
      if (!bank.is_active) throw conflict('PARTNER_BANK_ACCOUNT_INACTIVE', 'The bank account is inactive');
      const profile = (await c.query<{ functional_currency: string }>(
        `SELECT functional_currency FROM company_accounting_profiles WHERE company_id=$1 AND workflow_status='approved' AND effective_from<=$2::date AND (effective_to IS NULL OR effective_to>=$2::date) ORDER BY version_no DESC LIMIT 1`,
        [companyId, input.date])).rows[0];
      if (profile && profile.functional_currency.trim() !== bank.currency_code.trim()) {
        throw conflict('PARTNER_CURRENCY_MISMATCH', 'The bank account currency differs from the functional currency; foreign-currency partner transactions are not supported');
      }
    } else if (input.bankAccountId || input.bankTransactionId) {
      throw invalid('A cash transaction cannot name a bank account or bank transaction');
    }

    if (input.bankTransactionId) {
      const bt = (await c.query<{ bank_account_id: string; amount: string; transaction_date: string }>(
        'SELECT bank_account_id, amount::text, transaction_date::text FROM bank_transactions WHERE id=$1 AND company_id=$2 FOR UPDATE', [input.bankTransactionId, companyId])).rows[0];
      if (!bt) throw notFound('Bank transaction not found');
      if (bt.bank_account_id !== input.bankAccountId) throw conflict('PARTNER_BANK_TRANSACTION_MISMATCH', 'The bank transaction belongs to a different bank account');
      const signed = toHalalas(bt.amount.replace('-', ''));
      if (signed !== toHalalas(input.amount)) throw conflict('PARTNER_BANK_TRANSACTION_MISMATCH', 'The bank transaction amount differs from the transaction amount');
      const credit = !bt.amount.startsWith('-');
      if (credit !== inflow(input.type)) throw conflict('PARTNER_BANK_TRANSACTION_MISMATCH', 'The bank transaction direction does not match the transaction type');
      if (bt.transaction_date !== input.date) throw conflict('PARTNER_BANK_TRANSACTION_MISMATCH', 'The bank transaction date differs from the transaction date');
      const explained = await c.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM bank_transaction_matches WHERE bank_transaction_id=$1) OR EXISTS (SELECT 1 FROM document_settlements WHERE bank_transaction_id=$1)
                     OR EXISTS (SELECT 1 FROM obligation_settlements WHERE bank_transaction_id=$1)`, [input.bankTransactionId]);
      if (explained.rowCount) throw conflict('PARTNER_BANK_TRANSACTION_ALREADY_EXPLAINED', 'The bank transaction is already explained by another record');
    }

    if (input.documentId && !(await c.query('SELECT 1 FROM documents WHERE id=$1 AND company_id=$2 FOR SHARE', [input.documentId, companyId])).rowCount) throw notFound('Document not found');
  }

  async list(companyId: string, f: { partnerId?: string; status?: string; from?: string; to?: string; limit: number }) {
    const { rows } = await this.db.query<PartnerTransactionRow>(
      `SELECT ${COLUMNS}, p.name partner_name FROM partner_transactions t JOIN partners p ON p.id=t.partner_id AND p.company_id=t.company_id
        WHERE t.company_id=$1 AND ($2::uuid IS NULL OR t.partner_id=$2) AND ($3::text IS NULL OR t.status=$3)
          AND ($4::date IS NULL OR t.transaction_date>=$4) AND ($5::date IS NULL OR t.transaction_date<=$5)
        ORDER BY t.transaction_date DESC, t.created_at DESC, t.id LIMIT $6`,
      [companyId, f.partnerId ?? null, f.status ?? null, f.from ?? null, f.to ?? null, f.limit]);
    return { transactions: rows };
  }

  async get(companyId: string, id: string, c?: PoolClient): Promise<PartnerTransactionRow> {
    const q = c ?? this.db;
    const row = (await q.query<PartnerTransactionRow>(`SELECT ${COLUMNS}, p.name partner_name FROM partner_transactions t JOIN partners p ON p.id=t.partner_id AND p.company_id=t.company_id WHERE t.id=$1 AND t.company_id=$2`, [id, companyId])).rows[0];
    if (!row) throw notFound();
    return row;
  }

  private snapshot(r: PartnerTransactionRow) {
    return { partner_id: r.partner_id, transaction_type: r.transaction_type, transaction_date: r.transaction_date, amount: r.amount, channel: r.channel, bank_account_id: r.bank_account_id,
      bank_transaction_id: r.bank_transaction_id, document_id: r.document_id, reference: r.reference, description: r.description, status: r.status, version: r.version };
  }

  async create(companyId: string, actor: string, input: PartnerTransactionInput) {
    return this.tx(async (c) => {
      await this.validate(c, companyId, input);
      const id = (await c.query<{ id: string }>(
        `INSERT INTO partner_transactions(company_id,partner_id,transaction_type,transaction_date,amount,channel,bank_account_id,bank_transaction_id,document_id,reference,description,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [companyId, input.partnerId, input.type, input.date, input.amount, input.channel, input.bankAccountId, input.bankTransactionId, input.documentId, input.reference, input.description, actor])).rows[0]!.id;
      const row = await this.get(companyId, id, c);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'partner_transaction.create', entity_type: 'partner_transaction', entity_id: id, before_data: null, after_data: this.snapshot(row) as never }, c);
      return row;
    });
  }

  private async lockRow(c: PoolClient, companyId: string, id: string): Promise<PartnerTransactionRow> {
    const row = (await c.query<PartnerTransactionRow>(`SELECT ${COLUMNS} FROM partner_transactions t WHERE t.id=$1 AND t.company_id=$2 FOR UPDATE`, [id, companyId])).rows[0];
    if (!row) throw notFound();
    return row;
  }

  async update(companyId: string, actor: string, id: string, input: PartnerTransactionInput, version: number) {
    return this.tx(async (c) => {
      const before = await this.lockRow(c, companyId, id);
      if (before.status !== 'draft') throw conflict('PARTNER_TRANSACTION_NOT_DRAFT', 'Only a draft partner transaction can be edited');
      if (before.version !== version) throw conflict('PARTNER_TRANSACTION_VERSION_CONFLICT', 'The transaction was changed by someone else; reload and retry');
      await this.validate(c, companyId, input);
      await c.query(
        `UPDATE partner_transactions SET partner_id=$3,transaction_type=$4,transaction_date=$5,amount=$6,channel=$7,bank_account_id=$8,bank_transaction_id=$9,document_id=$10,reference=$11,description=$12,
                version=version+1,updated_at=NOW() WHERE id=$1 AND company_id=$2 AND status='draft'`,
        [id, companyId, input.partnerId, input.type, input.date, input.amount, input.channel, input.bankAccountId, input.bankTransactionId, input.documentId, input.reference, input.description]);
      const after = await this.get(companyId, id, c);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'partner_transaction.update', entity_type: 'partner_transaction', entity_id: id, before_data: this.snapshot(before) as never, after_data: this.snapshot(after) as never }, c);
      return after;
    });
  }

  async remove(companyId: string, actor: string, id: string, version: number) {
    return this.tx(async (c) => {
      const before = await this.lockRow(c, companyId, id);
      if (before.status !== 'draft') throw conflict('PARTNER_TRANSACTION_NOT_DRAFT', 'Only a draft partner transaction can be deleted');
      if (before.version !== version) throw conflict('PARTNER_TRANSACTION_VERSION_CONFLICT', 'The transaction was changed by someone else; reload and retry');
      await c.query("DELETE FROM partner_transactions WHERE id=$1 AND company_id=$2 AND status='draft'", [id, companyId]);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'partner_transaction.delete', entity_type: 'partner_transaction', entity_id: id, before_data: this.snapshot(before) as never, after_data: null as never }, c);
    });
  }

  /**
   * Explicit posting. Idempotent: posting an already-posted transaction returns it unchanged (no second journal; the unique journal source index is the backstop).
   * The journal is prepared from the accountant's validated mappings only and goes through the canonical posting contract (fiscal-year, monthly-period,
   * source-authority, balance and inactive-account guards, plus the exact partner-account shape check).
   */
  async post(companyId: string, actor: string, id: string) {
    return this.tx(async (c) => {
      const row = await this.lockRow(c, companyId, id);
      if (row.status === 'posted') return { transaction: await this.get(companyId, id, c), replayed: true };
      if (row.status === 'reversed') throw conflict('PARTNER_TRANSACTION_REVERSED', 'A reversed partner transaction cannot be posted again');

      const partner = (await c.query<{ is_active: boolean; name: string }>('SELECT is_active, name FROM partners WHERE id=$1 AND company_id=$2 FOR SHARE', [row.partner_id, companyId])).rows[0];
      if (!partner) throw notFound('Partner not found');
      if (!partner.is_active) throw conflict('PARTNER_INACTIVE', 'The partner is inactive');

      const accounts = await loadPartnerPostingAccounts(c, companyId, row.partner_id, row.transaction_type, row.bank_account_id, true);
      const missing = [...(accounts.partnerAccountId ? [] : [`partner:${mappingKeyFor(row.transaction_type)}`]), ...(accounts.cashAccountId ? [] : [row.bank_account_id ? 'bank_account' : 'cash'])];
      if (missing.length) throw conflict('PARTNER_MAPPING_MISSING', `Missing or invalid account mappings: ${missing.join(', ')}`);
      if (accounts.partnerAccountId === accounts.cashAccountId) throw conflict('PARTNER_MAPPING_CONFLICT', 'The partner account and the cash/bank account must differ');

      const years = (await c.query<{ id: string }>('SELECT id FROM fiscal_years WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date', [companyId, row.transaction_date])).rows;
      if (years.length !== 1) throw conflict('PARTNER_FISCAL_YEAR_UNRESOLVED', years.length === 0 ? 'No fiscal year covers the transaction date' : 'More than one fiscal year covers the transaction date');

      const label = `Partner ${row.transaction_type.replace(/_/g, ' ')}: ${partner.name}`.slice(0, 500);
      const reference = (row.reference ?? `PT ${row.id.slice(0, 8)}`).slice(0, 200);
      const journal = (await c.query<{ id: string }>(
        `INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,reference,source_type,source_id,entry_type,status,created_by)
         VALUES($1,$2,$3,$4,$5,'partner_transaction',$6,'standard','draft',$7) RETURNING id`,
        [companyId, years[0]!.id, row.transaction_date, label, reference, id, actor])).rows[0]!;
      const { debit, credit } = journalSides(row.transaction_type, accounts.partnerAccountId!, accounts.cashAccountId!);
      await c.query('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence) VALUES($1,$2,$3,$4,0,$5,1),($1,$2,$6,0,$4,$5,2)',
        [companyId, journal.id, debit, row.amount, row.transaction_type, credit]);
      await postJournalInTransaction(c, companyId, actor, journal.id);

      const updated = await c.query(
        `UPDATE partner_transactions SET status='posted', journal_entry_id=$3, posted_by=$4, posted_at=NOW(), version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2 AND status='draft'`,
        [id, companyId, journal.id, actor]);
      if (!updated.rowCount) throw conflict('PARTNER_TRANSACTION_NOT_DRAFT', 'The transaction is no longer a draft');
      const after = await this.get(companyId, id, c);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'partner_transaction.post', entity_type: 'partner_transaction', entity_id: id,
        before_data: { status: 'draft', version: row.version }, after_data: { status: 'posted', journal_entry_id: journal.id, version: after.version } }, c);
      return { transaction: after, replayed: false };
    });
  }

  /** Reverses a POSTED partner transaction with a separate, balanced, swapped journal (the original journal is never touched) and marks it reversed. */
  async reverse(companyId: string, actor: string, id: string, input: { date: string; reason: string }) {
    return this.tx(async (c) => {
      const row = await this.lockRow(c, companyId, id);
      if (row.status !== 'posted') throw conflict('PARTNER_TRANSACTION_NOT_POSTED', 'Only a posted partner transaction can be reversed');
      if (input.date < row.transaction_date) throw invalid('Reversal date cannot precede the transaction date', 'PARTNER_REVERSAL_DATE_INVALID');
      const years = (await c.query<{ id: string }>('SELECT id FROM fiscal_years WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date', [companyId, input.date])).rows;
      if (years.length !== 1) throw conflict('PARTNER_FISCAL_YEAR_UNRESOLVED', years.length === 0 ? 'No fiscal year covers the reversal date' : 'More than one fiscal year covers the reversal date');
      const lines = (await c.query<{ account_id: string; debit: string; credit: string; memo: string | null; sequence: number }>(
        'SELECT account_id,debit::text,credit::text,memo,sequence FROM journal_lines WHERE journal_entry_id=$1 AND company_id=$2 ORDER BY sequence,id', [row.journal_entry_id, companyId])).rows;
      if (lines.length !== 2) throw conflict('PARTNER_JOURNAL_UNEXPECTED', 'The original journal has an unexpected shape');
      // The reversal is a sourced journal (migration 080 reserves reversal_of_journal_id for manual journals). One per transaction: the unique
      // (company, source_type, source_id) index of journal_entries is the final backstop, the row lock above is the first.
      const reversal = (await c.query<{ id: string }>(
        `INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,reference,source_type,source_id,entry_type,status,created_by)
         VALUES($1,$2,$3,$4,$5,'partner_transaction_reversal',$6,'standard','draft',$7) RETURNING id`,
        [companyId, years[0]!.id, input.date, `Reversal of partner transaction ${row.id.slice(0, 8)}`, `REV PT ${row.id.slice(0, 8)}`, id, actor])).rows[0]!;
      for (const l of lines) {
        await c.query('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence) VALUES($1,$2,$3,$4,$5,$6,$7)', [companyId, reversal.id, l.account_id, l.credit, l.debit, l.memo, l.sequence]);
      }
      // Mark reversed first so the reversal source row exists for the posting contract; any posting failure rolls the whole transaction back.
      await c.query(
        `UPDATE partner_transactions SET status='reversed', reversal_journal_id=$3, reversed_by=$4, reversed_at=NOW(), reversal_date=$5, reversal_reason=$6, version=version+1, updated_at=NOW()
          WHERE id=$1 AND company_id=$2 AND status='posted'`, [id, companyId, reversal.id, actor, input.date, input.reason]);
      await postJournalInTransaction(c, companyId, actor, reversal.id);
      const after = await this.get(companyId, id, c);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'partner_transaction.reverse', entity_type: 'partner_transaction', entity_id: id,
        before_data: { status: 'posted', version: row.version }, after_data: { status: 'reversed', reversal_journal_id: reversal.id, reversal_date: input.date, version: after.version }, reason: input.reason }, c);
      return after;
    });
  }

  // ---------------------------------------------------------------- partner ledger and balances

  /**
   * Chronological movement rows for one partner (or every partner when partnerId is null), up to `to`.
   * Sources, each counted exactly once: approved opening-balance review items (dated at the fiscal-year start, only when the review's journal is posted),
   * POSTED and REVERSED partner transactions (a reversed one yields its original row and a separate reversal row). Drafts never count.
   * Sign convention: positive = credit balance (what the partner has put in / is owed), negative = amounts taken out or repaid.
   */
  private async movementRows(companyId: string, partnerId: string | null, to: string) {
    return (await this.db.query<{ partner_id: string; kind: LedgerMovement['kind']; eff_date: string; account_class: Class; effect: string; transaction_id: string | null; transaction_type: PartnerTransactionType | null;
      reference: string | null; description: string | null; channel: Channel | null; journal_entry_id: string | null; bank_transaction_id: string | null; document_id: string | null; ord: number }>(
      `SELECT * FROM (
         SELECT i.partner_id, 'opening_balance'::text kind, fy.start_date::text eff_date,
                (CASE i.category WHEN 'partner_capital' THEN 'capital' WHEN 'partner_current' THEN 'current' ELSE 'loan' END) account_class,
                (CASE i.balance_side WHEN 'credit' THEN i.amount ELSE -i.amount END)::text effect, NULL::uuid transaction_id, NULL::text transaction_type,
                i.source_reference reference, i.note description, NULL::text channel, r.journal_entry_id, NULL::uuid bank_transaction_id, i.source_document_id document_id, 0 ord, i.created_at
           FROM opening_balance_items i JOIN opening_balance_reviews r ON r.id=i.review_id AND r.company_id=i.company_id
           JOIN fiscal_years fy ON fy.id=r.fiscal_year_id AND fy.company_id=r.company_id
           JOIN journal_entries j ON j.id=r.journal_entry_id AND j.company_id=r.company_id AND j.status='posted'
          WHERE i.company_id=$1 AND ($2::uuid IS NULL OR i.partner_id=$2) AND i.partner_id IS NOT NULL AND i.category IN ('partner_capital','partner_current','partner_loan')
         UNION ALL
         SELECT t.partner_id, 'transaction', t.transaction_date::text,
                (CASE t.transaction_type WHEN 'capital_contribution' THEN 'capital' WHEN 'loan_received' THEN 'loan' WHEN 'loan_repayment' THEN 'loan' ELSE 'current' END),
                (CASE WHEN t.transaction_type IN ('capital_contribution','current_deposit','loan_received') THEN t.amount ELSE -t.amount END)::text, t.id, t.transaction_type,
                t.reference, t.description, t.channel, t.journal_entry_id, t.bank_transaction_id, t.document_id, 1, t.created_at
           FROM partner_transactions t WHERE t.company_id=$1 AND ($2::uuid IS NULL OR t.partner_id=$2) AND t.status IN ('posted','reversed')
         UNION ALL
         SELECT t.partner_id, 'reversal', t.reversal_date::text,
                (CASE t.transaction_type WHEN 'capital_contribution' THEN 'capital' WHEN 'loan_received' THEN 'loan' WHEN 'loan_repayment' THEN 'loan' ELSE 'current' END),
                (CASE WHEN t.transaction_type IN ('capital_contribution','current_deposit','loan_received') THEN -t.amount ELSE t.amount END)::text, t.id, t.transaction_type,
                t.reference, t.reversal_reason, t.channel, t.reversal_journal_id, t.bank_transaction_id, t.document_id, 2, t.reversed_at
           FROM partner_transactions t WHERE t.company_id=$1 AND ($2::uuid IS NULL OR t.partner_id=$2) AND t.status='reversed'
       ) x WHERE x.eff_date <= $3 ORDER BY x.eff_date, x.ord, x.created_at`,
      [companyId, partnerId, to])).rows;
  }

  /** Opening balance, dated movements with a running balance per account class, and closing balance for one partner over [from, to]. */
  async ledger(companyId: string, partnerId: string, from: string, to: string) {
    const partner = (await this.db.query<{ id: string; name: string; is_active: boolean }>('SELECT id,name,is_active FROM partners WHERE id=$1 AND company_id=$2', [partnerId, companyId])).rows[0];
    if (!partner) throw notFound('Partner not found');
    const rows = await this.movementRows(companyId, partnerId, to);
    const running: Record<Class, bigint> = { capital: 0n, current: 0n, loan: 0n };
    const opening: Record<Class, bigint> = { capital: 0n, current: 0n, loan: 0n };
    const totals: Record<Class, { increase: bigint; decrease: bigint }> = { capital: { increase: 0n, decrease: 0n }, current: { increase: 0n, decrease: 0n }, loan: { increase: 0n, decrease: 0n } };
    const movements: LedgerMovement[] = [];
    for (const r of rows) {
      const effect = toHalalas(r.effect);
      // Opening-balance items dated on `from` are part of the opening position; everything dated before `from` is too.
      const isOpening = r.eff_date < from || (r.kind === 'opening_balance' && r.eff_date === from);
      running[r.account_class] += effect;
      if (isOpening) { opening[r.account_class] += effect; continue; }
      if (effect > 0n) totals[r.account_class].increase += effect; else totals[r.account_class].decrease += -effect;
      movements.push({ date: r.eff_date, kind: r.kind, account_class: r.account_class, transaction_id: r.transaction_id, transaction_type: r.transaction_type, effect: fromHalalas(effect),
        running_balance: fromHalalas(running[r.account_class]), reference: r.reference, description: r.description, channel: r.channel, journal_entry_id: r.journal_entry_id,
        bank_transaction_id: r.bank_transaction_id, document_id: r.document_id });
    }
    const drafts = Number((await this.db.query<{ n: string }>("SELECT COUNT(*)::text n FROM partner_transactions WHERE company_id=$1 AND partner_id=$2 AND status='draft' AND transaction_date<=$3", [companyId, partnerId, to])).rows[0]!.n);
    const classes = Object.fromEntries((['capital', 'current', 'loan'] as Class[]).map((k) => [k, {
      opening_balance: fromHalalas(opening[k]), increases: fromHalalas(totals[k].increase), decreases: fromHalalas(totals[k].decrease), closing_balance: fromHalalas(running[k]),
    }]));
    return { partner: { id: partner.id, name: partner.name, is_active: partner.is_active }, from, to, sign_convention: 'credit_positive', classes, movements, draft_transactions_excluded: drafts };
  }

  /** Closing balance per partner and class as of a date (same sources and rules as the ledger). */
  async balances(companyId: string, asOf: string) {
    const rows = await this.movementRows(companyId, null, asOf);
    const by = new Map<string, Record<Class, bigint>>();
    for (const r of rows) {
      const entry = by.get(r.partner_id) ?? { capital: 0n, current: 0n, loan: 0n };
      entry[r.account_class] += toHalalas(r.effect);
      by.set(r.partner_id, entry);
    }
    const partners = (await this.db.query<{ id: string; name: string }>('SELECT id,name FROM partners WHERE company_id=$1 ORDER BY name', [companyId])).rows;
    return {
      as_of: asOf, sign_convention: 'credit_positive',
      partners: partners.filter((p) => by.has(p.id)).map((p) => { const b = by.get(p.id)!; return { partner_id: p.id, partner_name: p.name, capital: fromHalalas(b.capital), current: fromHalalas(b.current), loan: fromHalalas(b.loan) }; }),
    };
  }
}

export { isPartnerTransactionType };
