import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { postJournalInTransaction } from '../accounting/journal-posting';
import { assertAccountingDateWritable } from '../monthly-close/accounting-period.guard';
import { resolveBankLedgerAccount, resolvePayerAccount } from '../accounting/personal-payment-posting';

/**
 * Personal expense payments (a manager, employee or partner paid for the company out of personal funds) and their reimbursement. T3 / migration 089.
 * Workflow: draft -> submitted -> approved (posted atomically) | rejected -> (reopen) draft. Reimbursements are bank-backed, partial or final.
 * Presentation-free: every rule (payer identity, mappings, duplicates, periods, amounts) is enforced here and backstopped by database triggers.
 */

/** Stable, client-readable failure. `code` never changes; `message` is for logs and support. */
export class PersonalPaymentError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) { super(message); }
}
const invalid = (message: string, code = 'PERSONAL_PAYMENT_INVALID') => new PersonalPaymentError(400, code, message);
const conflict = (code: string, message: string) => new PersonalPaymentError(409, code, message);
const notFound = (what = 'Not found') => new PersonalPaymentError(404, 'PERSONAL_PAYMENT_NOT_FOUND', what);

export type Treatment = 'new_expense' | 'existing_obligation';
export type Status = 'draft' | 'submitted' | 'approved' | 'rejected';
export type PaymentInput = {
  payerId: string; treatment: Treatment; paymentDate: string; amount: string; purpose: string; counterpartyId: string | null;
  documentId: string | null; obligationId: string | null; expenseAccountId: string | null;
};
export type PayerInput = { displayName: string; userId: string | null; partnerId: string | null; payableAccountId: string | null };

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const validDate = (v: unknown): v is string =>
  typeof v === 'string' && DATE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const toHalalas = (v: string): bigint => { const [w, f = ''] = v.split('.'); return BigInt(w!) * 100n + BigInt(f.padEnd(2, '0').slice(0, 2)); };
const fromHalalas = (h: bigint): string => { const neg = h < 0n; const a = neg ? -h : h; return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };

type PaymentRow = {
  id: string; company_id: string; payer_id: string; payer_name?: string; payer_kind?: 'partner' | 'employee'; treatment: Treatment; payment_date: string; accounting_date: string;
  amount: string; currency_code: string; purpose: string; counterparty_id: string | null; counterparty_name?: string | null; document_id: string | null; obligation_id: string | null;
  expense_account_id: string | null; status: Status; debit_account_id: string | null; credit_account_id: string | null; journal_entry_id: string | null;
  submitted_at: string | null; reviewed_at: string | null; rejection_reason: string | null; version: number; created_at: string;
  reimbursed_amount?: string; outstanding_amount?: string; settlement_status?: 'none' | 'partial' | 'full';
};
const COLUMNS = `p.id,p.company_id,p.payer_id,p.treatment,p.payment_date::text,p.accounting_date::text,p.amount::text,p.currency_code,p.purpose,p.counterparty_id,p.document_id,
  p.obligation_id,p.expense_account_id,p.status,p.debit_account_id,p.credit_account_id,p.journal_entry_id,p.submitted_at,p.reviewed_at,p.rejection_reason,p.version,p.created_at`;
const WITH_TOTALS = `${COLUMNS}, py.display_name payer_name, (CASE WHEN py.partner_id IS NULL THEN 'employee' ELSE 'partner' END) payer_kind, cp.name counterparty_name,
  COALESCE(rb.total,0)::text reimbursed_amount, (CASE WHEN p.status='approved' THEN p.amount-COALESCE(rb.total,0) ELSE 0 END)::text outstanding_amount,
  (CASE WHEN p.status<>'approved' OR COALESCE(rb.total,0)=0 THEN 'none' WHEN COALESCE(rb.total,0)>=p.amount THEN 'full' ELSE 'partial' END) settlement_status`;
const FROM_TOTALS = `FROM personal_payments p JOIN personal_payers py ON py.id=p.payer_id AND py.company_id=p.company_id
  LEFT JOIN counterparties cp ON cp.id=p.counterparty_id AND cp.company_id=p.company_id
  LEFT JOIN (SELECT company_id,payment_id,SUM(amount) total FROM personal_payment_reimbursements GROUP BY company_id,payment_id) rb ON rb.payment_id=p.id AND rb.company_id=p.company_id`;

