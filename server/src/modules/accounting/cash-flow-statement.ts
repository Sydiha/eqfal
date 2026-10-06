import { Pool, PoolClient } from 'pg';
import type { CashFlowCategory, CashRole } from './account-classification.router';

export const CASH_FLOW_CLASSIFICATION_CODE='CASH_FLOW_CLASSIFICATION_BLOCKED';

export class CashFlowValidationError extends Error{}
export class CashFlowNotFoundError extends Error{}
export class CashFlowClassificationError extends Error{
  constructor(readonly blockers:CashFlowBlocker[]){super('Cash flow statement is blocked by unmapped or ambiguous cash activity');}
}

type QueryRunner=Pick<Pool|PoolClient,'query'>;
type CashFlowLine={
  journal_id:string;accounting_date:string;entry_type:'standard'|'opening_balance';source_type:string|null;source_id:string|null;
  account_id:string;code:string;name:string;name_ar:string|null;name_en:string|null;cash_role:CashRole;cash_flow_category:CashFlowCategory;debit:string;credit:string;
};
export type CashFlowBlocker={journal_id:string;accounting_date:string;reason:'unmapped'|'ambiguous';account_ids:string[]};
export type CashFlowRow={account_id:string;code:string;name:string;name_ar:string|null;name_en:string|null;amount:string};
export type CashFlowSection={category:Exclude<CashFlowCategory,'unmapped'>;accounts:CashFlowRow[];total:string};

const DATE=/^\d{4}-\d{2}-\d{2}$/;
const validDate=(value:string)=>DATE.test(value)&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const amount=(line:Pick<CashFlowLine,'debit'|'credit'>)=>Number(line.debit)-Number(line.credit);
const round=(value:number)=>Number(value.toFixed(2));
const money=(value:number)=>round(value).toFixed(2);
const material=(value:number)=>Math.abs(value)>=0.005;

export class CashFlowStatementService{
  constructor(private db:Pool){}

  async statement(companyId:string,fiscalYearId:string,start?:string,end?:string){
    const client=await this.db.connect();
    try{
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const year=(await client.query<{start_date:string;end_date:string}>(
        'SELECT start_date::text,end_date::text FROM fiscal_years WHERE id=$1 AND company_id=$2',
        [fiscalYearId,companyId],
      )).rows[0];
      if(!year)throw new CashFlowNotFoundError();
      const from=start??year.start_date,to=end??year.end_date;
      if(!validDate(from)||!validDate(to)||from>to||from<year.start_date||to>year.end_date)throw new CashFlowValidationError('Invalid report date range');
      const lines=await this.lines(client,companyId,fiscalYearId,year.start_date,to);
      const opening=lines.filter(line=>line.cash_role!=='non_cash'&&(line.entry_type==='opening_balance'||line.accounting_date<from)).reduce((sum,line)=>sum+amount(line),0);
      const closing=lines.filter(line=>line.cash_role!=='non_cash').reduce((sum,line)=>sum+amount(line),0);
      const journals=new Map<string,CashFlowLine[]>();
      for(const line of lines){
        if(line.entry_type==='opening_balance'||line.accounting_date<from)continue;
        const journal=journals.get(line.journal_id)??[];journal.push(line);journals.set(line.journal_id,journal);
      }
      const grouped:Record<Exclude<CashFlowCategory,'unmapped'>,Map<string,CashFlowRow>>={operating:new Map(),investing:new Map(),financing:new Map()};
      const blockers:CashFlowBlocker[]=[];
      for(const journal of journals.values())this.classify(journal,grouped,blockers);
      if(blockers.length)throw new CashFlowClassificationError(blockers);
      const sections=(Object.keys(grouped) as Array<Exclude<CashFlowCategory,'unmapped'>>).map(category=>{
        const rows=[...grouped[category].values()].sort((a,b)=>a.code.localeCompare(b.code)||a.account_id.localeCompare(b.account_id));
        return{category,accounts:rows,total:money(rows.reduce((sum,row)=>sum+Number(row.amount),0))};
      });
      const operating=Number(sections[0]!.total),investing=Number(sections[1]!.total),financing=Number(sections[2]!.total);
      const net=round(operating+investing+financing),difference=round(opening+net-closing);
      if(material(difference))throw new CashFlowClassificationError([{journal_id:'reconciliation',accounting_date:to,reason:'ambiguous',account_ids:[]}]);
      await client.query('COMMIT');
      return{
        statement:'cash_flow',fiscal_year_id:fiscalYearId,start_date:from,end_date:to,sections,
        operating_cash_flow:money(operating),investing_cash_flow:money(investing),financing_cash_flow:money(financing),
        net_change_in_cash_and_cash_equivalents:money(net),opening_cash_and_cash_equivalents:money(opening),closing_cash_and_cash_equivalents:money(closing),
        reconciliation:{expected:money(opening+net),actual:money(closing),difference:money(difference),balanced:!material(difference)},
      };
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  private async lines(db:QueryRunner,companyId:string,fiscalYearId:string,start:string,end:string){
    return(await db.query<CashFlowLine>(
      `SELECT j.id journal_id,j.accounting_date::text,j.entry_type,j.source_type,j.source_id,
              a.id account_id,a.code,a.name,a.name_ar,a.name_en,a.cash_role,a.cash_flow_category,l.debit::text,l.credit::text
       FROM journal_lines l
       JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
       JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id
       WHERE l.company_id=$1 AND j.company_id=$1 AND j.fiscal_year_id=$2 AND j.status='posted'
         AND j.accounting_date BETWEEN $3 AND $4
       ORDER BY j.accounting_date,j.created_at,j.id,l.sequence,l.id`,
      [companyId,fiscalYearId,start,end],
    )).rows;
  }

  private classify(journal:CashFlowLine[],grouped:Record<Exclude<CashFlowCategory,'unmapped'>,Map<string,CashFlowRow>>,blockers:CashFlowBlocker[]){
    const cash=journal.filter(line=>line.cash_role!=='non_cash'),counterparts=journal.filter(line=>line.cash_role==='non_cash');
    if(!cash.length)return;
    const cashNet=round(cash.reduce((sum,line)=>sum+amount(line),0));
    if(!counterparts.length)return; // A cash/cash-equivalent-only journal is an internal transfer.
    const ids=counterparts.map(line=>line.account_id);
    if(!material(cashNet)){
      blockers.push({journal_id:journal[0]!.journal_id,accounting_date:journal[0]!.accounting_date,reason:'ambiguous',account_ids:ids});return;
    }
    if(counterparts.some(line=>line.cash_flow_category==='unmapped')){
      blockers.push({journal_id:journal[0]!.journal_id,accounting_date:journal[0]!.accounting_date,reason:'unmapped',account_ids:ids});return;
    }
    const movements=counterparts.map(line=>({line,value:round(-amount(line))})).filter(row=>material(row.value));
    if(!movements.length||movements.some(row=>Math.sign(row.value)!==Math.sign(cashNet))||material(movements.reduce((sum,row)=>sum+row.value,0)-cashNet)){
      blockers.push({journal_id:journal[0]!.journal_id,accounting_date:journal[0]!.accounting_date,reason:'ambiguous',account_ids:ids});return;
    }
    for(const {line,value} of movements){
      const category=line.cash_flow_category as Exclude<CashFlowCategory,'unmapped'>,existing=grouped[category].get(line.account_id);
      grouped[category].set(line.account_id,{account_id:line.account_id,code:line.code,name:line.name,name_ar:line.name_ar,name_en:line.name_en,amount:money((existing?Number(existing.amount):0)+value)});
    }
  }
}
