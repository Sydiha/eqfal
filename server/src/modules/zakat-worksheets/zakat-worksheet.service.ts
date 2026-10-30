import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { FinancialStatementNotFoundError, FinancialStatementsService, FinancialStatementUnmappedError } from '../accounting/financial-statements';
import {
  BalanceAccount, BalancesSnapshot, CLASSIFIABLE_CATEGORIES, ENTITY_CLASSES, GateRow, OWNERSHIP_CLASSES, OwnershipVerification, ZAKAT_TYPES,
  evaluateReadiness, fingerprintOf, toCents, unsupportedPeriodReason, verifyOwnership,
} from './zakat-worksheet.rules';

export class ZakatNotFoundError extends Error {}
export class ZakatValidationError extends Error { constructor(message: string, readonly code = 'ZAKAT_VALIDATION') { super(message); } }
export class ZakatConflictError extends Error { constructor(message: string, readonly code = 'ZAKAT_CONFLICT') { super(message); } }

type Runner = Pick<Pool | PoolClient, 'query'>;
const OPEN = ['draft', 'in_review', 'reviewed'];
const WS = `w.*, w.prepared_at::text, w.reviewed_at::text, w.approved_at::text, w.snapshot_captured_at::text, w.created_at::text, w.updated_at::text`;

type Worksheet = {
  id: string; company_id: string; fiscal_year_id: string; revision_no: number; status: string; revision_reason: string | null; supersedes_id: string | null;
  non_financing_confirmed: boolean; accounting_records_confirmed: boolean;
  ownership_snapshot: OwnershipVerification | null; ownership_fingerprint: string | null;
  balances_snapshot: BalancesSnapshot | null; balances_fingerprint: string | null;
  approved_snapshot: Record<string, unknown> | null; approved_snapshot_fingerprint: string | null; version: number;
  [key: string]: unknown;
};

