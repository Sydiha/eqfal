import { fireEvent,render,screen,waitFor } from '@testing-library/react';
import { beforeEach,describe,expect,it,vi } from 'vitest';
import i18n from '../i18n';
import { AccountImportDialog } from '../components/AccountImportDialog';
import { accountImportTemplate } from '../components/accountImportXlsx';

function generatedTemplateFile(){
 const file=new File([accountImportTemplate()],'eqfal-chart-of-accounts-template.xlsx',{type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'});
 Object.defineProperty(file,'arrayBuffer',{value:()=>new Promise<ArrayBuffer>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result as ArrayBuffer);reader.onerror=()=>reject(reader.error);reader.readAsArrayBuffer(file);})});
 return file;
}

describe('Chart of Accounts Excel template upload',()=>{
 beforeEach(async()=>{await i18n.changeLanguage('en');});
 it('uploads the generated workbook and sends Excel boolean cells to the API as booleans',async()=>{
  const fetchMock=vi.fn(async(_url:string,_options?:RequestInit)=>new Response(JSON.stringify({issues:[]})));vi.stubGlobal('fetch',fetchMock);
  render(<AccountImportDialog onClose={vi.fn()} onComplete={vi.fn()} onUnauthorized={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText('Choose .xlsx file'),{target:{files:[generatedTemplateFile()]}});
  expect(await screen.findByText('2 accounts ready for review')).toBeInTheDocument();
  await waitFor(()=>expect(fetchMock).toHaveBeenCalledOnce());
  const body=JSON.parse(String(fetchMock.mock.calls[0]![1]?.body)) as {dry_run:boolean;rows:Array<{code:string;is_contra:unknown}>};
  expect(body.dry_run).toBe(true);expect(body.rows[0]).toMatchObject({code:'SAMPLE-ASSET-001',is_contra:false});expect(typeof body.rows[0]!.is_contra).toBe('boolean');
 });
 it('does not send a malformed workbook to the validation API',async()=>{
  const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);
  render(<AccountImportDialog onClose={vi.fn()} onComplete={vi.fn()} onUnauthorized={vi.fn()}/>);
  const bad=new File(['not a zip workbook'],'broken.xlsx');
  Object.defineProperty(bad,'arrayBuffer',{value:async()=>new TextEncoder().encode('not a zip workbook').buffer});
  fireEvent.change(screen.getByLabelText('Choose .xlsx file'),{target:{files:[bad]}});
  expect(await screen.findByText('Invalid or unsupported workbook structure. Use the provided .xlsx template.')).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
 });
});
