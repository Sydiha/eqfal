import{fireEvent,render,screen,waitFor,within}from'@testing-library/react';
import{beforeEach,describe,expect,it,vi}from'vitest';
import{FixedAssets}from'../components/FixedAssets';
import i18n from'../i18n';

const category={id:'category-1',name_ar:'أجهزة',name_en:'Equipment',default_useful_life_months:36,asset_account_id:'asset-account',accumulated_depreciation_account_id:'accumulated-account',depreciation_expense_account_id:'expense-account'};
const accounts=[{id:'asset-account',code:'1200',name:'Equipment',account_type:'asset',is_active:true},{id:'accumulated-account',code:'1290',name:'Accumulated depreciation',account_type:'asset',is_active:true},{id:'expense-account',code:'5100',name:'Depreciation expense',account_type:'expense',is_active:true},{id:'inactive-asset',code:'1201',name:'Inactive asset',account_type:'asset',is_active:false}];
const asset=(changes:Record<string,unknown>={})=>({id:'asset-1',asset_category_id:category.id,asset_number:'FA-001',name:'Laptop',description:'Original',source_type:'manual_opening',source_document_id:null,source_reference:'OPEN-1',category_name_ar:category.name_ar,category_name_en:category.name_en,acquisition_cost:'1000.00',acquisition_date:'2026-08-01',placed_in_service_date:'2026-08-02',depreciation_start_date:'2026-08-03',residual_value:'100.00',opening_accumulated_depreciation:'0.00',posted_depreciation:'0.00',net_book_value:'1000.00',useful_life_months:36,status:'draft',...changes});

function mockApi(initial=asset(),options:{approvalError?:boolean}={}){
 let current:Record<string,unknown>=initial;
 const fetchMock=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=String(input);
  if(url==='/api/assets'&&!init?.method)return new Response(JSON.stringify({assets:[current]}));
  if(url==='/api/asset-categories')return new Response(JSON.stringify({categories:[category]}));
  if(url==='/api/accounts')return new Response(JSON.stringify({accounts}));
  if(url==='/api/sales')return new Response(JSON.stringify({sales:[{id:'sale-1',status:'approved',reference_number:'SALE-1',original_filename:'sale.pdf',document_date:'2026-08-20',total_amount:'750.00'}]}));
  if(url==='/api/assets/asset-1'&&!init?.method)return new Response(JSON.stringify(current));
  if(url.endsWith('/depreciation'))return new Response(JSON.stringify({entries:[]}));
  if(url==='/api/assets/asset-1'&&init?.method==='PATCH'){
   current={...current,...JSON.parse(String(init.body))};
   return new Response(JSON.stringify(current));
  }
  if(url==='/api/asset-categories/category-1'&&init?.method==='PATCH')return new Response(JSON.stringify({...category,...JSON.parse(String(init.body))}));
  if(url==='/api/assets/asset-1/approve'&&init?.method==='POST')return options.approvalError?new Response(JSON.stringify({error:'Asset category accounting is incomplete'}),{status:400}):new Response(JSON.stringify({...current,status:'active'}));
  if(url==='/api/assets/asset-1/dispose'&&init?.method==='POST'){const body=JSON.parse(String(init.body));current={...current,status:'disposed',disposal_type:body.disposal_type,disposal_date:body.disposal_date,disposal_proceeds:body.disposal_proceeds,source_sale_document_id:body.source_sale_document_id,disposal_reason:body.reason,nbv_at_disposal:'1000.00',calculated_gain_loss:'-250.00'};return new Response(JSON.stringify(current),{status:201})}
  throw Error(`Unexpected request: ${url}`);
 });
 vi.stubGlobal('fetch',fetchMock);
 return fetchMock;
}

async function openDetails(){fireEvent.click((await screen.findByText('FA-001')).closest('tr')!);await screen.findByRole('complementary',{name:'Asset details'});}
const props={canView:true,canCreate:true,canEdit:true,canCancel:true,canManagePolicy:true,canApprove:false,canDispose:false,onUnauthorized:vi.fn()};
beforeEach(async()=>{vi.restoreAllMocks();window.history.replaceState(null,'','/?page=assets');await i18n.changeLanguage('en')});

