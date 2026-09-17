import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Accounting } from '../components/Accounting';
import i18n from '../i18n';

const year={id:'33333333-3333-4333-8333-333333333333',name:'2026',start_date:'2026-01-01',end_date:'2026-12-31'};
const base=(url:string)=>url==='/api/accounts'?{accounts:[]}:url==='/api/fiscal-years'?{fiscalYears:[year]}:url==='/api/journals'?{journals:[]}:{sources:[]};
const profit={statement:'profit_or_loss',sections:[{category:'revenue',accounts:[{account_id:'a',code:'4000',name:'Sales',amount:'200.00'}],total:'200.00'}],profit_or_loss:'200.00'};
const position={statement:'financial_position',sections:[{category:'current_asset',accounts:[{account_id:'a',code:'1000',name:'Cash',amount:'200.00'}],total:'200.00'}],current_period_earnings:'200.00',accounting_equation:{assets:'200.00',liabilities_and_equity:'200.00',difference:'0.00',balanced:true}};
const equity={statement:'changes_in_equity',equity_accounts:[{account_id:'e',code:'3000',name:'Owner equity',amount:'25.00'}],opening_equity:'100.00',direct_equity_movements:'25.00',current_period_earnings:'75.00',closing_equity:'200.00',reconciliation:{expected:'200.00',actual:'200.00',difference:'0.00',balanced:true}};
const cashFlow={statement:'cash_flow',sections:[{category:'operating',accounts:[{account_id:'r',code:'4000',name:'Customer receipts',amount:'125.00'}],total:'125.00'},{category:'investing',accounts:[],total:'0.00'},{category:'financing',accounts:[],total:'0.00'}],opening_cash_and_cash_equivalents:'25.00',net_change_in_cash_and_cash_equivalents:'125.00',closing_cash_and_cash_equivalents:'150.00',reconciliation:{expected:'150.00',actual:'150.00',difference:'0.00',balanced:true}};

