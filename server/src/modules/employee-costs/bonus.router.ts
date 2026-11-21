import { resolveBankLedgerAccount } from '../accounting/personal-payment-posting';
import { randomUUID } from 'node:crypto';
import { hasPrivilegedFinancialAuthority } from '../memberships/privileged-financial-authority';
import { Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { AccountingPeriodClosedError } from '../monthly-close/accounting-period.guard';
import { FiscalYearClosedError, JournalPostingValidationError, LedgerSourceAuthorityBlockedError, postJournalInTransaction } from '../accounting/journal-posting';
import { isDate } from './employee-cost.service';

export const bonusRouter = Router();
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const audit = new AuditLogRepository();

bonusRouter.post('/employee-bonuses/:id/recognition',
  requireSameOrigin, requireAuth, requireActiveCompany,
  requireCapability('employee.view'), requireCapability('employee_cost.salary.view'),
  requireCapability('employee_cost.approve'), requireCapability('accounting.journal.post'),
  async (req, res, next) => {
    const auth = getAuthenticatedContext(req)!;
    const company = auth.activeCompanyId!;
    const actor = auth.user.id;
    const id = req.params.id;
    const body = req.body ?? {};
    const { fulfilled_on: fulfilled, accounting_date: date, expense_account_id: expense, liability_account_id: liability } = body;
    const evidence = typeof body.evidence === 'string' ? body.evidence.trim() : '';
    const reason = typeof body.date_reason === 'string' ? body.date_reason.trim() : '';
    if (!uuid.test(id) || typeof expense !== 'string' || !uuid.test(expense) ||
        typeof liability !== 'string' || !uuid.test(liability) || expense === liability ||
        !isDate(fulfilled) || !isDate(date) || date < fulfilled ||
        !evidence || evidence.length > 4000 || reason.length > 1000 || (date !== fulfilled && !reason)) {
      res.status(400).json({ code: 'BONUS_RECOGNITION_INVALID' });
      return;
    }
    if (!pool) { res.status(503).json({ code: 'DB_UNAVAILABLE' }); return; }
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`bonus-payroll-recognition:${company}`]);
        const entitlement = (await client.query<{ approved: boolean; amount: string; created_by:string; approved_by:string }>(
          'SELECT approved_at IS NOT NULL approved,amount::text,created_by,approved_by FROM employee_bonus_entitlements WHERE company_id=$1 AND id=$2 FOR UPDATE',
          [company, id],
        )).rows[0];
        if (!entitlement || !entitlement.approved || entitlement.amount === '0.00') {
          await client.query('ROLLBACK');
          res.status(entitlement ? 409 : 404).json({ code: 'BONUS_RECOGNITION_INELIGIBLE' });
          return;
        }
        const relatedActor = [entitlement.created_by,entitlement.approved_by].includes(actor);
        if (relatedActor && !(await hasPrivilegedFinancialAuthority(client,company,actor))) {
          await client.query('ROLLBACK');
          res.status(403).json({ code:'BONUS_RECOGNITION_SEPARATION_REQUIRED' });
          return;
        }
        const existing = (await client.query<{ journal_id: string; same: boolean }>(`
          SELECT journal_id, fulfilled_on=$3 AND accounting_date=$4 AND evidence=$5
            AND date_reason IS NOT DISTINCT FROM $6 AND expense_account_id=$7 AND liability_account_id=$8 AS same
          FROM employee_bonus_recognitions WHERE company_id=$1 AND entitlement_id=$2
        `, [company, id, fulfilled, date, evidence, reason || null, expense, liability])).rows[0];
        if (existing) {
          await client.query('COMMIT');
          res.status(existing.same ? 200 : 409).json(existing.same ? { journal_id: existing.journal_id } : { code: 'BONUS_ALREADY_RECOGNIZED' });
          return;
        }
        const year = await client.query<{ id: string }>(`
          SELECT id FROM fiscal_years WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date
            AND $2::date<=CURRENT_DATE ORDER BY id FOR SHARE
        `, [company, date]);
        if (year.rows.length !== 1) {
          await client.query('ROLLBACK');
          res.status(409).json({ code: 'BONUS_PERIOD_INELIGIBLE' });
          return;
        }
        const accounts = await client.query(`
          SELECT id FROM accounts WHERE company_id=$1 AND is_active
            AND ((id=$2 AND account_type='expense') OR (id=$3 AND account_type='liability'))
          ORDER BY id FOR SHARE
        `, [company, expense, liability]);
        if (accounts.rows.length !== 2) {
          await client.query('ROLLBACK');
          res.status(409).json({ code: 'BONUS_ACCOUNTS_INELIGIBLE' });
          return;
        }
        const journal = (await client.query<{ id: string }>(`
          INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,source_type,source_id,created_by)
          VALUES($1,$2,$3,'Employee bonus recognition','employee_bonus_recognition',$4,$5) RETURNING id
        `, [company, year.rows[0]!.id, date, id, actor])).rows[0]!.id;
        await client.query(`
          INSERT INTO employee_bonus_recognitions(company_id,entitlement_id,journal_id,verified_by,fulfilled_on,
            accounting_date,evidence,date_reason,expense_account_id,liability_account_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        `, [company, id, journal, actor, fulfilled, date, evidence, reason || null, expense, liability]);
        await client.query(`
          INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence)
          VALUES($1,$2,$3,$5,0,1),($1,$2,$4,0,$5,2)
        `, [company, journal, expense, liability, entitlement.amount]);
        await postJournalInTransaction(client, company, actor, journal, { bonusRecognitionId: id });
        await audit.logEvent({
          company_id: company, actor_user_id: actor, action: 'employee_bonus.recognize',
          entity_type: 'employee_bonus_entitlement', entity_id: id,
          after_data: { journal_id: journal, fulfilled_on: fulfilled, accounting_date: date, privileged_role_override: relatedActor },
          reason: reason || undefined,
        }, client);
        await client.query('COMMIT');
        res.status(201).json({ journal_id: journal });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (error instanceof FiscalYearClosedError || error instanceof AccountingPeriodClosedError ||
          error instanceof LedgerSourceAuthorityBlockedError || error instanceof JournalPostingValidationError) {
        res.status(409).json({ code: 'BONUS_RECOGNITION_BLOCKED' });
      } else {
        next(error);
      }
    }
  });

