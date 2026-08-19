export type AccountResponse={id:string;code:string;name:string;account_type:'asset'|'liability'|'equity'|'revenue'|'expense';parent_account_id:string|null;is_active:boolean};
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
