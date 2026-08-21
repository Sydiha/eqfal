import { describe, expect, it } from 'vitest';
import { inferBankColumnMapping, parseBankFile } from '../src/modules/banking/bank.router';

function zip(entries:Record<string,string>):Buffer{
  const locals:Buffer[]=[]; const centrals:Buffer[]=[]; let offset=0;
  for(const [name,text] of Object.entries(entries)){
    const n=Buffer.from(name); const d=Buffer.from(text); const local=Buffer.alloc(30); local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(20,4);local.writeUInt16LE(0,6);local.writeUInt16LE(0,8);local.writeUInt32LE(0,14);local.writeUInt32LE(d.length,18);local.writeUInt32LE(d.length,22);local.writeUInt16LE(n.length,26);locals.push(local,n,d);
    const central=Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(20,4);central.writeUInt16LE(20,6);central.writeUInt16LE(0,8);central.writeUInt16LE(0,10);central.writeUInt32LE(0,16);central.writeUInt32LE(d.length,20);central.writeUInt32LE(d.length,24);central.writeUInt16LE(n.length,28);central.writeUInt32LE(offset,42);centrals.push(central,n);offset+=30+n.length+d.length;
  }
  const centralStart=offset; const centralData=Buffer.concat(centrals); const end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(Object.keys(entries).length,8);end.writeUInt16LE(Object.keys(entries).length,10);end.writeUInt32LE(centralData.length,12);end.writeUInt32LE(centralStart,16);return Buffer.concat([...locals,centralData,end]);
}

const s=(ref:string,value:string)=>`<c r="${ref}" t="inlineStr"><is><t>${value}</t></is></c>`;
const n=(ref:string,value:number)=>`<c r="${ref}"><v>${value}</v></c>`;

