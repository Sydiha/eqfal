import{fireEvent,render,screen,waitFor}from'@testing-library/react';
import{beforeEach,describe,expect,it,vi}from'vitest';
import{FixedAssetsModule}from'../components/FixedAssetsModule';
import i18n from'../i18n';

const category={id:'c1',name_ar:'أجهزة',name_en:'Equipment',depreciable:true,default_useful_life_months:36,asset_account_id:null,accumulated_depreciation_account_id:null,depreciation_expense_account_id:null};
const asset={id:'a1',asset_category_id:'c1',asset_number:'FA-001',name:'Laptop',description:null,source_type:'manual_opening',source_document_id:null,source_reference:'OPEN-1',category_name_ar:'أجهزة',category_name_en:'Equipment',acquisition_cost:'12500.00',acquisition_date:'2026-01-01',placed_in_service_date:'2026-01-01',depreciation_start_date:null,residual_value:'0.00',opening_accumulated_depreciation:'0.00',posted_depreciation:'2430.54',net_book_value:'10069.46',useful_life_months:36,status:'active',depreciation_policy_version_id:null};
const props={canView:true,canCreate:true,canEdit:true,canCancel:true,canManagePolicy:true,canApprove:false,canDispose:false,canCreateEstimate:true,canReviewEstimate:false,canApproveEstimate:false,onUnauthorized:vi.fn()};
function mock(policiesFail=false){vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request)=>{const u=String(input);
 if(u==='/api/assets')return new Response(JSON.stringify({assets:[asset]}));if(u==='/api/asset-categories')return new Response(JSON.stringify({categories:[category]}));
 if(u==='/api/accounts')return new Response(JSON.stringify({accounts:[]}));if(u==='/api/sales')return new Response(JSON.stringify({sales:[]}));
 if(u.endsWith('/policies'))return policiesFail?new Response(JSON.stringify({error:'Internal server error'}),{status:500}):new Response(JSON.stringify({policies:[]}));
 if(u.endsWith('/estimate-changes'))return new Response(JSON.stringify({changes:[]}));throw Error(`Unexpected request: ${u}`)}))}
beforeEach(async()=>{vi.restoreAllMocks();window.history.replaceState(null,'','/?page=assets');await i18n.changeLanguage('en')});

describe('Fixed Assets module sub-views',()=>{
 it('shows KPI summary derived from the register and navigates to policy governance and back',async()=>{
  mock();render(<FixedAssetsModule {...props}/>);
  expect(await screen.findByText('FA-001')).toBeInTheDocument();
  expect(screen.getAllByText('12,500.00').length).toBeGreaterThan(0);
  fireEvent.click(screen.getByRole('button',{name:'Asset depreciation policy governance'}));
  expect(await screen.findByRole('heading',{name:'Asset depreciation policy governance'})).toBeInTheDocument();
  expect(window.location.search).toContain('assetView=policy');
  fireEvent.click(screen.getByRole('button',{name:'Fixed Assets'}));
  expect(await screen.findByText('FA-001')).toBeInTheDocument();
  expect(window.location.search).not.toContain('assetView');
 });
 it('opens the category accounting sub-view with its own save action',async()=>{
  mock();render(<FixedAssetsModule {...props}/>);await screen.findByText('FA-001');
  fireEvent.click(screen.getByRole('button',{name:'Asset Category Accounting'}));
  expect(await screen.findByRole('heading',{name:'Asset Category Accounting'})).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Save'})).toBeInTheDocument();
 });
 it('renders the approved load-error treatment for governance failures',async()=>{
  mock(true);window.history.replaceState(null,'','/?page=assets&assetView=policy');render(<FixedAssetsModule {...props}/>);
  await waitFor(()=>expect(screen.getByRole('alert')).toHaveTextContent('Unable to load depreciation policy governance data'));
 });
});
