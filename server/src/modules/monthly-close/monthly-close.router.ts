import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool, PoolClient } from 'pg';
import pool from '../../db/pool';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { lockAccountingRange } from './accounting-period.guard';
import { VatService } from '../vat/vat.router';
import { loadOperationalSources } from '../accounting/operational-sources';

export const monthlyCloseRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
type Period = { id:string; company_id:string; fiscal_year_id:string; period_start:string; period_end:string; status:'open'|'closed'; created_at:Date; updated_at:Date };
type Blockers = { documents:number; obligations:number; bank_transactions:number; vat:number; ledger:number; assets:number; opening_balances:number; periodic_adjustments:number; total:number };
export class MonthlyCloseValidationError extends Error {}
export class MonthlyCloseNotFoundError extends Error {}
export class MonthlyCloseConflictError extends Error { constructor(message='Conflict'){super(message);} }
const route=(handler:(req:Request,res:Response)=>Promise<void>):RequestHandler=>(req,res,next:NextFunction)=>void handler(req,res).catch(next);
const context=(req:Request)=>getAuthenticatedContext(req)! as ReturnType<typeof getAuthenticatedContext>&{activeCompanyId:string};

function validDate(value:unknown): value is string { return typeof value==='string'&&DATE.test(value)&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`)); }
function parseCreate(body:unknown){if(!body||typeof body!=='object'||Array.isArray(body))return null;const x=body as Record<string,unknown>;if(Object.keys(x).some(k=>!['fiscal_year_id','period_start','period_end'].includes(k))||typeof x.fiscal_year_id!=='string'||!UUID.test(x.fiscal_year_id)||!validDate(x.period_start)||!validDate(x.period_end)||x.period_end<x.period_start)return null;return{fiscalYearId:x.fiscal_year_id,start:x.period_start,end:x.period_end};}
function parseReason(body:unknown){if(!body||typeof body!=='object'||Array.isArray(body))return null;const x=body as Record<string,unknown>;if(Object.keys(x).length!==1||typeof x.reason!=='string')return null;const reason=x.reason.trim();return reason&&reason.length<=500?reason:null;}
function expectedMonthlyBounds(start:string,fiscalStart:string,fiscalEnd:string){const date=new Date(`${start}T00:00:00Z`);const monthStart=`${start.slice(0,7)}-01`;date.setUTCMonth(date.getUTCMonth()+1,0);const monthEnd=date.toISOString().slice(0,10);return{start:fiscalStart>monthStart?fiscalStart:monthStart,end:fiscalEnd<monthEnd?fiscalEnd:monthEnd};}

export class MonthlyCloseService {
  private audit=new AuditLogRepository();
  constructor(private db:Pool){}
  private async tx<T>(fn:(client:PoolClient)=>Promise<T>){const client=await this.db.connect();try{await client.query('BEGIN');const result=await fn(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');if((error as {code?:string}).code==='23505')throw new MonthlyCloseConflictError('Monthly close period overlaps an existing period');throw error;}finally{client.release();}}
  private async incompleteMaterialDocuments(companyId:string,start:string,end:string,client:PoolClient|Pool){
    const {rows}=await client.query<{id:string}>(`WITH material AS (
      SELECT d.id,d.document_type,d.document_date,d.total_amount,r.review_status,r.vat_amount
      FROM documents d LEFT JOIN document_vat_reviews r ON r.document_id=d.id AND r.company_id=d.company_id
      WHERE d.company_id=$1 AND d.status='approved' AND d.document_type IN ('sale','purchase','expense') AND d.document_date BETWEEN $2 AND $3
    ), obligation_path AS (
      SELECT m.id document_id,o.id source_id,EXISTS(SELECT 1 FROM journal_entries j WHERE j.company_id=$1 AND j.source_type='obligation' AND j.source_id=o.id AND j.status='posted') posted
      FROM material m JOIN obligations o ON o.document_id=m.id AND o.company_id=$1 AND o.source_type='document' AND o.verification_status='confirmed' AND NOT o.is_cancelled
       AND o.direction=CASE WHEN m.document_type='sale' THEN 'receivable' ELSE 'payable' END AND o.recognized_on=m.document_date AND o.original_amount=m.total_amount
    ), custody_path AS (
      SELECT m.id document_id,SUM(a.amount)=m.total_amount amount_ok,BOOL_AND(j.id IS NOT NULL) posted
      FROM material m JOIN custody_document_allocations a ON a.document_id=m.id AND a.company_id=$1
      LEFT JOIN journal_entries j ON j.company_id=a.company_id AND j.source_type='custody_allocation' AND j.source_id=a.id AND j.status='posted'
      WHERE m.document_type='expense' GROUP BY m.id,m.total_amount
    ), recognition AS (
      SELECT m.id,m.document_type,m.review_status,m.vat_amount,
       CASE WHEN m.document_type='expense' THEN ((op.document_id IS NOT NULL)::int+(cp.document_id IS NOT NULL)::int)=1 AND COALESCE(op.posted,cp.amount_ok AND cp.posted,FALSE)
            ELSE op.document_id IS NOT NULL AND op.posted END recognition_ok
      FROM material m LEFT JOIN obligation_path op ON op.document_id=m.id LEFT JOIN custody_path cp ON cp.document_id=m.id
    ), recognition_journals AS (
      SELECT o.document_id,j.id journal_id FROM obligations o JOIN journal_entries j ON j.company_id=o.company_id AND j.source_type='obligation' AND j.source_id=o.id AND j.status='posted' WHERE o.company_id=$1
      UNION ALL
      SELECT a.document_id,j.id FROM custody_document_allocations a JOIN journal_entries j ON j.company_id=a.company_id AND j.source_type='custody_allocation' AND j.source_id=a.id AND j.status='posted' WHERE a.company_id=$1
    ), vat_lines AS (
      SELECT r.id document_id,
       COALESCE(SUM(CASE WHEN r.document_type='sale' AND l.memo='VAT_OUTPUT' AND a.account_type='liability' AND l.debit=0 THEN l.credit WHEN r.document_type<>'sale' AND l.memo='VAT_INPUT' AND a.account_type='asset' AND l.credit=0 THEN l.debit ELSE 0 END),0) vat_covered,
       COUNT(*) FILTER(WHERE l.memo IN ('VAT_INPUT','VAT_OUTPUT') AND NOT ((r.document_type='sale' AND l.memo='VAT_OUTPUT' AND a.account_type='liability' AND l.debit=0) OR (r.document_type<>'sale' AND l.memo='VAT_INPUT' AND a.account_type='asset' AND l.credit=0))) invalid_lines
      FROM recognition r LEFT JOIN recognition_journals rj ON rj.document_id=r.id LEFT JOIN journal_lines l ON l.journal_entry_id=rj.journal_id AND l.company_id=$1 LEFT JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id GROUP BY r.id
    )
    SELECT r.id FROM recognition r LEFT JOIN vat_lines v ON v.document_id=r.id
    WHERE NOT r.recognition_ok OR (r.review_status='reviewed' AND r.vat_amount>0 AND (v.vat_covered<>r.vat_amount OR v.invalid_lines<>0))`,[companyId,start,end]);
    return new Set(rows.map(row=>row.id));
  }
  private async blockers(companyId:string,fiscalYearId:string,start:string,end:string,client:PoolClient|Pool=this.db):Promise<Blockers>{
    const {rows}=await client.query<{documents:string;obligations:string;bank_transactions:string;opening_balances:string;periodic_adjustments:string}>(`SELECT
      (SELECT COUNT(*) FROM documents WHERE company_id=$1 AND document_date BETWEEN $2 AND $3 AND status IN ('uploaded','needs_review','incomplete'))::text documents,
      (SELECT COUNT(*) FROM obligations WHERE company_id=$1 AND recognized_on BETWEEN $2 AND $3 AND NOT is_cancelled AND verification_status='unconfirmed')::text obligations,
      (SELECT COUNT(*) FROM opening_balance_reviews WHERE company_id=$1 AND fiscal_year_id=$4 AND status<>'approved')::text opening_balances,
      (SELECT COUNT(DISTINCT adjustment_id) FROM (
        SELECT a.id adjustment_id
        FROM periodic_adjustments a
        WHERE a.company_id=$1 AND a.workflow_status IN ('draft','in_review')
          AND a.recognition_start <= $3 AND a.recognition_end >= $2
        UNION ALL
        SELECT s.adjustment_id
        FROM periodic_adjustment_schedule s
        JOIN periodic_adjustments a ON a.id=s.adjustment_id AND a.company_id=s.company_id
        WHERE s.company_id=$1 AND a.workflow_status='approved' AND s.status='pending'
          AND s.recognition_date BETWEEN $2 AND $3
      ) pending_adjustments)::text periodic_adjustments,
      (SELECT COUNT(*) FROM bank_transactions t WHERE t.company_id=$1 AND t.transaction_date BETWEEN $2 AND $3 AND NOT (
        EXISTS(SELECT 1 FROM obligation_settlements s WHERE s.company_id=t.company_id AND s.bank_transaction_id=t.id)
        OR EXISTS(SELECT 1 FROM bank_transaction_matches m WHERE m.company_id=t.company_id AND m.bank_transaction_id=t.id AND m.match_type IN ('custody_funding','custody_return'))
        OR EXISTS(SELECT 1 FROM bank_transaction_matches m JOIN document_settlements s ON s.company_id=m.company_id AND s.bank_transaction_id=m.bank_transaction_id AND s.document_id=m.document_id WHERE m.company_id=t.company_id AND m.bank_transaction_id=t.id AND m.match_type='document')
      ))::text bank_transactions`,[companyId,start,end,fiscalYearId]);
    const documents=Number(rows[0]!.documents),obligations=Number(rows[0]!.obligations),bank_transactions=Number(rows[0]!.bank_transactions),opening_balances=Number(rows[0]!.opening_balances),periodic_adjustments=Number(rows[0]!.periodic_adjustments);
    const vatReadiness=await new VatService(this.db).readiness(companyId,start,end,client);
    const vat=vatReadiness.ready?0:1;
    const incompleteDocuments=await this.incompleteMaterialDocuments(companyId,start,end,client);
    const sources=(await loadOperationalSources(companyId,client)).filter(source=>source.accounting_date>=start&&source.accounting_date<=end);
    let unpostedSources=0;
    for(const source of sources){if(source.source_type==='periodic_adjustment')continue;const documentId=typeof source.context.document_id==='string'?source.context.document_id:null;if(documentId&&incompleteDocuments.has(documentId)&&(source.source_type==='obligation'||source.source_type==='custody_allocation'))continue;if(!(await client.query("SELECT 1 FROM journal_entries WHERE company_id=$1 AND source_type=$2 AND source_id=$3 AND status='posted'",[companyId,source.source_type,source.source_id])).rowCount)unpostedSources++;}
    const sourceKeys=new Set(sources.map(source=>`${source.source_type}:${source.source_id}`));
    const draftJournals=(await client.query<{source_type:string|null;source_id:string|null}>("SELECT source_type,source_id FROM journal_entries WHERE company_id=$1 AND accounting_date BETWEEN $2 AND $3 AND status='draft'",[companyId,start,end])).rows;
    const independentDrafts=draftJournals.filter(journal=>!journal.source_type||!journal.source_id||!sourceKeys.has(`${journal.source_type}:${journal.source_id}`)).length;
    const ledger=incompleteDocuments.size+unpostedSources+independentDrafts;
    const assetCounts=(await client.query<{pending:string;drafts:string}>(`SELECT
      (SELECT COUNT(*) FROM asset_depreciation_entries WHERE company_id=$1 AND status='pending' AND period_end BETWEEN $2 AND $3)::text pending,
      (SELECT COUNT(*) FROM fixed_assets WHERE company_id=$1 AND source_type='document' AND status='draft' AND acquisition_date BETWEEN $2 AND $3)::text drafts`,[companyId,start,end])).rows[0]!;
    const assets=Number(assetCounts.pending)+Number(assetCounts.drafts);
    return{documents,obligations,bank_transactions,vat,ledger,assets,opening_balances,periodic_adjustments,total:documents+obligations+bank_transactions+vat+ledger+assets+opening_balances+periodic_adjustments};
  }
  async list(companyId:string){
    const {rows}=await this.db.query<Period>('SELECT *,period_start::text,period_end::text FROM monthly_close_periods WHERE company_id=$1 ORDER BY monthly_close_periods.period_start DESC',[companyId]);
    return {periods:await Promise.all(rows.map(async period=>{
      const blockers=await this.blockers(companyId,period.fiscal_year_id,period.period_start,period.period_end);
      return {...period,blockers,ready:blockers.total===0};
    }))};
  }
  async fiscalYears(companyId:string){const {rows}=await this.db.query<{id:string;name:string;start_date:string;end_date:string}>('SELECT id,name,start_date::text,end_date::text FROM fiscal_years WHERE company_id=$1 ORDER BY start_date DESC',[companyId]);return{fiscalYears:rows};}
  async create(companyId:string,actor:string,fiscalYearId:string,start:string,end:string){return this.tx(async client=>{
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`monthly-close-periods:${companyId}`]);
    const fy=(await client.query<{start_date:string;end_date:string}>('SELECT start_date::text,end_date::text FROM fiscal_years WHERE id=$1 AND company_id=$2',[fiscalYearId,companyId])).rows[0];
    if(!fy)throw new MonthlyCloseNotFoundError();if(start<fy.start_date||end>fy.end_date)throw new MonthlyCloseValidationError('Period must be within its fiscal year');const expected=expectedMonthlyBounds(start,fy.start_date,fy.end_date);if(start!==expected.start||end!==expected.end)throw new MonthlyCloseValidationError('Period must represent one calendar month');
    if((await client.query('SELECT 1 FROM monthly_close_periods WHERE company_id=$1 AND period_start<=$3 AND period_end>=$2',[companyId,start,end])).rowCount)throw new MonthlyCloseConflictError('Monthly close period overlaps an existing period');
    const period=(await client.query<Period>("INSERT INTO monthly_close_periods(company_id,fiscal_year_id,period_start,period_end,status) VALUES($1,$2,$3,$4,'open') RETURNING *,period_start::text,period_end::text",[companyId,fiscalYearId,start,end])).rows[0]!;
    await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'monthly_close.create',entity_type:'monthly_close_period',entity_id:period.id,before_data:null,after_data:period as never},client);return period;
  });}
  async close(companyId:string,actor:string,id:string){return this.tx(async client=>{const period=(await client.query<Period>('SELECT *,period_start::text,period_end::text FROM monthly_close_periods WHERE id=$1 AND company_id=$2 FOR UPDATE',[id,companyId])).rows[0];if(!period)throw new MonthlyCloseNotFoundError();if(period.status!=='open')throw new MonthlyCloseConflictError('Period is not open');await lockAccountingRange(companyId,period.period_start,period.period_end,client);const blockers=await this.blockers(companyId,period.fiscal_year_id,period.period_start,period.period_end,client);if(blockers.total)throw new MonthlyCloseConflictError('Monthly close has blockers');const after=(await client.query<Period>("UPDATE monthly_close_periods SET status='closed',updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *,period_start::text,period_end::text",[id,companyId])).rows[0]!;await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'monthly_close.close',entity_type:'monthly_close_period',entity_id:id,before_data:{status:'open'},after_data:{status:'closed'}},client);return{...after,blockers,ready:true};});}
  async reopen(companyId:string,actor:string,id:string,reason:string){return this.tx(async client=>{const period=(await client.query<Period>('SELECT *,period_start::text,period_end::text FROM monthly_close_periods WHERE id=$1 AND company_id=$2 FOR UPDATE',[id,companyId])).rows[0];if(!period)throw new MonthlyCloseNotFoundError();if(period.status!=='closed')throw new MonthlyCloseConflictError('Period is not closed');await lockAccountingRange(companyId,period.period_start,period.period_end,client);const after=(await client.query<Period>("UPDATE monthly_close_periods SET status='open',updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *,period_start::text,period_end::text",[id,companyId])).rows[0]!;await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'monthly_close.reopen',entity_type:'monthly_close_period',entity_id:id,before_data:{status:'closed'},after_data:{status:'open'},reason},client);return after;});}
}
function service(res:Response){if(!pool){res.status(503).json({error:'Database unavailable'});return null;}return new MonthlyCloseService(pool);}
function handle(error:unknown,res:Response){if(error instanceof MonthlyCloseValidationError)res.status(400).json({error:error.message});else if(error instanceof MonthlyCloseNotFoundError)res.status(404).json({error:'Not found'});else if(error instanceof MonthlyCloseConflictError)res.status(409).json({error:error.message});else throw error;}
monthlyCloseRouter.get('/monthly-close-periods',requireAuth,requireActiveCompany,requireCapability('monthly_close.view'),route(async(req,res)=>{const value=service(res);if(value)res.json(await value.list(context(req).activeCompanyId));}));
monthlyCloseRouter.get('/monthly-close-fiscal-years',requireAuth,requireActiveCompany,requireCapability('monthly_close.create'),route(async(req,res)=>{const value=service(res);if(value)res.json(await value.fiscalYears(context(req).activeCompanyId));}));
monthlyCloseRouter.post('/monthly-close-periods',requireSameOrigin,requireAuth,requireActiveCompany,requireCapability('monthly_close.create'),route(async(req,res)=>{try{const body=parseCreate(req.body);if(!body)throw new MonthlyCloseValidationError('Invalid request');const value=service(res);if(value)res.status(201).json(await value.create(context(req).activeCompanyId,context(req).user.id,body.fiscalYearId,body.start,body.end));}catch(error){handle(error,res);}}));
monthlyCloseRouter.post('/monthly-close-periods/:id/close',requireSameOrigin,requireAuth,requireActiveCompany,requireCapability('monthly_close.close'),route(async(req,res)=>{try{if(!UUID.test(req.params.id)||Object.keys(req.body??{}).length)throw new MonthlyCloseValidationError('Invalid request');const value=service(res);if(value)res.json(await value.close(context(req).activeCompanyId,context(req).user.id,req.params.id));}catch(error){handle(error,res);}}));
monthlyCloseRouter.post('/monthly-close-periods/:id/reopen',requireSameOrigin,requireAuth,requireActiveCompany,requireCapability('monthly_close.reopen'),route(async(req,res)=>{try{const reason=parseReason(req.body);if(!UUID.test(req.params.id)||!reason)throw new MonthlyCloseValidationError('Reason is required');const value=service(res);if(value)res.json(await value.reopen(context(req).activeCompanyId,context(req).user.id,req.params.id,reason));}catch(error){handle(error,res);}}));
