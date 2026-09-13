import { Pool } from 'pg';
import type { StatementCategory } from './account-classification.router';

export const FINANCIAL_STATEMENT_UNMAPPED_CODE='FINANCIAL_STATEMENT_UNMAPPED_ACCOUNTS';

export class FinancialStatementValidationError extends Error{}
export class FinancialStatementNotFoundError extends Error{}
export class FinancialStatementUnmappedError extends Error{
  constructor(readonly accounts:StatementAccount[]){super('Posted activity exists on unmapped accounts');}
}

export type StatementAccount={
  account_id:string;code:string;name:string;account_type:string;
  statement_category:StatementCategory;is_contra:boolean;amount:string;
};
type Movement=Omit<StatementAccount,'amount'>&{debit:string;credit:string};

const DATE=/^\d{4}-\d{2}-\d{2}$/;
const validDate=(value:string)=>DATE.test(value)&&!Number.isNaN(Date.parse(`${value}T00:00:00Z`));
const financialPositionCategories:StatementCategory[]=['current_asset','non_current_asset','current_liability','non_current_liability','equity'];
const profitOrLossCategories:StatementCategory[]=['revenue','cost_of_sales','operating_expense','finance_income','finance_expense','other_income','other_expense'];

const accountAmount=(row:Movement)=>{
  const debit=Number(row.debit),credit=Number(row.credit);
  if(row.account_type==='asset')return row.is_contra?debit-credit:debit-credit;
  if(row.account_type==='expense')return debit-credit;
  return credit-debit;
};

export class FinancialStatementsService{
  constructor(private db:Pool){}

  private async movements(companyId:string,fiscalYearId:string,start?:string,end?:string){
    const year=(await this.db.query<{start_date:string;end_date:string}>(
      'SELECT start_date::text,end_date::text FROM fiscal_years WHERE id=$1 AND company_id=$2',
      [fiscalYearId,companyId],
    )).rows[0];
    if(!year)throw new FinancialStatementNotFoundError();
    const from=start??year.start_date,to=end??year.end_date;
    if(!validDate(from)||!validDate(to)||from>to||from<year.start_date||to>year.end_date){
      throw new FinancialStatementValidationError('Invalid report date range');
    }
    const rows=(await this.db.query<Movement>(
      `SELECT a.id account_id,a.code,a.name,a.account_type,a.statement_category,a.is_contra,
              COALESCE(SUM(l.debit),0)::text debit,COALESCE(SUM(l.credit),0)::text credit
       FROM journal_lines l
       JOIN journal_entries j ON j.id=l.journal_entry_id AND j.company_id=l.company_id
       JOIN accounts a ON a.id=l.account_id AND a.company_id=l.company_id
       WHERE l.company_id=$1 AND j.company_id=$1 AND j.fiscal_year_id=$2
         AND j.status='posted' AND j.accounting_date BETWEEN $3 AND $4
       GROUP BY a.id,a.code,a.name,a.account_type,a.statement_category,a.is_contra
       ORDER BY a.code,a.id`,
      [companyId,fiscalYearId,from,to],
    )).rows;
    const accounts=rows.map(row=>({...row,amount:accountAmount(row).toFixed(2)}));
    const unmapped=accounts.filter(row=>row.statement_category==='unmapped'&&Number(row.amount)!==0);
    if(unmapped.length)throw new FinancialStatementUnmappedError(unmapped);
    return{fiscal_year_id:fiscalYearId,start_date:from,end_date:to,accounts};
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
    return{...report,as_of_date:report.end_date,statement:'financial_position',sections,total_assets:assets.toFixed(2),total_liabilities:liabilities.toFixed(2),current_period_earnings:currentPeriodEarnings.toFixed(2),total_equity:equity.toFixed(2),accounting_equation:{assets:assets.toFixed(2),liabilities_and_equity:(liabilities+equity).toFixed(2),difference:difference.toFixed(2),balanced:Math.abs(difference)<0.005}};
  }

  async profitOrLoss(companyId:string,fiscalYearId:string,start?:string,end?:string){
    const report=await this.movements(companyId,fiscalYearId,start,end);
    const sections=this.sections(report.accounts,profitOrLossCategories);
    const profit=this.earnings(report.accounts);
    return{...report,statement:'profit_or_loss',sections,profit_or_loss:profit.toFixed(2)};
  }

  async changesInEquity(companyId:string,fiscalYearId:string,start?:string,end?:string){
    const period=await this.movements(companyId,fiscalYearId,start,end);
    const closing=await this.movements(companyId,fiscalYearId,undefined,period.end_date);
    const previousDate=new Date(`${period.start_date}T00:00:00Z`);
    previousDate.setUTCDate(previousDate.getUTCDate()-1);
    const previousEnd=previousDate.toISOString().slice(0,10);
    const opening=previousEnd<closing.start_date
      ? {accounts:[] as StatementAccount[]}
      : await this.movements(companyId,fiscalYearId,undefined,previousEnd);
    const equityAccounts=period.accounts.filter(account=>account.statement_category==='equity');
    const openingEquity=this.equityWithEarnings(opening.accounts);
    const directEquityMovements=equityAccounts.reduce((sum,account)=>sum+Number(account.amount),0);
    const currentPeriodEarnings=this.earnings(period.accounts);
    const closingEquity=openingEquity+directEquityMovements+currentPeriodEarnings;
    const financialPositionEquity=this.equityWithEarnings(closing.accounts);
    const difference=closingEquity-financialPositionEquity;
    return{
      fiscal_year_id:fiscalYearId,start_date:period.start_date,end_date:period.end_date,
      statement:'changes_in_equity',opening_equity:openingEquity.toFixed(2),
      direct_equity_movements:directEquityMovements.toFixed(2),equity_accounts:equityAccounts,
      current_period_earnings:currentPeriodEarnings.toFixed(2),closing_equity:closingEquity.toFixed(2),
      reconciliation:{expected:closingEquity.toFixed(2),actual:financialPositionEquity.toFixed(2),difference:difference.toFixed(2),balanced:Math.abs(difference)<0.005},
    };
  }

  private earnings(accounts:StatementAccount[]){
    return this.sections(accounts,profitOrLossCategories).reduce((sum,section)=>sum+(section.category.includes('expense')||section.category==='cost_of_sales'?-Number(section.total):Number(section.total)),0);
  }

  private equityWithEarnings(accounts:StatementAccount[]){
    return accounts.filter(account=>account.statement_category==='equity').reduce((sum,account)=>sum+Number(account.amount),0)+this.earnings(accounts);
  }
}
