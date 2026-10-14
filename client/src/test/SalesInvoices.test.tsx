import {fireEvent,render,screen,waitFor,within} from './test-utils';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import {Sales} from '../components/Sales';
import {SalesInvoices} from '../components/SalesInvoices';
import i18n from '../i18n';
import {canShowNavigationPage} from '../components/navigationVisibility';

const draft={id:'11111111-1111-4111-8111-111111111111',status:'draft',counterparty_id:'22222222-2222-4222-8222-222222222222',counterparty_name:'Acme',internal_number:null,external_reference:'REF-1',issue_date:'2026-10-01',due_date:'2026-10-31',supply_date:null,tax_point_date:'2026-10-01',currency:'SAR',subtotal_amount:'100.00',vat_amount:'15.00',total_amount:'115.00',notes:null,version:3,lines:[{line_number:1,description:'Service',quantity:'1',unit_price:'100.00',discount_amount:'0.00',vat_rate:'15.00',net_amount:'100.00',vat_amount:'15.00',total_amount:'115.00',vat_treatment:'standard'}]};
const caps={canView:true,canCreate:true,canEdit:true,canSubmit:true};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status});

function mockApi(invoice:typeof draft|Record<string,unknown>=draft,overrides:Record<string,(init?:RequestInit)=>Response>={}){
 const fetchMock=vi.fn((url:string,init?:RequestInit)=>{
  const method=init?.method??'GET';
  const key=`${method} ${url.split('?')[0]}`;
  if(overrides[key])return Promise.resolve(overrides[key](init));
  if(key==='GET /api/invoices')return Promise.resolve(json({invoices:[invoice],total:1,limit:100,offset:0}));
  if(key===`GET /api/invoices/${draft.id}`)return Promise.resolve(json({invoice}));
  if(key==='GET /api/invoices/standard-rate'){const date=new URL(url,'http://x').searchParams.get('date')??'';return Promise.resolve(date>='2020-07-01'?json({date,jurisdiction:'SA',rate:'15.00',effective_from:'2020-07-01',effective_to:null}):date>='2018-01-01'?json({date,jurisdiction:'SA',rate:'5.00',effective_from:'2018-01-01',effective_to:'2020-06-30'}):json({error:'none',code:'VAT_RATE_NOT_CONFIGURED'},404))}
  if(key==='GET /api/invoices/customers')return Promise.resolve(json({customers:[{id:draft.counterparty_id,name:'Acme',type:'customer'}]}));
  return Promise.resolve(json({},404));
 });
 vi.stubGlobal('fetch',fetchMock);
 return fetchMock;
}
const bodyOf=(fetchMock:ReturnType<typeof vi.fn>,key:string)=>{const call=fetchMock.mock.calls.find(c=>`${(c[1] as RequestInit|undefined)?.method??'GET'} ${String(c[0]).split('?')[0]}`===key);return call?JSON.parse((call[1] as RequestInit).body as string):undefined};

