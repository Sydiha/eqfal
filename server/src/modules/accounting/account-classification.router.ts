import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool, PoolClient } from 'pg';
import pool from '../../db/pool';
import { AuditLogRepository } from '../audit-log/audit-log.repository';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';

export const accountClassificationRouter = Router();

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACCOUNT_TYPES=['asset','liability','equity','revenue','expense'] as const;
export const STATEMENT_CATEGORIES=[
  'unmapped',
  'current_asset',
  'non_current_asset',
  'current_liability',
  'non_current_liability',
  'equity',
  'revenue',
  'cost_of_sales',
  'operating_expense',
  'finance_income',
  'finance_expense',
  'other_income',
  'other_expense',
] as const;
export const CASH_ROLES=['non_cash','cash','cash_equivalent'] as const;
export const CASH_FLOW_CATEGORIES=['unmapped','operating','investing','financing'] as const;

type AccountType=typeof ACCOUNT_TYPES[number];
export type StatementCategory=typeof STATEMENT_CATEGORIES[number];
export type CashRole=typeof CASH_ROLES[number];
export type CashFlowCategory=typeof CASH_FLOW_CATEGORIES[number];
type AccountClassification={
  id:string;
  company_id:string;
  code:string;
  name:string;
  account_type:AccountType;
  parent_account_id:string|null;
  is_active:boolean;
  statement_category:StatementCategory;
  is_contra:boolean;
  cash_role:CashRole;
  cash_flow_category:CashFlowCategory;
  created_at:Date;
  updated_at:Date;
};
type ClassificationInput={
  statementCategory?:StatementCategory;
  isContra?:boolean;
  cashRole?:CashRole;
  cashFlowCategory?:CashFlowCategory;
};

const ALLOWED:Record<AccountType,readonly StatementCategory[]>={
  asset:['unmapped','current_asset','non_current_asset'],
  liability:['unmapped','current_liability','non_current_liability'],
  equity:['unmapped','equity'],
  revenue:['unmapped','revenue','finance_income','other_income'],
  expense:['unmapped','cost_of_sales','operating_expense','finance_expense','other_expense'],
};

class ClassificationValidationError extends Error{}
class ClassificationNotFoundError extends Error{}
export const CLASSIFICATION_CLOSED_YEAR_CODE='ACCOUNT_CLASSIFICATION_CLOSED_YEAR_LOCKED';
export class ClassificationClosedYearError extends Error{
  constructor(readonly fiscalYears:Array<{id:string;name:string}>){super('Account classification is locked by a closed fiscal year');}
}

/**
 * P2-F1/F2: closed-year statements are computed from the account's CURRENT classification, so a classification change on an account
 * with closed-year activity would silently restate them. Activity = a posted journal line in the closed year (ordinary, opening and
 * cut-over journals alike) or a line of an approved/superseded cut-over supplement whose authority range lies in that year.
 * Locking: every fiscal year of the company is read FOR SHARE, in start-date order, before the check; closeFiscalYear takes the year's
 * row FOR UPDATE, so a close either commits first (and this check sees it closed) or waits until this update has committed.
 */
async function closedYearsWithActivity(client:PoolClient,companyId:string,accountId:string){
  const years=(await client.query<{id:string;name:string;status:string}>(
    'SELECT id,name,status FROM fiscal_years WHERE company_id=$1 ORDER BY start_date,id FOR SHARE',
    [companyId],
  )).rows;
  const closed=years.filter(year=>year.status==='closed').map(year=>year.id);
  if(!closed.length)return[];
  return(await client.query<{id:string;name:string}>(
    `SELECT f.id,f.name FROM fiscal_years f
     WHERE f.company_id=$1 AND f.id=ANY($3::uuid[]) AND (
       EXISTS(SELECT 1 FROM journal_lines l JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
              WHERE l.company_id=$1 AND l.account_id=$2 AND j.fiscal_year_id=f.id AND j.status='posted')
       OR EXISTS(SELECT 1 FROM cutover_supplement_lines s
              JOIN cutover_supplement_versions v ON v.id=s.version_id AND v.company_id=s.company_id
              JOIN ledger_source_authority a ON a.id=v.authority_id AND a.company_id=v.company_id
              WHERE s.company_id=$1 AND s.account_id=$2 AND v.status IN ('approved','superseded')
                AND a.from_date<=f.end_date AND a.to_date>=f.start_date))
     ORDER BY f.start_date,f.id`,
    [companyId,accountId,closed],
  )).rows;
}

const route=(handler:(req:Request,res:Response)=>Promise<void>):RequestHandler=>
  (req,res,next:NextFunction)=>void handler(req,res).catch(next);
const context=(req:Request)=>getAuthenticatedContext(req)! as ReturnType<typeof getAuthenticatedContext>&{activeCompanyId:string};
const base=[requireAuth,requireActiveCompany] as const;
const isCategory=(value:unknown):value is StatementCategory=>
  typeof value==='string'&&STATEMENT_CATEGORIES.includes(value as StatementCategory);
const isCashRole=(value:unknown):value is CashRole=>
  typeof value==='string'&&CASH_ROLES.includes(value as CashRole);
const isCashFlowCategory=(value:unknown):value is CashFlowCategory=>
  typeof value==='string'&&CASH_FLOW_CATEGORIES.includes(value as CashFlowCategory);
const bodyObject=(value:unknown):Record<string,unknown>|null=>
  value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;

