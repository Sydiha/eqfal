import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import pool from '../../db/pool';
import { operationalDate } from '../../operational-date';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';

export const salesRouter = Router();

type SaleRow = {
  id:string; original_filename:string; status:string; document_date:string|null; reference_number:string|null;
  total_amount:string|null; intake_note:string|null; counterparty_id:string|null; customer_name:string|null;
  counterparty_type:'customer'|'supplier'|'government'|'other'|null; receivable_id:string|null;
  receivable_original_amount:string|null; due_on:string|null; verification_status:string|null; is_cancelled:boolean|null;
};

const cents=(value:string|null)=>{const match=/^(\d+)(?:\.(\d{1,2}))?$/.exec(value??'0');if(!match)throw new Error('Invalid monetary value');return BigInt(match[1])*100n+BigInt((match[2]??'').padEnd(2,'0'))};
const money=(value:bigint)=>`${value/100n}.${String(value%100n).padStart(2,'0')}`;

export class SalesService {
  constructor(private readonly db:Pool){}
  async list(companyId:string){
    const {rows}=await this.db.query<SaleRow>(`SELECT d.id,d.original_filename,d.status,d.document_date::text,d.reference_number,d.total_amount::text,d.intake_note,
      d.counterparty_id,c.name customer_name,c.type counterparty_type,o.id receivable_id,o.original_amount::text receivable_original_amount,o.due_on::text,
      o.verification_status,o.is_cancelled
      FROM documents d
      LEFT JOIN counterparties c ON c.id=d.counterparty_id AND c.company_id=d.company_id
      LEFT JOIN obligations o ON o.document_id=d.id AND o.company_id=d.company_id AND o.source_type='document' AND o.direction='receivable'
      WHERE d.company_id=$1 AND d.document_type='sale' ORDER BY d.document_date DESC NULLS LAST,d.created_at DESC`,[companyId]);
    const {rows:settlements}=await this.db.query(`SELECT s.id,s.document_id,s.bank_transaction_id,s.amount::text,s.note,
      t.transaction_date::text,t.description,t.bank_reference
      FROM document_settlements s JOIN bank_transactions t ON t.id=s.bank_transaction_id AND t.company_id=s.company_id
      WHERE s.company_id=$1 ORDER BY s.created_at DESC`,[companyId]);
    const today=operationalDate();
    return {sales:rows.map(row=>{
      const history=settlements.filter(item=>item.document_id===row.id);
      const collected=history.reduce((sum,item)=>sum+cents(String(item.amount)),0n);
      const original=cents(row.receivable_original_amount??row.total_amount);
      const remaining=original-collected;
      let financialState:'open'|'partial'|'paid'|'overdue'|null=null;
      if(row.receivable_id&&!row.is_cancelled){
        financialState=remaining<=0n?'paid':row.due_on!==null&&row.due_on<today?'overdue':collected>0n?'partial':'open';
      }
      return {...row,collected_amount:money(collected),remaining_amount:row.receivable_id&&!row.is_cancelled?money(remaining):null,
        financial_state:financialState,receivable_cancelled:row.is_cancelled===true,
        receivable_relationship:row.receivable_id?(row.is_cancelled?'linked_cancelled':'linked_active'):'not_created',settlement_history:history};
    })};
  }
}

const route=(handler:(req:Request,res:Response)=>Promise<void>):RequestHandler=>(req,res,next:NextFunction)=>void handler(req,res).catch(next);
salesRouter.get('/sales',requireAuth,requireActiveCompany,requireCapability('document.view'),requireCapability('obligation.view'),route(async(req,res)=>{
  if(!pool){res.status(503).json({error:'Database unavailable'});return;}
  const context=getAuthenticatedContext(req)!;
  res.json(await new SalesService(pool).list(context.activeCompanyId!));
}));
