import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
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

type AccountType=typeof ACCOUNT_TYPES[number];
export type StatementCategory=typeof STATEMENT_CATEGORIES[number];
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
  created_at:Date;
  updated_at:Date;
};
type ClassificationInput={statementCategory?:StatementCategory;isContra?:boolean};

const ALLOWED:Record<AccountType,readonly StatementCategory[]>={
  asset:['unmapped','current_asset','non_current_asset'],
  liability:['unmapped','current_liability','non_current_liability'],
  equity:['unmapped','equity'],
  revenue:['unmapped','revenue','finance_income','other_income'],
  expense:['unmapped','cost_of_sales','operating_expense','finance_expense','other_expense'],
};

class ClassificationValidationError extends Error{}
class ClassificationNotFoundError extends Error{}

const route=(handler:(req:Request,res:Response)=>Promise<void>):RequestHandler=>
  (req,res,next:NextFunction)=>void handler(req,res).catch(next);
const context=(req:Request)=>getAuthenticatedContext(req)! as ReturnType<typeof getAuthenticatedContext>&{activeCompanyId:string};
const base=[requireAuth,requireActiveCompany] as const;
const isCategory=(value:unknown):value is StatementCategory=>
  typeof value==='string'&&STATEMENT_CATEGORIES.includes(value as StatementCategory);
const bodyObject=(value:unknown):Record<string,unknown>|null=>
  value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;

function parseInput(body:unknown):ClassificationInput|null{
  const value=bodyObject(body);
  if(!value)return null;
  if(!Object.keys(value).every(key=>key==='statement_category'||key==='is_contra'))return null;
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
  return result;
}
function compatible(accountType:AccountType,category:StatementCategory,isContra:boolean){
  return ALLOWED[accountType].includes(category)&&(!isContra||accountType==='asset');
}

export class AccountClassificationService{
  private audit=new AuditLogRepository();
  constructor(private db:Pool){}

  async list(companyId:string,category?:StatementCategory){
    const params:unknown[]=[companyId];
    let where='company_id=$1';
    if(category!==undefined){params.push(category);where+=' AND statement_category=$2';}
    const {rows}=await this.db.query<AccountClassification>(
      `SELECT id,company_id,code,name,account_type,parent_account_id,is_active,statement_category,is_contra,created_at,updated_at
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
        `SELECT id,company_id,code,name,account_type,parent_account_id,is_active,statement_category,is_contra,created_at,updated_at
         FROM accounts WHERE id=$1 AND company_id=$2 FOR UPDATE`,
        [id,companyId],
      )).rows[0];
      if(!before)throw new ClassificationNotFoundError();

      const statementCategory=input.statementCategory??before.statement_category;
      const isContra=input.isContra??before.is_contra;
      if(!compatible(before.account_type,statementCategory,isContra)){
        throw new ClassificationValidationError('Invalid account classification');
      }

      const after=(await client.query<AccountClassification>(
        `UPDATE accounts
         SET statement_category=$3,is_contra=$4,updated_at=NOW()
         WHERE id=$1 AND company_id=$2
         RETURNING id,company_id,code,name,account_type,parent_account_id,is_active,statement_category,is_contra,created_at,updated_at`,
        [id,companyId,statementCategory,isContra],
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
  if(!pool){res.status(503).json({error:'Database unavailable'});return null;}
  return new AccountClassificationService(pool);
};
const handle=(error:unknown,res:Response)=>{
  if(error instanceof ClassificationValidationError){res.status(400).json({error:error.message});return;}
  if(error instanceof ClassificationNotFoundError){res.status(404).json({error:'Account not found'});return;}
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
  requireCapability('accounting.chart.manage'),
  route(async(req,res)=>{
    try{
      const input=parseInput(req.body);
      if(!UUID.test(req.params.id)||!input)throw new ClassificationValidationError('Invalid request');
      const s=service(res);
      if(s)res.json(await s.update(context(req).activeCompanyId,context(req).user.id,req.params.id,input));
    }catch(error){handle(error,res);}
  }),
);