describe('Sales invoices',()=>{
 beforeEach(async()=>{window.history.replaceState(null,'','/?page=sales');vi.restoreAllMocks();await i18n.changeLanguage('en')});

 it('lists sales invoices from /api/invoices and shows server totals in the detail',async()=>{
  const fetchMock=mockApi();
  render(<SalesInvoices {...caps} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('REF-1'));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
  expect(fetchMock.mock.calls[0][0]).toContain('direction=sales');
  expect(screen.getAllByText('115.00').length).toBeGreaterThan(0);
  expect(screen.getByText('15.00%')).toBeInTheDocument();
 });

 it('creates a draft with raw string inputs, direction sales, customers from the invoice picker endpoint',async()=>{
  const fetchMock=mockApi(draft,{'POST /api/invoices':()=>json({invoice:draft},201)});
  render(<SalesInvoices {...caps} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('button',{name:'Add sales invoice +'}));
  await screen.findByRole('dialog');
  await waitFor(()=>expect(within(screen.getByRole('dialog')).getByRole('option',{name:'Acme'})).toBeInTheDocument());
  expect(fetchMock.mock.calls.some(c=>c[0]==='/api/counterparties')).toBe(false);
  expect(fetchMock.mock.calls.some(c=>c[0]==='/api/invoices/customers')).toBe(true);
  fireEvent.change(within(screen.getByRole('dialog')).getByLabelText('Customer'),{target:{value:draft.counterparty_id}});
  fireEvent.change(screen.getByLabelText('Issue date'),{target:{value:'2026-10-01'}});
  fireEvent.change(screen.getByLabelText('Description'),{target:{value:'Service'}});
  fireEvent.change(screen.getByLabelText('Unit price'),{target:{value:'100.00'}});
  fireEvent.change(screen.getByLabelText('VAT treatment'),{target:{value:'standard'}});
  await waitFor(()=>expect(screen.getByLabelText('VAT rate %')).toHaveTextContent('15.00%'));
  expect(screen.getByLabelText('VAT rate %').tagName).toBe('OUTPUT');
  fireEvent.click(screen.getByRole('button',{name:'Save draft'}));
  await waitFor(()=>expect(bodyOf(fetchMock,'POST /api/invoices')).toBeDefined());
  const body=bodyOf(fetchMock,'POST /api/invoices');
  expect(body.direction).toBe('sales');
  expect(body.lines[0]).toEqual({description:'Service',quantity:'1',unit_price:'100.00',vat_rate:'15.00',vat_treatment:'standard'});
  expect(body).not.toHaveProperty('total_amount');
 });

 it('edits a draft with the current version and sends rate 0 for non-standard treatment',async()=>{
  const fetchMock=mockApi(draft,{[`PUT /api/invoices/${draft.id}`]:()=>json({invoice:draft})});
  render(<SalesInvoices {...caps} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('REF-1'));
  fireEvent.click(await screen.findByRole('button',{name:'Edit'}));
  fireEvent.change(await screen.findByLabelText('VAT treatment'),{target:{value:'exempt'}});
  fireEvent.click(screen.getByRole('button',{name:'Save draft'}));
  await waitFor(()=>expect(bodyOf(fetchMock,`PUT /api/invoices/${draft.id}`)).toBeDefined());
  const body=bodyOf(fetchMock,`PUT /api/invoices/${draft.id}`);
  expect(body.version).toBe(3);
  expect(body.lines[0].vat_rate).toBe('0');
  expect(body.lines[0].vat_treatment).toBe('exempt');
 });

 it('submits a draft and returns a submitted invoice using the version',async()=>{
  const submitted={...draft,status:'submitted',version:4};
  const fetchMock=mockApi(draft,{[`POST /api/invoices/${draft.id}/submit`]:()=>json({invoice:submitted}),[`POST /api/invoices/${draft.id}/return`]:()=>json({invoice:draft})});
  render(<SalesInvoices {...caps} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('REF-1'));
  fireEvent.click(await screen.findByRole('button',{name:'Submit'}));
  await waitFor(()=>expect(bodyOf(fetchMock,`POST /api/invoices/${draft.id}/submit`)).toEqual({version:3}));
 });

 it('offers return (not edit or submit) on a submitted invoice, and no actions once approved',async()=>{
  mockApi({...draft,status:'submitted',version:4});
  const first=render(<SalesInvoices {...caps} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('REF-1'));
  await screen.findByRole('button',{name:'Return to draft'});
  expect(screen.queryByRole('button',{name:'Edit'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Submit'})).not.toBeInTheDocument();
  first.unmount();
  mockApi({...draft,status:'approved',version:5});
  render(<SalesInvoices {...caps} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('REF-1'));
  await screen.findByRole('dialog');
  for(const name of ['Edit','Submit','Return to draft'])expect(screen.queryByRole('button',{name})).not.toBeInTheDocument();
 });

 it('hides actions the user has no capability for',async()=>{
  mockApi();
  render(<SalesInvoices canView canCreate={false} canEdit={false} canSubmit={false} onUnauthorized={vi.fn()}/>);
  expect(screen.queryByRole('button',{name:'Add sales invoice +'})).not.toBeInTheDocument();
  fireEvent.click(await screen.findByText('REF-1'));
  await screen.findByRole('dialog');
  expect(screen.queryByRole('button',{name:'Edit'})).not.toBeInTheDocument();
  // The next step stays visible but disabled, with the reason stated, instead of silently disappearing.
  expect(screen.getByRole('button',{name:'Submit'})).toBeDisabled();
  expect(screen.getByTestId('next-action-note')).toHaveTextContent('You do not have permission to submit invoices.');
 });

 it('shows a mapped message for a server error code instead of raw text',async()=>{
  mockApi(draft,{[`POST /api/invoices/${draft.id}/submit`]:()=>json({error:'raw backend text',code:'INVOICE_VAT_INCOMPLETE'},409)});
  render(<SalesInvoices {...caps} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('REF-1'));
  fireEvent.click(await screen.findByRole('button',{name:'Submit'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Complete the tax point date');
  expect(screen.queryByText('raw backend text')).not.toBeInTheDocument();
 });

 it('renders nothing without invoice capabilities and keeps Arabic labels',async()=>{
  mockApi();
  const none=render(<SalesInvoices canView={false} canCreate={false} canEdit={false} canSubmit={false} onUnauthorized={vi.fn()}/>);
  expect(none.container).toBeEmptyDOMElement();
  none.unmount();
  await i18n.changeLanguage('ar');
  render(<SalesInvoices {...caps} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByRole('button',{name:'إضافة فاتورة مبيعات +'})).toBeInTheDocument();
 });
});

describe('Sales page with invoice workflow',()=>{
 beforeEach(async()=>{window.history.replaceState(null,'','/?page=sales');vi.restoreAllMocks();await i18n.changeLanguage('en')});
 const none={canView:false,canCreate:false,canEdit:false,canSubmit:false};
 const stub=()=>{const f=vi.fn((url:string)=>Promise.resolve(url.startsWith('/api/invoices/customers')?json({customers:[]}):url.startsWith('/api/invoices')?json({invoices:[draft],total:1,limit:100,offset:0}):json({})));vi.stubGlobal('fetch',f);return f};

 it('opens the invoice form from the invoice action and shows no legacy tabs or upload',async()=>{
  stub();
  render(<Sales invoices={caps} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByText('REF-1')).toBeInTheDocument();
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Upload sale document'})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button',{name:'Add sales invoice +'}));
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
 });

 it('user without invoice access sees a restricted state and no legacy fallback, loading nothing',async()=>{
  const f=stub();
  render(<Sales invoices={none} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByText(/do not have access to invoices/i)).toBeInTheDocument();
  expect(screen.queryByRole('tab',{name:'Legacy documents'})).not.toBeInTheDocument();
  expect(screen.queryByRole('button',{name:'Add sales invoice +'})).not.toBeInTheDocument();
  expect(f).not.toHaveBeenCalled();
 });

 it('switching between a company with invoice access and one without never shows a legacy screen',async()=>{
  stub();
  const view=render(<Sales invoices={caps} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByText('REF-1')).toBeInTheDocument();
  view.rerender(<Sales invoices={none} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByText(/do not have access to invoices/i)).toBeInTheDocument();
  expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  view.rerender(<Sales invoices={caps} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByText('REF-1')).toBeInTheDocument();
 });
});

describe('Sales navigation visibility',()=>{
 it('shows Sales for invoice permissions alone or legacy permissions alone, hides it otherwise',()=>{
  expect(canShowNavigationPage('sales',['invoice.view'])).toBe(true);
  expect(canShowNavigationPage('sales',['invoice.create'])).toBe(true);
  expect(canShowNavigationPage('sales',['document.view','obligation.view'])).toBe(true);
  expect(canShowNavigationPage('sales',['document.view'])).toBe(false);
  expect(canShowNavigationPage('purchases',['invoice.view'])).toBe(true);
  expect(canShowNavigationPage('purchases',['invoice.create'])).toBe(true);
  expect(canShowNavigationPage('purchases',['document.view'])).toBe(false);
 });

 describe('standard VAT rate resolution',()=>{
  const openNew=async(fetchMock:ReturnType<typeof mockApi>)=>{
   render(<SalesInvoices {...caps} onUnauthorized={vi.fn()}/>);
   fireEvent.click(await screen.findByRole('button',{name:'Add sales invoice +'}));
   await screen.findByRole('dialog');
   return fetchMock;
  };
  const rateCalls=(fetchMock:ReturnType<typeof vi.fn>)=>fetchMock.mock.calls.map(c=>String(c[0])).filter(u=>u.startsWith('/api/invoices/standard-rate'));

  it('resolves the rate from the tax point date, falls back to the issue date only provisionally, and switches at the boundary',async()=>{
   const fetchMock=await openNew(mockApi());
   fireEvent.change(screen.getByLabelText('Issue date'),{target:{value:'2020-06-30'}});
   fireEvent.change(screen.getByLabelText('VAT treatment'),{target:{value:'standard'}});
   await waitFor(()=>expect(screen.getByLabelText('VAT rate %')).toHaveTextContent('5.00%'));
   expect(screen.getByText(/rate shown is provisional/)).toBeInTheDocument();
   fireEvent.change(screen.getByLabelText('Tax point date'),{target:{value:'2020-07-01'}});
   await waitFor(()=>expect(screen.getByLabelText('VAT rate %')).toHaveTextContent('15.00%'));
   expect(screen.queryByText(/rate shown is provisional/)).toBeNull();
   expect(rateCalls(fetchMock)).toEqual(expect.arrayContaining(['/api/invoices/standard-rate?date=2020-06-30','/api/invoices/standard-rate?date=2020-07-01']));
  });

  it('shows 0% for zero-rated, exempt and out-of-scope and keeps the treatment distinction when switching back to standard',async()=>{
   await openNew(mockApi());
   fireEvent.change(screen.getByLabelText('Issue date'),{target:{value:'2026-10-01'}});
   fireEvent.change(screen.getByLabelText('VAT treatment'),{target:{value:'standard'}});
   await waitFor(()=>expect(screen.getByLabelText('VAT rate %')).toHaveTextContent('15.00%'));
   for(const treatment of ['zero_rated','exempt','out_of_scope']){
    fireEvent.change(screen.getByLabelText('VAT treatment'),{target:{value:treatment}});
    expect(screen.getByLabelText('VAT rate %')).toHaveTextContent('0%');
   }
   fireEvent.change(screen.getByLabelText('VAT treatment'),{target:{value:'standard'}});
   expect(screen.getByLabelText('VAT rate %')).toHaveTextContent('15.00%');
  });

  it('fails closed when no rate is configured: standard lines show an error and cannot be saved once a tax point date is set',async()=>{
   await openNew(mockApi());
   fireEvent.change(screen.getByLabelText('Issue date'),{target:{value:'2017-12-31'}});
   fireEvent.change(screen.getByLabelText('Tax point date'),{target:{value:'2017-12-31'}});
   fireEvent.change(screen.getByLabelText('VAT treatment'),{target:{value:'standard'}});
   expect(await screen.findByText(/No standard VAT rate is configured for this date/)).toBeInTheDocument();
   expect(screen.getByRole('button',{name:'Save draft'})).toBeDisabled();
   fireEvent.change(screen.getByLabelText('VAT treatment'),{target:{value:'exempt'}});
   await waitFor(()=>expect(screen.getByRole('button',{name:'Save draft'})).not.toBeDisabled());
  });

  it('never overwrites a historical draft rate: shows the mismatch, blocks saving and applies the resolved rate only on request',async()=>{
   const historical={...draft,issue_date:'2020-08-01',tax_point_date:'2020-08-01',lines:[{...draft.lines[0],vat_rate:'5.00'}]};
   const fetchMock=mockApi(historical,{[`PUT /api/invoices/${draft.id}`]:()=>json({invoice:historical})});
   render(<SalesInvoices {...caps} onUnauthorized={vi.fn()}/>);
   fireEvent.click(await screen.findByText('REF-1'));
   fireEvent.click(await screen.findByRole('button',{name:'Edit'}));
   expect(await screen.findByText(/Saved rate 5.00% differs from the 15.00% in force/)).toBeInTheDocument();
   expect(screen.getByLabelText('VAT rate %')).toHaveTextContent('5.00%');
   expect(screen.getByRole('button',{name:'Save draft'})).toBeDisabled();
   fireEvent.click(screen.getByRole('button',{name:'Use 15.00%'}));
   await waitFor(()=>expect(screen.getByRole('button',{name:'Save draft'})).not.toBeDisabled());
   fireEvent.click(screen.getByRole('button',{name:'Save draft'}));
   await waitFor(()=>expect(bodyOf(fetchMock,`PUT /api/invoices/${draft.id}`)).toBeDefined());
   expect(bodyOf(fetchMock,`PUT /api/invoices/${draft.id}`).lines[0].vat_rate).toBe('15.00');
  });

  it('keeps a matching saved draft rate on edit and does not request a rate while the form is closed or the user cannot create or edit',async()=>{
   const fetchMock=mockApi();
   render(<SalesInvoices {...caps} canCreate={false} canEdit={false} onUnauthorized={vi.fn()}/>);
   fireEvent.click(await screen.findByText('REF-1'));
   await screen.findByRole('dialog');
   expect(screen.queryByRole('button',{name:'Edit'})).toBeNull();
   expect(rateCalls(fetchMock)).toEqual([]);
  });

  it('maps the server rate errors to clear messages when submitting',async()=>{
   mockApi(draft,{[`POST /api/invoices/${draft.id}/submit`]:()=>json({error:'x',code:'INVOICE_VAT_RATE_MISMATCH'},409)});
   render(<SalesInvoices {...caps} onUnauthorized={vi.fn()}/>);
   fireEvent.click(await screen.findByText('REF-1'));
   fireEvent.click(await screen.findByRole('button',{name:'Submit'}));
   expect(await screen.findByText(/does not use the VAT rate in force/)).toBeInTheDocument();
  });
 });
});
