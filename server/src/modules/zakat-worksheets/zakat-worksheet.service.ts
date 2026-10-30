import type { Pool, PoolClient } from 'pg';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import {
  EVIDENCE_CLASSES, OWNERSHIP_CLASSES, ENTITY_CLASSES, ZAKAT_CLASSES, ZakatConflictError, ZakatNotFoundError, ZakatValidationError,
  calculationGate, fp, halalas, isDate, money, scopeProblems, suggestClass,
} from './zakat.constants';
import { BalanceSnapshot, Runner, fiscalYearDates, loadBalanceSnapshot, verifyOwnership } from './zakat-sources';

const ALLOWED_CLASSES: Record<string, string[]> = {
  equity: ['addition_equity', 'addition_provision_equity', 'addition_partner_loan_equity'],
  non_current_liability: ['addition_non_current_liability', 'addition_provision_non_current_liability', 'addition_provision_equity', 'addition_partner_loan_equity', 'addition_partner_loan_liability'],
  current_liability: ['current_liability', 'addition_provision_equity', 'addition_partner_loan_equity', 'addition_partner_loan_liability'],
  current_asset: ['not_deducted', 'not_deducted_inventory', 'deduction_other_article', 'investment_unsupported'],
  non_current_asset: ['deduction_fixed_assets', 'deduction_intangibles', 'deduction_other_article', 'not_deducted', 'investment_unsupported'],
};
const REV_SELECT = `r.*, r.balance_captured_at::text, r.reviewed_at::text, r.approved_at::text, r.superseded_at::text, r.created_at::text, r.updated_at::text`;
export type Blocker = { code: string; count: number };
type Row = Record<string, any>;

export class ZakatWorksheetService {
  private audit = new AuditLogRepository();
  constructor(private db: Pool) {}

