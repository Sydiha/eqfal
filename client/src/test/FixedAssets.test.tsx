import{fireEvent,render,screen,waitFor,within}from'@testing-library/react';
import{beforeEach,describe,expect,it,vi}from'vitest';
import{FixedAssets}from'../components/FixedAssets';
import i18n from'../i18n';

const category={id:'category-1',name_ar:'أجهزة',name_en:'Equipment'};
const asset=(changes:Record<string,unknown>={})=>({id:'asset-1',asset_category_id:category.id,asset_number:'FA-001',name:'Laptop',description:'Original',source_type:'manual_opening',source_document_id:null,source_reference:'OPEN-1',category_name_ar:category.name_ar,category_name_en:category.name_en,acquisition_cost:'1000.00',acquisition_date:'2026-08-01',placed_in_service_date:'2026-08-02',depreciation_start_date:'2026-08-03',residual_value:'100.00',opening_accumulated_depreciation:'0.00',posted_depreciation:'0.00',net_book_value:'1000.00',useful_life_months:36,status:'draft',...changes});

function mockApi(initial=asset()){
 let current=initial;
 const fetchMock=vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{
  const url=String(input);
  if(url==='/api/assets'&&!init?.method)return new Response(JSON.stringify({assets:[current]}));
  if(url==='/api/asset-categories')return new Response(JSON.stringify({categories:[category]}));
  if(url.endsWith('/depreciation'))return new Response(JSON.stringify({entries:[]}));
  if(url==='/api/assets/asset-1'&&init?.method==='PATCH'){
   current={...current,...JSON.parse(String(init.body))};
   return new Response(JSON.stringify(current));
  }
  throw Error(`Unexpected request: ${url}`);
 });
 vi.stubGlobal('fetch',fetchMock);
 return fetchMock;
}

async function openDetails(){fireEvent.click((await screen.findByText('FA-001')).closest('tr')!);await screen.findByRole('complementary',{name:'Asset details'});}
const props={canView:true,canManage:true,canApprove:false,canDispose:false,onUnauthorized:vi.fn()};

describe('Fixed Assets draft editing',()=>{
 beforeEach(async()=>{vi.restoreAllMocks();window.history.replaceState(null,'','/?page=assets');await i18n.changeLanguage('en')});

 it('shows Edit only to managers for draft assets',async()=>{
  mockApi();const managerView=render(<FixedAssets {...props}/>);await openDetails();expect(screen.getByRole('button',{name:'Edit'})).toBeInTheDocument();
  managerView.unmount();mockApi();const viewerView=render(<FixedAssets {...props} canManage={false}/>);await openDetails();expect(screen.queryByRole('button',{name:'Edit'})).not.toBeInTheDocument();
  viewerView.unmount();mockApi(asset({status:'active'}));render(<FixedAssets {...props}/>);await openDetails();expect(screen.queryByRole('button',{name:'Edit'})).not.toBeInTheDocument();
 });

 it('prefills and PATCHes editable manual draft fields, then refreshes the detail',async()=>{
  const fetchMock=mockApi();render(<FixedAssets {...props}/>);await openDetails();fireEvent.click(screen.getByRole('button',{name:'Edit'}));
  expect(screen.getByLabelText('Asset name')).toHaveValue('Laptop');expect(screen.getByLabelText('Acquisition cost')).not.toHaveAttribute('readonly');expect(screen.getByLabelText('Acquisition date')).not.toHaveAttribute('readonly');
  fireEvent.change(screen.getByLabelText('Asset name'),{target:{value:'Updated laptop'}});fireEvent.change(screen.getByLabelText('Acquisition cost'),{target:{value:'1200.00'}});fireEvent.change(screen.getByLabelText('Acquisition date'),{target:{value:'2026-08-05'}});fireEvent.click(screen.getByRole('button',{name:'Save'}));
  await waitFor(()=>expect(screen.queryByRole('button',{name:'Save'})).not.toBeInTheDocument());expect(screen.getByRole('heading',{name:/Updated laptop/})).toBeInTheDocument();expect(within(screen.getByRole('complementary',{name:'Asset details'})).getByText('1200.00')).toBeInTheDocument();
  const patch=fetchMock.mock.calls.find(([,init])=>init?.method==='PATCH');expect(patch?.[0]).toBe('/api/assets/asset-1');expect(JSON.parse(String(patch?.[1]?.body))).toMatchObject({name:'Updated laptop',acquisition_cost:'1200.00',acquisition_date:'2026-08-05'});
  expect(fetchMock.mock.calls.filter(([url])=>url==='/api/assets')).toHaveLength(2);
 });

 it('keeps document-backed acquisition cost and date read-only',async()=>{
  mockApi(asset({source_type:'document',source_document_id:'purchase-1',source_reference:null}));render(<FixedAssets {...props}/>);await openDetails();fireEvent.click(screen.getByRole('button',{name:'Edit'}));
  expect(screen.getByLabelText('Acquisition cost')).toHaveAttribute('readonly');expect(screen.getByLabelText('Acquisition date')).toHaveAttribute('readonly');
 });
});
