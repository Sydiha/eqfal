import { Pool, PoolClient } from 'pg';
import type { CashFlowCategory, CashRole } from './account-classification.router';
import { assertCashFlowRange, CUTOVER_BOUNDS_SQL, CutoverBounds } from './external-period-guard';
import { loadCutoverDisclosure, preCutover } from './cutover-disclosure';
import { cents, money as exactMoney, SupplementLine } from './cutover-supplements';

export const CASH_FLOW_CLASSIFICATION_CODE='CASH_FLOW_CLASSIFICATION_BLOCKED';

export class CashFlowValidationError extends Error{}
export class CashFlowNotFoundError extends Error{}
export class CashFlowClassificationError extends Error{
  constructor(readonly blockers:CashFlowBlocker[]){super('Cash flow statement is blocked by unmapped or ambiguous cash activity');}
}

type QueryRunner=Pick<Pool|PoolClient,'query'>;
type CashFlowLine={
  journal_id:string;accounting_date:string;entry_type:'standard'|'opening_balance'|'cutover_balance';source_type:string|null;source_id:string|null;
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
      const year=(await client.query<{start_date:string;end_date:string}&CutoverBounds>(
        `SELECT start_date::text,end_date::text,${CUTOVER_BOUNDS_SQL} FROM fiscal_years WHERE id=$1 AND company_id=$2`,
        [fiscalYearId,companyId],
      )).rows[0];
      if(!year)throw new CashFlowNotFoundError();
      const from=start??year.start_date,to=end??year.end_date;
      if(!validDate(from)||!validDate(to)||from>to||from<year.start_date||to>year.end_date)throw new CashFlowValidationError('Invalid report date range');
      // S2: a cut-over year's statement may start on 1 Jan only with an approved, reconciled cash-flow supplement (spec v2 E/F); otherwise the
      // S1 rule stands (no period on or before D). January-1 companies never reach the supplement query.
      const disclosure=year.cutover_to?await loadCutoverDisclosure(client,companyId,fiscalYearId):null;
      const supplement=disclosure&&from===year.start_date&&to>=year.cutover_to!&&disclosure.completeness.cash_flow.full_year_complete?disclosure.supplements!.cash_flow:null;
      if(!supplement)assertCashFlowRange(year,from);
      const lines=await this.lines(client,companyId,fiscalYearId,year.start_date,to);
      const supplementLines=supplement?supplement.lines:[];
      const supplementOpening=supplementLines.filter(line=>line.line_type==='cash_balance').reduce((sum,line)=>sum+cents(line.opening_amount!),0n);
      // Full-year mode: the opening is the supplement's 1 Jan cash; the cut-over journal is NOT a cash movement (its cash lines are the D balances,
      // reached by the supplement flows), so it is excluded from classification but still counted in the closing balance. No double counting.
      const opening=supplement?Number(exactMoney(supplementOpening)):lines.filter(line=>line.cash_role!=='non_cash'&&(line.entry_type==='opening_balance'||line.accounting_date<from)).reduce((sum,line)=>sum+amount(line),0);
      const closing=lines.filter(line=>line.cash_role!=='non_cash').reduce((sum,line)=>sum+amount(line),0);
      const journals=new Map<string,CashFlowLine[]>();
      for(const line of lines){
        if(line.entry_type==='opening_balance'||line.accounting_date<from)continue;
        if(supplement&&line.entry_type==='cutover_balance')continue;
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
      if(supplement)return await this.fullYear(client,fiscalYearId,from,to,sections,supplementLines,supplementOpening,closing,disclosure!);
      const operating=Number(sections[0]!.total),investing=Number(sections[1]!.total),financing=Number(sections[2]!.total);
      const net=round(operating+investing+financing),difference=round(opening+net-closing);
      if(material(difference))throw new CashFlowClassificationError([{journal_id:'reconciliation',accounting_date:to,reason:'ambiguous',account_ids:[]}]);
      // S1: a year with an active cut-over range discloses it (only periods after D reach this point); January-1 companies are unchanged.
      await client.query('COMMIT');
      return{
        statement:'cash_flow',fiscal_year_id:fiscalYearId,start_date:from,end_date:to,...preCutover(disclosure,'cash_flow',false),sections,
        operating_cash_flow:money(operating),investing_cash_flow:money(investing),financing_cash_flow:money(financing),
        net_change_in_cash_and_cash_equivalents:money(net),opening_cash_and_cash_equivalents:money(opening),closing_cash_and_cash_equivalents:money(closing),
        reconciliation:{expected:money(opening+net),actual:money(closing),difference:money(difference),balanced:!material(difference)},
      };
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }

  /**
   * S2 full-year statement (1 Jan -> end): supplement flows (1 Jan -> D, tagged `pre_cutover_supplement`) + native flows after D, in exact
   * halalas. Each section keeps its native accounts; the supplement part is reported beside them. fx_effect is its own line. The closing
   * reconciliation must hold exactly or the statement is refused, as for any other period.
   */
  private async fullYear(client:PoolClient,fiscalYearId:string,from:string,to:string,nativeSections:CashFlowSection[],supplementLines:SupplementLine[],opening:bigint,closingNumber:number,disclosure:NonNullable<Awaited<ReturnType<typeof loadCutoverDisclosure>>>){
    const flows=supplementLines.filter(line=>line.line_type==='cash_flow');
    const pre=(section:string)=>flows.filter(line=>line.section===section).reduce((sum,line)=>sum+cents(line.amount!),0n);
    const sections=nativeSections.map(section=>{
      const native=cents(section.total),supplement=pre(section.category);
      return{...section,native_total:section.total,pre_cutover_total:exactMoney(supplement),total:exactMoney(native+supplement),
        pre_cutover_lines:flows.filter(line=>line.section===section.category).map(line=>({label:line.label!,account_id:line.account_id,amount:line.amount!,source:'pre_cutover_supplement' as const,...(line.classification_override_reason?{classification_override_reason:line.classification_override_reason}:{})}))};
    });
    const fx=pre('fx_effect');
    const operating=cents(sections[0]!.total),investing=cents(sections[1]!.total),financing=cents(sections[2]!.total);
    const net=operating+investing+financing+fx,closing=cents(money(closingNumber)),difference=opening+net-closing;
    if(difference!==0n)throw new CashFlowClassificationError([{journal_id:'reconciliation',accounting_date:to,reason:'ambiguous',account_ids:[]}]);
    await client.query('COMMIT');
    return{
      statement:'cash_flow',fiscal_year_id:fiscalYearId,start_date:from,end_date:to,...preCutover(disclosure,'cash_flow',true),sections,
      operating_cash_flow:exactMoney(operating),investing_cash_flow:exactMoney(investing),financing_cash_flow:exactMoney(financing),
      fx_effect:exactMoney(fx),fx_effect_lines:flows.filter(line=>line.section==='fx_effect').map(line=>({label:line.label!,amount:line.amount!,source:'pre_cutover_supplement' as const})),
      net_change_in_cash_and_cash_equivalents:exactMoney(net),opening_cash_and_cash_equivalents:exactMoney(opening),closing_cash_and_cash_equivalents:exactMoney(closing),
      reconciliation:{expected:exactMoney(opening+net),actual:exactMoney(closing),difference:exactMoney(difference),balanced:true},
    };
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