function parseInput(body:unknown):ClassificationInput|null{
  const value=bodyObject(body);
  if(!value)return null;
  if(!Object.keys(value).every(key=>
    key==='statement_category'||key==='is_contra'||key==='cash_role'||key==='cash_flow_category'))return null;
  if(!Object.keys(value).length)return null;
  const result:ClassificationInput={};
  if('statement_category' in value){
    if(!isCategory(value.statement_category))return null;
    result.statementCategory=value.statement_category;
  }
  if('is_contra' in value){
    if(typeof value.is_contra!=='boolean')return null;
    result.isContra=value.is_contra;
  }
  if('cash_role' in value){
    if(!isCashRole(value.cash_role))return null;
    result.cashRole=value.cash_role;
  }
  if('cash_flow_category' in value){
    if(!isCashFlowCategory(value.cash_flow_category))return null;
    result.cashFlowCategory=value.cash_flow_category;
  }
  return result;
}
function compatible(accountType:AccountType,category:StatementCategory,isContra:boolean){
  return ALLOWED[accountType].includes(category)&&(!isContra||accountType==='asset');
}
function cashCompatible(accountType:AccountType,cashRole:CashRole){
  return cashRole==='non_cash'||accountType==='asset';
}

export class AccountClassificationService{
  private audit=new AuditLogRepository();
  constructor(private db:Pool){}

  async list(companyId:string,category?:StatementCategory){
    const params:unknown[]=[companyId];
    let where='company_id=$1';
    if(category!==undefined){params.push(category);where+=' AND statement_category=$2';}
    const {rows}=await this.db.query<AccountClassification>(
      `SELECT id,company_id,code,name,account_type,parent_account_id,is_active,statement_category,is_contra,cash_role,cash_flow_category,created_at,updated_at
       FROM accounts WHERE ${where} ORDER BY code,id`,
      params,
    );
    return{accounts:rows};
  }

  async update(companyId:string,actor:string,id:string,input:ClassificationInput){
    const client=await this.db.connect();
    try{
      await client.query('BEGIN');
      const before=(await client.query<AccountClassification>(
        `SELECT id,company_id,code,name,account_type,parent_account_id,is_active,statement_category,is_contra,cash_role,cash_flow_category,created_at,updated_at
         FROM accounts WHERE id=$1 AND company_id=$2 FOR UPDATE`,
        [id,companyId],
      )).rows[0];
      if(!before)throw new ClassificationNotFoundError();

      const statementCategory=input.statementCategory??before.statement_category;
      const isContra=input.isContra??before.is_contra;
      const cashRole=input.cashRole??before.cash_role;
      const cashFlowCategory=input.cashFlowCategory??before.cash_flow_category;
      if(!compatible(before.account_type,statementCategory,isContra)||!cashCompatible(before.account_type,cashRole)){
        throw new ClassificationValidationError('Invalid account classification');
      }
      const changed=statementCategory!==before.statement_category||isContra!==before.is_contra
        ||cashRole!==before.cash_role||cashFlowCategory!==before.cash_flow_category;
      if(changed){
        const locked=await closedYearsWithActivity(client,companyId,id);
        if(locked.length)throw new ClassificationClosedYearError(locked);
      }

      const after=(await client.query<AccountClassification>(
        `UPDATE accounts
         SET statement_category=$3,is_contra=$4,cash_role=$5,cash_flow_category=$6,updated_at=NOW()
         WHERE id=$1 AND company_id=$2
         RETURNING id,company_id,code,name,account_type,parent_account_id,is_active,statement_category,is_contra,cash_role,cash_flow_category,created_at,updated_at`,
        [id,companyId,statementCategory,isContra,cashRole,cashFlowCategory],
      )).rows[0]!;
      await this.audit.logEvent({
        company_id:companyId,
        actor_user_id:actor,
        action:'account.classification.update',
        entity_type:'account',
        entity_id:id,
        before_data:before as never,
        after_data:after as never,
      },client);
      await client.query('COMMIT');
      return after;
    }catch(error){
      await client.query('ROLLBACK');
      if((error as{code?:string}).code==='23514')throw new ClassificationValidationError('Invalid account classification');
      throw error;
    }finally{
      client.release();
    }
  }
}

const service=(res:Response)=>{
  if(!pool){res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });return null;}
  return new AccountClassificationService(pool);
};
const handle=(error:unknown,res:Response)=>{
  if(error instanceof ClassificationValidationError){res.status(400).json({error:error.message});return;}
  if(error instanceof ClassificationNotFoundError){res.status(404).json({error:'Account not found'});return;}
  if(error instanceof ClassificationClosedYearError){
    res.status(409).json({error:error.message,code:CLASSIFICATION_CLOSED_YEAR_CODE,fiscal_years:error.fiscalYears});return;
  }
  throw error;
};

accountClassificationRouter.get(
  '/account-classifications',
  ...base,
  requireCapability('accounting.view'),
  route(async(req,res)=>{
    try{
      if(req.query.statement_category!==undefined&&!isCategory(req.query.statement_category)){
        throw new ClassificationValidationError('Invalid statement category');
      }
      const s=service(res);
      if(s)res.json(await s.list(context(req).activeCompanyId,req.query.statement_category as StatementCategory|undefined));
    }catch(error){handle(error,res);}
  }),
);

accountClassificationRouter.patch(
  '/accounts/:id/classification',
  requireSameOrigin,
  ...base,
  requireCapability('accounting.chart.edit'),
  route(async(req,res)=>{
    try{
      const input=parseInput(req.body);
      if(!UUID.test(req.params.id)||!input)throw new ClassificationValidationError('Invalid request');
      const s=service(res);
      if(s)res.json(await s.update(context(req).activeCompanyId,context(req).user.id,req.params.id,input));
    }catch(error){handle(error,res);}
  }),
);