bonusRouter.post('/employee-bonuses/:id/adjustments',
  requireSameOrigin, requireAuth, requireActiveCompany,
  requireCapability('employee.view'), requireCapability('employee_cost.salary.view'),
  requireCapability('employee_cost.correct'), requireCapability('employee_cost.approve'),
  requireCapability('accounting.journal.post'),
  async (req, res, next) => {
    const auth = getAuthenticatedContext(req)!;
    const company = auth.activeCompanyId!;
    const actor = auth.user.id;
    const id = req.params.id;
    const { kind, amount, accounting_date: date, idempotency_key: key } = req.body ?? {};
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (!uuid.test(id) || typeof key !== 'string' || !uuid.test(key) ||
        (kind !== 'increase' && kind !== 'decrease') || !isDate(date) ||
        typeof amount !== 'string' || !/^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/.test(amount) ||
        /^0(?:\.0{1,2})?$/.test(amount) || !reason || reason.length > 1000) {
      res.status(400).json({ code: 'BONUS_ADJUSTMENT_INVALID' });
      return;
    }
    if (!pool) { res.status(503).json({ code: 'DB_UNAVAILABLE' }); return; }
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const recognized = (await client.query<{
          expense_account_id: string; liability_account_id: string; verified_by: string;
          approved_by: string; created_by: string;
        }>(`
          SELECT r.expense_account_id,r.liability_account_id,r.verified_by,e.approved_by,e.created_by
          FROM employee_bonus_recognitions r JOIN employee_bonus_entitlements e
            ON e.company_id=r.company_id AND e.id=r.entitlement_id
          WHERE r.company_id=$1 AND r.entitlement_id=$2 AND r.accounting_date<=$3
        `, [company,id,date])).rows[0];
        if (!recognized) {
          await client.query('ROLLBACK');
          res.status(404).json({ code: 'BONUS_RECOGNITION_NOT_FOUND' });
          return;
        }
        if ([recognized.verified_by,recognized.approved_by,recognized.created_by].includes(actor) &&
            !(await hasPrivilegedFinancialAuthority(client,company,actor))) {
          await client.query('ROLLBACK');
          res.status(403).json({ code: 'BONUS_ADJUSTMENT_SEPARATION_REQUIRED' });
          return;
        }
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`bonus-adjustment:${company}:${key}`]);
        const existing = (await client.query<{ journal_id: string; same: boolean }>(`
          SELECT b.journal_id, (b.entitlement_id=$3 AND b.kind=$4 AND b.amount=$5::numeric
            AND b.adjustment_reason=$6 AND j.accounting_date=$7 AND b.created_by=$8) IS TRUE AS same
          FROM employee_bonus_balance_entries b JOIN journal_entries j
            ON j.company_id=b.company_id AND j.id=b.journal_id
          WHERE b.company_id=$1 AND b.idempotency_key=$2
        `, [company,key,id,kind,amount,reason,date,actor])).rows[0];
        if (existing) {
          await client.query('COMMIT');
          res.status(existing.same ? 200 : 409).json(existing.same ? { journal_id: existing.journal_id } : { code: 'BONUS_ADJUSTMENT_CONFLICT' });
          return;
        }
        const years = await client.query<{ id: string }>(`
          SELECT id FROM fiscal_years WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date
            AND $2::date<=CURRENT_DATE ORDER BY id FOR SHARE
        `, [company,date]);
        if (years.rows.length !== 1) {
          await client.query('ROLLBACK');
          res.status(409).json({ code: 'BONUS_PERIOD_INELIGIBLE' });
          return;
        }
        const entry = randomUUID();
        const journal = (await client.query<{ id: string }>(`
          INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,source_type,source_id,created_by)
          VALUES($1,$2,$3,'Employee bonus adjustment','employee_bonus_adjustment',$4,$5) RETURNING id
        `, [company,years.rows[0]!.id,date,entry,actor])).rows[0]!.id;
        await client.query(`
          INSERT INTO employee_bonus_balance_entries(id,company_id,entitlement_id,journal_id,idempotency_key,kind,amount,created_by,adjustment_reason)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
        `, [entry,company,id,journal,key,kind,amount,actor,reason]);
        const debit = kind === 'increase' ? recognized.expense_account_id : recognized.liability_account_id;
        const credit = kind === 'increase' ? recognized.liability_account_id : recognized.expense_account_id;
        await client.query(`
          INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence)
          VALUES($1,$2,$3,$5,0,1),($1,$2,$4,0,$5,2)
        `, [company,journal,debit,credit,amount]);
        await postJournalInTransaction(client,company,actor,journal,{ bonusAdjustmentId: entry });
        await audit.logEvent({
          company_id:company,actor_user_id:actor,action:'employee_bonus.adjust',
          entity_type:'employee_bonus_entitlement',entity_id:id,
          after_data:{ journal_id:journal,kind,amount,accounting_date:date },reason,
        },client);
        await client.query('COMMIT');
        res.status(201).json({ journal_id:journal });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      if (error instanceof FiscalYearClosedError || error instanceof AccountingPeriodClosedError ||
          error instanceof LedgerSourceAuthorityBlockedError || error instanceof JournalPostingValidationError ||
          ['23505','23514'].includes((error as { code?:string }).code ?? '')) {
        res.status(409).json({ code:'BONUS_ADJUSTMENT_BLOCKED' });
      } else {
        next(error);
      }
    }
  });

