import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { assertAccountingDateWritable } from '../monthly-close/accounting-period.guard';
import {
  CompanyReconciliation, ReconciliationMode, ReconciliationSettings, evaluateCompanyBankReconciliation, loadReconciliationSettings, lockBankAccountReconciliation,
} from './bank-reconciliation-core';

/** Stable, client-readable failure. `code` never changes; `message` is for logs and support. */
export class BankStatementError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
const invalid = (message: string, code = 'BANK_STATEMENT_INVALID') => new BankStatementError(400, code, message);
const conflict = (code: string, message: string) => new BankStatementError(409, code, message);
const notFound = (what = 'Not found', code = 'BANK_STATEMENT_NOT_FOUND') => new BankStatementError(404, code, what);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const validDate = (v: unknown): v is string =>
  typeof v === 'string' && DATE.test(v) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export type StatementInput = {
  bankAccountId: string; statementRef: string; periodStart: string; periodEnd: string; openingBalance: string | null; closingBalance: string;
  importBatchId: string | null; note: string | null;
};
export type StatementRow = {
  id: string; company_id: string; bank_account_id: string; currency_code: string; statement_ref: string; period_start: string; period_end: string;
  opening_balance: string | null; closing_balance: string; import_batch_id: string | null; note: string | null; status: 'draft' | 'confirmed' | 'superseded'; version: number;
  supersedes_id: string | null; replacement_reason: string | null; created_by: string; created_at: string; confirmed_by: string | null; confirmed_at: string | null;
  superseded_by: string | null; superseded_at: string | null;
};
export type LinkRow = {
  id: string; company_id: string; bank_account_id: string; account_id: string; valid_from: string; valid_to: string | null; created_by: string; created_at: string;
  ended_by: string | null; ended_at: string | null;
};

const STATEMENT_COLUMNS = `id,company_id,bank_account_id,currency_code,statement_ref,period_start::text,period_end::text,opening_balance::text,closing_balance::text,import_batch_id,note,
  status,version,supersedes_id,replacement_reason,created_by,created_at::text,confirmed_by,confirmed_at::text,superseded_by,superseded_at::text`;
const LINK_COLUMNS = 'id,company_id,bank_account_id,account_id,valid_from::text,valid_to::text,created_by,created_at::text,ended_by,ended_at::text';

const UNIQUE_CODES: Record<string, [string, string]> = {
  bank_statement_balances_confirmed_uidx: ['BANK_STATEMENT_DUPLICATE_PERIOD', 'A confirmed statement already exists for this bank account and period end'],
  bank_statement_balances_draft_uidx: ['BANK_STATEMENT_DUPLICATE_DRAFT', 'A draft statement already exists for this bank account and period end'],
  bank_statement_balances_ref_uidx: ['BANK_STATEMENT_DUPLICATE_REF', 'This statement reference is already used for the bank account'],
  bank_statement_balances_supersedes_uidx: ['BANK_STATEMENT_ALREADY_SUPERSEDED', 'This statement was already replaced'],
};

function mapDatabaseError(error: unknown): never {
  const e = error as { code?: string; constraint?: string; message?: string };
  if (e.code === '23505' && e.constraint && UNIQUE_CODES[e.constraint]) throw conflict(...UNIQUE_CODES[e.constraint]!);
  if (e.code === '23P01') throw conflict('BANK_LINK_OVERLAP', 'The link validity overlaps an existing link for this bank account or ledger account');
  if (e.code === '23000' || e.code === '23514') throw invalid(e.message ?? 'Constraint violation', 'BANK_RECONCILIATION_CONSTRAINT');
  throw error;
}

export class BankStatementService {
  private readonly audit = new AuditLogRepository();
  constructor(private readonly db: Pool) {}

