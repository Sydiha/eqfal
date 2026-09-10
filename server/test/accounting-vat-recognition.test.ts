import { describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { enforceVatRecognition, VatRecognitionIncompleteError } from '../src/modules/accounting/vat-recognition';

const company='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const journal='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const source='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const document='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const line='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

type RecoverabilityStatus='not_applicable'|'fully_recoverable'|'non_recoverable'|'partially_recoverable'|'needs_review';
type RequirementRow={
 document_id:string;
 document_type:'sale'|'purchase'|'expense';
 review_status:'pending'|'reviewed'|null;
 vat_amount:string|null;
 recoverability_status:RecoverabilityStatus|null;
 recoverable_vat_amount:string|null;
};

function row(overrides:Partial<RequirementRow>={}):RequirementRow{
 return{
  document_id:document,
  document_type:'purchase',
  review_status:'reviewed',
  vat_amount:'150.00',
  recoverability_status:'fully_recoverable',
  recoverable_vat_amount:'150.00',
  ...overrides,
 };
}

function clientFor(value:RequirementRow|null,candidates:string[]=[line],reserved=false){
 const updates:unknown[][]=[];
 const query=vi.fn(async(sql:string,args:unknown[]=[])=>{
  const normalized=sql.replace(/\s+/g,' ');
  if(normalized.startsWith('SELECT d.id document_id'))return{rows:value?[value]:[],rowCount:value?1:0};
  if(normalized.startsWith('SELECT l.id FROM journal_lines'))return{rows:candidates.map(id=>({id})),rowCount:candidates.length};
  if(normalized.startsWith('SELECT 1 FROM journal_lines'))return{rows:reserved?[{one:1}]:[],rowCount:reserved?1:0};
  if(normalized.startsWith('UPDATE journal_lines SET memo=')){updates.push(args);return{rows:[],rowCount:1};}
  throw new Error(normalized);
 });
 return{client:{query} as unknown as PoolClient,query,updates};
}

describe('VAT recognition journal semantics',()=>{
 it.each([
  ['purchase','VAT_INPUT','asset','150.00','0.00'],
  ['expense','VAT_INPUT','asset','150.00','0.00'],
  ['sale','VAT_OUTPUT','liability','0.00','150.00'],
 ] as const)('auto-tags reviewed %s obligation VAT when exactly one safe candidate exists',async(documentType,memo,accountType,debit,credit)=>{
  const built=clientFor(row({document_type:documentType,recoverability_status:documentType==='sale'?'not_applicable':'fully_recoverable',recoverable_vat_amount:documentType==='sale'?null:'150.00'}));
  await expect(enforceVatRecognition(company,journal,'obligation',source,built.client)).resolves.toEqual({documentId:document,memo,accountType,debit,credit});
  expect(built.query.mock.calls.find(([sql])=>String(sql).includes('SELECT l.id'))?.[1]).toEqual([company,journal,accountType,debit,credit]);
  expect(built.updates).toEqual([[line,company,memo]]);
 });

 it('uses approved recoverable VAT rather than gross VAT for partial input VAT',async()=>{
  const built=clientFor(row({recoverability_status:'partially_recoverable',recoverable_vat_amount:'90.00'}));
  await expect(enforceVatRecognition(company,journal,'obligation',source,built.client)).resolves.toEqual({documentId:document,memo:'VAT_INPUT',accountType:'asset',debit:'90.00',credit:'0.00'});
  expect(built.query.mock.calls.find(([sql])=>String(sql).includes('SELECT l.id'))?.[1]).toEqual([company,journal,'asset','90.00','0.00']);
  expect(built.updates).toEqual([[line,company,'VAT_INPUT']]);
 });

 it.each([
  ['needs review',row({recoverability_status:'needs_review',recoverable_vat_amount:null})],
  ['non recoverable',row({recoverability_status:'non_recoverable',recoverable_vat_amount:'0.00'})],
  ['zero VAT',row({vat_amount:'0.00',recoverability_status:'fully_recoverable',recoverable_vat_amount:'0.00'})],
  ['pending review',row({review_status:'pending',vat_amount:null,recoverability_status:null,recoverable_vat_amount:null})],
  ['no material document',null],
 ] as const)('does not stamp VAT_INPUT for %s',async(_label,value)=>{
  const built=clientFor(value);
  await expect(enforceVatRecognition(company,journal,'obligation',source,built.client)).resolves.toBeNull();
  expect(built.query).toHaveBeenCalledTimes(1);
  expect(built.updates).toEqual([]);
 });

 it.each([
  ['no matching line',[] as string[],false],
  ['multiple matching lines',[line,'ffffffff-ffff-4fff-8fff-ffffffffffff'],false],
  ['reserved VAT tag on another line',[line],true],
 ] as const)('blocks posting when VAT recognition has %s',async(_label,candidates,reserved)=>{
  const built=clientFor(row(),[...candidates],reserved);
  await expect(enforceVatRecognition(company,journal,'obligation',source,built.client)).rejects.toBeInstanceOf(VatRecognitionIncompleteError);
  expect(built.updates).toEqual([]);
 });

 it.each(['custody_allocation','obligation_settlement','document_settlement','custody_funding'])(
  'does not guess VAT allocation for %s sources',async(sourceType)=>{
   const built=clientFor(row());
   await expect(enforceVatRecognition(company,journal,sourceType,source,built.client)).resolves.toBeNull();
   expect(built.query).not.toHaveBeenCalled();
  },
 );
});
