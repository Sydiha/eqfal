import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { TaxWorkpaper } from '../components/TaxWorkpaper';

describe('Tax working paper',()=>{
 beforeEach(async()=>{vi.restoreAllMocks();await i18n.changeLanguage('en');});
 it('renders the applicable mixed path, readiness workflow, and traceable adjustments',async()=>{vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({workpaper:{id:'w',tax_path:'mixed',workflow_status:'draft',notes:null,professional_review_required:false,version:2,adjustments:[{id:'a',description:'Professional adjustment',direction:'add',amount:'12.30',notes:null,source_reference:'REF-1',professional_review_required:true,version:1}]}}),{status:200}));render(<TaxWorkpaper yearId="fy" canView canManage canReview canApprove onUnauthorized={vi.fn()} onChanged={vi.fn()}/>);expect(await screen.findByText('Mixed')).toBeInTheDocument();expect(screen.getByText('REF-1')).toBeInTheDocument();expect(screen.getAllByText(/Professional review required/).length).toBeGreaterThan(0);});
 it('allows an authorized user to create a missing workpaper',async()=>{const fetchMock=vi.spyOn(globalThis,'fetch').mockResolvedValueOnce(new Response(JSON.stringify({workpaper:null}),{status:200})).mockResolvedValueOnce(new Response(JSON.stringify({workpaper:{}}),{status:201})).mockResolvedValueOnce(new Response(JSON.stringify({workpaper:null}),{status:200}));render(<TaxWorkpaper yearId="fy" canView canManage canReview={false} canApprove={false} onUnauthorized={vi.fn()} onChanged={vi.fn()}/>);fireEvent.click(await screen.findByRole('button',{name:'Create working paper'}));await waitFor(()=>expect(fetchMock).toHaveBeenCalledWith('/api/tax-working-papers/fy',expect.objectContaining({method:'POST'})));});
});
