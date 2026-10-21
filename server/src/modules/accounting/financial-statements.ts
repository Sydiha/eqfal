import { Pool, PoolClient } from 'pg';
import type { StatementCategory } from './account-classification.router';
import { assertStatementRange, CUTOVER_BOUNDS_SQL, CutoverBounds } from './external-period-guard';
import { CutoverDisclosure, loadCutoverDisclosure, preCutover } from './cutover-disclosure';
import { cents, money as exactMoney, SupplementLine } from './cutover-supplements';

export const FINANCIAL_STATEMENT_UNMAPPED_CODE='FINANCIAL_STATEMENT_UNMAPPED_ACCOUNTS';

export class FinancialStatementValidationError extends Error{}
export class FinancialStatementNotFoundError extends Error{}
export class FinancialStatementUnmappedError extends Error{
  constructor(readonly accounts:StatementAccount[]){super('Posted activity exists on unmapped accounts');}
}

export type StatementAccount={
  account_id:string;code:string;name:string;name_ar:string|null;name_en:string|null;account_type:string;
  statement_category:StatementCategory;is_contra:boolean;amount:string;
};
type Movement=Omit<StatementAccount,'amount'>&{debit:string;credit:string;opening_debit:string;opening_credit:string;cutover_debit:string;cutover_credit:string};
type QueryRunner=Pick<Pool|PoolClient,'query'>;

const DATE=/^\d{4}-\d{2}-\d{2}$/;
const validDate=(value:string)=>DATE.test(value)&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const financialPositionCategories:StatementCategory[]=['current_asset','non_current_asset','current_liability','non_current_liability','equity'];
const profitOrLossCategories:StatementCategory[]=['revenue','cost_of_sales','operating_expense','finance_income','finance_expense','other_income','other_expense'];

const accountAmount=(row:Pick<Movement,'debit'|'credit'|'account_type'|'is_contra'>)=>{
  const debit=Number(row.debit),credit=Number(row.credit);
  if(row.account_type==='asset')return row.is_contra?debit-credit:debit-credit;
  if(row.account_type==='expense')return debit-credit;
  return credit-debit;
};

export class FinancialStatementsService{
  constructor(private db:Pool){}