describe('Fixed Assets draft editing',()=>{
 it('shows Edit only to managers for draft assets',async()=>{
  mockApi();const managerView=render(<FixedAssets {...props}/>);await openDetails();expect(screen.getByRole('button',{name:'Edit'})).toBeInTheDocument();
  managerView.unmount();mockApi();const viewerView=render(<FixedAssets {...props} canEdit={false}/>);await openDetails();expect(screen.queryByRole('button',{name:'Edit'})).not.toBeInTheDocument();
  viewerView.unmount();mockApi(asset({status:'active'}));render(<FixedAssets {...props}/>);await openDetails();expect(screen.queryByRole('button',{name:'Edit'})).not.toBeInTheDocument();
 });

 it('prefills and PATCHes editable manual draft fields, then refreshes the detail',async()=>{
  const fetchMock=mockApi();render(<FixedAssets {...props}/>);await openDetails();fireEvent.click(screen.getByRole('button',{name:'Edit'}));
  expect(screen.getByLabelText('Asset name')).toHaveValue('Laptop');expect(screen.getByLabelText('Acquisition cost')).not.toHaveAttribute('readonly');expect(screen.getByLabelText('Acquisition date')).not.toHaveAttribute('readonly');
  fireEvent.change(screen.getByLabelText('Asset name'),{target:{value:'Updated laptop'}});fireEvent.change(screen.getByLabelText('Acquisition cost'),{target:{value:'1200.00'}});fireEvent.change(screen.getByLabelText('Acquisition date'),{target:{value:'2026-08-05'}});fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Save'})).not.toBeInTheDocument());expect(screen.getByRole('heading',{name:/Updated laptop/})).toBeInTheDocument();expect(within(screen.getByRole('complementary',{name:'Asset details'})).getAllByText('1,200.00')[0]).toBeInTheDocument();
  const patch=fetchMock.mock.calls.find(([,init])=>init?.method==='PATCH');expect(patch?.[0]).toBe('/api/assets/asset-1');expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({name:'Updated laptop',acquisition_cost:'1200.00',acquisition_date:'2026-08-05'});
  expect(fetchMock.mock.calls.filter(([url])=>url==='/api/assets')).toHaveLength(2);
 });

 it('keeps document-backed acquisition cost and date read-only',async()=>{
  mockApi(asset({source_type:'document',source_document_id:'purchase-1',source_reference:null}));render(<FixedAssets {...props}/>);await openDetails();fireEvent.click(screen.getByRole('button',{name:'Edit'}));
  expect(screen.getByLabelText('Acquisition cost')).toHaveAttribute('readonly');expect(screen.getByLabelText('Acquisition date')).toHaveAttribute('readonly');
 });
});

describe('Fixed Assets functional completeness',()=>{
 it('capability-gates category accounting, prefills filtered accounts, saves and refreshes',async()=>{
  const fetchMock=mockApi();const view=render(<FixedAssets {...props}/>);await screen.findByText('FA-001');fireEvent.click(screen.getByRole('button',{name:'Asset Category Accounting'}));
  expect(screen.getByLabelText('Asset Account')).toHaveValue('asset-account');expect(screen.getByLabelText('Accumulated Depreciation Account')).toHaveValue('accumulated-account');expect(screen.getByLabelText('Depreciation Expense Account')).toHaveValue('expense-account');expect(screen.queryByRole('option',{name:/Inactive asset/})).not.toBeInTheDocument();expect(screen.getByLabelText('Depreciation Expense Account')).not.toHaveTextContent('Equipment');
  fireEvent.click(within(screen.getByRole('heading',{name:'Equipment'}).closest('form')!).getByRole('button',{name:'Save'}));await waitFor(()=>expect(fetchMock.mock.calls.some(([url,init])=>url==='/api/asset-categories/category-1'&&init?.method==='PATCH')).toBe(true));expect(fetchMock.mock.calls.filter(([url])=>url==='/api/asset-categories')).toHaveLength(2);
  view.unmount();const viewerFetch=mockApi();render(<FixedAssets {...props} canManagePolicy={false}/>);await screen.findByText('FA-001');expect(screen.queryByRole('button',{name:'Asset Category Accounting'})).not.toBeInTheDocument();expect(viewerFetch.mock.calls.some(([url])=>url==='/api/accounts')).toBe(false);
 });

 it('trims money fields before sending a draft edit',async()=>{const fetchMock=mockApi();render(<FixedAssets {...props}/>);await openDetails();fireEvent.click(screen.getByRole('button',{name:'Edit'}));fireEvent.change(screen.getByLabelText('Acquisition cost'),{target:{value:' 12500.00 '}});fireEvent.change(screen.getByLabelText('Residual value'),{target:{value:' 100.00 '}});fireEvent.click(screen.getByRole('button',{name:'Save'}));await waitFor(()=>expect(fetchMock.mock.calls.some(([,init])=>init?.method==='PATCH')).toBe(true));const call=fetchMock.mock.calls.find(([,init])=>init?.method==='PATCH')!;expect(JSON.parse(String(call[1]?.body))).toMatchObject({acquisition_cost:'12500.00',residual_value:'100.00'})});

 it.each(['active','fully_depreciated'])('shows disposal only for disposable %s assets',async status=>{mockApi(asset({status}));render(<FixedAssets {...props} canDispose/>);await openDetails();expect(screen.getByRole('button',{name:'Dispose'})).toBeInTheDocument()});

 it('submits a sale disposal and refreshes the displayed backend result',async()=>{const fetchMock=mockApi(asset({status:'active'}));render(<FixedAssets {...props} canDispose/>);await openDetails();fireEvent.click(screen.getByRole('button',{name:'Dispose'}));fireEvent.change(screen.getByLabelText('Disposal Type'),{target:{value:'sale'}});fireEvent.change(screen.getByLabelText('Disposal Date'),{target:{value:'2026-08-31'}});fireEvent.change(screen.getByLabelText('Disposal Proceeds'),{target:{value:' 750.00 '}});fireEvent.change(screen.getByLabelText('Reason'),{target:{value:'Sold'}});fireEvent.change(screen.getByLabelText('Source Sale Document'),{target:{value:'sale-1'}});fireEvent.click(within(screen.getByLabelText('Disposal Type').closest('form')!).getByRole('button',{name:'Dispose'}));await screen.findByText('NBV at Disposal');const post=fetchMock.mock.calls.find(([url,init])=>url==='/api/assets/asset-1/dispose'&&init?.method==='POST')!;expect(JSON.parse(String(post[1]?.body))).toEqual({disposal_type:'sale',disposal_date:'2026-08-31',disposal_proceeds:'750.00',source_sale_document_id:'sale-1',reason:'Sold'});expect(screen.getByText('Gain / Loss')).toBeInTheDocument();expect(screen.getByText('-250.00')).toBeInTheDocument()});

 it('submits scrap/write-off with zero proceeds and no sale document',async()=>{const fetchMock=mockApi(asset({status:'active'}));render(<FixedAssets {...props} canDispose/>);await openDetails();fireEvent.click(screen.getByRole('button',{name:'Dispose'}));fireEvent.change(screen.getByLabelText('Reason'),{target:{value:'Damaged'}});fireEvent.click(within(screen.getByLabelText('Disposal Type').closest('form')!).getByRole('button',{name:'Dispose'}));await waitFor(()=>expect(fetchMock.mock.calls.some(([url,init])=>url==='/api/assets/asset-1/dispose'&&init?.method==='POST')).toBe(true));const post=fetchMock.mock.calls.find(([url,init])=>url==='/api/assets/asset-1/dispose'&&init?.method==='POST')!;expect(JSON.parse(String(post[1]?.body))).toMatchObject({disposal_type:'scrap_write_off',disposal_proceeds:'0',source_sale_document_id:null,reason:'Damaged'})});

 it('turns the category accounting approval blocker into actionable feedback',async()=>{mockApi(asset(),{approvalError:true});render(<FixedAssets {...props} canApprove/>);await openDetails();fireEvent.click(screen.getByRole('button',{name:'Approve / Activate'}));expect(await screen.findByText(/Configure the category accounting mapping/)).toBeInTheDocument()});
});

