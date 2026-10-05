import { Pool, PoolClient } from 'pg';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanyAccountingProfileService } from '../src/modules/company-accounting-profile/company-accounting-profile.service';
import { CompanyAccountingProfile, ProfileValues } from '../src/modules/company-accounting-profile/company-accounting-profile.types';

const COMPANY='11111111-1111-4111-8111-111111111111';
const ACTOR='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ID='33333333-3333-4333-8333-333333333333';
const values:ProfileValues={
  accounting_framework:'IFRS',
  accounting_framework_notes:null,
  functional_currency:'SAR',
  reporting_currency:'SAR',
  first_live_accounting_date:'2026-01-01',
  vat_status:'not_registered',
  vat_registration_number:null,
  vat_registered_from:null,
  vat_deregistered_from:null,
  vat_filing_frequency:null,
  tax_treatment:'zakat_applicable',
  ownership_context:'saudi_gcc_only',
  tax_effective_from:null,
  tax_notes:null,
  wht_profile:'not_currently_applicable',
  has_non_resident_dealings:'no',
  effective_from:'2026-01-01',
  effective_to:null,
  change_reason:'initial'
};

const profile=(status:CompanyAccountingProfile['workflow_status']='draft',overrides:Partial<CompanyAccountingProfile>={}):CompanyAccountingProfile=>({
  id:ID,
  company_id:COMPANY,
  version_no:1,
  workflow_status:status,
  ...values,
  prepared_by_user_id:ACTOR,
  reviewed_by_user_id:null,
  reviewed_at:null,
  approved_by_user_id:null,
  approved_at:null,
  created_at:new Date(),
  updated_at:new Date(),
  closed_period_impact:false,
  professional_review_required:false,
  ...overrides
});

function setup(){
  const commands:string[]=[];
  const client={query:vi.fn(async(sql:string)=>{commands.push(sql);return{rows:[],rowCount:0};}),release:vi.fn()} as unknown as PoolClient;
  const pool={connect:vi.fn(async()=>client)} as unknown as Pool;
  const service=new CompanyAccountingProfileService(pool);
  const repo={hasAny:vi.fn(),create:vi.fn(),closedPeriodImpact:vi.fn().mockResolvedValue(false),byId:vi.fn(),updateDraft:vi.fn(),updateNeedsReview:vi.fn(),transition:vi.fn(),latestApproved:vi.fn(),nextVersion:vi.fn(),approvedOverlaps:vi.fn(),closeEffectivePeriod:vi.fn(),current:vi.fn(),history:vi.fn()};
  const audit={logEvent:vi.fn().mockResolvedValue({})};
  Object.assign(service as unknown as {repo:unknown;audit:unknown},{repo,audit});
  return{service,repo,audit,commands,client};
}