  private async movements(companyId:string,fiscalYearId:string,start?:string,end?:string,db:QueryRunner=this.db){
    const year=(await db.query<{start_date:string;end_date:string}&CutoverBounds>(
      `SELECT start_date::text,end_date::text,${CUTOVER_BOUNDS_SQL} FROM fiscal_years WHERE id=$1 AND company_id=$2`,
      [fiscalYearId,companyId],
    )).rows[0];
    if(!year)throw new FinancialStatementNotFoundError();
    const from=start??year.start_date,to=end??year.end_date;
    if(!validDate(from)||!validDate(to)||from>to||from<year.start_date||to>year.end_date){
      throw new FinancialStatementValidationError('Invalid report date range');
    }
    const cutoverDate=assertStatementRange(year,from,to);
    const rows=(await db.query<Movement>(
      `SELECT a.id account_id,a.code,a.name,a.name_ar,a.name_en,a.account_type,a.statement_category,a.is_contra,
              COALESCE(SUM(l.debit),0)::text debit,COALESCE(SUM(l.credit),0)::text credit,
              COALESCE(SUM(CASE WHEN j.entry_type='opening_balance' OR (j.entry_type='cutover_balance' AND a.statement_category='equity') THEN l.debit ELSE 0 END),0)::text opening_debit,
              COALESCE(SUM(CASE WHEN j.entry_type='opening_balance' OR (j.entry_type='cutover_balance' AND a.statement_category='equity') THEN l.credit ELSE 0 END),0)::text opening_credit,
              COALESCE(SUM(CASE WHEN j.entry_type='cutover_balance' THEN l.debit ELSE 0 END),0)::text cutover_debit,
              COALESCE(SUM(CASE WHEN j.entry_type='cutover_balance' THEN l.credit ELSE 0 END),0)::text cutover_credit
       FROM journal_lines l
       JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
       JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id
       WHERE l.company_id=$1 AND j.company_id=$1 AND j.fiscal_year_id=$2
         AND j.status='posted' AND j.accounting_date BETWEEN $3 AND $4
       GROUP BY a.id,a.code,a.name,a.name_ar,a.name_en,a.account_type,a.statement_category,a.is_contra
       ORDER BY a.code,a.id`,
      [companyId,fiscalYearId,from,to],
    )).rows;
    const accounts=rows.map(({opening_debit:_od,opening_credit:_oc,cutover_debit:_cd,cutover_credit:_cc,...row})=>({...row,amount:accountAmount(row).toFixed(2)}));
    const openingAccounts=rows.map(({opening_debit:debit,opening_credit:credit,cutover_debit:_cd,cutover_credit:_cc,...row})=>({...row,debit,credit,amount:accountAmount({...row,debit,credit}).toFixed(2)}));
    // S1: the part of each amount that comes from the cut-over journal (imported, dates up to D); zero when the range starts after D.
    const importedAmounts=rows.map(row=>accountAmount({...row,debit:row.cutover_debit,credit:row.cutover_credit}));
    // Only years with an active cut-over range disclose anything; January-1 companies get no extra query or field.
    const disclosure:CutoverDisclosure|null=cutoverDate?await loadCutoverDisclosure(db,companyId,fiscalYearId):null;
    const unmapped=accounts.filter((row,index)=>row.statement_category==='unmapped'&&(Number(rows[index]!.debit)!==0||Number(rows[index]!.credit)!==0));
    if(unmapped.length)throw new FinancialStatementUnmappedError(unmapped);
    return{fiscal_year_id:fiscalYearId,start_date:from,end_date:to,cutover_date:cutoverDate,accounts,openingAccounts,importedAmounts,disclosure};
  }

  private sections(accounts:StatementAccount[],categories:StatementCategory[]){
    return categories.map(category=>{
      const categoryAccounts=accounts.filter(account=>account.statement_category===category);
      return{category,accounts:categoryAccounts,total:categoryAccounts.reduce((sum,account)=>sum+Number(account.amount),0).toFixed(2)};
    });
  }

  async financialPosition(companyId:string,fiscalYearId:string,asOf?:string){
    const report=await this.movements(companyId,fiscalYearId,undefined,asOf);
    const sections=this.sections(report.accounts,financialPositionCategories);
    const total=(categories:StatementCategory[])=>sections.filter(section=>categories.includes(section.category)).reduce((sum,section)=>sum+Number(section.total),0);
    const currentPeriodEarnings=this.earnings(report.accounts);
    const assets=total(['current_asset','non_current_asset']);
    const liabilities=total(['current_liability','non_current_liability']);
    const equity=total(['equity'])+currentPeriodEarnings;
    const difference=assets-liabilities-equity;
    const{openingAccounts:_,importedAmounts:_i,disclosure,...publicReport}=report;
    return{...publicReport,...preCutover(disclosure,'financial_position',report.start_date===disclosure?.cutover_from),as_of_date:report.end_date,statement:'financial_position',sections,total_assets:assets.toFixed(2),total_liabilities:liabilities.toFixed(2),current_period_earnings:currentPeriodEarnings.toFixed(2),total_equity:equity.toFixed(2),accounting_equation:{assets:assets.toFixed(2),liabilities_and_equity:(liabilities+equity).toFixed(2),difference:difference.toFixed(2),balanced:Math.abs(difference)<0.005}};
  }