  private async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return mapDatabaseError(error);
    } finally {
      client.release();
    }
  }

  /* ---------------- settings ---------------- */
  getSettings(companyId: string): Promise<ReconciliationSettings> { return loadReconciliationSettings(this.db, companyId); }

  async updateSettings(companyId: string, actor: string, input: { mode: ReconciliationMode; enforceFrom: string | null; version: number }): Promise<ReconciliationSettings> {
    if (input.mode === 'enforce' && !input.enforceFrom) throw invalid('Enforcement needs an effective date', 'BANK_RECON_ENFORCE_DATE_REQUIRED');
    if (input.mode === 'off' && input.enforceFrom !== null) throw invalid('An effective date applies only to warn or enforce', 'BANK_RECON_INVALID_SETTINGS');
    return this.tx(async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bank-reconciliation-settings:${companyId}`]);
      const before = await loadReconciliationSettings(client, companyId);
      if (before.version !== input.version) throw conflict('BANK_RECON_SETTINGS_STALE', 'Settings changed; reload and retry');
      await client.query(
        `INSERT INTO company_bank_reconciliation_settings(company_id,mode,enforce_from,version,updated_by,updated_at) VALUES($1,$2,$3,1,$4,NOW())
         ON CONFLICT (company_id) DO UPDATE SET mode=EXCLUDED.mode,enforce_from=EXCLUDED.enforce_from,version=company_bank_reconciliation_settings.version+1,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
        [companyId, input.mode, input.mode === 'enforce' ? input.enforceFrom : null, actor],
      );
      const after = await loadReconciliationSettings(client, companyId);
      await this.audit.logEvent({
        company_id: companyId, actor_user_id: actor, action: 'bank_reconciliation.settings', entity_type: 'bank_reconciliation_settings', entity_id: companyId,
        before_data: { mode: before.mode, enforce_from: before.enforce_from }, after_data: { mode: after.mode, enforce_from: after.enforce_from },
      }, client);
      return after;
    });
  }

  /* ---------------- ledger links ---------------- */
  async listLinks(companyId: string): Promise<LinkRow[]> {
    return (await this.db.query<LinkRow>(`SELECT ${LINK_COLUMNS} FROM bank_account_ledger_links WHERE company_id=$1 ORDER BY bank_account_id,valid_from DESC`, [companyId])).rows;
  }

  async createLink(companyId: string, actor: string, input: { bankAccountId: string; accountId: string; validFrom: string }): Promise<LinkRow> {
    return this.tx(async client => {
      const bank = (await client.query<{ currency_code: string; is_active: boolean }>('SELECT currency_code,is_active FROM bank_accounts WHERE id=$1 AND company_id=$2 FOR SHARE', [input.bankAccountId, companyId])).rows[0];
      if (!bank) throw notFound('Bank account not found', 'BANK_ACCOUNT_NOT_FOUND');
      if (!bank.is_active) throw conflict('BANK_ACCOUNT_INACTIVE', 'The bank account is inactive');
      const account = (await client.query('SELECT 1 FROM accounts WHERE id=$1 AND company_id=$2 AND is_active', [input.accountId, companyId])).rowCount;
      if (!account) throw notFound('Ledger account not found', 'BANK_LINK_ACCOUNT_NOT_FOUND');
      const functional = (await client.query<{ functional_currency: string }>(
        `SELECT functional_currency FROM company_accounting_profiles WHERE company_id=$1 AND workflow_status='approved' AND effective_from<=$2::date AND (effective_to IS NULL OR effective_to>=$2::date)
          ORDER BY effective_from DESC, version_no DESC LIMIT 1`, [companyId, input.validFrom],
      )).rows[0]?.functional_currency;
      if (!functional) throw conflict('BANK_LINK_CURRENCY_UNVERIFIED', 'No approved accounting profile gives the functional currency for this date');
      if (bank.currency_code.trim() !== functional) throw conflict('BANK_LINK_CURRENCY_MISMATCH', 'The bank account currency differs from the functional currency; foreign-currency reconciliation is not supported');
      const row = (await client.query<LinkRow>(
        `INSERT INTO bank_account_ledger_links(company_id,bank_account_id,account_id,valid_from,created_by) VALUES($1,$2,$3,$4,$5) RETURNING ${LINK_COLUMNS}`,
        [companyId, input.bankAccountId, input.accountId, input.validFrom, actor],
      )).rows[0]!;
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'bank_ledger_link.create', entity_type: 'bank_ledger_link', entity_id: row.id, before_data: null, after_data: row as never }, client);
      return row;
    });
  }

  async endLink(companyId: string, actor: string, id: string, validTo: string): Promise<LinkRow> {
    return this.tx(async client => {
      const before = (await client.query<LinkRow>(`SELECT ${LINK_COLUMNS} FROM bank_account_ledger_links WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id, companyId])).rows[0];
      if (!before) throw notFound('Link not found', 'BANK_LINK_NOT_FOUND');
      if (before.valid_to !== null) throw conflict('BANK_LINK_ALREADY_ENDED', 'The link is already ended');
      if (validTo < before.valid_from) throw invalid('End date precedes the start date', 'BANK_LINK_INVALID_DATE');
      const after = (await client.query<LinkRow>(
        `UPDATE bank_account_ledger_links SET valid_to=$3,ended_by=$4,ended_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING ${LINK_COLUMNS}`, [id, companyId, validTo, actor],
      )).rows[0]!;
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'bank_ledger_link.end', entity_type: 'bank_ledger_link', entity_id: id, before_data: before as never, after_data: after as never }, client);
      return after;
    });
  }

  /* ---------------- statements ---------------- */
  async listStatements(companyId: string, filter: { bankAccountId?: string; status?: string }): Promise<StatementRow[]> {
    return (await this.db.query<StatementRow>(
      `SELECT ${STATEMENT_COLUMNS} FROM bank_statement_balances WHERE company_id=$1 AND ($2::uuid IS NULL OR bank_account_id=$2::uuid) AND ($3::text IS NULL OR status=$3::text)
        ORDER BY bank_account_id, period_end DESC, created_at DESC LIMIT 500`, [companyId, filter.bankAccountId ?? null, filter.status ?? null],
    )).rows;
  }

  private async lockedStatement(client: PoolClient, companyId: string, id: string): Promise<StatementRow> {
    const peek = (await client.query<{ bank_account_id: string }>('SELECT bank_account_id FROM bank_statement_balances WHERE id=$1 AND company_id=$2', [id, companyId])).rows[0];
    if (!peek) throw notFound();
    // Statement operations order: period guard (caller) -> bank-account lock -> row lock. Closes take the same bank-account lock.
    await lockBankAccountReconciliation(client, companyId, peek.bank_account_id);
    const row = (await client.query<StatementRow>(`SELECT ${STATEMENT_COLUMNS} FROM bank_statement_balances WHERE id=$1 AND company_id=$2 FOR UPDATE`, [id, companyId])).rows[0];
    if (!row) throw notFound();
    return row;
  }

  private async validateInput(client: PoolClient, companyId: string, input: StatementInput): Promise<{ currency: string }> {
    const bank = (await client.query<{ currency_code: string; is_active: boolean }>('SELECT currency_code,is_active FROM bank_accounts WHERE id=$1 AND company_id=$2', [input.bankAccountId, companyId])).rows[0];
    if (!bank) throw notFound('Bank account not found', 'BANK_ACCOUNT_NOT_FOUND');
    if (!bank.is_active) throw conflict('BANK_ACCOUNT_INACTIVE', 'The bank account is inactive');
    if (input.periodEnd < input.periodStart) throw invalid('Period end precedes period start');
    if (input.importBatchId) {
      const batch = (await client.query('SELECT 1 FROM bank_import_batches WHERE id=$1 AND company_id=$2 AND bank_account_id=$3', [input.importBatchId, companyId, input.bankAccountId])).rowCount;
      if (!batch) throw invalid('Import batch does not belong to this bank account', 'BANK_STATEMENT_BATCH_INVALID');
    }
    return { currency: bank.currency_code };
  }

  async createDraft(companyId: string, actor: string, input: StatementInput): Promise<StatementRow> {
    return this.tx(async client => {
      await assertAccountingDateWritable(companyId, input.periodEnd, client);
      await lockBankAccountReconciliation(client, companyId, input.bankAccountId);
      const { currency } = await this.validateInput(client, companyId, input);
      const row = (await client.query<StatementRow>(
        `INSERT INTO bank_statement_balances(company_id,bank_account_id,currency_code,statement_ref,period_start,period_end,opening_balance,closing_balance,import_batch_id,note,created_by)
         VALUES($1,$2,$3,btrim($4),$5,$6,$7,$8,$9,$10,$11) RETURNING ${STATEMENT_COLUMNS}`,
        [companyId, input.bankAccountId, currency, input.statementRef, input.periodStart, input.periodEnd, input.openingBalance, input.closingBalance, input.importBatchId, input.note, actor],
      )).rows[0]!;
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'bank_statement.create_draft', entity_type: 'bank_statement', entity_id: row.id, before_data: null, after_data: row as never }, client);
      return row;
    });
  }

  async updateDraft(companyId: string, actor: string, id: string, version: number, input: StatementInput): Promise<StatementRow> {
    return this.tx(async client => {
      const peek = (await client.query<{ period_end: string }>('SELECT period_end::text FROM bank_statement_balances WHERE id=$1 AND company_id=$2', [id, companyId])).rows[0];
      if (!peek) throw notFound();
      await assertAccountingDateWritable(companyId, peek.period_end, client);
      await assertAccountingDateWritable(companyId, input.periodEnd, client);
      const before = await this.lockedStatement(client, companyId, id);
      if (before.status !== 'draft') throw conflict('BANK_STATEMENT_NOT_DRAFT', 'Only a draft statement can be edited');
      if (before.version !== version) throw conflict('BANK_STATEMENT_STALE', 'The statement changed; reload and retry');
      if (before.bank_account_id !== input.bankAccountId) throw invalid('The bank account of a statement cannot change', 'BANK_STATEMENT_ACCOUNT_IMMUTABLE');
      await this.validateInput(client, companyId, input);
      const after = (await client.query<StatementRow>(
        `UPDATE bank_statement_balances SET statement_ref=btrim($3),period_start=$4,period_end=$5,opening_balance=$6,closing_balance=$7,import_batch_id=$8,note=$9,version=version+1
          WHERE id=$1 AND company_id=$2 RETURNING ${STATEMENT_COLUMNS}`,
        [id, companyId, input.statementRef, input.periodStart, input.periodEnd, input.openingBalance, input.closingBalance, input.importBatchId, input.note],
      )).rows[0]!;
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'bank_statement.update_draft', entity_type: 'bank_statement', entity_id: id, before_data: before as never, after_data: after as never }, client);
      return after;
    });
  }

  async deleteDraft(companyId: string, actor: string, id: string, version: number): Promise<void> {
    await this.tx(async client => {
      const peek = (await client.query<{ period_end: string }>('SELECT period_end::text FROM bank_statement_balances WHERE id=$1 AND company_id=$2', [id, companyId])).rows[0];
      if (!peek) throw notFound();
      await assertAccountingDateWritable(companyId, peek.period_end, client);
      const before = await this.lockedStatement(client, companyId, id);
      if (before.status !== 'draft') throw conflict('BANK_STATEMENT_NOT_DRAFT', 'Only a draft statement can be deleted');
      if (before.version !== version) throw conflict('BANK_STATEMENT_STALE', 'The statement changed; reload and retry');
      await client.query('DELETE FROM bank_statement_balances WHERE id=$1 AND company_id=$2', [id, companyId]);
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'bank_statement.delete_draft', entity_type: 'bank_statement', entity_id: id, before_data: before as never, after_data: null }, client);
    });
  }

  async confirm(companyId: string, actor: string, id: string, version: number): Promise<StatementRow> {
    return this.tx(async client => {
      const peek = (await client.query<{ period_end: string }>('SELECT period_end::text FROM bank_statement_balances WHERE id=$1 AND company_id=$2', [id, companyId])).rows[0];
      if (!peek) throw notFound();
      await assertAccountingDateWritable(companyId, peek.period_end, client);
      const before = await this.lockedStatement(client, companyId, id);
      if (before.status !== 'draft') throw conflict('BANK_STATEMENT_NOT_DRAFT', 'Only a draft statement can be confirmed');
      if (before.version !== version) throw conflict('BANK_STATEMENT_STALE', 'The statement changed; reload and retry');
      const after = (await client.query<StatementRow>(
        `UPDATE bank_statement_balances SET status='confirmed',confirmed_by=$3,confirmed_at=NOW(),version=version+1 WHERE id=$1 AND company_id=$2 RETURNING ${STATEMENT_COLUMNS}`,
        [id, companyId, actor],
      )).rows[0]!;
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'bank_statement.confirm', entity_type: 'bank_statement', entity_id: id, before_data: before as never, after_data: after as never }, client);
      return after;
    });
  }

  /** Replacement of a confirmed statement: the old row is superseded and a new confirmed row (with the reason) takes its place, atomically. */
  async supersede(companyId: string, actor: string, id: string, version: number, reason: string, input: StatementInput): Promise<StatementRow> {
    if (!reason.trim() || reason.trim().length > 500) throw invalid('A replacement reason of 1 to 500 characters is required', 'BANK_STATEMENT_REASON_REQUIRED');
    return this.tx(async client => {
      const peek = (await client.query<{ period_end: string }>('SELECT period_end::text FROM bank_statement_balances WHERE id=$1 AND company_id=$2', [id, companyId])).rows[0];
      if (!peek) throw notFound();
      await assertAccountingDateWritable(companyId, peek.period_end, client);
      await assertAccountingDateWritable(companyId, input.periodEnd, client);
      const before = await this.lockedStatement(client, companyId, id);
      if (before.status !== 'confirmed') throw conflict('BANK_STATEMENT_NOT_CONFIRMED', 'Only a confirmed statement can be replaced');
      if (before.version !== version) throw conflict('BANK_STATEMENT_STALE', 'The statement changed; reload and retry');
      if (before.bank_account_id !== input.bankAccountId) throw invalid('The bank account of a statement cannot change', 'BANK_STATEMENT_ACCOUNT_IMMUTABLE');
      const { currency } = await this.validateInput(client, companyId, input);
      await client.query(`UPDATE bank_statement_balances SET status='superseded',superseded_by=$3,superseded_at=NOW(),version=version+1 WHERE id=$1 AND company_id=$2`, [id, companyId, actor]);
      const after = (await client.query<StatementRow>(
        `INSERT INTO bank_statement_balances(company_id,bank_account_id,currency_code,statement_ref,period_start,period_end,opening_balance,closing_balance,import_batch_id,note,status,
                                              supersedes_id,replacement_reason,created_by,confirmed_by,confirmed_at)
         VALUES($1,$2,$3,btrim($4),$5,$6,$7,$8,$9,$10,'confirmed',$11,btrim($12),$13,$13,NOW()) RETURNING ${STATEMENT_COLUMNS}`,
        [companyId, input.bankAccountId, currency, input.statementRef, input.periodStart, input.periodEnd, input.openingBalance, input.closingBalance, input.importBatchId, input.note, id, reason, actor],
      )).rows[0]!;
      await this.audit.logEvent({
        company_id: companyId, actor_user_id: actor, action: 'bank_statement.supersede', entity_type: 'bank_statement', entity_id: after.id,
        before_data: { superseded_id: id, statement_ref: before.statement_ref, period_end: before.period_end, closing_balance: before.closing_balance, opening_balance: before.opening_balance },
        after_data: { ...after, reason: reason.trim() } as never,
      }, client);
      return after;
    });
  }

  /* ---------------- calculation views ---------------- */
  /** Live calculation for one bank account (works in every mode so a company can review before activating warn/enforce). */
  async preview(companyId: string, bankAccountId: string, periodEnd: string): Promise<CompanyReconciliation> {
    const exists = (await this.db.query('SELECT 1 FROM bank_accounts WHERE id=$1 AND company_id=$2', [bankAccountId, companyId])).rowCount;
    if (!exists) throw notFound('Bank account not found', 'BANK_ACCOUNT_NOT_FOUND');
    return evaluateCompanyBankReconciliation(this.db, companyId, periodEnd, periodEnd, { bankAccountId });
  }

  status(companyId: string, periodStart: string, periodEnd: string): Promise<CompanyReconciliation> {
    return evaluateCompanyBankReconciliation(this.db, companyId, periodStart, periodEnd);
  }
}
