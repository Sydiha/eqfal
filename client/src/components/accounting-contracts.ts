export type StatementCategory=
 |'unmapped'
 |'current_asset'
 |'non_current_asset'
 |'current_liability'
 |'non_current_liability'
 |'equity'
 |'revenue'
 |'cost_of_sales'
 |'operating_expense'
 |'finance_income'
 |'finance_expense'
 |'other_income'
 |'other_expense';
export type CashRole='non_cash'|'cash'|'cash_equivalent';
export type CashFlowCategory='unmapped'|'operating'|'investing'|'financing';

export type AccountResponse={
 id:string;
 code:string;
 name:string;
 name_ar?:string|null;
 name_en?:string|null;
 account_type:'asset'|'liability'|'equity'|'revenue'|'expense';
 parent_account_id:string|null;
 is_active:boolean;
 statement_category?:StatementCategory;
 is_contra?:boolean;
 cash_role?:CashRole;
 cash_flow_category?:CashFlowCategory;
 is_used?:boolean;
 has_children?:boolean;
};
export type JournalResponse={id:string;fiscal_year_id:string;accounting_date:string;description:string;reference:string|null;entry_type:'standard'|'opening_balance';status:'draft'|'posted'};
export type JournalLineResponse={id:string;company_id:string;journal_entry_id:string;account_id:string;debit:string;credit:string;memo:string|null;sequence:number};

export type JournalLineEditor={account_id:string;debit:string;credit:string;memo:string};
export type JournalLineWriteDTO={account_id:string;debit:string;credit:string;memo:string|null};
export type JournalLinesWriteDTO={lines:JournalLineWriteDTO[]};

export function journalLineToEditor(line:JournalLineResponse):JournalLineEditor{
 return{account_id:line.account_id,debit:line.debit,credit:line.credit,memo:line.memo??''};
}

export function serializeJournalLines(lines:JournalLineEditor[]):JournalLinesWriteDTO{
 return{lines:lines.map(line=>({account_id:line.account_id,debit:line.debit,credit:line.credit,memo:line.memo||null}))};
}

export type AccountNames={name:string;name_ar?:string|null;name_en?:string|null};
// Display-only localization: Arabic UI prefers name_ar, English UI prefers name_en. Once an account has any
// localized name the legacy `name` is only compatibility storage (it is not rewritten on edit and can be stale),
// so the other language is used before it. Legacy accounts with no localized name keep showing `name`.
// Nothing is translated or guessed.
export const localizedAccountName=(account:AccountNames,language:string)=>{
 const ar=language.startsWith('ar');
 const own=ar?account.name_ar:account.name_en,other=ar?account.name_en:account.name_ar;
 return own||other||account.name||'';
};
