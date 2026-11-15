import { PoolClient } from 'pg';
import { resolveBankLedgerAccount } from './personal-payment-posting';
import { toCents } from '../banking/bank-reconciliation-core';
import { JournalPostingValidationError } from './journal-posting-errors';
import type { OperationalSource } from './operational-sources';

type Runner = Pick<PoolClient,'query'>;
const fail=(message:string)=>new JournalPostingValidationError(message);

export async function resolveEmployeeAdvanceLedgerAccount(client:Runner,companyId:string,lock:boolean):Promise<string|null>{
  const row=(await client.query<{account_id:string}>(`SELECT m.account_id FROM employee_salary_advance_account_mappings m
    JOIN accounts a ON a.id=m.account_id AND a.company_id=m.company_id
    WHERE m.company_id=$1 AND a.is_active AND a.account_type='asset' AND a.statement_category='current_asset'
    AND NOT EXISTS(SELECT 1 FROM bank_account_ledger_links b WHERE b.company_id=m.company_id AND b.account_id=m.account_id)
    ${lock?'FOR SHARE OF m,a':''}`,[companyId])).rows[0];
  return row?.account_id??null;
}

export async function assertEmployeeAdvanceJournal(client:Runner,companyId:string,journalId:string,source:OperationalSource):Promise<void>{
  if(source.source_type!=='employee_advance_funding')return;
  const advanceAccount=await resolveEmployeeAdvanceLedgerAccount(client,companyId,true);
  if(!advanceAccount)throw fail('Employee advance receivable account is not configured or is invalid');
  const bankId=source.context?.bank_account_id;
  if(typeof bankId!=='string')throw fail('Employee advance bank account cannot be determined');
  const bankLedger=await resolveBankLedgerAccount(client,companyId,bankId,source.accounting_date,true);
  if(!bankLedger||bankLedger===advanceAccount)throw fail('Employee advance bank ledger mapping is missing or conflicts with the receivable account');
  const lines=(await client.query<{account_id:string;debit:string;credit:string;n:string}>(`SELECT account_id,SUM(debit)::numeric(18,2)::text debit,SUM(credit)::numeric(18,2)::text credit,COUNT(*)::text n
    FROM journal_lines WHERE journal_entry_id=$1 AND company_id=$2 GROUP BY account_id`,[journalId,companyId])).rows;
  const amount=toCents(source.amount),zero=(x:string)=>toCents(x)===0n,exact=(x:string)=>toCents(x)===amount;
  const debit=lines.find(x=>x.account_id===advanceAccount),credit=lines.find(x=>x.account_id===bankLedger);
  if(lines.length!==2||!debit||!credit||debit.n!=='1'||credit.n!=='1'||!exact(debit.debit)||!zero(debit.credit)||!exact(credit.credit)||!zero(credit.debit))
    throw fail('Employee advance funding journal must debit the receivable and credit the linked bank ledger by exactly the advance amount');
}
