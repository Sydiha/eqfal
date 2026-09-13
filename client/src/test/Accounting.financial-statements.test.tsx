import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Accounting } from '../components/Accounting';
import i18n from '../i18n';

const year={id:'33333333-3333-4333-8333-333333333333',name:'2026',start_date:'2026-01-01',end_date:'2026-12-31'};
const base=(url:string)=>url==='/api/accounts'?{accounts:[]}:url==='/api/fiscal-years'?{fiscalYears:[year]}:url==='/api/journals'?{journals:[]}:{sources:[]};
const profit={statement:'profit_or_loss',sections:[{category:'revenue',accounts:[{account_id:'a',code:'4000',name:'Sales',amount:'200.00'}],total:'200.00'}],profit_or_loss:'200.00'};
const position={statement:'financial_position',sections:[{category:'current_asset',accounts:[{account_id:'a',code:'1000',name:'Cash',amount:'200.00'}],total:'200.00'}],current_period_earnings:'200.00',accounting_equation:{assets:'200.00',liabilities_and_equity:'200.00',difference:'0.00',balanced:true}};
const equity={statement:'changes_in_equity',equity_accounts:[{account_id:'e',code:'3000',name:'Owner equity',amount:'25.00'}],opening_equity:'100.00',direct_equity_movements:'25.00',current_period_earnings:'75.00',closing_equity:'200.00',reconciliation:{expected:'200.00',actual:'200.00',difference:'0.00',balanced:true}};

describe('Accounting financial statements',()=>{
 beforeEach(async()=>{await i18n.changeLanguage('en');window.history.replaceState(null,'','/?page=accounting')});
 it('submits P&L from/to boundaries and renders its scoped result',async()=>{
  const fetchMock=vi.fn(async(url:string)=>new Response(JSON.stringify(url.startsWith('/api/financial-statements/')?profit:base(url))));
  vi.stubGlobal('fetch',fetchMock);
  render(<Accounting canView canManageChart={false} canManageJournals={false} canPost={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('tab',{name:'Profit or Loss'}));
  fireEvent.click(screen.getByRole('button',{name:'Run report'}));
  expect(await screen.findByText(/Sales/)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('start_date=2026-01-01&end_date=2026-12-31'),expect.anything());
 });

 it('submits financial position as-of date and clears it when changing statement tabs',async()=>{
  const fetchMock=vi.fn(async(url:string)=>new Response(JSON.stringify(url.startsWith('/api/financial-statements/')?position:base(url))));
  vi.stubGlobal('fetch',fetchMock);
  render(<Accounting canView canManageChart={false} canManageJournals={false} canPost={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('tab',{name:'Financial Position'}));
  fireEvent.click(screen.getByRole('button',{name:'Run report'}));
  expect(await screen.findByText(/Cash/)).toBeInTheDocument();
  expect(screen.getByText('Accounting equation').nextSibling).toHaveTextContent('Balanced');
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('as_of_date=2026-12-31'),expect.anything());
  fireEvent.click(screen.getByRole('tab',{name:'Profit or Loss'}));
  await waitFor(()=>expect(screen.queryByText(/Cash/)).not.toBeInTheDocument());
 });

 it('shows the explicit unmapped blocker',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.startsWith('/api/financial-statements/')?new Response(JSON.stringify({code:'FINANCIAL_STATEMENT_UNMAPPED_ACCOUNTS'}),{status:409}):new Response(JSON.stringify(base(url)))));
  render(<Accounting canView canManageChart={false} canManageJournals={false} canPost={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('tab',{name:'Financial Position'}));
  fireEvent.click(screen.getByRole('button',{name:'Run report'}));
  expect(await screen.findByText(/posted activity exists on unmapped accounts/)).toBeInTheDocument();
 });

 it('submits and renders the scoped changes-in-equity result and reconciliation',async()=>{
  const fetchMock=vi.fn(async(url:string)=>new Response(JSON.stringify(url.startsWith('/api/financial-statements/')?equity:base(url))));
  vi.stubGlobal('fetch',fetchMock);
  render(<Accounting canView canManageChart={false} canManageJournals={false} canPost={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('tab',{name:'Changes in Equity'}));
  fireEvent.click(screen.getByRole('button',{name:'Run report'}));
  expect(await screen.findByText(/Owner equity/)).toBeInTheDocument();
  expect(screen.getByText('Closing equity').nextSibling).toHaveTextContent('200.00');
  expect(screen.getByText('Financial Position reconciliation').nextSibling).toHaveTextContent('200.00 / 200.00 (0.00) — Balanced');
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/financial-statements/changes-in-equity?'),expect.anything());
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('start_date=2026-01-01&end_date=2026-12-31'),expect.anything());
 });
});
