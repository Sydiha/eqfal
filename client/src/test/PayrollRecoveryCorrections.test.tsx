import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PayrollRecoveryCorrections } from '../components/PayrollRecoveryCorrections';
import i18n from '../i18n';

const recovery={recovery_id:'r-1',recovery_amount:'40.00',employee_number:'E1',display_name:'Employee',advance_id:'a-1',advance_amount:'100.00',payroll_period:'2026-03-01',payroll_journal_reference:'PAY-1',reversed_amount:'0.00',remaining_reversible_amount:'40.00'};
const correction={id:'c-1',recovery_id:'r-1',amount:'10.00',reason:'Correct the verified recovery',status:'approved',requested_by_current_user:false,approved_by_current_user:false,payroll_participant_current_user:false,privileged_financial_authority_current_user:false,approval_expires_at:'2099-03-01T00:00:00Z',approval_expired:false,accounting_date:'2026-03-15',journal_reference:null,employee_number:'E1',employee_name:'Employee',payroll_draft_id:'d-1',period_month:'2026-03-01',end_reason:null};
const response=(data:unknown)=>new Response(JSON.stringify(data),{status:200});
const actionActors=[
 ['requester',{requested_by_current_user:true}],
 ['approver',{approved_by_current_user:true}],
 ['payroll participant',{payroll_participant_current_user:true}],
] as const;
const followupActions=['post','expiry'] as const;

