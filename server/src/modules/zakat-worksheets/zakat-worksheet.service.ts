import { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { FinancialStatementNotFoundError, FinancialStatementsService, FinancialStatementUnmappedError } from '../accounting/financial-statements';
import {
  BalanceAccount, BalancesSnapshot, CLASSIFIABLE_CATEGORIES, ENTITY_CLASSES, GateRow, OWNERSHIP_CLASSES, OwnershipVerification, ZAKAT_TYPES,
  REQUIRED_BLOCKING_GATES, evaluateReadiness, fingerprintOf, toCents, unsupportedPeriodReason, verifyOwnership,
} from './zakat-worksheet.rules';
import { actualDays, previewZakatWorksheet } from './zakat-worksheet.preview';

import { calculateWorksheetFinalization, decisionStatus, regulatoryGates, validGateFacts, type GateDecision } from './zakat-finalization';
import type { RegulatoryGate } from '../zakat-calculation/calculation-input';
import { ZakatInputError } from '../zakat-calculation/zakat-calculation';

export class ZakatForbiddenError extends Error {}
export class ZakatNotFoundError extends Error {}
export class ZakatValidationError extends Error { constructor(message: string, readonly code = 'ZAKAT_VALIDATION') { super(message); } }
export class ZakatConflictError extends Error { constructor(message: string, readonly code = 'ZAKAT_CONFLICT') { super(message); } }

type Runner = Pick<Pool | PoolClient, 'query'>;
function worksheetPeriodReason(start: string, end: string) {
  const reason = unsupportedPeriodReason(start, end);
  const days = actualDays(start, end);
  return reason === 'fiscal_year_not_12_months' && days && days < 354 ? null : reason;
}
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
    try { await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ'); const result = await fn(c); await c.query('COMMIT'); return result; }
    catch (e) { await c.query('ROLLBACK'); throw this.mapDb(e); }
    finally { c.release(); }
  }
  private mapDb(e: unknown) {
    const code = (e as { code?: string }).code;
    if (code === '40001') return new ZakatConflictError('The source changed. Reload and retry.', 'ZAKAT_STALE_SOURCE');
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
  private async captureBalances(company: string, year: string, r: Runner = this.db) {
    let report;
    try { report = await new FinancialStatementsService(this.db).financialPosition(company, year, undefined, r); }
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
          account_id: String(a['account_id']), code: String(a['code']), name: String(a['name']), name_ar: (a['name_ar'] as string | null) ?? null, name_en: (a['name_en'] as string | null) ?? null,
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
    return { snapshot, fingerprint: fingerprintOf(snapshot), ledgerAccounts: report.accounts, balanced: report.accounting_equation.balanced };
  }
  private async gates(r: Runner, verified: Set<string> = new Set()) {
    const rows = (await r.query<GateRow>('SELECT code, title, article_ref, blocks_approval FROM zakat_regulatory_gates ORDER BY code')).rows;
    return rows.map((row) => ({
      ...row, status: verified.has(row.code) ? 'verified' : 'unverified',
      verified_by_name: null, verified_on: null, verification_reference: null,
    }));
  }

  private async decisions(company: string, year: string, worksheet: string, r: Runner, lock = false) {
    return (await r.query<Omit<GateDecision, 'submitted_at' | 'approved_at' | 'ended_at'> & { submitted_at: Date; approved_at: Date | null; ended_at: Date | null }>(
      `SELECT d.*, e.uploaded_by_user_id evidence_uploader, COALESCE(e.status='approved' AND e.sha256=d.evidence_sha256,false) evidence_current,
              COALESCE(u.is_active AND a.appointment_reference=d.reviewer_appointment,false) reviewer_active
       FROM zakat_regulatory_decisions d
       JOIN documents e ON e.id=d.evidence_document_id AND e.company_id=d.company_id
       LEFT JOIN zakat_regulatory_reviewers a ON a.company_id=d.company_id AND a.user_id=d.reviewed_by
       LEFT JOIN users u ON u.id=d.reviewed_by
       WHERE d.company_id=$1 AND d.fiscal_year_id=$2 AND d.worksheet_id=$3 ORDER BY d.submitted_at, d.id ${lock ? 'FOR SHARE OF d,e' : ''}`,
      [company, year, worksheet])).rows.map((row) => ({
      ...row, submitted_at: row.submitted_at.toISOString(),
      approved_at: row.approved_at?.toISOString() ?? null, ended_at: row.ended_at?.toISOString() ?? null,
    }));
  }

  private async reviewers(company: string, r: Runner) {
    return (await r.query<{ id: string; name: string; appointment_reference: string }>(
      `SELECT u.id, COALESCE(u.display_name,u.email) name, a.appointment_reference
       FROM zakat_regulatory_reviewers a JOIN users u ON u.id=a.user_id AND u.is_active
       WHERE a.company_id=$1 ORDER BY u.id`, [company])).rows;
  }

  private async finalization(company: string, year: string, ws: Worksheet, r: Runner, approvalActor?: string) {
    const own = await this.liveOwnership(company, year, r);
    const live = await this.captureBalances(company, year, r).catch((e: unknown) => {
      if (e instanceof ZakatValidationError || e instanceof FinancialStatementUnmappedError) return null;
      throw e;
    });
    const currency = (await r.query<{ functional_currency: string }>(
      'SELECT functional_currency FROM company_accounting_profiles WHERE id=$1 AND company_id=$2',
      [own.verification.profile?.id ?? null, company])).rows[0]?.functional_currency ?? null;
    const children = await this.children(company, ws.id, r);
    const sourceVersion = ws.status === 'approved' ? ws.version - 1 : ws.version;
    const fingerprint = fingerprintOf({
      policy: 'zakat-finalization-v1', company, year, worksheet: ws.id, sourceVersion, fy: own.fy, currency,
      ownership: own.fingerprint, balances: live?.fingerprint, ledger: live?.ledgerAccounts,
      classifications: children.classifications, adjustments: children.adjustments,
    });
    const decisions = await this.decisions(company, year, ws.id, r, Boolean(approvalActor));
    const history = decisions.map((d) => ({ ...d, status: decisionStatus(d, fingerprint) }));
    const verified = new Set(regulatoryGates.flatMap((gate, i) =>
      history.some((d) => d.gate === gate && d.status === 'verified') ? [REQUIRED_BLOCKING_GATES[i]!] : []));
    const gates = await this.gates(r, verified);
    const readiness = this.readiness(ws, own, live?.fingerprint ?? null, new Set(children.classifications.map((c) => c.account_id)), gates,
      children.classifications.filter((c) => c.zakat_type === 'deductible_investment').length);
    const blockers = [...readiness.preparation_blockers, ...readiness.gate_blockers];
    if (!live?.balanced) blockers.push('ACCOUNTING_EQUATION_NOT_VERIFIED');
    if (own.fy.status !== 'closed') blockers.push('FISCAL_YEAR_NOT_CLOSED');
    if (currency !== 'SAR') blockers.push('FUNCTIONAL_CURRENCY_NOT_SAR');
    const closed = { own, live, children, fingerprint, history, readiness, gates };
    if (blockers.length || !live) return { ...closed, blockers, result: null };
    if (approvalActor && !this.independentFinalApprover(ws, history, approvalActor)) throw new ZakatForbiddenError();

    try {
      return { ...closed, ...await calculateWorksheetFinalization({
        year, worksheet: ws.id, start: own.fy.start_date, end: own.fy.end_date, snapshot: live.snapshot, ledgerAccounts: live.ledgerAccounts,
        ...children,
      }, decisions, fingerprint, ws.status === 'approved' || approvalActor ? { client: r as PoolClient, company, actor: approvalActor ?? null } : null) };
    } catch (e) {
      if (e instanceof ZakatInputError) return { ...closed, blockers: ['REGULATORY_FINANCIAL_FACTS_INVALID'], result: null };
      throw e;
    }
  }

  async changeDecision(company: string, year: string, actor: string, action:
    | { type: 'submit'; gate: RegulatoryGate; version: number; document: string; reference: string; facts: Record<string, unknown> }
    | { type: 'approve' | 'end'; id: string; reason?: string }) {
    await this.tx(async (c) => {
      const ws = (await c.query<Worksheet>(
        `SELECT ${WS} FROM zakat_worksheets w WHERE w.company_id=$1 AND w.fiscal_year_id=$2
         AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM zakat_regulatory_decisions d
              WHERE d.id=$3 AND d.company_id=w.company_id AND d.fiscal_year_id=w.fiscal_year_id AND d.worksheet_id=w.id))
         ORDER BY revision_no DESC LIMIT 1 FOR UPDATE`, [company, year, action.type === 'end' ? action.id : null])).rows[0];
      if (!ws) throw new ZakatNotFoundError();
      if (action.type !== 'end' && ws.status !== 'reviewed') throw new ZakatConflictError('The worksheet must be reviewed');
      const state = await this.finalization(company, year, ws, c);
      if (action.type === 'submit') {
        this.checkVersion(ws, action.version);
        if (!validGateFacts(action.gate, action.facts)) throw new ZakatValidationError('Invalid regulatory facts');
        if (state.own.fy.status !== 'closed' || !state.live?.balanced || state.readiness.preparation_blockers.length) {
          throw new ZakatConflictError('Close and reconcile the fiscal year and worksheet before submitting evidence', 'ZAKAT_NOT_READY');
        }
        const document = (await c.query<{ sha256: string }>(
          "SELECT sha256 FROM documents WHERE id=$1 AND company_id=$2 AND status='approved'", [action.document, company])).rows[0];
        if (!document) throw new ZakatValidationError('An approved evidence document for this company is required', 'ZAKAT_REFERENCE_NOT_FOUND');
        const id = (await c.query<{ id: string }>(
          `INSERT INTO zakat_regulatory_decisions(company_id,fiscal_year_id,worksheet_id,gate,source_fingerprint,evidence_document_id,evidence_sha256,authority_reference,facts,submitted_by)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [company, year, ws.id, action.gate, state.fingerprint, action.document, document.sha256, action.reference, action.facts, actor])).rows[0]!.id;
        await this.log(c, company, actor, 'zakat_regulatory_decision.submit', 'zakat_regulatory_decision', id, null, { gate: action.gate, worksheet_id: ws.id });
        return;
      }

      const decision = state.history.find((d) => d.id === action.id && !d.ended_at);
      if (!decision) throw new ZakatNotFoundError();
      const appointment = (await this.reviewers(company, c)).find((r) => r.id === actor);
      if (action.type === 'end') {
        if (!appointment && !(decision.submitted_by === actor && !decision.reviewed_by)) throw new ZakatForbiddenError();
        await c.query('UPDATE zakat_regulatory_decisions SET ended_by=$2,ended_at=now(),end_reason=$3 WHERE id=$1', [decision.id, actor, action.reason]);
      } else {
        if (!appointment || !this.independentReviewer(ws, decision, actor)) throw new ZakatForbiddenError();
        if (decision.status !== 'pending') throw new ZakatConflictError('Only current, pending evidence can be approved', 'ZAKAT_STALE_SOURCE');
        await c.query('UPDATE zakat_regulatory_decisions SET reviewed_by=$2,approved_at=now(),reviewer_appointment=$3 WHERE id=$1', [decision.id, actor, appointment.appointment_reference]);
      }
      await this.log(c, company, actor, `zakat_regulatory_decision.${action.type}`, 'zakat_regulatory_decision', decision.id, { status: decision.status }, null, action.reason);
    });
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
      periodReason: worksheetPeriodReason(own.fy.start_date, own.fy.end_date),
      declarationsOk: Boolean(ws?.non_financing_confirmed && ws?.accounting_records_confirmed),
      balances: ws?.balances_snapshot ?? null, classifiedAccountIds: classifiedIds,
      balancesDrift: Boolean(ws && liveBalancesFp !== null && ws.balances_fingerprint !== liveBalancesFp),
      ownershipDrift: Boolean(ws && ws.ownership_fingerprint !== own.fingerprint), gates, investmentClassifications,
    });
  }

  private independentReviewer(ws: Worksheet, decision: GateDecision, actor: string) {
    return actor !== decision.submitted_by && actor !== decision.evidence_uploader && actor !== ws.prepared_by_user_id;
  }

  async get(company: string, year: string, actor?: string, viewDocuments = false) {
    return this.tx(async (c) => {
      const own = await this.liveOwnership(company, year, c);
      const revisions = (await c.query<Worksheet>(`SELECT ${WS} FROM zakat_worksheets w WHERE w.company_id=$1 AND w.fiscal_year_id=$2 ORDER BY w.revision_no DESC`, [company, year])).rows;
      const eligibility = (await c.query(`SELECT e.*, e.effective_from::text, e.effective_to::text, e.confirmed_at::text, e.created_at::text, p.name partner_name FROM zakat_ownership_eligibility e JOIN partners p ON p.id=e.partner_id AND p.company_id=e.company_id WHERE e.company_id=$1 ORDER BY p.name, e.effective_from`, [company])).rows;
      const ws = revisions[0] ?? null;
      const state = ws && await this.finalization(company, year, ws, c);
      const gates = state?.gates ?? await this.gates(c);
      const readiness = state?.readiness ?? this.readiness(null, own, null, new Set(), gates);
      const reviewers = await this.reviewers(company, c);
      const appointed = reviewers.some((r) => r.id === actor);
      const result = state?.result;
      const finalizationFingerprint = ws?.status === 'approved' && state && this.finalizationFingerprint(state);
      const released = ws?.status === 'approved' && finalizationFingerprint && ws.approved_snapshot?.finalization_fingerprint === finalizationFingerprint;
      const canApprove = Boolean(ws?.status === 'reviewed' && state?.result && state.result.status !== 'BLOCKED' && actor &&
        this.independentFinalApprover(ws, state.history, actor));
      return {
        scope: { fiscal_year: own.fy, unsupported_reason: worksheetPeriodReason(own.fy.start_date, own.fy.end_date) },
        worksheet: ws, revisions: revisions.map((r) => ({ id: r.id, revision_no: r.revision_no, status: r.status, revision_reason: r.revision_reason, approved_at: r.approved_at })),
        classifications: state?.children.classifications ?? [], adjustments: state?.children.adjustments ?? [], eligibility,
        ownership_live: own.verification, gates,
        readiness: { ...readiness, can_approve: canApprove },
        regulatory_reviewers: reviewers.map(({ id, name }) => ({ id, name })),
        regulatory_decisions: ws && state ? state.history.map((d) => ({
          id: d.id, gate: d.gate, status: d.status, submitted_by: d.submitted_by, submitted_at: d.submitted_at,
          reviewed_by: d.reviewed_by, approved_at: d.approved_at, ended_by: d.ended_by, ended_at: d.ended_at,
          end_reason: d.end_reason, reviewer_appointment: viewDocuments ? d.reviewer_appointment : null,
          ...(viewDocuments ? {
            evidence_document_id: d.evidence_document_id, evidence_sha256: d.evidence_sha256,
            authority_reference: d.authority_reference, facts: d.facts,
          } : {}),
          can_approve: Boolean(actor && appointed && ws.status === 'reviewed' && d.status === 'pending' && this.independentReviewer(ws, d, actor)),
          can_end: Boolean(actor && !d.ended_at && (appointed || (actor === d.submitted_by && !d.reviewed_by))),
        })) : [],
        finalization: {
          status: released ? result!.status : 'BLOCKED',
          blockers: !state ? ['WORKSHEET_REQUIRED', ...readiness.gate_blockers]
            : state.blockers.length ? state.blockers : released ? [] : ['WORKSHEET_APPROVAL_REQUIRED'],
          payable_amount_halalas: released ? result!.payableAmountHalalas : null,
          final_zakat_base_halalas: released ? result!.finalZakatBaseHalalas : null,
          exemption_code: released ? result!.exemptionCode : null,
        },
      };
    });
  }

  private finalizationFingerprint(state: Awaited<ReturnType<ZakatWorksheetService['finalization']>>) {
    if (!state.result || state.result.status === 'BLOCKED' || state.blockers.length) return null;
    return fingerprintOf({
      source: state.fingerprint, decisions: state.history.filter((row) => row.status === 'verified').map((row) => row.id),
      result: state.result,
    });
  }

  private independentFinalApprover(ws: Worksheet, history: (GateDecision & { status: string })[], actor: string) {
    return actor !== ws.prepared_by_user_id && actor !== ws.reviewed_by_user_id
      && !history.some((d) => d.status === 'verified' && d.submitted_by === actor);
  }

  /** Read-only preview through the isolated component composer; it never calculates payable Zakat. */
  async preview(company: string, year: string) {
    const data = await this.get(company, year);
    const profileCurrency = (await this.db.query<{ functional_currency: string }>(
      `SELECT functional_currency FROM company_accounting_profiles WHERE company_id=$1 AND workflow_status='approved' AND effective_from<=$2 AND (effective_to IS NULL OR effective_to>=$3) AND (tax_effective_from IS NULL OR tax_effective_from<=$2) ORDER BY effective_from DESC, version_no DESC LIMIT 1`,
      [company, data.scope.fiscal_year.start_date, data.scope.fiscal_year.end_date],
    )).rows[0]?.functional_currency ?? null;
    return previewZakatWorksheet({
      worksheet: data.worksheet,
      fiscalYear: data.scope.fiscal_year,
      functionalCurrency: profileCurrency,
      classifications: data.classifications as unknown as { account_id: string; zakat_type: string; evidence_document_id: string | null }[],
      adjustments: data.adjustments as unknown as { id: string; description: string; direction: 'add' | 'deduct'; amount: string; evidence_document_id: string | null }[],
      gates: data.gates,
      ownershipQualified: data.ownership_live.qualified,
      ownershipBlockers: data.ownership_live.blockers,
      readinessBlockers: [
        ...data.readiness.preparation_blockers,
        ...data.readiness.gate_blockers,
        ...(data.scope.unsupported_reason ? [data.scope.unsupported_reason] : []),
      ],
    });
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
    const reason = worksheetPeriodReason(fy.start_date, fy.end_date);
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
    await this.tx(async (c) => {
      const ws = await this.lockOpen(company, year, c);
      const live = await this.captureBalances(company, year, c);
      const from = { submit: 'draft', review: 'in_review', approve: 'reviewed' }[action];
      if (ws.status !== from) throw new ZakatConflictError('Invalid workflow transition', 'ZAKAT_INVALID_TRANSITION');
      this.checkVersion(ws, version);
      const { readiness } = await this.liveReadiness(company, year, ws, c, live.fingerprint);
      if (readiness.preparation_blockers.length) throw new ZakatValidationError(`Worksheet is not ready: ${readiness.preparation_blockers.join(', ')}`, 'ZAKAT_NOT_READY');
      if (action === 'approve') {
        if (await this.packageFinalized(company, year, c)) throw new ZakatConflictError('The annual package is finalized', 'ZAKAT_PACKAGE_FINALIZED');
        const state = await this.finalization(company, year, ws, c, actor);
        if (state.readiness.gate_blockers.length) throw new ZakatConflictError(`Approval is blocked by unverified regulatory gates: ${state.readiness.gate_blockers.join(', ')}`, 'ZAKAT_REGULATORY_GATES_UNVERIFIED');
        const finalizationFingerprint = this.finalizationFingerprint(state);
        if (!finalizationFingerprint) throw new ZakatConflictError('Financial validation is incomplete', 'ZAKAT_NOT_READY');
        const { classifications, adjustments } = state.children;
        const snapshot = {
          schema: 'zakat-worksheet-approved-v1', fiscal_year_id: year, revision_no: ws.revision_no, as_of_date: ws.balances_snapshot?.as_of_date,
          ownership: ws.ownership_snapshot, balances: ws.balances_snapshot,
          classifications: classifications.map((r: Record<string, unknown>) => ({ account_id: r['account_id'], zakat_type: r['zakat_type'], reg_article: r['reg_article'], evidence_document_id: r['evidence_document_id'], confirmed_by_user_id: r['confirmed_by_user_id'] })),
          adjustments: adjustments.map((r: Record<string, unknown>) => ({ id: r['id'], description: r['description'], direction: r['direction'], amount: r['amount'], reg_article: r['reg_article'], evidence_document_id: r['evidence_document_id'], evidence_note: r['evidence_note'] })),
          gates: state.gates.map((g) => ({ code: g.code, status: g.status, blocks_approval: g.blocks_approval })),
          regulatory_decisions: state.history.filter((d) => d.status === 'verified').map((d) => ({ id: d.id, gate: d.gate })),
          source_fingerprint: state.fingerprint, calculation_performed: true, payable_amount: null, finalization_fingerprint: finalizationFingerprint,
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
      const state = await this.finalization(company, year, ws, r);
      const fingerprint = this.finalizationFingerprint(state);
      drift = !fingerprint || ws.approved_snapshot?.finalization_fingerprint !== fingerprint;
    }
    return { revision_no: ws.revision_no, approved_snapshot_fingerprint: ws.approved_snapshot_fingerprint!, source_drift: drift };
  }
}
