import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '../i18n';
import { TaxWorkpaper } from '../components/TaxWorkpaper';

const workpaper={id:'w',tax_path:'mixed',workflow_status:'draft',notes:null,professional_review_required:false,version:1,adjustments:[{id:'a',description:'Adjustment A',direction:'add',amount:'10.00',notes:null,source_reference:null,professional_review_required:false,version:1}]};

describe('Tax workpaper granular capabilities',()=>{
  beforeEach(async()=>{vi.restoreAllMocks();await i18n.changeLanguage('en');vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({workpaper}),{status:200}));});

  it('does not expose create without create capability',async()=>{
    vi.spyOn(globalThis,'fetch').mockResolvedValue(new Response(JSON.stringify({workpaper:null}),{status:200}));
    render(<TaxWorkpaper yearId="fy" canView canCreate={false} canEdit={false} canCreateAdjustment={false} canEditAdjustment={false} canDeleteAdjustment={false} canSubmit={false} canReview={false} canApprove={false} onUnauthorized={vi.fn()} onChanged={vi.fn()}/>);
    expect(await screen.findByText('No working paper has been started for this fiscal year.')).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Create working paper'})).not.toBeInTheDocument();
  });

  it('keeps adjustment actions independent',async()=>{
    render(<TaxWorkpaper yearId="fy" canView canCreate={false} canEdit={false} canCreateAdjustment={false} canEditAdjustment canDeleteAdjustment={false} canSubmit={false} canReview={false} canApprove={false} onUnauthorized={vi.fn()} onChanged={vi.fn()}/>);
    expect(await screen.findByText('Adjustment A')).toBeInTheDocument();
    expect(screen.getByRole('button',{name:'Edit'})).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Remove'})).not.toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Add adjustment'})).not.toBeInTheDocument();
  });

  it('does not expose submit without submit capability',async()=>{
    render(<TaxWorkpaper yearId="fy" canView canCreate canEdit canCreateAdjustment canEditAdjustment canDeleteAdjustment canSubmit={false} canReview={false} canApprove={false} onUnauthorized={vi.fn()} onChanged={vi.fn()}/>);
    expect(await screen.findByText('Adjustment A')).toBeInTheDocument();
    expect(screen.queryByRole('button',{name:'Submit for review'})).not.toBeInTheDocument();
  });
});