describe('payroll recovery correction UI',()=>{
 beforeEach(async()=>{await i18n.changeLanguage('en');});afterEach(()=>vi.unstubAllGlobals());
 it('shows correction history read-only without correction permissions',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/advance-recoveries')?response({recoveries:[recovery]}):url.endsWith('/recovery-corrections')?response({corrections:[correction]}):response({lease_days:30,correction_approval_days:30})));
  render(<PayrollRecoveryCorrections capabilities={['payroll.view','payroll.employee_advance_recovery.view']} onUnauthorized={vi.fn()}/>);
  const article=await screen.findByRole('article');expect(article.textContent).toContain('Correct the verified recovery');expect(article.textContent).toContain('E1');
  expect(screen.getByText(/Approved for posting/)).toBeInTheDocument();
  expect(screen.queryByRole('button',{name:/Post correction journal/})).toBeNull();
  expect(screen.queryByRole('button',{name:/Approve independently/})).toBeNull();
  expect(screen.queryByRole('button',{name:/Submit correction request/})).toBeNull();
 });
 it('keeps independent approval separate from posting and refreshes after approval',async()=>{
  const calls:Array<{url:string;method:string}> = [];
  vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{const url=String(input),method=init?.method??'GET';calls.push({url,method});if(url.endsWith('/recovery-corrections')&&method==='POST')return response({id:'c-1',status:'approved'});return url.endsWith('/advance-recoveries')?response({recoveries:[recovery]}):url.endsWith('/recovery-corrections')?response({corrections:[{...correction,status:'pending'}]}):response({lease_days:30,correction_approval_days:30});}));
  render(<PayrollRecoveryCorrections capabilities={['payroll.view','payroll.employee_advance_recovery.view','payroll.employee_advance_recovery.correct.approve']} onUnauthorized={vi.fn()}/>);
  const reason=await screen.findByRole('textbox',{name:'Independent approval or rejection reason'});
  fireEvent.change(reason,{target:{value:'Independent review confirms this correction'}});
  fireEvent.click(screen.getByRole('button',{name:'Approve independently'}));
  await waitFor(()=>expect(calls.some(x=>x.url==='/api/payroll/recovery-corrections/c-1/decision'&&x.method==='POST')).toBe(true));
  expect(calls.some(x=>x.url.endsWith('/c-1/post'))).toBe(false);
 });
 it('allows a server-authorized privileged requester and payroll participant to decide their own correction',async()=>{
  const calls:Array<{url:string;method:string}> = [];
  const ownCorrection={...correction,status:'pending',requested_by_current_user:true,payroll_participant_current_user:true,privileged_financial_authority_current_user:true};
  vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{const url=String(input),method=init?.method??'GET';calls.push({url,method});if(url.endsWith('/decision'))return response({id:'c-1',status:'approved'});return url.endsWith('/advance-recoveries')?response({recoveries:[]}):url.endsWith('/recovery-corrections')?response({corrections:[ownCorrection]}):response({lease_days:30,correction_approval_days:30});}));
  render(<PayrollRecoveryCorrections capabilities={['payroll.view','payroll.employee_advance_recovery.view','payroll.employee_advance_recovery.correct.approve']} onUnauthorized={vi.fn()}/>);
  const reason=await screen.findByRole('textbox',{name:'Independent approval or rejection reason'});
  fireEvent.change(reason,{target:{value:'Privileged review confirms this correction'}});
  const approve=screen.getByRole('button',{name:'Approve independently'});
  expect(approve).toBeEnabled();
  fireEvent.click(approve);
  await waitFor(()=>expect(calls.some(x=>x.url==='/api/payroll/recovery-corrections/c-1/decision'&&x.method==='POST')).toBe(true));
 });
 it.each([
  ['requester',{requested_by_current_user:true,payroll_participant_current_user:false}],
  ['payroll participant',{requested_by_current_user:false,payroll_participant_current_user:true}],
 ] as const)('keeps ordinary-user %s decisions disabled',async(_label,participation)=>{
  const ordinaryCorrection={...correction,...participation,status:'pending',privileged_financial_authority_current_user:false};
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/advance-recoveries')?response({recoveries:[]}):url.endsWith('/recovery-corrections')?response({corrections:[ordinaryCorrection]}):response({lease_days:30,correction_approval_days:30})));
  render(<PayrollRecoveryCorrections capabilities={['payroll.view','payroll.employee_advance_recovery.view','payroll.employee_advance_recovery.correct.approve']} onUnauthorized={vi.fn()}/>);
  const reason=await screen.findByRole('textbox',{name:'Independent approval or rejection reason'});
  fireEvent.change(reason,{target:{value:'A sufficiently detailed decision reason'}});
  expect(screen.getByRole('button',{name:'Approve independently'})).toBeDisabled();
  expect(screen.getByRole('button',{name:'Reject'})).toBeDisabled();
 });
 it.each(followupActions.flatMap(action=>actionActors.map(([actor,flags])=>[action,actor,flags] as const)))('allows a privileged %s action for a %s',async(action,_actor,flags)=>{
  const calls:Array<{url:string;method:string}> = [];
  const privilegedCorrection={...correction,...flags,status:'approved',approval_expired:action==='expiry',privileged_financial_authority_current_user:true};
  vi.stubGlobal('fetch',vi.fn(async(input:string|URL|Request,init?:RequestInit)=>{const url=String(input),method=init?.method??'GET';calls.push({url,method});return url.endsWith('/advance-recoveries')?response({recoveries:[]}):url.endsWith('/recovery-corrections')?response({corrections:[privilegedCorrection]}):response({lease_days:30,correction_approval_days:30});}));
  render(<PayrollRecoveryCorrections capabilities={['payroll.view','payroll.employee_advance_recovery.view','payroll.employee_advance_recovery.correct','payroll.accounting.post']} onUnauthorized={vi.fn()}/>);
  const label=action==='post'?'Post correction journal':'Record approval expiry';
  const button=await screen.findByRole('button',{name:label});
  expect(button).toBeEnabled();
  fireEvent.click(button);
  const suffix=action==='post'?'/post':'/expire';
  await waitFor(()=>expect(calls.some(x=>x.url===`/api/payroll/recovery-corrections/c-1${suffix}`&&x.method==='POST')).toBe(true));
 });
 it.each(followupActions.flatMap(action=>actionActors.map(([actor,flags])=>[action,actor,flags] as const)))('keeps ordinary-user %s disabled for a %s',async(action,_actor,flags)=>{
  const ordinaryCorrection={...correction,...flags,status:'approved',approval_expired:action==='expiry',privileged_financial_authority_current_user:false};
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/advance-recoveries')?response({recoveries:[]}):url.endsWith('/recovery-corrections')?response({corrections:[ordinaryCorrection]}):response({lease_days:30,correction_approval_days:30})));
  render(<PayrollRecoveryCorrections capabilities={['payroll.view','payroll.employee_advance_recovery.view','payroll.employee_advance_recovery.correct','payroll.accounting.post']} onUnauthorized={vi.fn()}/>);
  const label=action==='post'?'Post correction journal':'Record approval expiry';
  expect(await screen.findByRole('button',{name:label})).toBeDisabled();
 });
 it('renders Arabic correction and expiry labels',async()=>{
  await i18n.changeLanguage('ar');
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.endsWith('/advance-recoveries')?response({recoveries:[]}):url.endsWith('/recovery-corrections')?response({corrections:[{...correction,status:'expired',approval_expired:true}]}):response({lease_days:30,correction_approval_days:30})));
  render(<PayrollRecoveryCorrections capabilities={['payroll.view','payroll.employee_advance_recovery.view']} onUnauthorized={vi.fn()}/>);
  expect(await screen.findByText('استرداد سلف الرواتب وتصحيحها')).toBeInTheDocument();
  expect(screen.getByText(/انتهى الاعتماد/)).toBeInTheDocument();
 });
});
