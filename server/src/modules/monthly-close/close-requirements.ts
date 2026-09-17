import { Pool, PoolClient } from 'pg';
import { CompanyAccountingProfileRepository } from '../company-accounting-profile/company-accounting-profile.repository';

type Runner = Pool | PoolClient;

export type MonthlyCloseRequirements = {
  vat: boolean;
  vat_requires_resolution: boolean;
  opening_balances: boolean;
  profile_resolved: boolean;
};

export class MonthlyCloseRequirementResolver {
  private profiles: CompanyAccountingProfileRepository;

  constructor(private readonly db: Pool) {
    this.profiles = new CompanyAccountingProfileRepository(db);
  }

  async resolve(companyId: string, fiscalYearId: string, start: string, end: string, runner: Runner = this.db): Promise<MonthlyCloseRequirements> {
    const [startProfile, endProfile, fiscalYearResult] = await Promise.all([
      this.profiles.current(companyId, start, runner),
      this.profiles.current(companyId, end, runner),
      runner.query<{start_date:string;end_date:string}>('SELECT start_date::text,end_date::text FROM fiscal_years WHERE id=$1 AND company_id=$2',[fiscalYearId,companyId]),
    ]);
    const fiscalYear=fiscalYearResult.rows[0]??null;
    const profile=startProfile&&endProfile&&startProfile.id===endProfile.id?startProfile:null;
    const profileResolved=Boolean(profile&&fiscalYear);

    if(!profile||!fiscalYear){
      return{vat:true,vat_requires_resolution:true,opening_balances:true,profile_resolved:false};
    }

    let vat=true;
    let vatRequiresResolution=false;
    if(profile.vat_status==='needs_review'){
      vatRequiresResolution=true;
    }else if(profile.vat_status==='not_registered'){
      vat=false;
    }else if(profile.vat_status==='registered'){
      vat=!profile.vat_registered_from||end>=profile.vat_registered_from;
    }else if(profile.vat_status==='deregistered'){
      vat=!profile.vat_deregistered_from||start<profile.vat_deregistered_from;
    }

    const openingBalances=profile.first_live_accounting_date>=fiscalYear.start_date&&profile.first_live_accounting_date<=fiscalYear.end_date;
    return{vat,vat_requires_resolution:vatRequiresResolution,opening_balances:openingBalances,profile_resolved:profileResolved};
  }
}