  async profitOrLoss(companyId:string,fiscalYearId:string,start?:string,end?:string){
    const report=await this.movements(companyId,fiscalYearId,start,end);
    const sections=this.sections(report.accounts,profitOrLossCategories);
    const profit=this.earnings(report.accounts);
    const{openingAccounts:_,importedAmounts,disclosure,...publicReport}=report;
    const base={...publicReport,statement:'profit_or_loss' as const,sections,profit_or_loss:profit.toFixed(2)};
    if(!disclosure)return base;
    // Imported (cut-over journal, dates up to D) vs native (after D) columns. Both come from the same posted ledger, so imported + native = amount.
    const imported=report.accounts.map((account,index)=>({...account,amount:(Math.abs(importedAmounts[index]!)<0.005?0:importedAmounts[index]!).toFixed(2)}));
    const money=(value:number)=>(Math.abs(value)<0.005?0:value).toFixed(2); // never "-0.00" from a float difference
    const native=report.accounts.map((account,index)=>({...account,amount:money(Number(account.amount)-importedAmounts[index]!)}));
    const importedById=new Map(imported.map(account=>[account.account_id,account.amount]));
    const nativeById=new Map(native.map(account=>[account.account_id,account.amount]));
    const importedSections=this.sections(imported,profitOrLossCategories),nativeSections=this.sections(native,profitOrLossCategories);
    const importedProfit=this.earnings(imported);
    return{
      ...base,...preCutover(disclosure,'income_statement',report.start_date===disclosure.cutover_from),
      sections:sections.map((section,index)=>({
        ...section,imported_total:importedSections[index]!.total,native_total:nativeSections[index]!.total,
        accounts:section.accounts.map(account=>({...account,imported_amount:importedById.get(account.account_id)!,native_amount:nativeById.get(account.account_id)!})),
      })),
      profit_or_loss_split:{imported:money(importedProfit),native:money(profit-importedProfit)},
    };
  }

  async changesInEquity(companyId:string,fiscalYearId:string,start?:string,end?:string){
    const client=await this.db.connect();
    try{
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const period=await this.movements(companyId,fiscalYearId,start,end,client);
      const closing=await this.movements(companyId,fiscalYearId,undefined,period.end_date,client);
      const previousDate=new Date(`${period.start_date}T00:00:00Z`);
      previousDate.setUTCDate(previousDate.getUTCDate()-1);
      const previousEnd=previousDate.toISOString().slice(0,10);
      const opening=previousEnd<closing.start_date
        ? {accounts:[] as StatementAccount[]}
        : await this.movements(companyId,fiscalYearId,undefined,previousEnd,client);
      const openingBalanceAccounts=period.start_date===closing.start_date?period.openingAccounts:[];
      const periodAccounts=period.accounts.map((account,index)=>({...account,amount:(Number(account.amount)-Number(period.openingAccounts[index]!.amount)).toFixed(2)}));
      const equityAccounts=periodAccounts.filter(account=>account.statement_category==='equity');
      const fullYearRange=Boolean(period.disclosure)&&period.start_date===period.disclosure!.cutover_from;
      const supplement=fullYearRange&&period.disclosure!.completeness.changes_in_equity.full_year_complete?period.disclosure!.supplements!.equity:null;
      if(supplement){
        await client.query('COMMIT');
        return this.fullYearEquity(fiscalYearId,period,periodAccounts,equityAccounts,closing.accounts,supplement.lines);
      }
      const openingEquity=this.equityWithEarnings(opening.accounts)+this.equityWithEarnings(openingBalanceAccounts);
      const directEquityMovements=equityAccounts.reduce((sum,account)=>sum+Number(account.amount),0);
      const currentPeriodEarnings=this.earnings(periodAccounts);
      const closingEquity=openingEquity+directEquityMovements+currentPeriodEarnings;
      const financialPositionEquity=this.equityWithEarnings(closing.accounts);
      const difference=closingEquity-financialPositionEquity;
      await client.query('COMMIT');
      return{
        fiscal_year_id:fiscalYearId,start_date:period.start_date,end_date:period.end_date,cutover_date:period.cutover_date,
        ...preCutover(period.disclosure,'changes_in_equity',fullYearRange),
        statement:'changes_in_equity',opening_equity:openingEquity.toFixed(2),
        direct_equity_movements:directEquityMovements.toFixed(2),equity_accounts:equityAccounts,
        current_period_earnings:currentPeriodEarnings.toFixed(2),closing_equity:closingEquity.toFixed(2),
        reconciliation:{expected:closingEquity.toFixed(2),actual:financialPositionEquity.toFixed(2),difference:difference.toFixed(2),balanced:Math.abs(difference)<0.005},
      };
    }catch(error){
      await client.query('ROLLBACK');
      throw error;
    }finally{
      client.release();
    }
  }