bonusRouter.get('/employee-bonuses',
  requireAuth, requireActiveCompany, requireCapability('employee.view'),
  requireCapability('employee_cost.view'), requireCapability('employee_cost.salary.view'),
  async (req, res, next) => {
    if (!pool) { res.status(503).json({ code:'DB_UNAVAILABLE' }); return; }
    try {
      const company = getAuthenticatedContext(req)!.activeCompanyId!;
      const result = await pool.query(`
        SELECT e.id,e.employee_id,p.display_name,e.award_code,e.frequency,e.period_start::text,e.period_end::text,
          e.calculation_method,e.amount::text,e.approved_at,r.fulfilled_on::text,r.accounting_date::text,
          (SELECT l.id FROM journal_lines l WHERE l.company_id=r.company_id AND l.journal_entry_id=r.journal_id
            AND l.account_id=r.liability_account_id AND l.credit>0) AS liability_line_id,
          CASE WHEN r.journal_id IS NULL THEN NULL ELSE
            (e.amount+COALESCE(b.adjustments,0)-COALESCE(b.settled,0))::text END AS outstanding,
          COALESCE(b.pending,0)::numeric(18,2)::text AS pending_payroll,
          COALESCE(b.settled,0)::numeric(18,2)::text AS settled,
          COALESCE((SELECT json_agg(json_build_object('id',s.id,'due_on',s.due_on,'amount',s.amount::text,
            'channel',s.channel) ORDER BY s.due_on,s.id) FROM employee_bonus_payment_schedule s
            WHERE s.company_id=e.company_id AND s.entitlement_id=e.id),'[]') AS schedule
        FROM employee_bonus_entitlements e
        JOIN employees p ON p.id=e.employee_id AND p.company_id=e.company_id
        LEFT JOIN employee_bonus_recognitions r ON r.entitlement_id=e.id AND r.company_id=e.company_id
        LEFT JOIN LATERAL (
          SELECT sum(CASE WHEN kind='increase' THEN amount WHEN kind='decrease' THEN -amount ELSE 0 END) adjustments,
            sum(CASE WHEN x.kind='bank' OR (x.kind='payroll' AND paid.complete) THEN x.amount
              WHEN x.kind='reversal' THEN -x.amount ELSE 0 END) settled,
            sum(CASE WHEN x.kind='payroll' AND NOT COALESCE(paid.complete,false) THEN x.amount ELSE 0 END) pending
          FROM employee_bonus_balance_entries x
          LEFT JOIN LATERAL (
            SELECT sum(s.amount)=l.credit complete
            FROM journal_lines l
            JOIN payroll_settlement_allocations s ON s.company_id=l.company_id AND s.liability_line_id=l.id
            JOIN journal_entries j ON j.company_id=s.company_id AND j.id=s.journal_entry_id AND j.status='posted'
            WHERE l.company_id=x.company_id AND l.journal_entry_id=x.journal_id AND l.memo='net_payroll_liability'
            GROUP BY l.id
          ) paid ON x.kind='payroll'
          WHERE x.company_id=e.company_id AND x.entitlement_id=e.id
        ) b ON true
        WHERE e.company_id=$1
        ORDER BY e.period_start DESC,p.display_name,e.id
      `, [company]);
      res.json({ bonuses:result.rows });
    } catch (error) { next(error); }
  });

