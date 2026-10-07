import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n'; import i18n from '../i18n'; import { Partners } from '../components/Partners';
const unknown={id:'p1',name:'Unknown Partner',is_active:true,version:1,current_ownership_percentage:null,current_effective_from:null,has_unconfirmed_ownership:true};
const confirmed={id:'p2',name:'Known Partner',is_active:true,version:1,current_ownership_percentage:'35.5000',current_effective_from:'2026-01-01',has_unconfirmed_ownership:false};
const permissions={canCreatePartner:false,canEditPartner:false,canDisablePartner:false,canCreateOwnership:false,canEditOwnership:false,canConfirmOwnership:false};
beforeEach(async()=>{await i18n.changeLanguage('en');vi.restoreAllMocks();window.history.replaceState(null,'','/?page=partners')});
describe('Partners',()=>{
 it('renders unknown and confirmed ownership without guessing zero',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({partners:[unknown,confirmed]}),{status:200})));render(<Partners canView {...permissions} onUnauthorized={vi.fn()}/>);expect(await screen.findByText('Unknown Partner')).toBeInTheDocument();expect(screen.getAllByText('Unknown').length).toBeGreaterThan(0);expect(screen.queryByText('0%')).not.toBeInTheDocument();expect(screen.getByText('35.5000%')).toBeInTheDocument();expect(screen.getByText('Unconfirmed')).toBeInTheDocument()});
 it('gates partner actions independently',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({partners:[unknown]}),{status:200})));const {rerender}=render(<Partners canView {...permissions} canCreatePartner onUnauthorized={vi.fn()}/>);await screen.findByText('Unknown Partner');expect(screen.getByText('Create partner')).toBeInTheDocument();expect(screen.queryByText('Edit')).not.toBeInTheDocument();rerender(<Partners canView {...permissions} canDisablePartner onUnauthorized={vi.fn()}/>);expect(screen.queryByText('Create partner')).not.toBeInTheDocument();expect(screen.getByText('Edit')).toBeInTheDocument()});
 it('gates ownership create, edit, and confirm independently',async()=>{const ownership={id:'o1',ownership_percentage:'25',effective_from:'2026-01-01',effective_to:null,verification_status:'unconfirmed',source_document_id:'doc-1',note:'Pending evidence',version:1};const responses=()=>vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({partners:[unknown]}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({ownership:[ownership]}),{status:200}));vi.stubGlobal('fetch',responses());const {unmount}=render(<Partners canView {...permissions} canCreateOwnership onUnauthorized={vi.fn()}/>);fireEvent.click(await screen.findByText('Unknown Partner'));expect(await screen.findByText('Add ownership period')).toBeInTheDocument();expect(screen.queryByText('Edit / confirm')).not.toBeInTheDocument();unmount();window.history.replaceState(null,'','/?page=partners');vi.stubGlobal('fetch',responses());render(<Partners canView {...permissions} canConfirmOwnership onUnauthorized={vi.fn()}/>);fireEvent.click(await screen.findByText('Unknown Partner'));expect(await screen.findByText('Edit / confirm')).toBeInTheDocument();expect(screen.queryByText('Add ownership period')).not.toBeInTheDocument()});
 it('renders the Arabic path',async()=>{await i18n.changeLanguage('ar');vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({partners:[]}),{status:200})));render(<Partners canView {...permissions} onUnauthorized={vi.fn()}/>);expect(await screen.findByText('لا يوجد شركاء بعد.')).toBeInTheDocument();expect(screen.getByRole('heading',{name:'الشركاء'})).toBeInTheDocument()});
 it('shows total, active and inactive counts derived from the register',async()=>{const inactive={...confirmed,id:'p3',name:'Inactive Partner',is_active:false};vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({partners:[unknown,confirmed,inactive]}),{status:200})));render(<Partners canView {...permissions} onUnauthorized={vi.fn()}/>);await screen.findByText('Inactive Partner');const summary=screen.getByLabelText('Partner summary');expect(summary).toHaveTextContent('Total partners3');expect(summary).toHaveTextContent('Active2');expect(summary).toHaveTextContent('Inactive1')});
 it('never shows another partner\'s ownership history while switching or after an out-of-order response',async()=>{let releaseFirst:(r:Response)=>void=()=>{};const row=(id:string,pct:string)=>({id:`o-${id}`,ownership_percentage:pct,effective_from:'2026-01-01',effective_to:null,verification_status:'confirmed',source_document_id:null,note:null,version:1});vi.stubGlobal('fetch',vi.fn((url:string)=>{if(url==='/api/partners')return Promise.resolve(new Response(JSON.stringify({partners:[unknown,confirmed]})));if(url==='/api/partners/p1/ownership')return new Promise<Response>(resolve=>{releaseFirst=resolve});return Promise.resolve(new Response(JSON.stringify({ownership:[row('p2','60')]})))}));render(<Partners canView {...permissions} onUnauthorized={vi.fn()}/>);fireEvent.click(await screen.findByRole('button',{name:'Unknown Partner'}));fireEvent.click(screen.getByRole('button',{name:'Known Partner'}));expect(await screen.findByText('60%')).toBeInTheDocument();await act(async()=>{releaseFirst(new Response(JSON.stringify({ownership:[row('p1','10')]})))});expect(screen.queryByText('10%')).not.toBeInTheDocument();expect(screen.getByText('60%')).toBeInTheDocument()});

 it('submits an ownership entry only once on repeated clicks',async()=>{let posts=0;vi.stubGlobal('fetch',vi.fn((url:string,o?:RequestInit)=>{if(o?.method==='POST'){posts+=1;return new Promise<Response>(()=>{})}if(url==='/api/partners')return Promise.resolve(new Response(JSON.stringify({partners:[confirmed]})));return Promise.resolve(new Response(JSON.stringify({ownership:[]})))}));render(<Partners canView {...permissions} canCreateOwnership onUnauthorized={vi.fn()}/>);fireEvent.click(await screen.findByRole('button',{name:'Known Partner'}));fireEvent.click(await screen.findByRole('button',{name:'Add ownership period'}));const save=await screen.findByRole('button',{name:'Save'});fireEvent.click(save);fireEvent.click(save);expect(posts).toBe(1)});
});