export class ZakatWorksheetService {
  private audit = new AuditLogRepository();
  constructor(private db: Pool) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>) {
    const c = await this.db.connect();
    try { await c.query('BEGIN'); const result = await fn(c); await c.query('COMMIT'); return result; }
    catch (e) { await c.query('ROLLBACK'); throw this.mapDb(e); }
    finally { c.release(); }
  }
  private mapDb(e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === '23505') return new ZakatConflictError('A conflicting record already exists', 'ZAKAT_DUPLICATE');
    if (code === '23503') return new ZakatValidationError('A referenced record (document, partner or account) was not found in this company', 'ZAKAT_REFERENCE_NOT_FOUND');
    if (code === '23514') return new ZakatConflictError((e as Error).message, 'ZAKAT_LOCKED');
    return e;
  }

  // ---------- live sources ----------
  private async fiscalYear(company: string, year: string, r: Runner) {
    const fy = (await r.query<{ start_date: string; end_date: string; status: string }>('SELECT start_date::text, end_date::text, status FROM fiscal_years WHERE id=$1 AND company_id=$2', [year, company])).rows[0];
    if (!fy) throw new ZakatNotFoundError();
    return fy;
  }
  private async liveOwnership(company: string, year: string, r: Runner) {
    const fy = await this.fiscalYear(company, year, r);
    const profile = (await r.query<{ id: string; ownership_context: string; tax_treatment: string }>(
      `SELECT id, ownership_context, tax_treatment FROM company_accounting_profiles WHERE company_id=$1 AND workflow_status='approved' AND effective_from<=$2 AND (effective_to IS NULL OR effective_to>=$3) AND (tax_effective_from IS NULL OR tax_effective_from<=$2) ORDER BY effective_from DESC, version_no DESC LIMIT 1`,
      [company, fy.start_date, fy.end_date])).rows[0] ?? null;
    const partners = (await r.query<{ id: string; name: string; is_active: boolean }>('SELECT id, name, is_active FROM partners WHERE company_id=$1', [company])).rows;
    const periods = (await r.query(`SELECT partner_id, ownership_percentage::text pct, effective_from::text, effective_to::text, verification_status FROM partner_ownership_periods WHERE company_id=$1`, [company])).rows;
    const eligibility = (await r.query(`SELECT id, partner_id, ownership_class, effective_from::text, effective_to::text, evidence_document_id, verification_status, confirmed_by_user_id, confirmed_at::text FROM zakat_ownership_eligibility WHERE company_id=$1`, [company])).rows;
    const verification = verifyOwnership({ asOf: fy.end_date, profile, partners, periods, eligibility });
    return { fy, verification, fingerprint: fingerprintOf(verification) };
  }
  private async captureBalances(company: string, year: string) {
    let report;
    try { report = await new FinancialStatementsService(this.db).financialPosition(company, year); }
    catch (e) {
      if (e instanceof FinancialStatementNotFoundError) throw new ZakatNotFoundError();
      if (e instanceof FinancialStatementUnmappedError) throw new ZakatValidationError('Posted activity exists on unmapped accounts', 'ZAKAT_UNMAPPED_ACCOUNTS');
      throw e;
    }
    const accounts: BalanceAccount[] = [];
    for (const section of report.sections as unknown as { accounts: Record<string, unknown>[] }[]) {
      for (const a of section.accounts) {
        const cents = toCents(String(a['amount']));
        accounts.push({
          account_id: String(a['account_id']), code: String(a['code']), name: String(a['name']), name_ar: (a['name_ar'] as string | null) ?? null,
          statement_category: String(a['statement_category']), account_type: String(a['account_type']), is_contra: Boolean(a['is_contra']), amount_cents: cents.toString(),
        });
      }
    }
    accounts.sort((x, y) => x.code.localeCompare(y.code) || x.account_id.localeCompare(y.account_id));
    const snapshot: BalancesSnapshot = {
      as_of_date: String(report.as_of_date), accounts,
      current_period_earnings_cents: toCents(String(report.current_period_earnings)).toString(),
      totals_cents: {
        assets: toCents(String(report.total_assets)).toString(),
        liabilities: toCents(String(report.total_liabilities)).toString(),
        equity: toCents(String(report.total_equity)).toString(),
      },
    };
    return { snapshot, fingerprint: fingerprintOf(snapshot) };
  }
  private async gates(r: Runner) {
    return (await r.query<GateRow>('SELECT code, title, article_ref, blocks_approval, status, verified_by_name, verified_on::text, verification_reference FROM zakat_regulatory_gates ORDER BY code')).rows;
  }
  private async packageFinalized(company: string, year: string, r: Runner) {
    return Boolean((await r.query(`SELECT 1 FROM annual_closing_packages WHERE company_id=$1 AND fiscal_year_id=$2 AND status IN ('finalized','handed_off')`, [company, year])).rowCount);
  }

  // ---------- read ----------
  private async children(company: string, worksheetId: string, r: Runner) {
    const classifications = (await r.query(`SELECT *, confirmed_at::text FROM zakat_account_classifications WHERE company_id=$1 AND worksheet_id=$2 ORDER BY account_id`, [company, worksheetId])).rows;
    const adjustments = (await r.query(`SELECT *, amount::text, created_at::text, updated_at::text FROM zakat_worksheet_adjustments WHERE company_id=$1 AND worksheet_id=$2 ORDER BY zakat_worksheet_adjustments.created_at, id`, [company, worksheetId])).rows;
    return { classifications, adjustments };
  }
  private readiness(ws: Worksheet | null, own: { verification: OwnershipVerification; fingerprint: string; fy: { start_date: string; end_date: string } }, liveBalancesFp: string | null, classifiedIds: Set<string>, gates: GateRow[], investmentClassifications = 0) {
    return evaluateReadiness({
      ownership: own.verification,
      periodReason: unsupportedPeriodReason(own.fy.start_date, own.fy.end_date),
      declarationsOk: Boolean(ws?.non_financing_confirmed && ws?.accounting_records_confirmed),
      balances: ws?.balances_snapshot ?? null, classifiedAccountIds: classifiedIds,
      balancesDrift: Boolean(ws && liveBalancesFp !== null && ws.balances_fingerprint !== liveBalancesFp),
      ownershipDrift: Boolean(ws && ws.ownership_fingerprint !== own.fingerprint), gates, investmentClassifications,
    });
  }

  async get(company: string, year: string) {
    const own = await this.liveOwnership(company, year, this.db);
    const revisions = (await this.db.query<Worksheet>(`SELECT ${WS} FROM zakat_worksheets w WHERE w.company_id=$1 AND w.fiscal_year_id=$2 ORDER BY w.revision_no DESC`, [company, year])).rows;
    const gates = await this.gates(this.db);
    const eligibility = (await this.db.query(`SELECT e.*, e.effective_from::text, e.effective_to::text, e.confirmed_at::text, e.created_at::text, p.name partner_name FROM zakat_ownership_eligibility e JOIN partners p ON p.id=e.partner_id AND p.company_id=e.company_id WHERE e.company_id=$1 ORDER BY p.name, e.effective_from`, [company])).rows;
    const ws = revisions[0] ?? null;
    let liveFp: string | null = null; let children: { classifications: { account_id: string }[]; adjustments: unknown[] } = { classifications: [], adjustments: [] };
    if (ws) {
      if (OPEN.includes(ws.status) || ws.status === 'approved') liveFp = (await this.captureBalances(company, year).catch(() => null))?.fingerprint ?? null;
      children = (await this.children(company, ws.id, this.db)) as typeof children;
    }
    const readiness = this.readiness(ws, own, liveFp, new Set(children.classifications.map((c) => c.account_id)), gates, (children.classifications as unknown as { zakat_type: string }[]).filter((c) => c.zakat_type === 'deductible_investment').length);
    return {
      scope: { fiscal_year: own.fy, unsupported_reason: unsupportedPeriodReason(own.fy.start_date, own.fy.end_date) },
      worksheet: ws, revisions: revisions.map((r) => ({ id: r.id, revision_no: r.revision_no, status: r.status, revision_reason: r.revision_reason, approved_at: r.approved_at })),
      classifications: children.classifications, adjustments: children.adjustments, eligibility,
      ownership_live: own.verification, gates, readiness,
    };
  }

  // ---------- worksheet lifecycle ----------
  private async lockOpen(company: string, year: string, c: PoolClient) {
    const ws = (await c.query<Worksheet>(`SELECT ${WS} FROM zakat_worksheets w WHERE w.company_id=$1 AND w.fiscal_year_id=$2 AND w.status = ANY($3) FOR UPDATE`, [company, year, OPEN])).rows[0];
    if (!ws) throw new ZakatNotFoundError();
    return ws;
  }
  private checkVersion(ws: Worksheet, version: number) {
    if (ws.version !== version) throw new ZakatConflictError('Worksheet was modified', 'ZAKAT_VERSION_CONFLICT');
  }
  private requireDraft(ws: Worksheet, version: number) {
    if (ws.status !== 'draft') throw new ZakatConflictError('Only a draft worksheet may be edited', 'ZAKAT_WORKSHEET_NOT_DRAFT');
    this.checkVersion(ws, version);
  }
  private async bump(c: PoolClient, company: string, id: string) {
    await c.query('UPDATE zakat_worksheets SET version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2', [id, company]);
  }
  private log(c: PoolClient, company: string, actor: string, action: string, entityType: string, entityId: string, before: unknown, after: unknown, reason: string | null = null) {
    return this.audit.logEvent({ company_id: company, actor_user_id: actor, action, entity_type: entityType, entity_id: entityId, before_data: before as Record<string, unknown> | null, after_data: after as Record<string, unknown> | null, reason }, c);
  }
  private brief(ws: Worksheet) {
    return { id: ws.id, revision_no: ws.revision_no, status: ws.status, version: ws.version, balances_fingerprint: ws.balances_fingerprint, ownership_fingerprint: ws.ownership_fingerprint };
  }

  async create(company: string, year: string, actor: string) {
    const fy = await this.fiscalYear(company, year, this.db);
    const reason = unsupportedPeriodReason(fy.start_date, fy.end_date);
    if (reason) throw new ZakatValidationError(`Unsupported fiscal year for the Zakat worksheet (${reason})`, 'ZAKAT_UNSUPPORTED_SCOPE');
    const balances = await this.captureBalances(company, year);
    return this.tx(async (c) => {
      if (await this.packageFinalized(company, year, c)) throw new ZakatConflictError('The annual package is finalized', 'ZAKAT_PACKAGE_FINALIZED');
      const own = await this.liveOwnership(company, year, c);
      const prior = (await c.query('SELECT 1 FROM zakat_worksheets WHERE company_id=$1 AND fiscal_year_id=$2', [company, year])).rowCount;
      if (prior) throw new ZakatConflictError('A Zakat worksheet already exists for this fiscal year', 'ZAKAT_WORKSHEET_EXISTS');
      const row = (await c.query<Worksheet>(
        `INSERT INTO zakat_worksheets(company_id, fiscal_year_id, revision_no, prepared_by_user_id, ownership_snapshot, ownership_fingerprint, balances_snapshot, balances_fingerprint, snapshot_captured_at)
         VALUES($1,$2,1,$3,$4,$5,$6,$7,NOW()) RETURNING id`,
        [company, year, actor, JSON.stringify(own.verification), own.fingerprint, JSON.stringify(balances.snapshot), balances.fingerprint])).rows[0]!;
      await this.log(c, company, actor, 'zakat_worksheet.create', 'zakat_worksheet', row.id, null, { revision_no: 1, fiscal_year_id: year });
      return row.id;
    }).then(() => this.get(company, year));
  }

  async setDeclarations(company: string, year: string, actor: string, input: { non_financing_confirmed: boolean; accounting_records_confirmed: boolean; version: number }) {
    await this.tx(async (c) => {
      const ws = await this.lockOpen(company, year, c);
      this.requireDraft(ws, input.version);
      await c.query('UPDATE zakat_worksheets SET non_financing_confirmed=$3, accounting_records_confirmed=$4, version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2', [ws.id, company, input.non_financing_confirmed, input.accounting_records_confirmed]);
      await this.log(c, company, actor, 'zakat_worksheet.declarations', 'zakat_worksheet', ws.id,
        { non_financing_confirmed: ws.non_financing_confirmed, accounting_records_confirmed: ws.accounting_records_confirmed },
        { non_financing_confirmed: input.non_financing_confirmed, accounting_records_confirmed: input.accounting_records_confirmed });
    });
    return this.get(company, year);
  }

  /** Re-captures balances and the fiscal-year-end ownership snapshot of a draft. Classifications of accounts that left the snapshot are removed. */
  async refresh(company: string, year: string, actor: string, version: number) {
    const balances = await this.captureBalances(company, year);
    await this.tx(async (c) => {
      const ws = await this.lockOpen(company, year, c);
      this.requireDraft(ws, version);
      const own = await this.liveOwnership(company, year, c);
      const ids = balances.snapshot.accounts.filter((a) => CLASSIFIABLE_CATEGORIES.includes(a.statement_category)).map((a) => a.account_id);
      const dropped = await c.query('DELETE FROM zakat_account_classifications WHERE company_id=$1 AND worksheet_id=$2 AND NOT (account_id = ANY($3::uuid[])) RETURNING account_id', [company, ws.id, ids]);
      await c.query(
        `UPDATE zakat_worksheets SET ownership_snapshot=$3, ownership_fingerprint=$4, balances_snapshot=$5, balances_fingerprint=$6, snapshot_captured_at=NOW(), version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2`,
        [ws.id, company, JSON.stringify(own.verification), own.fingerprint, JSON.stringify(balances.snapshot), balances.fingerprint]);
      await this.log(c, company, actor, 'zakat_worksheet.refresh', 'zakat_worksheet', ws.id, this.brief(ws), { balances_fingerprint: balances.fingerprint, ownership_fingerprint: own.fingerprint, dropped_classifications: dropped.rowCount });
    });
    return this.get(company, year);
  }

  // ---------- classifications ----------
  async classify(company: string, year: string, accountId: string, actor: string, input: { zakat_type: string; reg_article: string; evidence_document_id: string | null; note: string | null; version: number }) {
    await this.tx(async (c) => {
      const ws = await this.lockOpen(company, year, c);
      this.requireDraft(ws, input.version);
      const type = ZAKAT_TYPES[input.zakat_type];
      if (!type) throw new ZakatValidationError('Unknown Zakat classification', 'ZAKAT_INVALID_TYPE');
      const account = ws.balances_snapshot?.accounts.find((a) => a.account_id === accountId);
      if (!account || !CLASSIFIABLE_CATEGORIES.includes(account.statement_category)) throw new ZakatValidationError('The account is not a classifiable balance in the captured snapshot', 'ZAKAT_ACCOUNT_NOT_IN_SNAPSHOT');
      if (!type.categories.includes(account.statement_category as never)) throw new ZakatValidationError('The classification is not consistent with the account statement category', 'ZAKAT_TYPE_CATEGORY_MISMATCH');
      if (type.evidence && !input.evidence_document_id) throw new ZakatValidationError('This classification requires a supporting evidence document', 'ZAKAT_EVIDENCE_REQUIRED');
      const before = (await c.query('SELECT * FROM zakat_account_classifications WHERE worksheet_id=$1 AND account_id=$2 AND company_id=$3', [ws.id, accountId, company])).rows[0] ?? null;
      const row = (await c.query(
        `INSERT INTO zakat_account_classifications(company_id, worksheet_id, account_id, zakat_type, reg_article, evidence_document_id, note, confirmed_by_user_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (worksheet_id, account_id) DO UPDATE SET zakat_type=EXCLUDED.zakat_type, reg_article=EXCLUDED.reg_article, evidence_document_id=EXCLUDED.evidence_document_id, note=EXCLUDED.note,
           confirmed_by_user_id=EXCLUDED.confirmed_by_user_id, confirmed_at=NOW(), version=zakat_account_classifications.version+1 RETURNING *`,
        [company, ws.id, accountId, input.zakat_type, input.reg_article.trim(), input.evidence_document_id, input.note, actor])).rows[0];
      await this.bump(c, company, ws.id);
      await this.log(c, company, actor, 'zakat_worksheet.classification.confirm', 'zakat_account_classification', row.id, before, row);
    });
    return this.get(company, year);
  }
  async unclassify(company: string, year: string, accountId: string, actor: string, version: number) {
    await this.tx(async (c) => {
      const ws = await this.lockOpen(company, year, c);
      this.requireDraft(ws, version);
      const before = (await c.query('DELETE FROM zakat_account_classifications WHERE worksheet_id=$1 AND account_id=$2 AND company_id=$3 RETURNING *', [ws.id, accountId, company])).rows[0];
      if (!before) throw new ZakatNotFoundError();
      await this.bump(c, company, ws.id);
      await this.log(c, company, actor, 'zakat_worksheet.classification.remove', 'zakat_account_classification', before.id, before, null);
    });
    return this.get(company, year);
  }

  // ---------- adjustments ----------
  private adjustmentChecks(i: { description: string; direction: string; amount: string; reg_article: string; evidence_document_id: string | null; evidence_note: string | null }) {
    if (!i.description.trim() || !['add', 'deduct'].includes(i.direction) || !/^(?:0|[1-9]\d{0,15})\.\d{2}$/.test(i.amount) || i.amount === '0.00' || !i.reg_article.trim()) throw new ZakatValidationError('Invalid adjustment', 'ZAKAT_INVALID_ADJUSTMENT');
    if (!i.evidence_document_id && !(i.evidence_note ?? '').trim()) throw new ZakatValidationError('An adjustment needs an evidence document or an evidence note', 'ZAKAT_EVIDENCE_REQUIRED');
  }
  async addAdjustment(company: string, year: string, actor: string, input: { description: string; direction: string; amount: string; reg_article: string; evidence_document_id: string | null; evidence_note: string | null; professional_review_required: boolean; version: number }) {
    this.adjustmentChecks(input);
    await this.tx(async (c) => {
      const ws = await this.lockOpen(company, year, c);
      this.requireDraft(ws, input.version);
      const row = (await c.query(
        `INSERT INTO zakat_worksheet_adjustments(company_id, worksheet_id, description, direction, amount, reg_article, evidence_document_id, evidence_note, professional_review_required, created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *, amount::text`,
        [company, ws.id, input.description.trim(), input.direction, input.amount, input.reg_article.trim(), input.evidence_document_id, input.evidence_note, input.professional_review_required, actor])).rows[0];
      await this.bump(c, company, ws.id);
      await this.log(c, company, actor, 'zakat_worksheet.adjustment.create', 'zakat_worksheet_adjustment', row.id, null, row);
    });
    return this.get(company, year);
  }
  async changeAdjustment(company: string, year: string, id: string, actor: string, input: { description: string; direction: string; amount: string; reg_article: string; evidence_document_id: string | null; evidence_note: string | null; professional_review_required: boolean; version: number; adjustment_version: number }) {
    this.adjustmentChecks(input);
    await this.tx(async (c) => {
      const ws = await this.lockOpen(company, year, c);
      this.requireDraft(ws, input.version);
      const before = (await c.query('SELECT *, amount::text FROM zakat_worksheet_adjustments WHERE id=$1 AND company_id=$2 AND worksheet_id=$3', [id, company, ws.id])).rows[0];
      if (!before) throw new ZakatNotFoundError();
      const row = (await c.query(
        `UPDATE zakat_worksheet_adjustments SET description=$4, direction=$5, amount=$6, reg_article=$7, evidence_document_id=$8, evidence_note=$9, professional_review_required=$10, version=version+1, updated_at=NOW()
         WHERE id=$1 AND company_id=$2 AND worksheet_id=$3 AND version=$11 RETURNING *, amount::text`,
        [id, company, ws.id, input.description.trim(), input.direction, input.amount, input.reg_article.trim(), input.evidence_document_id, input.evidence_note, input.professional_review_required, input.adjustment_version])).rows[0];
      if (!row) throw new ZakatConflictError('Adjustment was modified', 'ZAKAT_VERSION_CONFLICT');
      await this.bump(c, company, ws.id);
      await this.log(c, company, actor, 'zakat_worksheet.adjustment.update', 'zakat_worksheet_adjustment', id, before, row);
    });
    return this.get(company, year);
  }
  async removeAdjustment(company: string, year: string, id: string, actor: string, version: number) {
    await this.tx(async (c) => {
      const ws = await this.lockOpen(company, year, c);
      this.requireDraft(ws, version);
      const before = (await c.query('DELETE FROM zakat_worksheet_adjustments WHERE id=$1 AND company_id=$2 AND worksheet_id=$3 RETURNING *, amount::text', [id, company, ws.id])).rows[0];
      if (!before) throw new ZakatNotFoundError();
      await this.bump(c, company, ws.id);
      await this.log(c, company, actor, 'zakat_worksheet.adjustment.delete', 'zakat_worksheet_adjustment', id, before, null);
    });
    return this.get(company, year);
  }

  // ---------- workflow ----------
  private async liveReadiness(company: string, year: string, ws: Worksheet, c: PoolClient, liveFp: string) {
    const own = await this.liveOwnership(company, year, c);
    const classRows = (await c.query<{ account_id: string; zakat_type: string }>('SELECT account_id, zakat_type FROM zakat_account_classifications WHERE company_id=$1 AND worksheet_id=$2', [company, ws.id])).rows;
    const classified = new Set(classRows.map((r) => r.account_id));
    const gates = await this.gates(c);
    return { own, gates, readiness: this.readiness(ws, own, liveFp, classified, gates, classRows.filter((r) => r.zakat_type === 'deductible_investment').length) };
  }

  async transition(company: string, year: string, actor: string, action: 'submit' | 'review' | 'approve', version: number) {
    const live = await this.captureBalances(company, year);
    await this.tx(async (c) => {
      const ws = await this.lockOpen(company, year, c);
      const from = { submit: 'draft', review: 'in_review', approve: 'reviewed' }[action];
      if (ws.status !== from) throw new ZakatConflictError('Invalid workflow transition', 'ZAKAT_INVALID_TRANSITION');
      this.checkVersion(ws, version);
      const { gates, readiness } = await this.liveReadiness(company, year, ws, c, live.fingerprint);
      if (readiness.preparation_blockers.length) throw new ZakatValidationError(`Worksheet is not ready: ${readiness.preparation_blockers.join(', ')}`, 'ZAKAT_NOT_READY');
      if (action === 'approve') {
        if (readiness.gate_blockers.length) throw new ZakatConflictError(`Approval is blocked by unverified regulatory gates: ${readiness.gate_blockers.join(', ')}`, 'ZAKAT_REGULATORY_GATES_UNVERIFIED');
        if (await this.packageFinalized(company, year, c)) throw new ZakatConflictError('The annual package is finalized', 'ZAKAT_PACKAGE_FINALIZED');
        const { classifications, adjustments } = await this.children(company, ws.id, c);
        const snapshot = {
          schema: 'zakat-worksheet-approved-v1', fiscal_year_id: year, revision_no: ws.revision_no, as_of_date: ws.balances_snapshot?.as_of_date,
          ownership: ws.ownership_snapshot, balances: ws.balances_snapshot,
          classifications: classifications.map((r: Record<string, unknown>) => ({ account_id: r['account_id'], zakat_type: r['zakat_type'], reg_article: r['reg_article'], evidence_document_id: r['evidence_document_id'], confirmed_by_user_id: r['confirmed_by_user_id'] })),
          adjustments: adjustments.map((r: Record<string, unknown>) => ({ id: r['id'], description: r['description'], direction: r['direction'], amount: r['amount'], reg_article: r['reg_article'], evidence_document_id: r['evidence_document_id'], evidence_note: r['evidence_note'] })),
          gates: gates.map((g) => ({ code: g.code, status: g.status, blocks_approval: g.blocks_approval })),
          calculation_performed: false, payable_amount: null,
        };
        await c.query(`UPDATE zakat_worksheets SET status='superseded', version=version+1, updated_at=NOW() WHERE company_id=$1 AND fiscal_year_id=$2 AND status='approved'`, [company, year]);
        await c.query(
          `UPDATE zakat_worksheets SET status='approved', approved_snapshot=$3, approved_snapshot_fingerprint=$4, approved_by_user_id=$5, approved_at=NOW(), version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2`,
          [ws.id, company, JSON.stringify(snapshot), fingerprintOf(snapshot), actor]);
      } else if (action === 'review') {
        await c.query(`UPDATE zakat_worksheets SET status='reviewed', reviewed_by_user_id=$3, reviewed_at=NOW(), version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2`, [ws.id, company, actor]);
      } else {
        await c.query(`UPDATE zakat_worksheets SET status='in_review', version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2`, [ws.id, company]);
      }
      await this.log(c, company, actor, `zakat_worksheet.${action}`, 'zakat_worksheet', ws.id, this.brief(ws), { status: { submit: 'in_review', review: 'reviewed', approve: 'approved' }[action] });
    });
    return this.get(company, year);
  }

  /** Returns an in-review or reviewed worksheet to draft; a reason is mandatory and audited. */
  async returnToDraft(company: string, year: string, actor: string, version: number, reason: string) {
    if (!reason.trim() || reason.length > 2000) throw new ZakatValidationError('A return reason is required', 'ZAKAT_REASON_REQUIRED');
    await this.tx(async (c) => {
      const ws = await this.lockOpen(company, year, c);
      if (!['in_review', 'reviewed'].includes(ws.status)) throw new ZakatConflictError('Invalid workflow transition', 'ZAKAT_INVALID_TRANSITION');
      this.checkVersion(ws, version);
      await c.query(`UPDATE zakat_worksheets SET status='draft', reviewed_by_user_id=NULL, reviewed_at=NULL, version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2`, [ws.id, company]);
      await this.log(c, company, actor, 'zakat_worksheet.return_to_draft', 'zakat_worksheet', ws.id, this.brief(ws), { status: 'draft' }, reason.trim());
    });
    return this.get(company, year);
  }

  /** Opens a new draft revision of the approved worksheet. The approved revision stays untouched until the new revision is approved. */
  async revise(company: string, year: string, actor: string, version: number, reason: string) {
    if (!reason.trim() || reason.length > 2000) throw new ZakatValidationError('A revision reason is required', 'ZAKAT_REASON_REQUIRED');
    const balances = await this.captureBalances(company, year);
    await this.tx(async (c) => {
      const approved = (await c.query<Worksheet>(`SELECT ${WS} FROM zakat_worksheets w WHERE w.company_id=$1 AND w.fiscal_year_id=$2 AND w.status='approved' FOR UPDATE`, [company, year])).rows[0];
      if (!approved) throw new ZakatNotFoundError();
      this.checkVersion(approved, version);
      if ((await c.query('SELECT 1 FROM zakat_worksheets WHERE company_id=$1 AND fiscal_year_id=$2 AND status = ANY($3)', [company, year, OPEN])).rowCount) throw new ZakatConflictError('An open revision already exists', 'ZAKAT_OPEN_REVISION_EXISTS');
      if (await this.packageFinalized(company, year, c)) throw new ZakatConflictError('The annual package is finalized', 'ZAKAT_PACKAGE_FINALIZED');
      const own = await this.liveOwnership(company, year, c);
      const next = (await c.query<{ id: string }>(
        `INSERT INTO zakat_worksheets(company_id, fiscal_year_id, revision_no, revision_reason, supersedes_id, non_financing_confirmed, accounting_records_confirmed, prepared_by_user_id, ownership_snapshot, ownership_fingerprint, balances_snapshot, balances_fingerprint, snapshot_captured_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,NOW()) RETURNING id`,
        [company, year, approved.revision_no + 1, reason.trim(), approved.id, approved.non_financing_confirmed, approved.accounting_records_confirmed, actor, JSON.stringify(own.verification), own.fingerprint, JSON.stringify(balances.snapshot), balances.fingerprint])).rows[0]!;
      const ids = balances.snapshot.accounts.filter((a) => CLASSIFIABLE_CATEGORIES.includes(a.statement_category)).map((a) => a.account_id);
      await c.query(
        `INSERT INTO zakat_account_classifications(company_id, worksheet_id, account_id, zakat_type, reg_article, evidence_document_id, note, confirmed_by_user_id, confirmed_at)
         SELECT company_id, $3, account_id, zakat_type, reg_article, evidence_document_id, note, confirmed_by_user_id, confirmed_at FROM zakat_account_classifications WHERE company_id=$1 AND worksheet_id=$2 AND account_id = ANY($4::uuid[])`,
        [company, approved.id, next.id, ids]);
      await c.query(
        `INSERT INTO zakat_worksheet_adjustments(company_id, worksheet_id, description, direction, amount, reg_article, evidence_document_id, evidence_note, created_by_user_id)
         SELECT company_id, $3, description, direction, amount, reg_article, evidence_document_id, evidence_note, created_by_user_id FROM zakat_worksheet_adjustments WHERE company_id=$1 AND worksheet_id=$2`,
        [company, approved.id, next.id]);
      await this.log(c, company, actor, 'zakat_worksheet.revise', 'zakat_worksheet', next.id, this.brief(approved), { revision_no: approved.revision_no + 1, supersedes_id: approved.id }, reason.trim());
    });
    return this.get(company, year);
  }

  // ---------- eligibility evidence ----------
  async listEligibility(company: string, partnerId?: string) {
    return (await this.db.query(
      `SELECT e.*, e.effective_from::text, e.effective_to::text, e.confirmed_at::text, e.created_at::text, e.updated_at::text, p.name partner_name FROM zakat_ownership_eligibility e JOIN partners p ON p.id=e.partner_id AND p.company_id=e.company_id WHERE e.company_id=$1 AND ($2::uuid IS NULL OR e.partner_id=$2) ORDER BY p.name, e.effective_from`,
      [company, partnerId ?? null])).rows;
  }
  async createEligibility(company: string, actor: string, input: { partner_id: string; ownership_class: string; effective_from: string; effective_to: string | null; evidence_document_id: string; entity_ultimate_ownership_note: string | null; note: string | null }) {
    if (!OWNERSHIP_CLASSES.includes(input.ownership_class as never)) throw new ZakatValidationError('Unknown ownership class', 'ZAKAT_INVALID_CLASS');
    if (ENTITY_CLASSES.includes(input.ownership_class as never) && !(input.entity_ultimate_ownership_note ?? '').trim()) throw new ZakatValidationError('Entity owners need a note describing the ultimate ownership', 'ZAKAT_ENTITY_NOTE_REQUIRED');
    if (input.effective_to && input.effective_to < input.effective_from) throw new ZakatValidationError('Invalid effective dates', 'ZAKAT_INVALID_DATES');
    return this.tx(async (c) => {
      const row = (await c.query(
        `INSERT INTO zakat_ownership_eligibility(company_id, partner_id, ownership_class, effective_from, effective_to, evidence_document_id, entity_ultimate_ownership_note, note, created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *, effective_from::text, effective_to::text`,
        [company, input.partner_id, input.ownership_class, input.effective_from, input.effective_to, input.evidence_document_id, input.entity_ultimate_ownership_note, input.note, actor])).rows[0];
      await this.log(c, company, actor, 'zakat_eligibility.create', 'zakat_ownership_eligibility', row.id, null, row);
      return row;
    });
  }
  async confirmEligibility(company: string, actor: string, id: string, version: number) {
    return this.tx(async (c) => {
      const before = (await c.query('SELECT * FROM zakat_ownership_eligibility WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, company])).rows[0];
      if (!before) throw new ZakatNotFoundError();
      if (before.version !== version || before.verification_status !== 'unconfirmed') throw new ZakatConflictError('Eligibility row was modified or is already confirmed', 'ZAKAT_VERSION_CONFLICT');
      const row = (await c.query(`UPDATE zakat_ownership_eligibility SET verification_status='confirmed', confirmed_by_user_id=$3, confirmed_at=NOW(), version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *, effective_from::text, effective_to::text`, [id, company, actor])).rows[0];
      await this.log(c, company, actor, 'zakat_eligibility.confirm', 'zakat_ownership_eligibility', id, before, row);
      return row;
    });
  }
  async endEligibility(company: string, actor: string, id: string, version: number, effectiveTo: string, reason: string) {
    if (!reason.trim()) throw new ZakatValidationError('A reason is required to end a confirmed eligibility period', 'ZAKAT_REASON_REQUIRED');
    return this.tx(async (c) => {
      const before = (await c.query('SELECT *, effective_from::text ef FROM zakat_ownership_eligibility WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, company])).rows[0];
      if (!before) throw new ZakatNotFoundError();
      if (before.version !== version) throw new ZakatConflictError('Eligibility row was modified', 'ZAKAT_VERSION_CONFLICT');
      if (before.effective_to !== null || effectiveTo < before.ef) throw new ZakatValidationError('The end date is invalid or already set', 'ZAKAT_INVALID_DATES');
      const row = (await c.query(`UPDATE zakat_ownership_eligibility SET effective_to=$3, end_reason=$4, ended_by_user_id=$5, ended_at=NOW(), version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *, effective_from::text, effective_to::text`, [id, company, effectiveTo, reason.trim(), actor])).rows[0];
      await this.log(c, company, actor, 'zakat_eligibility.end', 'zakat_ownership_eligibility', id, before, row, reason.trim());
      return row;
    });
  }
  async removeEligibility(company: string, actor: string, id: string, version: number) {
    await this.tx(async (c) => {
      const before = (await c.query('SELECT * FROM zakat_ownership_eligibility WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, company])).rows[0];
      if (!before) throw new ZakatNotFoundError();
      if (before.version !== version || before.verification_status !== 'unconfirmed') throw new ZakatConflictError('Only an unconfirmed eligibility row can be removed', 'ZAKAT_VERSION_CONFLICT');
      await c.query('DELETE FROM zakat_ownership_eligibility WHERE id=$1 AND company_id=$2', [id, company]);
      await this.log(c, company, actor, 'zakat_eligibility.delete', 'zakat_ownership_eligibility', id, before, null);
    });
  }

  // ---------- annual closing package ----------
  /** Summary of the current approved revision for the annual package; null when none exists (package fingerprints then stay unchanged). */
  async packageSummary(company: string, year: string, r: Runner, checkDrift: boolean) {
    const ws = (await r.query<Worksheet>(`SELECT ${WS} FROM zakat_worksheets w WHERE w.company_id=$1 AND w.fiscal_year_id=$2 AND w.status='approved'`, [company, year])).rows[0];
    if (!ws) return null;
    let drift = false;
    if (checkDrift) {
      const own = await this.liveOwnership(company, year, r);
      const live = await this.captureBalances(company, year).catch(() => null);
      drift = ws.ownership_fingerprint !== own.fingerprint || live === null || ws.balances_fingerprint !== live.fingerprint;
    }
    return { revision_no: ws.revision_no, approved_snapshot_fingerprint: ws.approved_snapshot_fingerprint!, source_drift: drift };
  }
}