const decimal = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,2})?$/;
const factor = /^(?:0|[1-9]\d{0,15})(?:\.\d{1,4})?$/;
const textWithin = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;

bonusRouter.post('/employee-bonuses',
  requireSameOrigin, requireAuth, requireActiveCompany, requireCapability('employee.view'),
  requireCapability('employee_cost.salary.view'), requireCapability('employee_cost.create'),
  async (req, res, next) => {
    const auth = getAuthenticatedContext(req)!;
    const { request_key: key, frequency, period_start: start, period_end: end,
      eligibility_condition: eligibility, recognition_condition: condition, employees, award_code: awardCode = 'standard' } = req.body ?? {};
    if (typeof awardCode !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,49}$/.test(awardCode) ||
        typeof key !== 'string' || !uuid.test(key) ||
        !['monthly','quarterly','annual','one_time'].includes(frequency) ||
        !isDate(start) || !isDate(end) || end < start || !textWithin(eligibility,1000) || !textWithin(condition,1000) ||
        !Array.isArray(employees) || !employees.length || employees.length>100 || employees.some(e =>
          !e || typeof e.employee_id!=='string' || !uuid.test(e.employee_id) ||
          !['fixed','basic_multiplier','total_multiplier','percentage'].includes(e.method) ||
          (e.method==='percentage' ? !['basic','total'].includes(e.basis) : e.basis!=null) ||
          typeof e.value!=='string' || !factor.test(e.value) ||
          (e.method==='fixed' && !decimal.test(e.value)) ||
          typeof e.basic_salary!=='string' || !decimal.test(e.basic_salary) ||
          typeof e.allowances!=='string' || !decimal.test(e.allowances)) ||
        new Set(employees.map(e=>e.employee_id.toLowerCase())).size!==employees.length) {
      res.status(400).json({ code:'BONUS_DRAFT_INVALID' });
      return;
    }
    if (!pool) { res.status(503).json({ code:'DB_UNAVAILABLE' }); return; }
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const records = [];
        for (const employee of employees) {
          const record = (await client.query<{id:string; amount:string}>(`
            INSERT INTO employee_bonus_entitlements(company_id,employee_id,request_key,frequency,period_start,period_end,
              eligibility_condition,recognition_condition,calculation_method,percentage_basis,calculation_value,
              basic_salary,applicable_allowances,created_by,award_code)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id,amount::text
          `, [auth.activeCompanyId,employee.employee_id,key,frequency,start,end,eligibility.trim(),condition.trim(),
            employee.method,employee.basis??null,employee.value,employee.basic_salary,employee.allowances,auth.user.id,awardCode])).rows[0]!;
          await audit.logEvent({
            company_id:auth.activeCompanyId!,actor_user_id:auth.user.id,action:'employee_bonus.create',
            entity_type:'employee_bonus_entitlement',entity_id:record.id,after_data:{request_key:key},
          },client);
          records.push(record);
        }
        await client.query('COMMIT');
        res.status(201).json({ bonuses:records });
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    } catch (error) {
      if (['22003','23503','23505','23514'].includes((error as {code?:string}).code ?? '')) {
        res.status(409).json({ code:'BONUS_DRAFT_CONFLICT' });
      } else next(error);
    }
  });