describe('Partner dialog company context',()=>{
 it('shows the active company read-only with no company selector and no company in the payload',async()=>{await i18n.changeLanguage('en');const bodies:string[]=[];vi.stubGlobal('fetch',vi.fn((_url:string,o?:RequestInit)=>{if(o?.method==='POST'){bodies.push(String(o.body));return Promise.resolve(new Response('{}',{status:200}))}return Promise.resolve(new Response(JSON.stringify({partners:[]}),{status:200}))}));render(<Partners canView {...permissions} canCreatePartner companyName="Acme Co" onUnauthorized={vi.fn()}/>);fireEvent.click(await screen.findByRole('button',{name:/create|add/i}));expect(await screen.findByText('Company: Acme Co')).toBeTruthy();expect(screen.queryByRole('combobox')).toBeNull();fireEvent.change(screen.getByLabelText(/name/i),{target:{value:'New Partner'}});await act(async()=>{fireEvent.click(screen.getByRole('button',{name:/save/i}))});expect(bodies).toEqual([JSON.stringify({name:'New Partner'})])});
 it('renders the Arabic company label',async()=>{await i18n.changeLanguage('ar');vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({partners:[]}),{status:200})));render(<Partners canView {...permissions} canCreatePartner companyName="شركة النور" onUnauthorized={vi.fn()}/>);fireEvent.click(await screen.findByRole('button',{name:/إضافة|إنشاء/}));expect(await screen.findByText('الشركة: شركة النور')).toBeTruthy()});
});

describe('Partners context and navigation',()=>{
 const periods=(extra:Record<string,unknown>[]=[])=>[{id:'o-cur',ownership_percentage:'60',effective_from:'2026-01-01',effective_to:null,verification_status:'confirmed',source_document_id:null,note:null,version:1},{id:'o-old',ownership_percentage:'40',effective_from:'2020-01-01',effective_to:'2020-12-31',verification_status:'confirmed',source_document_id:null,note:null,version:1},{id:'o-future',ownership_percentage:'70',effective_from:'2999-01-01',effective_to:null,verification_status:'confirmed',source_document_id:null,note:null,version:1},{id:'o-unc',ownership_percentage:'10',effective_from:'2026-02-01',effective_to:null,verification_status:'unconfirmed',source_document_id:null,note:null,version:1},...extra];
 const api=()=>vi.fn((url:string)=>Promise.resolve(new Response(JSON.stringify(url==='/api/partners'?{partners:[unknown,confirmed]}:{ownership:periods()}),{status:200})));
 it('states the as-of date, counts partners awaiting confirmation and labels period states',async()=>{
  vi.stubGlobal('fetch',api());render(<Partners canView {...permissions} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByTestId('partners-asof')).toHaveTextContent('in effect today');
  const summary=screen.getByLabelText('Partner summary');expect(summary).toHaveTextContent('Awaiting confirmation1');
  fireEvent.click(screen.getByText('Known Partner'));
  expect(await screen.findByText('In effect today')).toBeInTheDocument();
  expect(screen.getByText('Ended')).toBeInTheDocument();expect(screen.getByText('Starts later')).toBeInTheDocument();
  expect(screen.getAllByTestId('ownership-period-state')).toHaveLength(3);
  expect(screen.getByTestId('partner-history-context')).toHaveTextContent('Active');
 });
 it('keeps the selected partner in the URL and restores it after reload',async()=>{
  vi.stubGlobal('fetch',api());const first=render(<Partners canView {...permissions} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('Known Partner'));await screen.findByText('In effect today');
  expect(window.location.search).toContain('partner=p2');first.unmount();
  vi.stubGlobal('fetch',api());render(<Partners canView {...permissions} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByText('In effect today')).toBeInTheDocument();
  expect(screen.getByRole('button',{name:'Known Partner'})).toHaveAttribute('aria-pressed','true');
 });
 it('drops an unknown partner id from the URL instead of showing a stale selection',async()=>{
  window.history.replaceState(null,'','/?page=partners&partner=gone');
  vi.stubGlobal('fetch',api());render(<Partners canView {...permissions} onUnauthorized={vi.fn()}/>);
  await screen.findByText('Known Partner');await waitFor(()=>expect(window.location.search).not.toContain('partner='));
  expect(screen.queryByText('Ownership history')).not.toBeInTheDocument();
 });
 it('names the partner inside the ownership dialog and renders Arabic labels',async()=>{
  await i18n.changeLanguage('ar');vi.stubGlobal('fetch',api());render(<Partners canView {...permissions} canCreateOwnership onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByText('Known Partner'));fireEvent.click(await screen.findByText('إضافة فترة ملكية'));
  expect(await screen.findByTestId('ownership-partner-context')).toHaveTextContent('الشريك: Known Partner');
  expect(screen.getByText('بانتظار التأكيد')).toBeInTheDocument();
 });
});
