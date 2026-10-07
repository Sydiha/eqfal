import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import { Pool } from 'pg';
import pool from '../../db/pool';
import { operationalDate } from '../../operational-date';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';

export const purchasesRouter = Router();

type PurchaseRow = {
  id:string; document_type:'purchase'|'expense'; original_filename:string; status:string; document_date:string|null; reference_number:string|null;
  total_amount:string|null; intake_note:string|null; counterparty_id:string|null; supplier_name:string|null;
  counterparty_type:'customer'|'supplier'|'government'|'other'|null; payable_id:string|null;
  payable_original_amount:string|null; due_on:string|null; verification_status:string|null; is_cancelled:boolean|null;
  vat_review_status:'pending'|'reviewed'|null; tax_date:string|null; vat_treatment:string|null;
  taxable_amount:string|null; vat_amount:string|null; asset_id:string|null;
};

const cents=(value:string|null)=>{const match=/^(\d+)(?:\.(\d{1,2}))?$/.exec(value??'0');if(!match)throw new Error('Invalid monetary value');return BigInt(match[1])*100n+BigInt((match[2]??'').padEnd(2,'0'))};
const money=(value:bigint)=>`${value/100n}.${String(value%100n).padStart(2,'0')}`;

export class PurchasesService {
  constructor(private readonly db:Pool){}
  async list(companyId:string){
    const {rows}=await this.db.query<PurchaseRow>(`SELECT d.id,d.document_type,d.original_filename,d.status,d.document_date::text,d.reference_number,d.total_amount::text,d.intake_note,
      d.counterparty_id,c.name supplier_name,c.type counterparty_type,o.id payable_id,o.original_amount::text payable_original_amount,o.due_on::text,
      o.verification_status,o.is_cancelled,v.review_status vat_review_status,v.tax_date::text,v.treatment vat_treatment,
      v.taxable_amount::text,v.vat_amount::text,a.id asset_id
      FROM documents d
      LEFT JOIN counterparties c ON c.id=d.counterparty_id AND c.company_id=d.company_id
      LEFT JOIN obligations o ON o.document_id=d.id AND o.company_id=d.company_id AND o.source_type='document' AND o.direction='payable'
      LEFT JOIN document_vat_reviews v ON v.document_id=d.id AND v.company_id=d.company_id
      LEFT JOIN fixed_assets a ON a.source_document_id=d.id AND a.company_id=d.company_id AND a.status<>'cancelled'
      WHERE d.company_id=$1 AND d.document_type IN ('purchase','expense') ORDER BY d.document_date DESC NULLS LAST,d.created_at DESC`,[companyId]);
    const {rows:settlements}=await this.db.query(`SELECT s.id,s.document_id,s.bank_transaction_id,s.amount::text,s.note,
      t.transaction_date::text,t.description,t.bank_reference
      FROM document_settlements s JOIN bank_transactions t ON t.id=s.bank_transaction_id AND t.company_id=s.company_id
      WHERE s.company_id=$1 ORDER BY s.created_at DESC`,[companyId]);
    const today=operationalDate();
    return {purchases:rows.map(row=>{
      const history=settlements.filter(item=>item.document_id===row.id);
      const paid=history.reduce((sum,item)=>sum+cents(String(item.amount)),0n);
      const original=cents(row.payable_original_amount??row.total_amount);
      const remaining=original>paid?original-paid:0n;
      let financialState:'open'|'partial'|'paid'|'overdue'|null=null;
      if(row.payable_id&&!row.is_cancelled){
        financialState=remaining<=0n?'paid':row.due_on!==null&&row.due_on<today?'overdue':paid>0n?'partial':'open';
      }
      return {...row,paid_amount:money(paid),remaining_amount:row.payable_id&&!row.is_cancelled?money(remaining):null,
        vat_review_status:row.vat_review_status??'missing',
        financial_state:financialState,payable_cancelled:row.is_cancelled===true,
        payable_relationship:row.payable_id?(row.is_cancelled?'linked_cancelled':'linked_active'):'not_created',settlement_history:history};
    })};
  }
}

const route=(handler:(req:Request,res:Response)=>Promise<void>):RequestHandler=>(req,res,next:NextFunction)=>void handler(req,res).catch(next);
purchasesRouter.get('/purchases',requireAuth,requireActiveCompany,requireCapability('document.view'),requireCapability('obligation.view'),route(async(req,res)=>{
  if(!pool){res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });return;}
  const context=getAuthenticatedContext(req)!;
  res.json(await new PurchasesService(pool).list(context.activeCompanyId!));
}));