bonusRouter.post('/employee-bonuses/:id/approval',
  requireSameOrigin, requireAuth, requireActiveCompany, requireCapability('employee.view'),
  requireCapability('employee_cost.salary.view'), requireCapability('employee_cost.approve'),
  async (req,res,next) => {
    const auth=getAuthenticatedContext(req)!;
    const id=req.params.id;
    if (!uuid.test(id)) { res.status(400).json({code:'BONUS_DRAFT_INVALID'}); return; }
    if (!pool) { res.status(503).json({code:'DB_UNAVAILABLE'}); return; }
    try {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const row=(await client.query<{created_by:string; approved_at:string|null; amount:string}>(`
          SELECT created_by,approved_at,amount::text FROM employee_bonus_entitlements
          WHERE company_id=$1 AND id=$2 FOR UPDATE
        `,[auth.activeCompanyId,id])).rows[0];
        if (!row || row.approved_at) {
          await client.query('ROLLBACK');
          res.status(row ? 409 : 404).json({code:'BONUS_APPROVAL_INELIGIBLE'});
          return;
        }
        if (row.created_by===auth.user.id && !(await hasPrivilegedFinancialAuthority(client,auth.activeCompanyId!,auth.user.id))) {
          await client.query('ROLLBACK');
          res.status(403).json({code:'BONUS_APPROVAL_SEPARATION_REQUIRED'});
          return;
        }
        await client.query('UPDATE employee_bonus_entitlements SET approved_by=$3,approved_at=now() WHERE company_id=$1 AND id=$2',
          [auth.activeCompanyId,id,auth.user.id]);
        await audit.logEvent({company_id:auth.activeCompanyId!,actor_user_id:auth.user.id,
          action:'employee_bonus.approve',entity_type:'employee_bonus_entitlement',entity_id:id,
          after_data:{amount:row.amount}},client);
        await client.query('COMMIT');
        res.json({id,amount:row.amount});
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    } catch (error) { next(error); }
  });