function workbook(sheets:{name:string;xml:string}[]):Buffer{
  const sheetTags=sheets.map((sheet,index)=>`<sheet name="${sheet.name}" r:id="rId${index+1}"/>`).join('');
  const relTags=sheets.map((_sheet,index)=>`<Relationship Id="rId${index+1}" Target="worksheets/sheet${index+1}.xml"/>`).join('');
  const entries:Record<string,string>={
    'xl/workbook.xml':`<workbook xmlns:r="r"><sheets>${sheetTags}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':`<Relationships>${relTags}</Relationships>`,
  };
  sheets.forEach((sheet,index)=>{entries[`xl/worksheets/sheet${index+1}.xml`]=sheet.xml;});
  return zip(entries);
}

function sheet(rows:string[]):string{return `<worksheet><sheetData>${rows.join('')}</sheetData></worksheet>`;}
function row(number:number,cells:string[]):string{return `<row r="${number}">${cells.join('')}</row>`;}


describe('bank import auto-mapping inference',()=>{
  it('infers the supplied one-row CSV without manual mapping',()=>{
    const table=parseBankFile('csv',Buffer.from([
      'date,description,reference,amount',
      '8/21/2026,EQFAL sales E2E test,E2E-SALE-1150-001,1150',
    ].join('\n')));

    expect(inferBankColumnMapping(table)).toEqual({
      amount_mode:'signed',
      date_format:'MM/DD/YYYY',
      transaction_date:{index:0,label:'date'},
      amount:{index:3,label:'amount'},
      description:{index:1,label:'description'},
      bank_reference:{index:2,label:'reference'},
    });
  });

  it('falls back instead of guessing an ambiguous slash date',()=>{
    const table=parseBankFile('csv',Buffer.from([
      'date,description,reference,amount',
      '8/9/2026,Ambiguous date,R1,100',
    ].join('\n')));

    expect(inferBankColumnMapping(table)).toBeNull();
  });
});

describe('real bank statement transaction-table detection',()=>{
  it('detects an Arabic debit/credit table after statement metadata and excludes the footer',()=>{
    const metadata=[
      row(2,[s('A2','كشف الحساب')]),
      row(7,[s('K7','شركة اختبار'),s('L7','اسم العميل')]),
      row(9,[s('K9','123456789'),s('L9','رقم الحساب')]),
      row(14,[n('K14',50064.5),s('L14','الرصيد الافتتاحي')]),
      row(15,[n('K15',617906.43),s('L15','رصيد الاغلاق')]),
    ];
    const header=row(17,[s('G17','الرصيد'),s('H17','مدين'),s('I17','دائن'),s('J17','تفاصيل العملية'),s('K17','تفاصيل العملية'),s('L17','التاريخ الميلادي')]);
    const transactions=[
      row(18,[n('G18',35564.5),n('H18',-14500),n('I18',0),s('J18','حوالة صادرة'),s('K18','REF-1'),s('L18','05/10/2025')]),
      row(19,[n('G19',35563.35),n('H19',-1.15),n('I19',0),s('J19','رسوم'),s('K19','REF-1'),s('L19','05/10/2025')]),
      row(20,[n('G20',45563.35),n('H20',0),n('I20',10000),s('J20','حوالة واردة'),s('K20','REF-2'),s('L20','06/10/2025')]),
    ];
    const footer=[
      row(309,[s('K309','1'),s('L309','عدد عمليات الايداع')]),
      row(310,[s('K310','2'),s('L310','عدد عمليات الخصم')]),
      row(311,[n('K311',50064.5),s('L311','الرصيد الافتتاحي')]),
      row(314,[n('K314',617906.43),s('L314','رصيد الاغلاق')]),
    ];
    const table=parseBankFile('xlsx',workbook([{name:'Sheet 1',xml:sheet([...metadata,header,...transactions,...footer])}]));
    expect(table.headers.slice(6,12)).toEqual(['الرصيد','مدين','دائن','تفاصيل العملية','تفاصيل العملية','التاريخ الميلادي']);
    expect(table.rows).toHaveLength(3);
    expect(table.sourceRowNumbers).toEqual([18,19,20]);
    expect(table.rows[0]?.[11]).toBe('05/10/2025');
    expect(table.rows.some((r)=>String(r[11]??'').includes('عدد عمليات'))).toBe(false);
  });

  it('selects the worksheet that actually contains transactions instead of the first non-empty sheet',()=>{
    const cover=sheet([row(1,[s('A1','Account statement')]),row(2,[s('A2','Customer'),s('B2','Example')])]);
    const data=sheet([
      row(8,[s('A8','Posting Date'),s('B8','Narration'),s('C8','Amount'),s('D8','Balance')]),
      row(9,[s('A9','2026-08-01'),s('B9','Sale'),n('C9',100),n('D9',1000)]),
      row(10,[s('A10','2026-08-02'),s('B10','Fee'),n('C10',-5),n('D10',995)]),
    ]);
    const table=parseBankFile('xlsx',workbook([{name:'Cover',xml:cover},{name:'Transactions',xml:data}]));
    expect(table.headers.slice(0,4)).toEqual(['Posting Date','Narration','Amount','Balance']);
    expect(table.sourceRowNumbers).toEqual([9,10]);
  });

  it('detects transaction tables in CSV after preamble rows and keeps malformed rows inside the detected region',()=>{
    const csv=Buffer.from([
      'Account Statement',
      'Account Number,12345',
      '',
      'Date,Description,Amount,Reference',
      '2026-08-01,Sale,100.00,R1',
      'not-a-date,Needs review,25.00,R2',
      '2026-08-03,Fee,-5.00,R3',
      '',
      'Total,,,120.00',
    ].join('\n'));
    const table=parseBankFile('csv',csv);
    expect(table.headers).toEqual(['Date','Description','Amount','Reference']);
    expect(table.sourceRowNumbers).toEqual([5,6,7]);
    expect(table.rows[1]?.[0]).toBe('not-a-date');
  });

  it('accepts a valid CSV containing exactly one transaction row',()=>{
    const csv=Buffer.from([
      'date,description,reference,amount',
      '8/21/2026,EQFAL sales E2E test,E2E-SALE-1150-001,1150',
    ].join('\n'));
    const table=parseBankFile('csv',csv);
    expect(table.headers).toEqual(['date','description','reference','amount']);
    expect(table.sourceRowNumbers).toEqual([2]);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]).toEqual(['8/21/2026','EQFAL sales E2E test','E2E-SALE-1150-001','1150']);
  });

  it('rejects a rich-looking candidate backed by only one transaction-like row',()=>{
    const csv=Buffer.from([
      'Account Statement',
      'Date,Description,Amount,Balance,Reference',
      '2026-08-01,Possible example,100.00,1000.00,R1',
      'Customer Name,Example,,,',
      'Closing Balance,,,1000.00,',
    ].join('\n'));
    expect(()=>parseBankFile('csv',csv)).toThrow(/detect bank transaction table/);
  });

  it('still accepts a genuinely small statement with two consistent transactions',()=>{
    const csv=Buffer.from([
      'Statement',
      'Date,Description,Amount,Balance',
      '2026-08-01,Sale,100.00,1100.00',
      '2026-08-02,Fee,-5.00,1095.00',
      'Closing Balance,,,1095.00',
    ].join('\n'));
    const table=parseBankFile('csv',csv);
    expect(table.headers).toEqual(['Date','Description','Amount','Balance']);
    expect(table.sourceRowNumbers).toEqual([3,4]);
    expect(table.rows).toHaveLength(2);
  });

  it('fails closed when no credible transaction table can be found',()=>{
    const csv=Buffer.from('Account Statement\nCustomer,Example\nOpening Balance,1000\nClosing Balance,900\n');
    expect(()=>parseBankFile('csv',csv)).toThrow(/detect bank transaction table/);
  });
});