describe('Accounting financial statements',()=>{
 beforeEach(async()=>{await i18n.changeLanguage('en');window.history.replaceState(null,'','/?page=accounting')});
 it('submits P&L from/to boundaries and renders its scoped result',async()=>{
  const fetchMock=vi.fn(async(url:string)=>new Response(JSON.stringify(url.startsWith('/api/financial-statements/')?profit:base(url))));
  vi.stubGlobal('fetch',fetchMock);
  render(<Accounting canView canCreateChart={false} canEditChart={false} canCreateJournal={false} canEditJournal={false} canPost={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('tab',{name:'Profit or Loss'}));
  fireEvent.click(screen.getByRole('button',{name:'Run report'}));
  expect(await screen.findByText(/Sales/)).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('start_date=2026-01-01&end_date=2026-12-31'),expect.anything());
 });

 it('submits financial position as-of date and clears it when changing statement tabs',async()=>{
  const fetchMock=vi.fn(async(url:string)=>new Response(JSON.stringify(url.startsWith('/api/financial-statements/')?position:base(url))));
  vi.stubGlobal('fetch',fetchMock);
  render(<Accounting canView canCreateChart={false} canEditChart={false} canCreateJournal={false} canEditJournal={false} canPost={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('tab',{name:'Financial Position'}));
  fireEvent.click(screen.getByRole('button',{name:'Run report'}));
  expect(await screen.findByText(/1000.*Cash/)).toBeInTheDocument();
  expect(screen.getByText('Accounting equation').nextSibling).toHaveTextContent('Balanced');
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('as_of_date=2026-12-31'),expect.anything());
  fireEvent.click(screen.getByRole('tab',{name:'Profit or Loss'}));
  await waitFor(()=>expect(screen.queryByText(/1000.*Cash/)).not.toBeInTheDocument());
 });

 it('shows the explicit unmapped blocker',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.startsWith('/api/financial-statements/')?new Response(JSON.stringify({code:'FINANCIAL_STATEMENT_UNMAPPED_ACCOUNTS'}),{status:409}):new Response(JSON.stringify(base(url)))));
  render(<Accounting canView canCreateChart={false} canEditChart={false} canCreateJournal={false} canEditJournal={false} canPost={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('tab',{name:'Financial Position'}));
  fireEvent.click(screen.getByRole('button',{name:'Run report'}));
  expect(await screen.findByText(/posted activity exists on unmapped accounts/)).toBeInTheDocument();
 });

 it('submits and renders the scoped changes-in-equity result and reconciliation',async()=>{
  const fetchMock=vi.fn(async(url:string)=>new Response(JSON.stringify(url.startsWith('/api/financial-statements/')?equity:base(url))));
  vi.stubGlobal('fetch',fetchMock);
  render(<Accounting canView canCreateChart={false} canEditChart={false} canCreateJournal={false} canEditJournal={false} canPost={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('tab',{name:'Changes in Equity'}));
  fireEvent.click(screen.getByRole('button',{name:'Run report'}));
  expect(await screen.findByText(/Owner equity/)).toBeInTheDocument();
  expect(screen.getByText('Closing equity').nextSibling).toHaveTextContent('200.00');
  expect(screen.getByText('Financial Position reconciliation').nextSibling).toHaveTextContent('200.00 / 200.00 (0.00) — Balanced');
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/financial-statements/changes-in-equity?'),expect.anything());
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('start_date=2026-01-01&end_date=2026-12-31'),expect.anything());
 });

 it('synchronizes changes-in-equity dates when switching fiscal years',async()=>{
  const nextYear={id:'44444444-4444-4444-8444-444444444444',name:'2027',start_date:'2027-04-01',end_date:'2028-03-31'};
  const fetchMock=vi.fn(async(url:string)=>new Response(JSON.stringify(url==='/api/fiscal-years'?{fiscalYears:[year,nextYear]}:url.startsWith('/api/financial-statements/')?equity:base(url))));
  vi.stubGlobal('fetch',fetchMock);
  render(<Accounting canView canCreateChart={false} canEditChart={false} canCreateJournal={false} canEditJournal={false} canPost={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('tab',{name:'Changes in Equity'}));
  fireEvent.change(screen.getByRole('combobox'),{target:{value:nextYear.id}});
  expect(screen.getByLabelText('From accounting date')).toHaveValue('2027-04-01');
  expect(screen.getByLabelText('To accounting date')).toHaveValue('2028-03-31');
  fireEvent.click(screen.getByRole('button',{name:'Run report'}));
  await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining(`fiscal_year_id=${nextYear.id}&start_date=2027-04-01&end_date=2028-03-31`),expect.anything()));
 });

 it('loads and renders the three cash-flow sections and reconciled totals',async()=>{
  const fetchMock=vi.fn(async(url:string)=>new Response(JSON.stringify(url.startsWith('/api/financial-statements/')?cashFlow:base(url))));
  vi.stubGlobal('fetch',fetchMock);
  render(<Accounting canView canCreateChart={false} canEditChart={false} canCreateJournal={false} canEditJournal={false} canPost={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('tab',{name:'Cash Flows'}));
  fireEvent.click(screen.getByRole('button',{name:'Run report'}));
  expect(await screen.findByText('Operating activities')).toBeInTheDocument();
  expect(screen.getByText('Investing activities')).toBeInTheDocument();
  expect(screen.getByText('Financing activities')).toBeInTheDocument();
  expect(screen.getByText('Closing cash and cash equivalents').nextSibling).toHaveTextContent('150.00');
  expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/financial-statements/cash-flow?'),expect.anything());
 });

 it('renders the cash-flow fail-closed readiness state',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.startsWith('/api/financial-statements/')?new Response(JSON.stringify({code:'CASH_FLOW_CLASSIFICATION_BLOCKED'}),{status:409}):new Response(JSON.stringify(base(url)))));
  render(<Accounting canView canCreateChart={false} canEditChart={false} canCreateJournal={false} canEditJournal={false} canPost={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('tab',{name:'Cash Flows'}));
  fireEvent.click(screen.getByRole('button',{name:'Run report'}));
  expect(await screen.findByText(/cash activity is unmapped or ambiguous/)).toBeInTheDocument();
 });
});