bonusRouter.post('/employee-bonuses/:id/schedule',
  requireSameOrigin, requireAuth, requireActiveCompany, requireCapability('employee.view'),
  requireCapability('employee_cost.salary.view'), requireCapability('employee_cost.payment.allocate'),
  async (req,res,next) => {
    const auth=getAuthenticatedContext(req)!;
    const id=req.params.id;
    const { request_key:key, due_on:date, amount, channel }=req.body??{};
    if (!uuid.test(id) || typeof key!=='string' || !uuid.test(key) || !isDate(date) ||
        typeof amount!=='string' || !decimal.test(amount) || /^0(?:\.0{1,2})?$/.test(amount) ||
        !['payroll','bank'].includes(channel)) {
      res.status(400).json({code:'BONUS_SCHEDULE_INVALID'}); return;
    }
    if (!pool) { res.status(503).json({code:'DB_UNAVAILABLE'}); return; }
    try {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const entitlement=(await client.query(`
          SELECT 1 FROM employee_bonus_entitlements WHERE company_id=$1 AND id=$2
            AND approved_at IS NOT NULL AND amount>0 FOR UPDATE
        `,[auth.activeCompanyId,id])).rows[0];
        if (!entitlement) {
          await client.query('ROLLBACK');
          res.status(409).json({code:'BONUS_SCHEDULE_INELIGIBLE'}); return;
        }
        const existing=(await client.query<{id:string;same:boolean}>(`
          SELECT id,due_on=$4 AND amount=$5::numeric AND channel=$6 AND created_by=$7 AS same
          FROM employee_bonus_payment_schedule WHERE company_id=$1 AND entitlement_id=$2 AND request_key=$3
        `,[auth.activeCompanyId,id,key,date,amount,channel,auth.user.id])).rows[0];
        if (existing) {
          await client.query('COMMIT');
          res.status(existing.same?200:409).json(existing.same?{id:existing.id}:{code:'BONUS_SCHEDULE_CONFLICT'}); return;
        }
        const saved=(await client.query<{id:string}>(`
          INSERT INTO employee_bonus_payment_schedule(company_id,entitlement_id,request_key,due_on,amount,channel,created_by)
          SELECT $1,$2,$3,$4,$5,$6,$7
          FROM employee_bonus_entitlements e
          WHERE e.company_id=$1 AND e.id=$2 AND $5::numeric+COALESCE((
            SELECT sum(s.amount) FROM employee_bonus_payment_schedule s WHERE s.company_id=$1 AND s.entitlement_id=$2
          ),0)<=e.amount RETURNING id
        `,[auth.activeCompanyId,id,key,date,amount,channel,auth.user.id])).rows[0];
        if (!saved) {
          await client.query('ROLLBACK');
          res.status(409).json({code:'BONUS_SCHEDULE_EXCEEDS_APPROVED'}); return;
        }
        await audit.logEvent({company_id:auth.activeCompanyId!,actor_user_id:auth.user.id,
          action:'employee_bonus.schedule',entity_type:'employee_bonus_entitlement',entity_id:id,
          after_data:{schedule_id:saved.id,due_on:date,amount,channel}},client);
        await client.query('COMMIT');
        res.status(201).json(saved);
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    } catch (error) { next(error); }
  });

