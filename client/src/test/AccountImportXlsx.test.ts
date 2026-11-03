import { describe,expect,it } from 'vitest';
import { accountImportTemplate,readAccountImport } from '../components/accountImportXlsx';

describe('Chart of Accounts Excel template',()=>{
 it('creates a readable XLSX template with bilingual names and supported classifications',async()=>{
  const file=new File([accountImportTemplate()],'accounts.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});Object.defineProperty(file,'arrayBuffer',{value:()=>new Promise<ArrayBuffer>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result as ArrayBuffer);reader.onerror=()=>reject(reader.error);reader.readAsArrayBuffer(file);})});const rows=await readAccountImport(file);expect(rows).toHaveLength(2);expect(rows[0]).toMatchObject({code:'1000',name_ar:'الصندوق',name_en:'Cash',account_type:'asset',statement_category:'current_asset',cash_role:'cash',cash_flow_category:'operating'});expect(rows[1]).toMatchObject({code:'4000',account_type:'revenue',statement_category:'revenue'});
 });
});
