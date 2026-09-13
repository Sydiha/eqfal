import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Accounting } from '../components/Accounting';
import i18n from '../i18n';

const year={id:'33333333-3333-4333-8333-333333333333',name:'2026',start_date:'2026-01-01',end_date:'2026-12-31'};
const base=(url:string)=>url==='/api/accounts'?{accounts:[]}:url==='/api/fiscal-years'?{fiscalYears:[year]}:url==='/api/journals'?{journals:[]}:{sources:[]};

describe('Accounting financial statements',()=>{
 beforeEach(async()=>{await i18n.changeLanguage('en');window.history.replaceState(null,'','/?page=accounting')});
 it('loads and renders Profit or Loss',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>new Response(JSON.stringify(url.startsWith('/api/financial-statements/')?{sections:[{category:'revenue',accounts:[{account_id:'a',code:'4000',name:'Sales',amount:'200.00'}],total:'200.00'}],profit_or_loss:'200.00'}:base(url)))));
  render(<Accounting canView canManageChart={false} canManageJournals={false} canPost={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('tab',{name:'Profit or Loss'}));
  fireEvent.click(screen.getByRole('button',{name:'Run report'}));
  expect(await screen.findByText(/Sales/)).toBeInTheDocument();
  expect(screen.getAllByText('200.00').length).toBeGreaterThan(0);
 });

 it('shows the explicit unmapped blocker',async()=>{
  vi.stubGlobal('fetch',vi.fn(async(url:string)=>url.startsWith('/api/financial-statements/')?new Response(JSON.stringify({code:'FINANCIAL_STATEMENT_UNMAPPED_ACCOUNTS'}),{status:409}):new Response(JSON.stringify(base(url)))));
  render(<Accounting canView canManageChart={false} canManageJournals={false} canPost={false} onUnauthorized={vi.fn()}/>);
  fireEvent.click(await screen.findByRole('tab',{name:'Financial Position'}));
  fireEvent.click(screen.getByRole('button',{name:'Run report'}));
  expect(await screen.findByText(/posted activity exists on unmapped accounts/)).toBeInTheDocument();
 });
});