bonusRouter.post('/employee-bonuses/:id/bank-reversals',
  requireSameOrigin, requireAuth, requireActiveCompany, requireCapability('employee.view'),
  requireCapability('employee_cost.salary.view'), requireCapability('employee_cost.payment.reverse'),
  requireCapability('bank.view'), requireCapability('bank.reconcile'), requireCapability('accounting.journal.post'),
  async (req,res,next) => {
    const auth=getAuthenticatedContext(req)!;
    const company=auth.activeCompanyId!;
    const actor=auth.user.id;
    const id=req.params.id;
    const { payment_id: payment, bank_transaction_id: bank, idempotency_key: key, amount, reason }=req.body??{};
    if (![id,payment,bank,key].every(value=>typeof value==='string'&&uuid.test(value)) ||
        typeof amount!=='string' || !decimal.test(amount) || Number(amount)<=0 || !textWithin(reason,1000)) {
      res.status(400).json({code:'BONUS_REVERSAL_INVALID'}); return;
    }
    if (!pool) { res.status(503).json({code:'DB_UNAVAILABLE'}); return; }
    try {
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        const original=(await client.query<{ account_id:string; transaction_date:string; created_by:string; payroll_journal_id:string|null; employee_id:string; net:string|null }>(`
          SELECT r.liability_account_id account_id,COALESCE(t.transaction_date,paid.last_paid)::text transaction_date,
            b.created_by,e.employee_id,CASE WHEN b.kind='payroll' THEN j.id END payroll_journal_id,
            (line.salary+line.allowances+line.bonus+line.overtime-line.deductions-COALESCE(recovery.amount,0))::text net
          FROM employee_bonus_balance_entries b
          JOIN employee_bonus_recognitions r USING(company_id,entitlement_id)
          JOIN employee_bonus_entitlements e ON e.company_id=b.company_id AND e.id=b.entitlement_id
          JOIN journal_entries j ON j.company_id=b.company_id AND j.id=b.journal_id AND j.status='posted'
          LEFT JOIN payroll_settlement_allocations p ON p.company_id=b.company_id AND p.journal_entry_id=b.journal_id
          LEFT JOIN bank_transactions t ON t.company_id=p.company_id AND t.id=p.bank_transaction_id
          LEFT JOIN payroll_draft_employees line ON j.source_type='payroll' AND line.company_id=j.company_id
            AND line.draft_id=j.source_id AND line.employee_id=e.employee_id
          LEFT JOIN LATERAL (
            SELECT sum(a.amount) amount FROM payroll_employee_advance_recoveries a
            WHERE a.company_id=line.company_id AND a.draft_id=line.draft_id AND a.employee_id=line.employee_id AND a.status='posted'
          ) recovery ON true
          LEFT JOIN LATERAL (
            SELECT max(tx.transaction_date) last_paid FROM journal_lines net
            JOIN payroll_settlement_allocations paid ON paid.company_id=net.company_id AND paid.liability_line_id=net.id
            JOIN journal_entries sj ON sj.company_id=paid.company_id AND sj.id=paid.journal_entry_id AND sj.status='posted'
            JOIN bank_transactions tx ON tx.company_id=paid.company_id AND tx.id=paid.bank_transaction_id
            WHERE net.company_id=j.company_id AND net.journal_entry_id=j.id AND net.memo='net_payroll_liability'
            GROUP BY net.id HAVING sum(paid.amount)=net.credit
          ) paid ON b.kind='payroll'
          WHERE b.company_id=$1 AND b.entitlement_id=$2 AND b.id=$3
            AND ((b.kind='bank' AND t.id IS NOT NULL) OR (b.kind='payroll' AND line.id IS NOT NULL AND paid.last_paid IS NOT NULL))
        `,[company,id,payment])).rows[0];
        if (!original) { await client.query('ROLLBACK'); res.status(404).json({code:'BONUS_PAYMENT_NOT_FOUND'}); return; }
        if (original.created_by===actor && !(await hasPrivilegedFinancialAuthority(client,company,actor))) {
          await client.query('ROLLBACK'); res.status(403).json({code:'BONUS_REVERSAL_SEPARATION_REQUIRED'}); return;
        }
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`bonus-reversal:${company}:${key}`]);
        const prior=(await client.query<{journal_id:string;same:boolean}>(`
          SELECT b.journal_id,(b.kind='reversal' AND b.entitlement_id=$3 AND b.reverses_id=$4 AND
            b.amount=$5::numeric AND b.adjustment_reason=$6 AND b.created_by=$7 AND EXISTS (
              SELECT 1 FROM journal_lines l WHERE l.company_id=b.company_id AND l.journal_entry_id=b.journal_id
                AND l.bank_transaction_id=$8)) IS TRUE AS same
          FROM employee_bonus_balance_entries b WHERE b.company_id=$1 AND b.idempotency_key=$2
        `,[company,key,id,payment,amount,reason.trim(),actor,bank])).rows[0];
        if (prior) {
          await client.query('COMMIT');
          res.status(prior.same?200:409).json(prior.same?{journal_id:prior.journal_id}:{code:'BONUS_REVERSAL_CONFLICT'}); return;
        }
        if (original.payroll_journal_id) {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
            [`payroll-bonus-refund:${company}:${original.payroll_journal_id}:${original.employee_id}`]);
          const remaining = (await client.query<{valid:boolean}>(`
            SELECT $4::numeric+COALESCE(sum(refund.amount),0)<=$5::numeric AS valid
            FROM employee_bonus_balance_entries refund
            JOIN employee_bonus_balance_entries paid ON paid.company_id=refund.company_id AND paid.id=refund.reverses_id
            JOIN employee_bonus_entitlements e ON e.company_id=paid.company_id AND e.id=paid.entitlement_id
            WHERE refund.company_id=$1 AND paid.journal_id=$2 AND e.employee_id=$3 AND refund.kind='reversal'
          `,[company,original.payroll_journal_id,original.employee_id,amount,original.net])).rows[0];
          if (!remaining?.valid) {
            await client.query('ROLLBACK'); res.status(409).json({code:'BONUS_REFUND_EXCEEDS_PAYROLL_NET'}); return;
          }
        }
        const refund=(await client.query<{transaction_date:string;bank_account_id:string}>(`
          SELECT transaction_date::text,bank_account_id FROM bank_transactions WHERE company_id=$1 AND id=$2
            AND amount=$3::numeric AND currency_code='SAR' AND transaction_date >= $4
            AND reconciliation_status<>'reconciled' AND manual_journal_binding_protected
        `,[company,bank,amount,original.transaction_date])).rows[0];
        if (!refund) { await client.query('ROLLBACK'); res.status(409).json({code:'BONUS_REFUND_INELIGIBLE'}); return; }
        const year=(await client.query<{id:string}>(`
          SELECT id FROM fiscal_years WHERE company_id=$1 AND $2::date BETWEEN start_date AND end_date
            AND status='open' AND $2::date<=CURRENT_DATE FOR SHARE
        `,[company,refund.transaction_date])).rows;
        if (year.length!==1) { await client.query('ROLLBACK'); res.status(409).json({code:'BONUS_PERIOD_INELIGIBLE'}); return; }
        const verifiedRefund = await client.query(`
          SELECT 1 FROM bank_transactions WHERE company_id=$1 AND id=$2 AND amount=$3::numeric
            AND transaction_date=$4 AND bank_account_id=$5 AND currency_code='SAR'
            AND reconciliation_status<>'reconciled' AND manual_journal_binding_protected FOR UPDATE
        `,[company,bank,amount,refund.transaction_date,refund.bank_account_id]);
        if (!verifiedRefund.rowCount) {
          await client.query('ROLLBACK'); res.status(409).json({code:'BONUS_REFUND_INELIGIBLE'}); return;
        }
        const account=await resolveBankLedgerAccount(client,company,refund.bank_account_id,refund.transaction_date,true);
        if (!account || account===original.account_id) {
          await client.query('ROLLBACK'); res.status(409).json({code:'BONUS_REFUND_INELIGIBLE'}); return;
        }
        const journal=(await client.query<{id:string}>(`
          INSERT INTO journal_entries(company_id,fiscal_year_id,accounting_date,description,created_by)
          VALUES($1,$2,$3,'Employee bonus refund',$4) RETURNING id
        `,[company,year[0]!.id,refund.transaction_date,actor])).rows[0]!.id;
        await client.query(`
          INSERT INTO journal_lines(company_id,journal_entry_id,account_id,debit,credit,sequence,bank_transaction_id)
          VALUES($1,$2,$3,$5,0,1,$6),($1,$2,$4,0,$5,2,NULL)
        `,[company,journal,account,original.account_id,amount,bank]);
        // Canonical bank ownership checks run while posting the bank-bound journal.
        await postJournalInTransaction(client,company,actor,journal);
        await client.query(`
          INSERT INTO employee_bonus_balance_entries(company_id,entitlement_id,journal_id,idempotency_key,
            kind,amount,reverses_id,created_by,adjustment_reason)
          VALUES($1,$2,$3,$4,'reversal',$5,$6,$7,$8)
        `,[company,id,journal,key,amount,payment,actor,reason.trim()]);
        await audit.logEvent({company_id:company,actor_user_id:actor,action:original.payroll_journal_id?'employee_bonus.reverse_payroll_payment':'employee_bonus.reverse_bank_payment',
          entity_type:'employee_bonus_entitlement',entity_id:id,reason:reason.trim(),
          after_data:{payment_id:payment,bank_transaction_id:bank,journal_id:journal,amount}},client);
        await client.query('COMMIT');
        res.status(201).json({journal_id:journal});
      } catch (error) { await client.query('ROLLBACK'); throw error; }
      finally { client.release(); }
    } catch (error) {
      if (error instanceof FiscalYearClosedError || error instanceof AccountingPeriodClosedError ||
          error instanceof LedgerSourceAuthorityBlockedError || error instanceof JournalPostingValidationError ||
          ['23505','23514'].includes((error as {code?:string}).code??'')) {
        res.status(409).json({code:'BONUS_REVERSAL_BLOCKED'});
      } else next(error);
    }
  });
