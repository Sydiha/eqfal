import { Pool } from 'pg';

type QueryRunner = Pick<Pool, 'query'>;
export type VatDocumentType = 'purchase' | 'expense' | 'sale';
export type VatTreatment = 'standard' | 'zero_rated' | 'exempt' | 'out_of_scope';

export interface VatReportDocument {
  id: string;
  original_filename: string;
  document_type: VatDocumentType;
  document_date: string | null;
  counterparty_name: string | null;
  total_amount: string | null;
  tax_date: string;
  treatment: VatTreatment;
  taxable_amount: string;
  vat_amount: string;
}

export interface VatClosingReport {
  period: { id: string; period_start: string; period_end: string; status: 'closed' };
  company: { id: string; name: string };
  totals: { output_vat: number; input_vat: number; net_vat: number; sales_total: number; purchase_expense_total: number };
  treatments: Record<VatTreatment, { count: number; taxable_amount: number; vat_amount: number }>;
  documents: VatReportDocument[];
}

export class VatReportNotFoundError extends Error {}
export class VatReportOpenPeriodError extends Error {}

const treatments: VatTreatment[] = ['standard', 'zero_rated', 'exempt', 'out_of_scope'];

export async function loadVatClosingReport(db: QueryRunner, companyId: string, periodId: string): Promise<VatClosingReport> {
  const periodResult = await db.query<{
    id: string; period_start: string; period_end: string; status: 'open' | 'closed'; company_name: string;
  }>(`SELECT vp.id, vp.period_start::text, vp.period_end::text, vp.status, c.name AS company_name
      FROM vat_periods vp JOIN companies c ON c.id=vp.company_id
      WHERE vp.id=$1 AND vp.company_id=$2`, [periodId, companyId]);
  const period = periodResult.rows[0];
  if (!period) throw new VatReportNotFoundError();
  if (period.status !== 'closed') throw new VatReportOpenPeriodError();

  const documentResult = await db.query<VatReportDocument>(`SELECT d.id,d.original_filename,d.document_type,d.document_date::text,d.counterparty_name,d.total_amount::text,
      r.tax_date::text,r.treatment,r.taxable_amount::text,r.vat_amount::text
      FROM documents d JOIN document_vat_reviews r ON r.document_id=d.id AND r.company_id=d.company_id
      WHERE d.company_id=$1 AND d.status='approved' AND d.document_type IN ('purchase','expense','sale')
        AND r.review_status='reviewed'
        AND ((d.document_date BETWEEN $2 AND $3) OR (r.tax_date BETWEEN $2 AND $3))
      ORDER BY r.tax_date,d.created_at,d.id`, [companyId, period.period_start, period.period_end]);

  const treatmentTotals = Object.fromEntries(treatments.map(t => [t, { count: 0, taxable_amount: 0, vat_amount: 0 }])) as VatClosingReport['treatments'];
  let output = 0, input = 0, salesTotal = 0, purchaseExpenseTotal = 0;
  for (const document of documentResult.rows) {
    const vat = Number(document.vat_amount || 0);
    const taxable = Number(document.taxable_amount || 0);
    const total = Number(document.total_amount || 0);
    const bucket = treatmentTotals[document.treatment];
    bucket.count += 1; bucket.taxable_amount += taxable; bucket.vat_amount += vat;
    if (document.document_type === 'sale') { output += vat; salesTotal += total; }
    else { input += vat; purchaseExpenseTotal += total; }
  }

  return {
    period: { id: period.id, period_start: period.period_start, period_end: period.period_end, status: 'closed' },
    company: { id: companyId, name: period.company_name },
    totals: { output_vat: output, input_vat: input, net_vat: output - input, sales_total: salesTotal, purchase_expense_total: purchaseExpenseTotal },
    treatments: treatmentTotals,
    documents: documentResult.rows,
  };
}