describe('Fixed Assets close discovery',()=>{
 it('shows document drafts acquired in-period and assets with pending period-end entries',async()=>{
  window.history.replaceState(null,'','/?page=assets&assetFrom=2026-08-01&assetTo=2026-08-31');
  const acquired=asset({id:'acquired',asset_number:'FA-ACQUIRED',name:'Acquired',source_type:'document',source_document_id:'doc',acquisition_date:'2026-08-10'}),scheduled=asset({id:'scheduled',asset_number:'FA-SCHEDULED',name:'Scheduled',status:'active',acquisition_date:'2025-01-01'}),outside=asset({id:'outside',asset_number:'FA-OUTSIDE',name:'Outside',source_type:'document',source_document_id:'old',acquisition_date:'2025-01-01'});
  vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request)=>{const url=String(input);if(url==='/api/assets')return new Response(JSON.stringify({assets:[acquired,scheduled,outside]}));if(url==='/api/asset-categories')return new Response(JSON.stringify({categories:[category]}));if(url==='/api/accounts')return new Response(JSON.stringify({accounts}));if(url.includes('/depreciation'))return new Response(JSON.stringify({entries:url.includes('scheduled')?[{id:'e',period_start:'2026-08-01',period_end:'2026-08-31',depreciation_amount:'10',closing_nbv:'90',status:'pending'}]:[]}));throw Error(url)}));
  render(<FixedAssets {...props}/>);expect(await screen.findByText('FA-ACQUIRED')).toBeInTheDocument();expect(screen.getByText('FA-SCHEDULED')).toBeInTheDocument();expect(screen.queryByText('FA-OUTSIDE')).not.toBeInTheDocument();
 });
 it('ignores invalid close context without loading depreciation discovery',async()=>{window.history.replaceState(null,'','/?page=assets&assetFrom=bad&assetTo=2026-08-31');const fetchMock=mockApi();render(<FixedAssets {...props}/>);expect(await screen.findByText('FA-001')).toBeInTheDocument();expect(fetchMock.mock.calls.some(([url])=>String(url).endsWith('/depreciation'))).toBe(false)});
});