describe('company accounting profile createVersion - behavioral regression tests', () => {
  beforeEach(()=>vi.clearAllMocks());

  it('creates new draft version without copying effective dates from approved base', async () => {
    const x=setup();
    const approved=profile('approved',{version_no:1, id:'44444444-4444-4444-8444-444444444444', effective_from:'2026-01-01', effective_to:null});
    x.repo.latestApproved.mockResolvedValue(approved);
    x.repo.nextVersion.mockResolvedValue(2);
    const createdDraft=profile('draft',{version_no:2, id:'55555555-5555-4555-8555-555555555555', effective_from:null, effective_to:null});
    x.repo.create.mockResolvedValue(createdDraft);

    const result=await x.service.createVersion(COMPANY,ACTOR,{change_reason:'material'});

    expect(x.repo.create).toHaveBeenCalled();
    const callArgs=x.repo.create.mock.calls[0];
    const createdValues=callArgs[3];

    expect(createdValues.effective_from).toBe(null);
    expect(createdValues.effective_to).toBe(null);
    expect(result.workflow_status).toBe('draft');
  });

  it('increments version number and preserves approved profile unchanged', async () => {
    const x=setup();
    const approved=profile('approved',{version_no:1, id:'44444444-4444-4444-8444-444444444444'});
    x.repo.latestApproved.mockResolvedValue(approved);
    x.repo.nextVersion.mockResolvedValue(2);
    const newVersion=profile('draft',{version_no:2, id:'55555555-5555-4555-8555-555555555555', change_reason:'adjustment needed'});
    x.repo.create.mockResolvedValue(newVersion);

    const result=await x.service.createVersion(COMPANY,ACTOR,{change_reason:'adjustment needed'});

    expect(x.repo.nextVersion).toHaveBeenCalledWith(COMPANY,x.client);
    expect(x.repo.create).toHaveBeenCalledWith(COMPANY,2,ACTOR,expect.any(Object),x.client);
    expect(result.version_no).toBe(2);
    expect(result.change_reason).toBe('adjustment needed');
  });

  it('copies profile data from approved base while clearing effective dates', async () => {
    const x=setup();
    const approved=profile('approved',{
      version_no:1,
      id:'44444444-4444-4444-8444-444444444444',
      effective_from:'2026-01-01',
      effective_to:null,
      accounting_framework:'IFRS',
      functional_currency:'SAR',
      tax_treatment:'zakat_applicable',
      accounting_framework_notes:'audited'
    });
    x.repo.latestApproved.mockResolvedValue(approved);
    x.repo.nextVersion.mockResolvedValue(2);
    const newVersion=profile('draft',{version_no:2, id:'55555555-5555-4555-8555-555555555555'});
    x.repo.create.mockResolvedValue(newVersion);

    const result=await x.service.createVersion(COMPANY,ACTOR,{change_reason:'update'});

    const callArgs=x.repo.create.mock.calls[0];
    const createdValues=callArgs[3];

    expect(createdValues.accounting_framework).toBe('IFRS');
    expect(createdValues.functional_currency).toBe('SAR');
    expect(createdValues.tax_treatment).toBe('zakat_applicable');
    expect(createdValues.accounting_framework_notes).toBe('audited');
    expect(createdValues.effective_from).toBe(null);
    expect(createdValues.effective_to).toBe(null);
  });

  it('requires change_reason and rejects creation without approved base', async () => {
    const x=setup();
    x.repo.latestApproved.mockResolvedValue(null);

    await expect(x.service.createVersion(COMPANY,ACTOR,{change_reason:null})).rejects.toThrow('change_reason is required');
    await expect(x.service.createVersion(COMPANY,ACTOR,{change_reason:'  '})).rejects.toThrow('change_reason is required');
    await expect(x.service.createVersion(COMPANY,ACTOR,{change_reason:'valid'})).rejects.toThrow('No approved profile to version');
    expect(x.repo.create).not.toHaveBeenCalled();
  });

  it('executes atomic transaction with audit logging', async () => {
    const x=setup();
    x.repo.latestApproved.mockResolvedValue(profile('approved'));
    x.repo.nextVersion.mockResolvedValue(2);
    x.repo.create.mockResolvedValue(profile('draft',{version_no:2}));

    await x.service.createVersion(COMPANY,ACTOR,{change_reason:'material'});

    expect(x.commands).toEqual(expect.arrayContaining(['BEGIN','COMMIT']));
    expect(x.audit.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      company_id:COMPANY,
      actor_user_id:ACTOR,
      action:'company_accounting_profile.create'
    }),x.client);
  });

  it('rolls back transaction when audit logging fails', async () => {
    const x=setup();
    x.repo.latestApproved.mockResolvedValue(profile('approved'));
    x.repo.nextVersion.mockResolvedValue(2);
    x.repo.create.mockResolvedValue(profile('draft',{version_no:2}));
    x.audit.logEvent.mockRejectedValue(new Error('audit failed'));

    await expect(x.service.createVersion(COMPANY,ACTOR,{change_reason:'material'})).rejects.toThrow('audit failed');
    expect(x.commands).toContain('ROLLBACK');
    expect(x.commands).not.toContain('COMMIT');
  });

  it('enforces tenant isolation with proper company scoping', async () => {
    const x=setup();
    const OTHER='22222222-2222-4222-8222-222222222222';
    x.repo.latestApproved.mockResolvedValue(null);

    await expect(x.service.createVersion(OTHER,ACTOR,{change_reason:'attempt'})).rejects.toThrow('No approved profile to version');
    expect(x.repo.latestApproved).toHaveBeenCalledWith(OTHER,x.client);
  });
});