function xml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function colName(index: number): string { let n=index+1,s=''; while(n){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);} return s; }
function crc32(buffer: Buffer): number {
  let crc=0xffffffff;
  for (const byte of buffer) { crc ^= byte; for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xedb88320:0); }
  return (crc^0xffffffff)>>>0;
}
function zipStore(files: Array<{name:string;data:Buffer}>): Buffer {
  const locals: Buffer[]=[]; const centrals: Buffer[]=[]; let offset=0;
  for (const file of files) {
    const name=Buffer.from(file.name); const crc=crc32(file.data); const local=Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50,0); local.writeUInt16LE(20,4); local.writeUInt16LE(0,6); local.writeUInt16LE(0,8);
    local.writeUInt16LE(0,10); local.writeUInt16LE(0,12); local.writeUInt32LE(crc,14); local.writeUInt32LE(file.data.length,18); local.writeUInt32LE(file.data.length,22); local.writeUInt16LE(name.length,26); local.writeUInt16LE(0,28);
    locals.push(local,name,file.data);
    const central=Buffer.alloc(46); central.writeUInt32LE(0x02014b50,0); central.writeUInt16LE(20,4); central.writeUInt16LE(20,6); central.writeUInt16LE(0,8); central.writeUInt16LE(0,10); central.writeUInt16LE(0,12); central.writeUInt16LE(0,14); central.writeUInt32LE(crc,16); central.writeUInt32LE(file.data.length,20); central.writeUInt32LE(file.data.length,24); central.writeUInt16LE(name.length,28); central.writeUInt16LE(0,30); central.writeUInt16LE(0,32); central.writeUInt16LE(0,34); central.writeUInt16LE(0,36); central.writeUInt32LE(0,38); central.writeUInt32LE(offset,42);
    centrals.push(central,name); offset += local.length+name.length+file.data.length;
  }
  const centralSize=centrals.reduce((n,b)=>n+b.length,0); const end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0); end.writeUInt16LE(0,4); end.writeUInt16LE(0,6); end.writeUInt16LE(files.length,8); end.writeUInt16LE(files.length,10); end.writeUInt32LE(centralSize,12); end.writeUInt32LE(offset,16); end.writeUInt16LE(0,20);
  return Buffer.concat([...locals,...centrals,end]);
}

export function buildVatWorkingPaperXlsx(report: VatClosingReport): Buffer {
  const headers=['Document','Customer / Supplier','Type','Document Date','Tax Date','Total','Treatment','Taxable Amount','VAT Amount'];
  const rows: Array<Array<string|number>>=[
    ['VAT Working Paper'],['Company',report.company.name],['Period',`${report.period.period_start} — ${report.period.period_end}`],
    ['Output VAT',report.totals.output_vat],['Input VAT',report.totals.input_vat],['Net VAT',report.totals.net_vat],[],headers,
    ...report.documents.map(d=>[d.original_filename,d.counterparty_name??'',d.document_type,d.document_date??'',d.tax_date,Number(d.total_amount??0),d.treatment,Number(d.taxable_amount),Number(d.vat_amount)]),
  ];
  const sheetRows=rows.map((row,r)=>`<row r="${r+1}">${row.map((v,c)=>typeof v==='number'?`<c r="${colName(c)}${r+1}"><v>${Number.isFinite(v)?v:0}</v></c>`:`<c r="${colName(c)}${r+1}" t="inlineStr"><is><t>${xml(v)}</t></is></c>`).join('')}</row>`).join('');
  const files=[
    {name:'[Content_Types].xml',data:Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>`)},
    {name:'_rels/.rels',data:Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`)},
    {name:'xl/workbook.xml',data:Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="VAT Working Paper" sheetId="1" r:id="rId1"/></sheets></workbook>`)},
    {name:'xl/_rels/workbook.xml.rels',data:Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`)},
    {name:'xl/worksheets/sheet1.xml',data:Buffer.from(`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`)},
  ];
  return zipStore(files);
}