  private async tx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.db.connect();
    try { await c.query('BEGIN'); const v = await fn(c); await c.query('COMMIT'); return v; } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  }
  private log(c: PoolClient, company: string, actor: string, action: string, type: string, id: string, before: unknown, after: unknown) {
    return this.audit.logEvent({ company_id: company, actor_user_id: actor, action, entity_type: type, entity_id: id, before_data: before as never, after_data: after as never }, c);
  }
  private async assertDocument(company: string, id: string | null | undefined, c: Runner) {
    if (id == null) return;
    if (!(await c.query('SELECT 1 FROM documents WHERE id=$1 AND company_id=$2', [id, company])).rowCount) throw new ZakatValidationError('Evidence document not found for this company', 'ZAKAT_EVIDENCE_NOT_FOUND');
  }

  // ---- Eligibility records (effective-dated, evidence-backed, never inferred) ----
  async listEligibility(company: string, runner: Runner = this.db) {
    return (await runner.query<Row>(`SELECT e.*, e.effective_from::text, e.effective_to::text, e.confirmed_at::text, e.revoked_at::text, e.created_at::text, p.name partner_name
      FROM zakat_partner_eligibility e JOIN partners p ON p.id=e.partner_id AND p.company_id=e.company_id WHERE e.company_id=$1 ORDER BY p.name, e.effective_from, e.created_at`, [company])).rows;
  }
  recordEligibility(company: string, actor: string, i: { partner_id: string; ownership_class: string; effective_from: string; effective_to: string | null; evidence_document_id: string; ultimate_ownership_note: string | null }) {
    if (!(OWNERSHIP_CLASSES as readonly string[]).includes(i.ownership_class)) throw new ZakatValidationError('Invalid ownership class', 'ZAKAT_INVALID_OWNERSHIP_CLASS');
    if (!isDate(i.effective_from) || (i.effective_to !== null && (!isDate(i.effective_to) || i.effective_to < i.effective_from))) throw new ZakatValidationError('Invalid effective dates', 'ZAKAT_INVALID_DATES');
    if (ENTITY_CLASSES.includes(i.ownership_class) && !i.ultimate_ownership_note?.trim()) throw new ZakatValidationError('Entity partners need an ultimate-ownership note confirmed by the accountant', 'ZAKAT_ENTITY_NOTE_REQUIRED');
    return this.tx(async (c) => {
      if (!(await c.query('SELECT 1 FROM partners WHERE id=$1 AND company_id=$2 FOR UPDATE', [i.partner_id, company])).rowCount) throw new ZakatNotFoundError();
      await this.assertDocument(company, i.evidence_document_id, c);
      const overlap = await c.query(`SELECT 1 FROM zakat_partner_eligibility WHERE company_id=$1 AND partner_id=$2 AND status='active' AND effective_from<=COALESCE($4::date,'9999-12-31') AND COALESCE(effective_to,'9999-12-31')>=$3::date`, [company, i.partner_id, i.effective_from, i.effective_to]);
      if (overlap.rowCount) throw new ZakatConflictError('An active eligibility record already covers part of this period', 'ZAKAT_ELIGIBILITY_OVERLAP');
      const row = (await c.query<Row>(`INSERT INTO zakat_partner_eligibility(company_id,partner_id,ownership_class,effective_from,effective_to,evidence_document_id,ultimate_ownership_note,confirmed_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *, effective_from::text, effective_to::text, confirmed_at::text, created_at::text`,
        [company, i.partner_id, i.ownership_class, i.effective_from, i.effective_to, i.evidence_document_id, i.ultimate_ownership_note?.trim() || null, actor])).rows[0]!;
      await this.log(c, company, actor, 'zakat_eligibility.record', 'zakat_partner_eligibility', row.id, null, row);
      return row;
    });
  }
  revokeEligibility(company: string, id: string, actor: string, reason: string, version: number) {
    if (!reason.trim()) throw new ZakatValidationError('A revocation reason is required', 'ZAKAT_REASON_REQUIRED');
    return this.tx(async (c) => {
      const before = (await c.query<Row>('SELECT * FROM zakat_partner_eligibility WHERE id=$1 AND company_id=$2 FOR UPDATE', [id, company])).rows[0];
      if (!before) throw new ZakatNotFoundError();
      if (before.status !== 'active' || before.version !== version) throw new ZakatConflictError('Eligibility record was modified', 'ZAKAT_STALE_VERSION');
      const after = (await c.query<Row>(`UPDATE zakat_partner_eligibility SET status='revoked', revoked_by_user_id=$3, revoked_at=NOW(), revoke_reason=$4, version=version+1 WHERE id=$1 AND company_id=$2 RETURNING *, effective_from::text, effective_to::text, revoked_at::text`, [id, company, actor, reason.trim()])).rows[0]!;
      await this.log(c, company, actor, 'zakat_eligibility.revoke', 'zakat_partner_eligibility', id, before, after);
      return after;
    });
  }

  // ---- Views ----
  private async workpaper(company: string, year: string, r: Runner, lock = false) {
    return (await r.query<Row>(`SELECT id, tax_path, workflow_status FROM tax_working_papers WHERE company_id=$1 AND fiscal_year_id=$2${lock ? ' FOR UPDATE' : ''}`, [company, year])).rows[0] ?? null;
  }
  private async revisions(company: string, year: string, r: Runner) {
    return (await r.query<Row>(`SELECT ${REV_SELECT} FROM zakat_worksheet_revisions r WHERE r.company_id=$1 AND r.fiscal_year_id=$2 ORDER BY r.revision_no DESC`, [company, year])).rows;
  }
  private async classifications(company: string, revision: string, r: Runner) {
    return (await r.query<Row>(`SELECT k.*, k.confirmed_at::text, k.created_at::text, k.updated_at::text, a.code account_code, a.name account_name, a.statement_category FROM zakat_revision_classifications k JOIN accounts a ON a.id=k.account_id AND a.company_id=k.company_id WHERE k.company_id=$1 AND k.revision_id=$2 ORDER BY a.code, a.id`, [company, revision])).rows;
  }
  private async adjustments(company: string, revision: string, r: Runner) {
    return (await r.query<Row>(`SELECT x.*, x.amount::text, x.created_at::text, x.updated_at::text FROM zakat_revision_adjustments x WHERE x.company_id=$1 AND x.revision_id=$2 ORDER BY x.created_at, x.id`, [company, revision])).rows;
  }

  /** Blockers that keep a worksheet from review/approval (preparation completeness; independent of the calculation gate). */
  private async blockersFor(company: string, year: string, rev: Row, r: Runner): Promise<{ blockers: Blocker[]; source_drift: boolean; ownership_reasons: string[] }> {
    const list: Blocker[] = [];
    const add = (code: string, count = 1) => { if (count > 0) list.push({ code, count }); };
    const fy = await fiscalYearDates(company, year, r);
    add('unsupported_scope', scopeProblems(fy.start_date, fy.end_date).length);
    const snap = rev.ownership_snapshot_id ? (await r.query<Row>('SELECT qualified, reasons, fingerprint FROM zakat_ownership_snapshots WHERE id=$1 AND company_id=$2', [rev.ownership_snapshot_id, company])).rows[0] : null;
    let drift = false;
    const reasons: string[] = snap?.reasons ?? [];
    if (!snap) add('ownership_snapshot_missing'); else if (!snap.qualified) add('ownership_not_qualified', reasons.length);
    const live = await loadBalanceSnapshot(company, year, r);
    if (live.fingerprint !== rev.balance_fingerprint) { drift = true; add('balance_source_drift'); }
    if (snap && (await verifyOwnership(company, year, r)).fingerprint !== snap.fingerprint) { drift = true; add('ownership_source_drift'); }
    const balances = new Map((rev.balance_snapshot as BalanceSnapshot).accounts.map((a) => [a.account_id, BigInt(a.balance_halalas)]));
    const classes = await this.classifications(company, rev.id, r);
    const byAccount = new Map(classes.map((k) => [k.account_id, k]));
    let unclassified = 0, unconfirmed = 0, unsupported = 0;
    for (const [id, bal] of balances) {
      if (bal === 0n) continue;
      const k = byAccount.get(id);
      if (!k) unclassified++; else if (k.status !== 'confirmed') unconfirmed++; else if (k.zakat_class === 'investment_unsupported') unsupported++;
    }
    add('unclassified_balance', unclassified); add('unconfirmed_classification', unconfirmed); add('unsupported_scope', unsupported);
    add('professional_review_unresolved', (await this.adjustments(company, rev.id, r)).filter((a) => a.professional_review_required).length);
    return { blockers: list, source_drift: drift, ownership_reasons: reasons };
  }

  async get(company: string, year: string) {
    const fy = await fiscalYearDates(company, year, this.db);
    const workpaper = await this.workpaper(company, year, this.db);
    const revisions = await this.revisions(company, year, this.db);
    const current = revisions.find((r) => ['draft', 'needs_review', 'reviewed'].includes(r.status)) ?? null;
    const approved = revisions.find((r) => r.status === 'approved') ?? null;
    const shown = current ?? approved;
    let detail: Row | null = null;
    if (shown) {
      const { blockers, source_drift, ownership_reasons } = await this.blockersFor(company, year, shown, this.db);
      const snap = shown.ownership_snapshot_id ? (await this.db.query<Row>('SELECT id, qualified, reasons, detail, fingerprint, captured_at::text FROM zakat_ownership_snapshots WHERE id=$1 AND company_id=$2', [shown.ownership_snapshot_id, company])).rows[0] ?? null : null;
      detail = { ...shown, classifications: await this.classifications(company, shown.id, this.db), adjustments: await this.adjustments(company, shown.id, this.db), ownership_snapshot: snap, blockers, source_drift, ownership_reasons };
      delete detail.approved_snapshot;
    }
    const scope = scopeProblems(fy.start_date, fy.end_date);
    return {
      fiscal_year: { id: year, ...fy }, workpaper, scope_problems: scope,
      worksheet: detail, revisions: revisions.map(({ balance_snapshot: _b, approved_snapshot: _a, ...r }) => r),
      eligibility: await this.listEligibility(company),
      ownership_preview: await verifyOwnership(company, year, this.db),
      calculation: calculationGate(),
    };
  }

  // ---- Revision lifecycle ----
  private async lockRevision(company: string, year: string, c: PoolClient, version: number, statuses: string[]) {
    await this.workpaper(company, year, c, true);
    const rev = (await c.query<Row>(`SELECT ${REV_SELECT} FROM zakat_worksheet_revisions r WHERE r.company_id=$1 AND r.fiscal_year_id=$2 AND r.status IN ('draft','needs_review','reviewed') FOR UPDATE`, [company, year])).rows[0];
    if (!rev) throw new ZakatNotFoundError();
    if (!statuses.includes(rev.status)) throw new ZakatConflictError(`Worksheet is ${rev.status}; this change is not allowed`, 'ZAKAT_INVALID_STATE');
    if (rev.version !== version) throw new ZakatConflictError('Worksheet was modified', 'ZAKAT_STALE_VERSION');
    return rev;
  }
  private bump(c: PoolClient, company: string, id: string) { return c.query('UPDATE zakat_worksheet_revisions SET version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2', [id, company]); }

  private async captureOwnership(company: string, year: string, actor: string, c: PoolClient) {
    const v = await verifyOwnership(company, year, c);
    const row = (await c.query<Row>('INSERT INTO zakat_ownership_snapshots(company_id,fiscal_year_id,snapshot_date,qualified,reasons,detail,fingerprint,captured_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id', [company, year, v.detail.snapshot_date, v.qualified, JSON.stringify(v.reasons), JSON.stringify(v.detail), v.fingerprint, actor])).rows[0]!;
    await this.log(c, company, actor, 'zakat_ownership_snapshot.capture', 'zakat_ownership_snapshot', row.id, null, { fiscal_year_id: year, qualified: v.qualified, reasons: v.reasons, fingerprint: v.fingerprint });
    return row.id as string;
  }
  private async seedSuggestions(company: string, revision: string, snapshot: BalanceSnapshot, c: PoolClient) {
    for (const a of snapshot.accounts) {
      const s = suggestClass(a.statement_category);
      if (s) await c.query('INSERT INTO zakat_revision_classifications(company_id,revision_id,account_id,zakat_class,reg_article) VALUES($1,$2,$3,$4,$5) ON CONFLICT (revision_id, account_id) DO NOTHING', [company, revision, a.account_id, s.zakat_class, s.reg_article]);
    }
  }

  createInitial(company: string, year: string, actor: string, declared: boolean) {
    return this.tx(async (c) => {
      const fy = await fiscalYearDates(company, year, c);
      const wp = await this.workpaper(company, year, c, true);
      if (!wp) throw new ZakatConflictError('Create the tax working paper for this fiscal year first', 'ZAKAT_WORKPAPER_REQUIRED');
      const problems = [...scopeProblems(fy.start_date, fy.end_date), ...(wp.tax_path === 'zakat' ? [] : ['tax_path_not_zakat']), ...(declared ? [] : ['non_financing_declaration_missing'])];
      if (problems.length) throw new ZakatValidationError('This fiscal year is outside the supported Zakat worksheet scope', 'ZAKAT_UNSUPPORTED_SCOPE', problems);
      if ((await c.query('SELECT 1 FROM zakat_worksheet_revisions WHERE workpaper_id=$1', [wp.id])).rowCount) throw new ZakatConflictError('A worksheet already exists; create a revision instead', 'ZAKAT_WORKSHEET_EXISTS');
      const bal = await loadBalanceSnapshot(company, year, c);
      const ownershipId = await this.captureOwnership(company, year, actor, c);
      const rev = (await c.query<Row>('INSERT INTO zakat_worksheet_revisions(company_id,fiscal_year_id,workpaper_id,revision_no,non_financing_entity_declared,ownership_snapshot_id,balance_snapshot,balance_fingerprint,prepared_by_user_id) VALUES($1,$2,$3,1,TRUE,$4,$5,$6,$7) RETURNING id', [company, year, wp.id, ownershipId, JSON.stringify(bal.snapshot), bal.fingerprint, actor])).rows[0]!;
      await this.seedSuggestions(company, rev.id, bal.snapshot, c);
      await this.log(c, company, actor, 'zakat_worksheet.create', 'zakat_worksheet_revision', rev.id, null, { fiscal_year_id: year, revision_no: 1, balance_fingerprint: bal.fingerprint, ownership_snapshot_id: ownershipId });
    }).then(() => this.get(company, year));
  }

  refresh(company: string, year: string, actor: string, version: number) {
    return this.tx(async (c) => {
      const rev = await this.lockRevision(company, year, c, version, ['draft', 'needs_review', 'reviewed']);
      const bal = await loadBalanceSnapshot(company, year, c);
      const ownershipId = await this.captureOwnership(company, year, actor, c);
      await c.query(`UPDATE zakat_worksheet_revisions SET balance_snapshot=$3, balance_fingerprint=$4, balance_captured_at=NOW(), ownership_snapshot_id=$5, status='draft', reviewed_by_user_id=NULL, reviewed_at=NULL, version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2`, [rev.id, company, JSON.stringify(bal.snapshot), bal.fingerprint, ownershipId]);
      await this.seedSuggestions(company, rev.id, bal.snapshot, c);
      await this.log(c, company, actor, 'zakat_worksheet.refresh', 'zakat_worksheet_revision', rev.id, { status: rev.status, balance_fingerprint: rev.balance_fingerprint }, { status: 'draft', balance_fingerprint: bal.fingerprint, ownership_snapshot_id: ownershipId });
    }).then(() => this.get(company, year));
  }

  setClassification(company: string, year: string, accountId: string, actor: string, i: { zakat_class: string; reg_article: string; evidence_document_id: string | null; note: string | null; version: number }) {
    if (!(ZAKAT_CLASSES as readonly string[]).includes(i.zakat_class)) throw new ZakatValidationError('Invalid Zakat classification', 'ZAKAT_INVALID_CLASS');
    if (!i.reg_article.trim()) throw new ZakatValidationError('A regulatory article reference is required', 'ZAKAT_ARTICLE_REQUIRED');
    return this.tx(async (c) => {
      const rev = await this.lockRevision(company, year, c, i.version, ['draft']);
      const acc = (rev.balance_snapshot as BalanceSnapshot).accounts.find((a) => a.account_id === accountId);
      if (!acc) throw new ZakatNotFoundError();
      if (!ALLOWED_CLASSES[acc.statement_category]?.includes(i.zakat_class)) throw new ZakatValidationError('This classification does not fit the account category', 'ZAKAT_CLASS_CATEGORY_MISMATCH');
      await this.assertDocument(company, i.evidence_document_id, c);
      const before = (await c.query<Row>('SELECT * FROM zakat_revision_classifications WHERE revision_id=$1 AND account_id=$2 AND company_id=$3', [rev.id, accountId, company])).rows[0] ?? null;
      const after = (await c.query<Row>(`INSERT INTO zakat_revision_classifications(company_id,revision_id,account_id,zakat_class,reg_article,evidence_document_id,note) VALUES($1,$2,$3,$4,$5,$6,$7)
        ON CONFLICT (revision_id, account_id) DO UPDATE SET zakat_class=EXCLUDED.zakat_class, reg_article=EXCLUDED.reg_article, evidence_document_id=EXCLUDED.evidence_document_id, note=EXCLUDED.note, status='suggested', confirmed_by_user_id=NULL, confirmed_at=NULL, version=zakat_revision_classifications.version+1, updated_at=NOW() RETURNING *`,
        [company, rev.id, accountId, i.zakat_class, i.reg_article.trim(), i.evidence_document_id, i.note?.trim() || null])).rows[0]!;
      await this.bump(c, company, rev.id);
      await this.log(c, company, actor, 'zakat_worksheet.classification.set', 'zakat_revision_classification', after.id, before, after);
    }).then(() => this.get(company, year));
  }

  confirmClassification(company: string, year: string, accountId: string, actor: string, version: number) {
    return this.tx(async (c) => {
      const rev = await this.lockRevision(company, year, c, version, ['draft']);
      const before = (await c.query<Row>('SELECT * FROM zakat_revision_classifications WHERE revision_id=$1 AND account_id=$2 AND company_id=$3 FOR UPDATE', [rev.id, accountId, company])).rows[0];
      if (!before) throw new ZakatNotFoundError();
      if (!before.reg_article?.trim()) throw new ZakatValidationError('A regulatory article reference is required', 'ZAKAT_ARTICLE_REQUIRED');
      if (EVIDENCE_CLASSES.includes(before.zakat_class) && !before.evidence_document_id) throw new ZakatValidationError('This classification needs supporting evidence', 'ZAKAT_EVIDENCE_REQUIRED');
      const after = (await c.query<Row>(`UPDATE zakat_revision_classifications SET status='confirmed', confirmed_by_user_id=$3, confirmed_at=NOW(), version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *`, [before.id, company, actor])).rows[0]!;
      await this.bump(c, company, rev.id);
      await this.log(c, company, actor, 'zakat_worksheet.classification.confirm', 'zakat_revision_classification', after.id, before, after);
    }).then(() => this.get(company, year));
  }

  addAdjustment(company: string, year: string, actor: string, i: { description: string; direction: string; amount: string; reg_article: string; evidence_document_id: string; note: string | null; professional_review_required: boolean; version: number }) {
    return this.tx(async (c) => {
      const rev = await this.lockRevision(company, year, c, i.version, ['draft']);
      await this.assertDocument(company, i.evidence_document_id, c);
      const row = (await c.query<Row>('INSERT INTO zakat_revision_adjustments(company_id,revision_id,description,direction,amount,reg_article,evidence_document_id,note,professional_review_required,created_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *, amount::text', [company, rev.id, i.description, i.direction, i.amount, i.reg_article, i.evidence_document_id, i.note, i.professional_review_required, actor])).rows[0]!;
      await this.bump(c, company, rev.id);
      await this.log(c, company, actor, 'zakat_worksheet.adjustment.create', 'zakat_revision_adjustment', row.id, null, row);
    }).then(() => this.get(company, year));
  }
  changeAdjustment(company: string, year: string, id: string, actor: string, i: Partial<{ description: string; direction: string; amount: string; reg_article: string; evidence_document_id: string; note: string | null; professional_review_required: boolean }> & { version: number }) {
    return this.tx(async (c) => {
      const rev = await this.lockRevision(company, year, c, i.version, ['draft']);
      const before = (await c.query<Row>('SELECT *, amount::text FROM zakat_revision_adjustments WHERE id=$1 AND company_id=$2 AND revision_id=$3 FOR UPDATE', [id, company, rev.id])).rows[0];
      if (!before) throw new ZakatNotFoundError();
      if (i.evidence_document_id) await this.assertDocument(company, i.evidence_document_id, c);
      const next = { ...before, ...Object.fromEntries(Object.entries(i).filter(([k, v]) => k !== 'version' && v !== undefined)) } as Row;
      const after = (await c.query<Row>('UPDATE zakat_revision_adjustments SET description=$3,direction=$4,amount=$5,reg_article=$6,evidence_document_id=$7,note=$8,professional_review_required=$9,version=version+1,updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *, amount::text', [id, company, next.description, next.direction, next.amount, next.reg_article, next.evidence_document_id, next.note, next.professional_review_required])).rows[0]!;
      await this.bump(c, company, rev.id);
      await this.log(c, company, actor, 'zakat_worksheet.adjustment.update', 'zakat_revision_adjustment', id, before, after);
    }).then(() => this.get(company, year));
  }
  removeAdjustment(company: string, year: string, id: string, actor: string, version: number) {
    return this.tx(async (c) => {
      const rev = await this.lockRevision(company, year, c, version, ['draft']);
      const before = (await c.query<Row>('DELETE FROM zakat_revision_adjustments WHERE id=$1 AND company_id=$2 AND revision_id=$3 RETURNING *, amount::text', [id, company, rev.id])).rows[0];
      if (!before) throw new ZakatNotFoundError();
      await this.bump(c, company, rev.id);
      await this.log(c, company, actor, 'zakat_worksheet.adjustment.delete', 'zakat_revision_adjustment', id, before, null);
    }).then(() => this.get(company, year));
  }

  // ---- Workflow ----
  private async approvedSnapshot(company: string, year: string, rev: Row, c: PoolClient) {
    const fy = await fiscalYearDates(company, year, c);
    const own = (await c.query<Row>('SELECT id, qualified, reasons, detail, fingerprint FROM zakat_ownership_snapshots WHERE id=$1 AND company_id=$2', [rev.ownership_snapshot_id, company])).rows[0]!;
    const classes = await this.classifications(company, rev.id, c);
    const balances = new Map((rev.balance_snapshot as BalanceSnapshot).accounts.map((a) => [a.account_id, BigInt(a.balance_halalas)]));
    const totals = new Map<string, bigint>();
    const items = classes.filter((k) => balances.has(k.account_id)).map((k) => { const bal = balances.get(k.account_id)!; totals.set(k.zakat_class, (totals.get(k.zakat_class) ?? 0n) + bal); return { account_id: k.account_id, code: k.account_code, name: k.account_name, zakat_class: k.zakat_class, reg_article: k.reg_article, evidence_document_id: k.evidence_document_id, note: k.note, status: k.status, confirmed_by_user_id: k.confirmed_by_user_id, balance_halalas: bal.toString() }; });
    const adjustments = await this.adjustments(company, rev.id, c);
    const sum = (d: string) => adjustments.filter((a) => a.direction === d).reduce((s, a) => s + halalas(a.amount), 0n);
    const gate = calculationGate();
    return {
      schema: 'zakat-worksheet-v1', rules_version: gate.rules_version, fiscal_year: { id: year, ...fy }, revision_no: rev.revision_no,
      scope: { non_financing_entity_declared: rev.non_financing_entity_declared, problems: scopeProblems(fy.start_date, fy.end_date) },
      ownership: { snapshot_id: own.id, qualified: own.qualified, reasons: own.reasons, fingerprint: own.fingerprint, detail: own.detail },
      balances: { fingerprint: rev.balance_fingerprint, ...(rev.balance_snapshot as BalanceSnapshot) },
      classifications: items,
      descriptive_class_totals_halalas: [...totals].sort(([a], [b]) => a.localeCompare(b)).map(([zakat_class, total]) => ({ zakat_class, total_halalas: total.toString() })),
      adjustments: adjustments.map((a) => ({ id: a.id, description: a.description, direction: a.direction, amount: a.amount, reg_article: a.reg_article, evidence_document_id: a.evidence_document_id, note: a.note })),
      adjustment_totals: { add: money(sum('add')), deduct: money(sum('deduct')) },
      calculation: { status: gate.status, payable_amount: null, blocker_codes: gate.blockers.map((b) => b.code) },
    };
  }

  transition(company: string, year: string, actor: string, action: 'submit-review' | 'review' | 'approve', version: number) {
    const [from, to] = action === 'submit-review' ? ['draft', 'needs_review'] : action === 'review' ? ['needs_review', 'reviewed'] : ['reviewed', 'approved'];
    return this.tx(async (c) => {
      const rev = await this.lockRevision(company, year, c, version, [from!]);
      const { blockers } = await this.blockersFor(company, year, rev, c);
      if (blockers.length) throw new ZakatValidationError('The worksheet has unresolved blockers', 'ZAKAT_WORKSHEET_BLOCKED', blockers.map((b) => b.code));
      if (to === 'approved') {
        const snapshot = await this.approvedSnapshot(company, year, rev, c);
        await c.query(`UPDATE zakat_worksheet_revisions SET status='superseded', superseded_at=NOW(), updated_at=NOW() WHERE workpaper_id=$1 AND company_id=$2 AND status='approved'`, [rev.workpaper_id, company]);
        const fingerprint = fp(snapshot);
        await c.query(`UPDATE zakat_worksheet_revisions SET status='approved', approved_snapshot=$3, approved_fingerprint=$4, approved_by_user_id=$5, approved_at=NOW(), version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2`, [rev.id, company, JSON.stringify(snapshot), fingerprint, actor]);
        await this.log(c, company, actor, 'zakat_worksheet.approve', 'zakat_worksheet_revision', rev.id, { status: from }, { status: to, revision_no: rev.revision_no, approved_fingerprint: fingerprint, calculation_status: 'blocked' });
      } else {
        await c.query(`UPDATE zakat_worksheet_revisions SET status=$3, reviewed_by_user_id=CASE WHEN $3='reviewed' THEN $4::uuid ELSE reviewed_by_user_id END, reviewed_at=CASE WHEN $3='reviewed' THEN NOW() ELSE reviewed_at END, version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2`, [rev.id, company, to, actor]);
        await this.log(c, company, actor, `zakat_worksheet.${to === 'needs_review' ? 'submit_review' : 'review'}`, 'zakat_worksheet_revision', rev.id, { status: from }, { status: to });
      }
    }).then(() => this.get(company, year));
  }

  returnToDraft(company: string, year: string, actor: string, version: number, reason: string) {
    if (!reason.trim()) throw new ZakatValidationError('A reason is required', 'ZAKAT_REASON_REQUIRED');
    return this.tx(async (c) => {
      const rev = await this.lockRevision(company, year, c, version, ['needs_review', 'reviewed']);
      await c.query(`UPDATE zakat_worksheet_revisions SET status='draft', reviewed_by_user_id=NULL, reviewed_at=NULL, version=version+1, updated_at=NOW() WHERE id=$1 AND company_id=$2`, [rev.id, company]);
      await this.log(c, company, actor, 'zakat_worksheet.return_to_draft', 'zakat_worksheet_revision', rev.id, { status: rev.status }, { status: 'draft', reason: reason.trim() });
    }).then(() => this.get(company, year));
  }

  /** Starts revision N+1 from the approved revision. The approved revision stays untouched until the new one is approved. */
  newRevision(company: string, year: string, actor: string, approvedVersion: number, reason: string) {
    if (!reason.trim()) throw new ZakatValidationError('A revision reason is required', 'ZAKAT_REASON_REQUIRED');
    return this.tx(async (c) => {
      const wp = await this.workpaper(company, year, c, true);
      if (!wp) throw new ZakatNotFoundError();
      const prev = (await c.query<Row>(`SELECT * FROM zakat_worksheet_revisions WHERE company_id=$1 AND workpaper_id=$2 AND status='approved' FOR UPDATE`, [company, wp.id])).rows[0];
      if (!prev) throw new ZakatConflictError('There is no approved revision to revise', 'ZAKAT_NO_APPROVED_REVISION');
      if (prev.version !== approvedVersion) throw new ZakatConflictError('Worksheet was modified', 'ZAKAT_STALE_VERSION');
      if ((await c.query(`SELECT 1 FROM zakat_worksheet_revisions WHERE workpaper_id=$1 AND status IN ('draft','needs_review','reviewed')`, [wp.id])).rowCount) throw new ZakatConflictError('A revision is already in progress', 'ZAKAT_REVISION_IN_PROGRESS');
      const no = Number((await c.query<{ n: string }>('SELECT (MAX(revision_no)+1)::text n FROM zakat_worksheet_revisions WHERE workpaper_id=$1', [wp.id])).rows[0]!.n);
      const bal = await loadBalanceSnapshot(company, year, c);
      const ownershipId = await this.captureOwnership(company, year, actor, c);
      const rev = (await c.query<Row>('INSERT INTO zakat_worksheet_revisions(company_id,fiscal_year_id,workpaper_id,revision_no,revision_reason,supersedes_id,non_financing_entity_declared,ownership_snapshot_id,balance_snapshot,balance_fingerprint,prepared_by_user_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id', [company, year, wp.id, no, reason.trim(), prev.id, prev.non_financing_entity_declared, ownershipId, JSON.stringify(bal.snapshot), bal.fingerprint, actor])).rows[0]!;
      await c.query(`INSERT INTO zakat_revision_classifications(company_id,revision_id,account_id,zakat_class,reg_article,evidence_document_id,note,status,confirmed_by_user_id,confirmed_at) SELECT company_id,$3,account_id,zakat_class,reg_article,evidence_document_id,note,status,confirmed_by_user_id,confirmed_at FROM zakat_revision_classifications WHERE company_id=$1 AND revision_id=$2`, [company, prev.id, rev.id]);
      await c.query(`INSERT INTO zakat_revision_adjustments(company_id,revision_id,description,direction,amount,reg_article,evidence_document_id,note,professional_review_required,created_by_user_id) SELECT company_id,$3,description,direction,amount,reg_article,evidence_document_id,note,professional_review_required,$4 FROM zakat_revision_adjustments WHERE company_id=$1 AND revision_id=$2`, [company, prev.id, rev.id, actor]);
      await this.seedSuggestions(company, rev.id, bal.snapshot, c);
      await this.log(c, company, actor, 'zakat_worksheet.revision.create', 'zakat_worksheet_revision', rev.id, null, { revision_no: no, supersedes_id: prev.id, reason: reason.trim() });
    }).then(() => this.get(company, year));
  }

  /** Read-only helper for the annual closing readiness/package: null when the company has no worksheet for the year. */
  async packageSummary(company: string, year: string, r: Runner, checkDrift = true): Promise<{ summary: Record<string, string | number | boolean>; blockers: string[] } | null> {
    const revs = await this.revisions(company, year, r);
    if (!revs.length) return null;
    const approved = revs.find((x) => x.status === 'approved') ?? null;
    const inProgress = revs.find((x) => ['draft', 'needs_review', 'reviewed'].includes(x.status)) ?? null;
    const blockers: string[] = [];
    if (!approved) blockers.push('zakat_worksheet_not_approved');
    if (inProgress) blockers.push('zakat_revision_in_progress');
    if (checkDrift && (approved ?? inProgress)) {
      const target = (approved ?? inProgress)!;
      const b = await this.blockersFor(company, year, target, r);
      if (b.source_drift) blockers.push('zakat_worksheet_source_drift');
      if (!approved) for (const x of b.blockers) if (x.code !== 'balance_source_drift' && x.code !== 'ownership_source_drift') blockers.push(x.code);
    }
    const own = approved?.approved_snapshot?.ownership;
    return {
      blockers: [...new Set(blockers)],
      summary: {
        zakat_worksheet_revision_no: approved?.revision_no ?? 0,
        zakat_worksheet_fingerprint: approved?.approved_fingerprint ?? '',
        zakat_ownership_fingerprint: own?.fingerprint ?? '',
        zakat_calculation_status: 'blocked',
      },
    };
  }
}