export class PersonalPaymentService {
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
      const err = e as { code?: string; message?: string };
      // Final backstops of migration 089, surfaced as stable codes.
      if (err.code === '23505') {
        if (/bank transaction already explained|personal_payment_reimbursements_bank_transaction_id_key/.test(err.message ?? '')) throw conflict('PERSONAL_BANK_TRANSACTION_ALREADY_EXPLAINED', 'The bank transaction is already linked or explained');
        if (/document is already recognized|personal_payments_document_uidx/.test(err.message ?? '')) throw conflict('PERSONAL_PAYMENT_DOCUMENT_ALREADY_RECOGNIZED', 'The document is already recognized by another workflow');
        if (/personal_payers_/.test(err.message ?? '')) throw conflict('PERSONAL_PAYER_DUPLICATE', 'The payer, partner or user is already registered');
        throw conflict('PERSONAL_PAYMENT_DUPLICATE', 'A duplicate financial effect was refused');
      }
      if (err.code === '23514' && /exceeds the outstanding/.test(err.message ?? '')) throw conflict('PERSONAL_PAYMENT_OVER_REIMBURSEMENT', 'The amount exceeds the outstanding amount');
      if (err.code === '23503') throw notFound();
      throw e;
    } finally {
      c.release();
    }
  }

  private async functionalCurrency(c: PoolClient, companyId: string, date: string): Promise<string> {
    const profile = (await c.query<{ functional_currency: string }>(
      `SELECT functional_currency FROM company_accounting_profiles WHERE company_id=$1 AND workflow_status='approved' AND effective_from<=$2::date AND (effective_to IS NULL OR effective_to>=$2::date) ORDER BY version_no DESC LIMIT 1`,
      [companyId, date])).rows[0];
    return (profile?.functional_currency ?? 'SAR').trim();
  }

  private async fiscalYear(c: PoolClient, companyId: string, date: string, requireOpen: boolean): Promise<string> {
    const years = (await c.query<{ id: string; status: string }>('SELECT id,status FROM fiscal_years WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date', [companyId, date])).rows;
    if (years.length !== 1) throw conflict('PERSONAL_PAYMENT_FISCAL_YEAR_UNRESOLVED', years.length === 0 ? 'No fiscal year covers the date' : 'More than one fiscal year covers the date');
    if (requireOpen && years[0]!.status !== 'open') throw conflict('PERSONAL_PAYMENT_FISCAL_YEAR_CLOSED', 'The fiscal year of the date is closed');
    return years[0]!.id;
  }

  // ---------------------------------------------------------------- payers (explicit identity + partner association + payable mapping)

  async payers(companyId: string, includeAccounts: boolean) {
    const rows = (await this.db.query(
      `SELECT py.id, py.display_name, py.user_id, u.email user_email, py.partner_id, pr.name partner_name, py.payable_account_id, a.code payable_account_code, a.name payable_account_name,
              py.is_active, py.version,
              (CASE WHEN py.partner_id IS NOT NULL THEN EXISTS (SELECT 1 FROM partner_account_mappings m JOIN accounts x ON x.id=m.account_id AND x.company_id=m.company_id
                       WHERE m.company_id=py.company_id AND m.partner_id=py.partner_id AND m.mapping_key='current' AND x.is_active AND x.account_type IN ('equity','liability'))
                    ELSE COALESCE(a.is_active AND a.account_type='liability', FALSE) END) AS mapping_valid
         FROM personal_payers py LEFT JOIN users u ON u.id=py.user_id LEFT JOIN partners pr ON pr.id=py.partner_id AND pr.company_id=py.company_id
         LEFT JOIN accounts a ON a.id=py.payable_account_id AND a.company_id=py.company_id
        WHERE py.company_id=$1 ORDER BY py.is_active DESC, py.display_name`, [companyId])).rows;
    const extra = includeAccounts ? {
      accounts: (await this.db.query("SELECT id, code, name, account_type FROM accounts WHERE company_id=$1 AND is_active AND account_type='liability' ORDER BY code", [companyId])).rows,
      partners: (await this.db.query('SELECT id, name FROM partners WHERE company_id=$1 AND is_active ORDER BY name', [companyId])).rows,
      members: (await this.db.query(
        `SELECT u.id, u.email FROM memberships m JOIN users u ON u.id=m.user_id WHERE m.company_id=$1 AND m.is_active ORDER BY u.email`, [companyId])).rows,
    } : {};
    return { payers: rows, ...extra };
  }

  private async checkPayerReferences(c: PoolClient, companyId: string, input: PayerInput) {
    if (input.partnerId && input.payableAccountId) throw invalid('A partner payer is recognized through the partner current account, not a separate payable', 'PERSONAL_PAYER_ONE_ACCOUNT_PATH');
    if (input.partnerId) {
      const partner = (await c.query<{ is_active: boolean }>('SELECT is_active FROM partners WHERE id=$1 AND company_id=$2 FOR SHARE', [input.partnerId, companyId])).rows[0];
      if (!partner) throw notFound('Partner not found');
      if (!partner.is_active) throw conflict('PARTNER_INACTIVE', 'The partner is inactive');
    }
    if (input.userId && !(await c.query('SELECT 1 FROM memberships WHERE user_id=$1 AND company_id=$2 AND is_active', [input.userId, companyId])).rowCount) {
      throw conflict('PERSONAL_PAYER_USER_NOT_MEMBER', 'The user is not an active member of this company');
    }
    if (input.payableAccountId) {
      const account = (await c.query<{ is_active: boolean; account_type: string }>('SELECT is_active, account_type FROM accounts WHERE id=$1 AND company_id=$2 FOR SHARE', [input.payableAccountId, companyId])).rows[0];
      if (!account || !account.is_active) throw invalid('Account not found or inactive for this company', 'PERSONAL_PAYER_ACCOUNT_INVALID');
      if (account.account_type !== 'liability') throw invalid('The payable account must be a liability account', 'PERSONAL_PAYER_ACCOUNT_TYPE');
    }
  }

  async createPayer(companyId: string, actor: string, input: PayerInput) {
    return this.tx(async (c) => {
      await this.checkPayerReferences(c, companyId, input);
      const row = (await c.query(
        `INSERT INTO personal_payers(company_id,display_name,user_id,partner_id,payable_account_id,created_by) VALUES($1,$2,$3,$4,$5,$6)
         RETURNING id,display_name,user_id,partner_id,payable_account_id,is_active,version`,
        [companyId, input.displayName, input.userId, input.partnerId, input.payableAccountId, actor])).rows[0]!;
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'personal_payer.create', entity_type: 'personal_payer', entity_id: row.id, before_data: null as never, after_data: row as never }, c);
      return row;
    });
  }

  async updatePayer(companyId: string, actor: string, id: string, patch: { displayName?: string; isActive?: boolean; payableAccountId?: string | null }, version: number) {
    return this.tx(async (c) => {
      const before = (await c.query('SELECT id,display_name,user_id,partner_id,payable_account_id,is_active,version FROM personal_payers WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, companyId])).rows[0];
      if (!before) throw notFound('Payer not found');
      if (before.version !== version) throw conflict('PERSONAL_PAYER_VERSION_CONFLICT', 'The payer was changed by someone else; reload and retry');
      const payable = patch.payableAccountId === undefined ? before.payable_account_id : patch.payableAccountId;
      if (before.partner_id && payable) throw invalid('A partner payer is recognized through the partner current account, not a separate payable', 'PERSONAL_PAYER_ONE_ACCOUNT_PATH');
      await this.checkPayerReferences(c, companyId, { displayName: '', userId: null, partnerId: null, payableAccountId: payable });
      const after = (await c.query(
        `UPDATE personal_payers SET display_name=$3, is_active=$4, payable_account_id=$5, version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2
         RETURNING id,display_name,user_id,partner_id,payable_account_id,is_active,version`,
        [id, companyId, patch.displayName ?? before.display_name, patch.isActive ?? before.is_active, payable])).rows[0]!;
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'personal_payer.update', entity_type: 'personal_payer', entity_id: id, before_data: before as never, after_data: after as never }, c);
      return after;
    });
  }

  // ---------------------------------------------------------------- lookups for the registration form

  async lookups(companyId: string, forCreate: boolean) {
    const payers = (await this.db.query('SELECT id, display_name, (partner_id IS NOT NULL) is_partner FROM personal_payers WHERE company_id=$1 AND is_active ORDER BY display_name', [companyId])).rows;
    if (!forCreate) return { payers };
    const documents = (await this.db.query(
      `SELECT d.id, d.original_filename, d.total_amount::text, d.document_date::text, d.counterparty_id FROM documents d
        WHERE d.company_id=$1 AND d.status='approved' AND d.document_type='expense' AND d.total_amount IS NOT NULL AND d.document_date IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM obligations o WHERE o.document_id=d.id AND o.company_id=d.company_id AND NOT o.is_cancelled)
          AND NOT EXISTS (SELECT 1 FROM custody_document_allocations a WHERE a.document_id=d.id AND a.company_id=d.company_id)
          AND NOT EXISTS (SELECT 1 FROM document_settlements s WHERE s.document_id=d.id AND s.company_id=d.company_id)
          AND NOT EXISTS (SELECT 1 FROM invoice_source_links l WHERE l.document_id=d.id AND l.company_id=d.company_id)
          AND NOT EXISTS (SELECT 1 FROM personal_payments p WHERE p.document_id=d.id AND p.company_id=d.company_id AND p.status<>'rejected')
          AND NOT EXISTS (SELECT 1 FROM document_vat_reviews r WHERE r.document_id=d.id AND r.company_id=d.company_id AND (r.review_status<>'reviewed' OR COALESCE(r.vat_amount,0)>0))
        ORDER BY d.document_date DESC, d.created_at DESC LIMIT 300`, [companyId])).rows;
    const obligations = (await this.db.query(
      `SELECT o.id, c.name counterparty_name, o.recognized_on::text, o.original_amount::text,
              (o.original_amount+obligation_adjustment_net(o.id,o.company_id)-CASE WHEN o.source_type='document'
                 THEN COALESCE((SELECT SUM(s.amount) FROM document_settlements s WHERE s.document_id=o.document_id AND s.company_id=o.company_id),0)
                 ELSE COALESCE((SELECT SUM(s.amount) FROM obligation_settlements s WHERE s.obligation_id=o.id AND s.company_id=o.company_id),0) END)::text outstanding
         FROM obligations o JOIN counterparties c ON c.id=o.counterparty_id AND c.company_id=o.company_id
        WHERE o.company_id=$1 AND o.direction='payable' AND o.verification_status='confirmed' AND NOT o.is_cancelled
          AND EXISTS (SELECT 1 FROM journal_entries j WHERE j.company_id=o.company_id AND j.source_type='obligation' AND j.source_id=o.id AND j.status='posted')
        ORDER BY o.recognized_on DESC LIMIT 300`, [companyId])).rows.filter((o: { outstanding: string }) => toHalalas(o.outstanding) > 0n);
    const accounts = (await this.db.query("SELECT id, code, name FROM accounts WHERE company_id=$1 AND is_active AND account_type='expense' ORDER BY code", [companyId])).rows;
    const counterparties = (await this.db.query('SELECT id, name FROM counterparties WHERE company_id=$1 AND is_active ORDER BY name', [companyId])).rows;
    return { payers, documents, obligations, expense_accounts: accounts, counterparties };
  }

  // ---------------------------------------------------------------- payments

  async list(companyId: string, f: { status?: string; payerId?: string; from?: string; to?: string; limit: number }) {
    const { rows } = await this.db.query<PaymentRow>(
      `SELECT ${WITH_TOTALS} ${FROM_TOTALS}
        WHERE p.company_id=$1 AND ($2::text IS NULL OR p.status=$2) AND ($3::uuid IS NULL OR p.payer_id=$3)
          AND ($4::date IS NULL OR p.accounting_date>=$4) AND ($5::date IS NULL OR p.accounting_date<=$5)
        ORDER BY p.accounting_date DESC, p.created_at DESC, p.id LIMIT $6`,
      [companyId, f.status ?? null, f.payerId ?? null, f.from ?? null, f.to ?? null, f.limit]);
    return { payments: rows };
  }

  /** Detail with reimbursement history. The workflow events and journal links are returned only to those holding the audit capability. */
  async get(companyId: string, id: string, includeAudit: boolean, c?: PoolClient) {
    const q = c ?? this.db;
    const payment = (await q.query<PaymentRow>(`SELECT ${WITH_TOTALS} ${FROM_TOTALS} WHERE p.id=$1 AND p.company_id=$2`, [id, companyId])).rows[0];
    if (!payment) throw notFound();
    const reimbursements = (await q.query(
      `SELECT r.id, r.amount::text, r.reimbursement_date::text, r.bank_transaction_id, t.bank_reference, t.description bank_description, r.note, r.created_at${includeAudit ? ', r.journal_entry_id' : ''}
         FROM personal_payment_reimbursements r JOIN bank_transactions t ON t.id=r.bank_transaction_id AND t.company_id=r.company_id
        WHERE r.payment_id=$1 AND r.company_id=$2 ORDER BY r.reimbursement_date, r.created_at, r.id`, [id, companyId])).rows;
    const history = includeAudit ? (await q.query(
      `SELECT e.id, e.event_type, e.from_status, e.to_status, e.actor_user_id, u.email actor_email, e.reason, e.journal_entry_id, e.reimbursement_id, e.amount::text, e.created_at
         FROM personal_payment_events e JOIN users u ON u.id=e.actor_user_id WHERE e.payment_id=$1 AND e.company_id=$2 ORDER BY e.created_at, e.id`, [id, companyId])).rows : undefined;
    const visible = includeAudit ? payment : { ...payment, journal_entry_id: null, debit_account_id: null, credit_account_id: null };
    return { payment: visible, reimbursements, ...(history ? { history } : {}) };
  }

  private snapshot(r: PaymentRow) {
    return { payer_id: r.payer_id, treatment: r.treatment, payment_date: r.payment_date, accounting_date: r.accounting_date, amount: r.amount, purpose: r.purpose,
      counterparty_id: r.counterparty_id, document_id: r.document_id, obligation_id: r.obligation_id, expense_account_id: r.expense_account_id, status: r.status, version: r.version };
  }

  private async event(c: PoolClient, companyId: string, paymentId: string, actor: string, e: { type: string; from?: Status | null; to?: Status | null; reason?: string | null; journalId?: string | null; reimbursementId?: string | null; amount?: string | null }) {
    await c.query(
      `INSERT INTO personal_payment_events(company_id,payment_id,event_type,from_status,to_status,actor_user_id,reason,journal_entry_id,reimbursement_id,amount) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [companyId, paymentId, e.type, e.from ?? null, e.to ?? null, actor, e.reason ?? null, e.journalId ?? null, e.reimbursementId ?? null, e.amount ?? null]);
  }

  /** Outstanding amount of an existing payable obligation (same formula every obligation reader uses), after locking it. */
  private async lockedObligation(c: PoolClient, companyId: string, obligationId: string, lock: 'SHARE' | 'UPDATE') {
    const o = (await c.query<{ id: string; counterparty_id: string; recognized_on: string; direction: string; verification_status: string; is_cancelled: boolean; outstanding: string }>(
      `SELECT o.id, o.counterparty_id, o.recognized_on::text, o.direction, o.verification_status, o.is_cancelled,
              (o.original_amount+obligation_adjustment_net(o.id,o.company_id)-CASE WHEN o.source_type='document'
                 THEN COALESCE((SELECT SUM(s.amount) FROM document_settlements s WHERE s.document_id=o.document_id AND s.company_id=o.company_id),0)
                 ELSE COALESCE((SELECT SUM(s.amount) FROM obligation_settlements s WHERE s.obligation_id=o.id AND s.company_id=o.company_id),0) END)::text outstanding
         FROM obligations o WHERE o.id=$1 AND o.company_id=$2 FOR ${lock}`, [obligationId, companyId])).rows[0];
    if (!o) throw notFound('Obligation not found');
    if (o.direction !== 'payable' || o.verification_status !== 'confirmed' || o.is_cancelled) throw conflict('PERSONAL_PAYMENT_OBLIGATION_NOT_OPEN', 'The obligation is not an open confirmed payable');
    const posted = (await c.query<{ id: string }>("SELECT id FROM journal_entries WHERE company_id=$1 AND source_type='obligation' AND source_id=$2 AND status='posted'", [companyId, obligationId])).rows[0];
    if (!posted) throw conflict('PERSONAL_PAYMENT_OBLIGATION_NOT_POSTED', 'The obligation has no posted recognition journal');
    return { ...o, journalId: posted.id };
  }

  /**
   * Everything knowable from the stored content: payer, document or obligation evidence, amount agreement, VAT boundary, period. Used at draft time,
   * again on submit and again on approval (selfId excludes the payment itself from the "already recognized" checks).
   */
  private async validate(c: PoolClient, companyId: string, input: PaymentInput, selfId: string | null, lock: 'SHARE' | 'UPDATE') {
    const payer = (await c.query<{ is_active: boolean }>('SELECT is_active FROM personal_payers WHERE id=$1 AND company_id=$2 FOR SHARE', [input.payerId, companyId])).rows[0];
    if (!payer) throw new PersonalPaymentError(404, 'PERSONAL_PAYER_NOT_FOUND', 'Payer not found');
    if (!payer.is_active) throw conflict('PERSONAL_PAYER_INACTIVE', 'The payer is inactive');

    let accountingDate: string;
    let counterpartyId = input.counterpartyId;
    if (input.treatment === 'new_expense') {
      if (!input.documentId || input.obligationId || !input.expenseAccountId) throw invalid('A new expense needs its document and expense account only');
      const doc = (await c.query<{ status: string; document_type: string | null; document_date: string | null; total_amount: string | null; counterparty_id: string | null }>(
        'SELECT status, document_type, document_date::text, total_amount::text, counterparty_id FROM documents WHERE id=$1 AND company_id=$2 FOR SHARE', [input.documentId, companyId])).rows[0];
      if (!doc) throw notFound('Document not found');
      if (doc.status !== 'approved' || doc.document_type !== 'expense' || !doc.document_date || doc.total_amount === null) {
        throw conflict('PERSONAL_PAYMENT_DOCUMENT_NOT_ELIGIBLE', 'The document must be an approved expense document with a date and total');
      }
      if (toHalalas(doc.total_amount) !== toHalalas(input.amount)) throw conflict('PERSONAL_PAYMENT_DOCUMENT_AMOUNT_MISMATCH', 'The amount must equal the document total');
      const vat = (await c.query<{ review_status: string; vat_amount: string | null }>('SELECT review_status, vat_amount::text FROM document_vat_reviews WHERE document_id=$1 AND company_id=$2', [input.documentId, companyId])).rows[0];
      if (vat && (vat.review_status !== 'reviewed' || (vat.vat_amount !== null && toHalalas(vat.vat_amount) > 0n))) {
        throw conflict('PERSONAL_PAYMENT_VAT_UNSUPPORTED', 'A document carrying VAT must be recognized through the invoice or obligation path, then reclassified as an existing obligation');
      }
      const claimed = await c.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM obligations o WHERE o.document_id=$1 AND o.company_id=$2 AND NOT o.is_cancelled)
                     OR EXISTS (SELECT 1 FROM custody_document_allocations a WHERE a.document_id=$1 AND a.company_id=$2)
                     OR EXISTS (SELECT 1 FROM document_settlements s WHERE s.document_id=$1 AND s.company_id=$2)
                     OR EXISTS (SELECT 1 FROM invoice_source_links l WHERE l.document_id=$1 AND l.company_id=$2)
                     OR EXISTS (SELECT 1 FROM personal_payments p WHERE p.document_id=$1 AND p.company_id=$2 AND p.status<>'rejected' AND ($3::uuid IS NULL OR p.id<>$3))`,
        [input.documentId, companyId, selfId]);
      if (claimed.rowCount) throw conflict('PERSONAL_PAYMENT_DOCUMENT_ALREADY_RECOGNIZED', 'The document is already recognized by another workflow');
      const account = (await c.query<{ is_active: boolean; account_type: string }>('SELECT is_active, account_type FROM accounts WHERE id=$1 AND company_id=$2 FOR SHARE', [input.expenseAccountId, companyId])).rows[0];
      if (!account || !account.is_active) throw invalid('Expense account not found or inactive for this company', 'PERSONAL_PAYMENT_ACCOUNT_INVALID');
      if (account.account_type !== 'expense') throw invalid('The recognition account must be an expense account', 'PERSONAL_PAYMENT_ACCOUNT_TYPE');
      accountingDate = doc.document_date;
      counterpartyId = counterpartyId ?? doc.counterparty_id;
    } else {
      if (!input.obligationId || input.documentId || input.expenseAccountId) throw invalid('A reclassification needs its obligation only');
      const o = await this.lockedObligation(c, companyId, input.obligationId, lock);
      if (toHalalas(input.amount) > toHalalas(o.outstanding)) throw conflict('PERSONAL_PAYMENT_EXCEEDS_OUTSTANDING', 'The amount exceeds the outstanding obligation amount');
      if (input.paymentDate < o.recognized_on) throw conflict('PERSONAL_PAYMENT_DATE_INVALID', 'The payment cannot precede the obligation');
      accountingDate = input.paymentDate;
      counterpartyId = o.counterparty_id;
    }
    if (counterpartyId && !(await c.query('SELECT 1 FROM counterparties WHERE id=$1 AND company_id=$2', [counterpartyId, companyId])).rowCount) throw notFound('Counterparty not found');

    await this.fiscalYear(c, companyId, accountingDate, true);
    await assertAccountingDateWritable(companyId, accountingDate, c);
    return { accountingDate, counterpartyId, currency: await this.functionalCurrency(c, companyId, accountingDate) };
  }

  async create(companyId: string, actor: string, input: PaymentInput) {
    return this.tx(async (c) => {
      const v = await this.validate(c, companyId, input, null, 'SHARE');
      const id = (await c.query<{ id: string }>(
        `INSERT INTO personal_payments(company_id,payer_id,treatment,payment_date,accounting_date,amount,currency_code,purpose,counterparty_id,document_id,obligation_id,expense_account_id,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [companyId, input.payerId, input.treatment, input.paymentDate, v.accountingDate, input.amount, v.currency, input.purpose, v.counterpartyId, input.documentId, input.obligationId, input.expenseAccountId, actor])).rows[0]!.id;
      const row = (await this.get(companyId, id, true, c)).payment as PaymentRow;
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'personal_payment.create', entity_type: 'personal_payment', entity_id: id, before_data: null as never, after_data: this.snapshot(row) as never }, c);
      return (await this.get(companyId, id, false, c)).payment;
    });
  }

  private async lockRow(c: PoolClient, companyId: string, id: string): Promise<PaymentRow> {
    const row = (await c.query<PaymentRow>(`SELECT ${COLUMNS} FROM personal_payments p WHERE p.id=$1 AND p.company_id=$2 FOR UPDATE`, [id, companyId])).rows[0];
    if (!row) throw notFound();
    return row;
  }
  private inputOf(r: PaymentRow): PaymentInput {
    return { payerId: r.payer_id, treatment: r.treatment, paymentDate: r.payment_date, amount: r.amount, purpose: r.purpose, counterpartyId: r.counterparty_id,
      documentId: r.document_id, obligationId: r.obligation_id, expenseAccountId: r.expense_account_id };
  }

  async update(companyId: string, actor: string, id: string, input: PaymentInput, version: number) {
    return this.tx(async (c) => {
      const before = await this.lockRow(c, companyId, id);
      if (before.status !== 'draft') throw conflict('PERSONAL_PAYMENT_NOT_DRAFT', 'Only a draft personal payment can be edited');
      if (before.version !== version) throw conflict('PERSONAL_PAYMENT_VERSION_CONFLICT', 'The payment was changed by someone else; reload and retry');
      const v = await this.validate(c, companyId, input, id, 'SHARE');
      await c.query(
        `UPDATE personal_payments SET payer_id=$3,treatment=$4,payment_date=$5,accounting_date=$6,amount=$7,currency_code=$8,purpose=$9,counterparty_id=$10,document_id=$11,obligation_id=$12,
                expense_account_id=$13,version=version+1,updated_at=NOW() WHERE id=$1 AND company_id=$2 AND status='draft'`,
        [id, companyId, input.payerId, input.treatment, input.paymentDate, v.accountingDate, input.amount, v.currency, input.purpose, v.counterpartyId, input.documentId, input.obligationId, input.expenseAccountId]);
      const after = (await this.get(companyId, id, true, c)).payment as PaymentRow;
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'personal_payment.update', entity_type: 'personal_payment', entity_id: id, before_data: this.snapshot(before) as never, after_data: this.snapshot(after) as never }, c);
      return (await this.get(companyId, id, false, c)).payment;
    });
  }

  async remove(companyId: string, actor: string, id: string, version: number) {
    return this.tx(async (c) => {
      const before = await this.lockRow(c, companyId, id);
      if (before.status !== 'draft') throw conflict('PERSONAL_PAYMENT_NOT_DRAFT', 'Only a draft personal payment can be deleted');
      if (before.version !== version) throw conflict('PERSONAL_PAYMENT_VERSION_CONFLICT', 'The payment was changed by someone else; reload and retry');
      try {
        await c.query("DELETE FROM personal_payments WHERE id=$1 AND company_id=$2 AND status='draft'", [id, companyId]);
      } catch (e) {
        // A reopened draft keeps its workflow history (events are RESTRICT-linked): it can no longer be deleted.
        if ((e as { code?: string }).code === '23503') throw conflict('PERSONAL_PAYMENT_HAS_HISTORY', 'A payment with review history cannot be deleted');
        throw e;
      }
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'personal_payment.delete', entity_type: 'personal_payment', entity_id: id, before_data: this.snapshot(before) as never, after_data: null as never }, c);
    });
  }

  async submit(companyId: string, actor: string, id: string) {
    return this.tx(async (c) => {
      const row = await this.lockRow(c, companyId, id);
      if (row.status === 'submitted') return { payment: (await this.get(companyId, id, false, c)).payment, replayed: true };
      if (row.status !== 'draft') throw conflict('PERSONAL_PAYMENT_NOT_DRAFT', 'Only a draft personal payment can be submitted');
      await this.validate(c, companyId, this.inputOf(row), id, 'SHARE');
      const account = await resolvePayerAccount(c, companyId, row.payer_id, false);
      if (!account?.accountId) throw conflict('PERSONAL_PAYMENT_MAPPING_MISSING', account?.kind === 'partner' ? 'The partner has no valid current-account mapping' : 'The payer has no valid payable account');
      await c.query("UPDATE personal_payments SET status='submitted',submitted_by=$3,submitted_at=NOW(),version=version+1,updated_at=NOW() WHERE id=$1 AND company_id=$2 AND status='draft'", [id, companyId, actor]);
      await this.event(c, companyId, id, actor, { type: 'submitted', from: 'draft', to: 'submitted' });
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'personal_payment.submit', entity_type: 'personal_payment', entity_id: id,
        before_data: { status: 'draft', version: row.version }, after_data: { status: 'submitted', version: row.version + 1 } }, c);
      return { payment: (await this.get(companyId, id, false, c)).payment, replayed: false };
    });
  }

  /** The debit side of a reclassification is the account the obligation was originally credited (read from its posted journal; never guessed). */
  private async obligationPayableAccount(c: PoolClient, companyId: string, obligationJournalId: string): Promise<string> {
    const lines = (await c.query<{ account_id: string; account_type: string; is_active: boolean }>(
      `SELECT l.account_id, a.account_type, a.is_active FROM journal_lines l JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id
        WHERE l.journal_entry_id=$1 AND l.company_id=$2 AND l.credit>0 FOR SHARE OF a`, [obligationJournalId, companyId])).rows;
    if (lines.length !== 1 || lines[0]!.account_type !== 'liability' || !lines[0]!.is_active) {
      throw conflict('PERSONAL_PAYMENT_PAYABLE_ACCOUNT_UNRESOLVED', 'The payable account of the obligation cannot be determined unambiguously');
    }
    return lines[0]!.account_id;
  }

  /** Approval creates the liability and posts atomically; replaying an approved payment returns it unchanged (the unique journal source index is the backstop). */
  async approve(companyId: string, actor: string, id: string, includeAudit = false) {
    return this.tx(async (c) => {
      const row = await this.lockRow(c, companyId, id);
      if (row.status === 'approved') return { payment: (await this.get(companyId, id, includeAudit, c)).payment, replayed: true };
      if (row.status !== 'submitted') throw conflict('PERSONAL_PAYMENT_NOT_SUBMITTED', 'Only a submitted personal payment can be approved');
      const input = this.inputOf(row);
      await this.validate(c, companyId, input, id, 'UPDATE');
      const payer = await resolvePayerAccount(c, companyId, row.payer_id, true);
      if (!payer?.accountId) throw conflict('PERSONAL_PAYMENT_MAPPING_MISSING', payer?.kind === 'partner' ? 'The partner has no valid current-account mapping' : 'The payer has no valid payable account');
      const creditAccount = payer.accountId;
      let debitAccount: string;
      if (row.treatment === 'new_expense') {
        debitAccount = row.expense_account_id!;
      } else {
        const o = await this.lockedObligation(c, companyId, row.obligation_id!, 'UPDATE');
        debitAccount = await this.obligationPayableAccount(c, companyId, o.journalId);
      }
      if (debitAccount === creditAccount) throw conflict('PERSONAL_PAYMENT_MAPPING_CONFLICT', 'The debit and credit accounts must differ');
      const fiscalYearId = await this.fiscalYear(c, companyId, row.accounting_date, true);

      // Snapshot the accounts while still submitted (the guard allows only this change), then journal and post through the canonical contract.
      await c.query('UPDATE personal_payments SET debit_account_id=$3, credit_account_id=$4 WHERE id=$1 AND company_id=$2 AND status=\'submitted\'', [id, companyId, debitAccount, creditAccount]);
      const label = `Personal payment: ${row.purpose}`.slice(0, 500);
      const journal = (await c.query<{ id: string }>(
        `INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,reference,source_type,source_id,entry_type,status,created_by)
         VALUES($1,$2,$3,$4,$5,'personal_payment',$6,'standard','draft',$7) RETURNING id`,
        [companyId, fiscalYearId, row.accounting_date, label, `PP ${id.slice(0, 8)}`, id, actor])).rows[0]!;
      await c.query('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence) VALUES($1,$2,$3,$4,0,$5,1),($1,$2,$6,0,$4,$5,2)',
        [companyId, journal.id, debitAccount, row.amount, 'personal_payment', creditAccount]);
      await postJournalInTransaction(c, companyId, actor, journal.id);

      const updated = await c.query(
        `UPDATE personal_payments SET status='approved', journal_entry_id=$3, reviewed_by=$4, reviewed_at=NOW(), version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2 AND status='submitted'`,
        [id, companyId, journal.id, actor]);
      if (!updated.rowCount) throw conflict('PERSONAL_PAYMENT_NOT_SUBMITTED', 'The payment is no longer submitted');
      await this.event(c, companyId, id, actor, { type: 'approved', from: 'submitted', to: 'approved', journalId: journal.id });
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'personal_payment.approve', entity_type: 'personal_payment', entity_id: id,
        before_data: { status: 'submitted', version: row.version }, after_data: { status: 'approved', journal_entry_id: journal.id, debit_account_id: debitAccount, credit_account_id: creditAccount, version: row.version + 1 } }, c);
      return { payment: (await this.get(companyId, id, includeAudit, c)).payment, replayed: false };
    });
  }

  async reject(companyId: string, actor: string, id: string, reason: string) {
    return this.tx(async (c) => {
      const row = await this.lockRow(c, companyId, id);
      if (row.status !== 'submitted') throw conflict('PERSONAL_PAYMENT_NOT_SUBMITTED', 'Only a submitted personal payment can be rejected');
      await c.query("UPDATE personal_payments SET status='rejected', reviewed_by=$3, reviewed_at=NOW(), rejection_reason=$4, version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2 AND status='submitted'", [id, companyId, actor, reason]);
      await this.event(c, companyId, id, actor, { type: 'rejected', from: 'submitted', to: 'rejected', reason });
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'personal_payment.reject', entity_type: 'personal_payment', entity_id: id,
        before_data: { status: 'submitted', version: row.version }, after_data: { status: 'rejected', version: row.version + 1 }, reason }, c);
      return (await this.get(companyId, id, false, c)).payment;
    });
  }

  /** Correction path of a rejected payment: back to an editable draft. The rejection stays in the events and the audit log. */
  async reopen(companyId: string, actor: string, id: string) {
    return this.tx(async (c) => {
      const row = await this.lockRow(c, companyId, id);
      if (row.status !== 'rejected') throw conflict('PERSONAL_PAYMENT_NOT_REJECTED', 'Only a rejected personal payment can be reopened');
      await c.query(
        `UPDATE personal_payments SET status='draft', submitted_by=NULL, submitted_at=NULL, reviewed_by=NULL, reviewed_at=NULL, rejection_reason=NULL, version=version+1, updated_at=NOW()
          WHERE id=$1 AND company_id=$2 AND status='rejected'`, [id, companyId]);
      await this.event(c, companyId, id, actor, { type: 'reopened', from: 'rejected', to: 'draft', reason: row.rejection_reason });
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'personal_payment.reopen', entity_type: 'personal_payment', entity_id: id,
        before_data: { status: 'rejected', version: row.version }, after_data: { status: 'draft', version: row.version + 1 } }, c);
      return (await this.get(companyId, id, false, c)).payment;
    });
  }

  // ---------------------------------------------------------------- reimbursement

  /** Company outflows not yet explained by any workflow that could reimburse this payment (amount at most the outstanding amount). */
  async reimbursableBankTransactions(companyId: string, paymentId: string) {
    const p = (await this.db.query<{ status: string; outstanding: string; accounting_date: string }>(
      `SELECT p.status, (p.amount-COALESCE((SELECT SUM(r.amount) FROM personal_payment_reimbursements r WHERE r.payment_id=p.id AND r.company_id=p.company_id),0))::text outstanding, GREATEST(p.accounting_date,p.payment_date)::text accounting_date
         FROM personal_payments p WHERE p.id=$1 AND p.company_id=$2`, [paymentId, companyId])).rows[0];
    if (!p) throw notFound();
    if (p.status !== 'approved') return { transactions: [] };
    const rows = (await this.db.query(
      `SELECT t.id, t.bank_account_id, b.display_name bank_account_name, t.transaction_date::text, (-t.amount)::text amount, t.description, t.bank_reference
         FROM bank_transactions t JOIN bank_accounts b ON b.id=t.bank_account_id AND b.company_id=t.company_id
        WHERE t.company_id=$1 AND t.amount<0 AND (-t.amount)<=$2::numeric AND t.transaction_date>=$3::date AND b.is_active
          AND NOT EXISTS (SELECT 1 FROM bank_transaction_matches m WHERE m.bank_transaction_id=t.id)
          AND NOT EXISTS (SELECT 1 FROM document_settlements s WHERE s.bank_transaction_id=t.id)
          AND NOT EXISTS (SELECT 1 FROM obligation_settlements s WHERE s.bank_transaction_id=t.id)
          AND NOT EXISTS (SELECT 1 FROM partner_transactions x WHERE x.bank_transaction_id=t.id AND x.status IN ('draft','posted'))
          AND NOT EXISTS (SELECT 1 FROM personal_payment_reimbursements r WHERE r.bank_transaction_id=t.id)
        ORDER BY t.transaction_date DESC, t.id LIMIT 200`, [companyId, p.outstanding, p.accounting_date])).rows;
    return { transactions: rows };
  }

  async reimburse(companyId: string, actor: string, paymentId: string, input: { bankTransactionId: string; note: string | null }, includeAudit = false) {
    return this.tx(async (c) => {
      const payment = await this.lockRow(c, companyId, paymentId);
      if (payment.status !== 'approved') throw conflict('PERSONAL_PAYMENT_NOT_APPROVED', 'Only an approved personal payment can be reimbursed');

      // Idempotent replay: the same bank row already reimbursed this payment.
      const existing = (await c.query<{ payment_id: string }>('SELECT payment_id FROM personal_payment_reimbursements WHERE bank_transaction_id=$1 AND company_id=$2', [input.bankTransactionId, companyId])).rows[0];
      if (existing) {
        if (existing.payment_id === paymentId) return { ...(await this.get(companyId, paymentId, includeAudit, c)), replayed: true };
        throw conflict('PERSONAL_BANK_TRANSACTION_ALREADY_EXPLAINED', 'The bank transaction is already linked or explained');
      }

      const bt = (await c.query<{ bank_account_id: string; amount: string; transaction_date: string; currency_code: string }>(
        'SELECT bank_account_id, amount::text, transaction_date::text, currency_code FROM bank_transactions WHERE id=$1 AND company_id=$2 FOR UPDATE', [input.bankTransactionId, companyId])).rows[0];
      if (!bt) throw notFound('Bank transaction not found');
      if (!bt.amount.startsWith('-')) throw conflict('PERSONAL_REIMBURSEMENT_BANK_MISMATCH', 'A reimbursement must be backed by a company outflow');
      const amount = fromHalalas(toHalalas(bt.amount.slice(1)));
      const reimbursed = toHalalas((await c.query<{ s: string }>('SELECT COALESCE(SUM(amount),0)::text s FROM personal_payment_reimbursements WHERE payment_id=$1 AND company_id=$2', [paymentId, companyId])).rows[0]!.s);
      if (toHalalas(amount) > toHalalas(payment.amount) - reimbursed) throw conflict('PERSONAL_PAYMENT_OVER_REIMBURSEMENT', 'The bank transaction exceeds the outstanding amount');
      if (bt.transaction_date < payment.accounting_date || bt.transaction_date < payment.payment_date) throw conflict('PERSONAL_REIMBURSEMENT_DATE_INVALID', 'The reimbursement cannot precede the payer\'s payment or its accounting date');

      const bank = (await c.query<{ is_active: boolean; currency_code: string }>('SELECT is_active, currency_code FROM bank_accounts WHERE id=$1 AND company_id=$2 FOR SHARE', [bt.bank_account_id, companyId])).rows[0];
      if (!bank || !bank.is_active) throw conflict('PERSONAL_REIMBURSEMENT_BANK_INACTIVE', 'The bank account is inactive');
      if ((await this.functionalCurrency(c, companyId, bt.transaction_date)) !== bank.currency_code.trim() || bt.currency_code.trim() !== bank.currency_code.trim()) {
        throw conflict('PERSONAL_PAYMENT_CURRENCY_MISMATCH', 'Foreign-currency reimbursements are not supported');
      }
      if ((await c.query(
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM bank_transaction_matches WHERE bank_transaction_id=$1) OR EXISTS (SELECT 1 FROM document_settlements WHERE bank_transaction_id=$1)
                     OR EXISTS (SELECT 1 FROM obligation_settlements WHERE bank_transaction_id=$1) OR EXISTS (SELECT 1 FROM partner_transactions WHERE bank_transaction_id=$1 AND status IN ('draft','posted'))`,
        [input.bankTransactionId])).rowCount) throw conflict('PERSONAL_BANK_TRANSACTION_ALREADY_EXPLAINED', 'The bank transaction is already explained by another record');

      const fiscalYearId = await this.fiscalYear(c, companyId, bt.transaction_date, true);
      await assertAccountingDateWritable(companyId, bt.transaction_date, c);
      const bankLedger = await resolveBankLedgerAccount(c, companyId, bt.bank_account_id, bt.transaction_date, true);
      if (!bankLedger) throw conflict('PERSONAL_PAYMENT_BANK_LEDGER_UNMAPPED', 'The bank account has no active ledger link on the reimbursement date');
      const payerAccount = (await c.query<{ is_active: boolean }>('SELECT is_active FROM accounts WHERE id=$1 AND company_id=$2 FOR SHARE', [payment.credit_account_id, companyId])).rows[0];
      if (!payerAccount?.is_active) throw conflict('PERSONAL_PAYMENT_MAPPING_MISSING', 'The payer account of the payment is inactive');

      const reimbursementId = (await c.query<{ id: string }>(
        `INSERT INTO personal_payment_reimbursements(company_id,payment_id,bank_transaction_id,amount,reimbursement_date,debit_account_id,credit_account_id,note,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [companyId, paymentId, input.bankTransactionId, amount, bt.transaction_date, payment.credit_account_id, bankLedger, input.note, actor])).rows[0]!.id;
      const journal = (await c.query<{ id: string }>(
        `INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,reference,source_type,source_id,entry_type,status,created_by)
         VALUES($1,$2,$3,$4,$5,'personal_payment_reimbursement',$6,'standard','draft',$7) RETURNING id`,
        [companyId, fiscalYearId, bt.transaction_date, `Personal payment reimbursement: ${payment.purpose}`.slice(0, 500), `PPR ${reimbursementId.slice(0, 8)}`, reimbursementId, actor])).rows[0]!;
      await c.query('INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,memo,sequence) VALUES($1,$2,$3,$4,0,$5,1),($1,$2,$6,0,$4,$5,2)',
        [companyId, journal.id, payment.credit_account_id, amount, 'personal_payment_reimbursement', bankLedger]);
      await postJournalInTransaction(c, companyId, actor, journal.id);
      await c.query('UPDATE personal_payment_reimbursements SET journal_entry_id=$3 WHERE id=$1 AND company_id=$2 AND journal_entry_id IS NULL', [reimbursementId, companyId, journal.id]);
      await this.event(c, companyId, paymentId, actor, { type: 'reimbursed', reimbursementId, journalId: journal.id, amount });
      await this.audit.logEvent({ company_id: companyId, actor_user_id: actor, action: 'personal_payment.reimburse', entity_type: 'personal_payment', entity_id: paymentId,
        before_data: { reimbursed: fromHalalas(reimbursed) }, after_data: { reimbursement_id: reimbursementId, amount, bank_transaction_id: input.bankTransactionId, journal_entry_id: journal.id, reimbursed: fromHalalas(reimbursed + toHalalas(amount)) } }, c);
      return { ...(await this.get(companyId, paymentId, includeAudit, c)), replayed: false };
    });
  }

  // ---------------------------------------------------------------- reporting

  /**
   * Outstanding balance per payer as of a date: approved personal payments dated up to it, minus reimbursements dated up to it. Non-partner payers are the
   * employee/manager payables; a partner payer's balance is part of that partner's individual current account (shown for reconciliation, not an extra liability).
   */
  async payables(companyId: string, asOf: string) {
    const { rows } = await this.db.query<{ payer_id: string; payer_name: string; payer_kind: 'partner' | 'employee'; partner_id: string | null; approved: string; reimbursed: string; open_count: string }>(
      `SELECT py.id payer_id, py.display_name payer_name, (CASE WHEN py.partner_id IS NULL THEN 'employee' ELSE 'partner' END) payer_kind, py.partner_id,
              COALESCE(SUM(p.amount),0)::text approved,
              COALESCE(SUM((SELECT COALESCE(SUM(r.amount),0) FROM personal_payment_reimbursements r WHERE r.payment_id=p.id AND r.company_id=p.company_id AND r.reimbursement_date<=$2::date)),0)::text reimbursed,
              COUNT(p.id) FILTER (WHERE p.amount > (SELECT COALESCE(SUM(r.amount),0) FROM personal_payment_reimbursements r WHERE r.payment_id=p.id AND r.company_id=p.company_id AND r.reimbursement_date<=$2::date))::text open_count
         FROM personal_payers py LEFT JOIN personal_payments p ON p.payer_id=py.id AND p.company_id=py.company_id AND p.status='approved' AND p.accounting_date<=$2::date
        WHERE py.company_id=$1 GROUP BY py.id, py.display_name, py.partner_id ORDER BY py.display_name`, [companyId, asOf]);
    const payers = rows.filter((r) => toHalalas(r.approved) > 0n).map((r) => ({
      payer_id: r.payer_id, payer_name: r.payer_name, payer_kind: r.payer_kind, partner_id: r.partner_id, approved_amount: fromHalalas(toHalalas(r.approved)), reimbursed_amount: fromHalalas(toHalalas(r.reimbursed)),
      outstanding_amount: fromHalalas(toHalalas(r.approved) - toHalalas(r.reimbursed)), open_payments: Number(r.open_count),
    }));
    return { as_of: asOf, payers };
  }
}
