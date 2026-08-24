import {fireEvent,render,screen,waitFor} from '@testing-library/react';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {Documents} from '../components/Documents';
import i18n from '../i18n';

const uploaded={id:'doc-1',original_filename:'invoice.pdf',mime_type:'application/pdf',size_bytes:2048,status:'uploaded',review_note:null,reviewed_at:null,created_at:'2026-08-24T00:00:00Z',document_type:'purchase' as const,counterparty_id:null,counterparty_name:null,document_date:null,reference_number:null,total_amount:null,intake_note:null};

describe('Documents contextual purchase entry',()=>{
 beforeEach(async()=>{vi.restoreAllMocks();await i18n.changeLanguage('en')});

 it('opens upload, presets the chosen type through the existing intake endpoint, selects the new document, and returns after intake save',async()=>{
  const onEntryComplete=vi.fn();
  const fetchMock=vi.fn()
   .mockResolvedValueOnce(new Response(JSON.stringify({documents:[],counterparties:[]})))
   .mockResolvedValueOnce(new Response(JSON.stringify({document:{id:'doc-1'}}),{status:201}))
   .mockResolvedValueOnce(new Response(JSON.stringify({document:{...uploaded}})))
   .mockResolvedValueOnce(new Response(JSON.stringify({documents:[uploaded],counterparties:[]})))
   .mockResolvedValueOnce(new Response(JSON.stringify({document:{...uploaded,reference_number:'INV-1'}})))
   .mockResolvedValueOnce(new Response(JSON.stringify({documents:[{...uploaded,reference_number:'INV-1'}],counterparties:[]})));
  vi.stubGlobal('fetch',fetchMock);

  render(<Documents canView canUpload canReview={false} canApprove={false} entryDocumentType="purchase" onEntryComplete={onEntryComplete} onEntryCancel={vi.fn()} onUnauthorized={vi.fn()}/>);
  const file=new File([new Uint8Array([0x25,0x50,0x44,0x46,0x2d])],'invoice.pdf',{type:'application/pdf'});
  fireEvent.change(await screen.findByLabelText(/Choose document/),{target:{files:[file]}});
  const uploadForm=screen.getAllByRole('button',{name:'Upload document'}).find(button=>button.closest('form'))?.closest('form');
  fireEvent.submit(uploadForm!);

  await screen.findAllByText('invoice.pdf');
  expect(fetchMock.mock.calls[2][0]).toBe('/api/documents/doc-1/intake');
  expect(JSON.parse(String(fetchMock.mock.calls[2][1]?.body))).toEqual({document_type:'purchase'});

  fireEvent.change(screen.getByLabelText('Invoice / Reference Number'),{target:{value:'INV-1'}});
  fireEvent.click(screen.getByRole('button',{name:'Save Intake'}));
  await waitFor(()=>expect(onEntryComplete).toHaveBeenCalledTimes(1));
  expect(fetchMock.mock.calls[4][0]).toBe('/api/documents/doc-1/intake');
 });

 it('cancels back to Purchases without uploading',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({documents:[],counterparties:[]}))));
  const onEntryCancel=vi.fn();
  render(<Documents canView canUpload canReview={false} canApprove={false} entryDocumentType="expense" onEntryCancel={onEntryCancel} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Cancel'}));
  expect(onEntryCancel).toHaveBeenCalledTimes(1);
 });

 it('quick-adds a supplier through the existing counterparty endpoint only when management is allowed',async()=>{
  const fetchMock=vi.fn()
   .mockResolvedValueOnce(new Response(JSON.stringify({documents:[uploaded],counterparties:[]})))
   .mockResolvedValueOnce(new Response(JSON.stringify({id:'cp-new',name:'New Supplier',is_active:true,type:'supplier',version:1}),{status:201}));
  vi.stubGlobal('fetch',fetchMock);
  render(<Documents canView canUpload canReview={false} canApprove={false} canManageCounterparties onUnauthorized={vi.fn()}/>);
  await screen.findAllByText('invoice.pdf');
  fireEvent.click(screen.getByRole('button',{name:'Create counterparty'}));
  fireEvent.change(screen.getByRole('textbox',{name:'Counterparty'}),{target:{value:'New Supplier'}});
  fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(2));
  expect(fetchMock.mock.calls[1][0]).toBe('/api/counterparties');
  expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({name:'New Supplier',type:'supplier'});
  await waitFor(()=>expect(screen.getByRole('combobox',{name:/Counterparty/})).toHaveValue('cp-new'));
 });
});