  /**
   * S2 full-year changes in equity (spec v2 E): opening = the supplement's 1 Jan balances; movements = supplement movements (1 Jan -> D) +
   * native direct equity movements after D; result = the year's profit (cut-over journal P&L + native). The cut-over journal's equity lines are
   * NOT movements: they are the D balances the supplement rolls forward to (E1), so nothing is counted twice. Exact halalas; the closing equity
   * must equal the financial position's equity exactly.
   */
  private fullYearEquity(fiscalYearId:string,period:Awaited<ReturnType<FinancialStatementsService['movements']>>,periodAccounts:StatementAccount[],equityAccounts:StatementAccount[],closingAccounts:StatementAccount[],lines:SupplementLine[]){
    const exact=(value:number)=>cents(value.toFixed(2));
    const openings=lines.filter(line=>line.line_type==='equity_opening'),movements=lines.filter(line=>line.line_type==='equity_movement');
    const openingEquity=openings.reduce((sum,line)=>sum+cents(line.opening_amount!),0n);
    const supplementMovements=movements.reduce((sum,line)=>sum+cents(line.amount!),0n);
    const nativeMovements=equityAccounts.reduce((sum,account)=>sum+cents(account.amount),0n);
    const earnings=exact(this.earnings(periodAccounts));
    const closingEquity=openingEquity+supplementMovements+nativeMovements+earnings;
    const financialPositionEquity=exact(this.equityWithEarnings(closingAccounts));
    const difference=closingEquity-financialPositionEquity;
    const byType=(type:string)=>exactMoney(movements.filter(line=>line.movement_type===type).reduce((sum,line)=>sum+cents(line.amount!),0n));
    return{
      fiscal_year_id:fiscalYearId,start_date:period.start_date,end_date:period.end_date,cutover_date:period.cutover_date,
      ...preCutover(period.disclosure,'changes_in_equity',true),
      statement:'changes_in_equity',opening_equity:exactMoney(openingEquity),
      direct_equity_movements:exactMoney(supplementMovements+nativeMovements),equity_accounts:equityAccounts,
      current_period_earnings:exactMoney(earnings),closing_equity:exactMoney(closingEquity),
      pre_cutover_equity:{
        opening_equity:exactMoney(openingEquity),movements:exactMoney(supplementMovements),native_movements:exactMoney(nativeMovements),
        movements_by_type:{contribution:byType('contribution'),distribution:byType('distribution'),transfer:byType('transfer'),other:byType('other')},
        accounts:openings.map(line=>({account_id:line.account_id!,opening_amount:line.opening_amount!,movements:movements.filter(m=>m.account_id===line.account_id).map(m=>({movement_type:m.movement_type!,label:m.label!,amount:m.amount!}))})),
        source:'pre_cutover_supplement' as const,
      },
      reconciliation:{expected:exactMoney(closingEquity),actual:exactMoney(financialPositionEquity),difference:exactMoney(difference),balanced:difference===0n},
    };
  }

  private earnings(accounts:StatementAccount[]){
    return this.sections(accounts,profitOrLossCategories).reduce((sum,section)=>sum+(section.category.includes('expense')||section.category==='cost_of_sales'?-Number(section.total):Number(section.total)),0);
  }

  private equityWithEarnings(accounts:StatementAccount[]){
    return accounts.filter(account=>account.statement_category==='equity').reduce((sum,account)=>sum+Number(account.amount),0)+this.earnings(accounts);
  }
}
