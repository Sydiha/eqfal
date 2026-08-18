import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../i18n';
import i18n from '../i18n';
import { MonthlyClose } from '../components/MonthlyClose';

const open={id:'period-open',fiscal_year_id:'fy',period_start:'2026-01-01',period_end:'2026-01-31',status:'open',ready:false,blockers:{documents:1,obligations:2,bank_transactions:3,total:6}} as const;
const closed={...open,id:'period-closed',period_start:'2025-12-01',period_end:'2025-12-31',status:'closed',ready:true,blockers:{documents:0,obligations:0,bank_transactions:0,total:0}} as const;
const years={fiscalYears:[{id:'fy',name:'FY 2026',start_date:'2026-01-01',end_date:'2026-12-31'}]};

beforeEach(async()=>{await i18n.changeLanguage('en');vi.restoreAllMocks();});

describe('MonthlyClose',()=>{
 it('shows computed blockers and only authorized state actions',async()=>{vi.stubGlobal('fetch',vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({periods:[open,closed]}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify(years),{status:200})));render(<MonthlyClose canView canClose canReopen onUnauthorized={vi.fn()}/>);expect(await screen.findByText('6 blocking items')).toBeInTheDocument();expect(screen.getByText('Documents: 1')).toBeInTheDocument();expect(screen.getByRole('button',{name:'Close period'})).toBeDisabled();expect(screen.getByRole('button',{name:'Reopen period'})).toBeEnabled();});
 it('requires and sends a reopen reason',async()=>{const fetchMock=vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({periods:[closed]}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify(years),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({...closed,status:'open'}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({periods:[]}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify(years),{status:200}));vi.stubGlobal('fetch',fetchMock);render(<MonthlyClose canView canClose={false} canReopen onUnauthorized={vi.fn()}/>);fireEvent.click(await screen.findByRole('button',{name:'Reopen period'}));const reason=screen.getByLabelText('Reason');expect(reason).toBeRequired();fireEvent.change(reason,{target:{value:'Correct January invoice'}});fireEvent.submit(reason.closest('form')!);await waitFor(()=>expect(fetchMock).toHaveBeenCalledTimes(5));expect(fetchMock.mock.calls[2]![0]).toBe('/api/monthly-close-periods/period-closed/reopen');expect(JSON.parse(fetchMock.mock.calls[2]![1].body)).toEqual({reason:'Correct January invoice'});});
 it('does not fetch without view access',()=>{const fetchMock=vi.fn();vi.stubGlobal('fetch',fetchMock);render(<MonthlyClose canView={false} canClose canReopen onUnauthorized={vi.fn()}/>);expect(screen.getByText(/do not have permission/)).toBeInTheDocument();expect(fetchMock).not.toHaveBeenCalled();});
});
