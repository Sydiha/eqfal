import { Pool, PoolClient } from 'pg';
import { CompanyAccountingProfile, ProfileValues, UpdateProfileInput, WorkflowStatus } from './company-accounting-profile.types';

type Runner = Pick<Pool, 'query'> | Pick<PoolClient, 'query'>;
const RETURNING = `*, first_live_accounting_date::text, vat_registered_from::text,
  vat_deregistered_from::text, tax_effective_from::text, effective_from::text, effective_to::text`;
const SELECT = `p.*, p.first_live_accounting_date::text, p.vat_registered_from::text,
  p.vat_deregistered_from::text, p.tax_effective_from::text, p.effective_from::text, p.effective_to::text,
  EXISTS (SELECT 1 FROM monthly_close_periods m WHERE m.company_id=p.company_id AND m.status='closed'
    AND p.effective_from IS NOT NULL AND m.period_start<=p.effective_from AND m.period_end>=p.effective_from) AS closed_period_impact`;

export class CompanyAccountingProfileRepository {
  constructor(private readonly pool: Pool) {}

  private decorate(row: Omit<CompanyAccountingProfile, 'professional_review_required'> | undefined): CompanyAccountingProfile | null {
    if (!row) return null;
    return {...row, professional_review_required:
      row.accounting_framework === 'Other / accountant-reviewed' || row.tax_treatment === 'needs_review' ||
      row.ownership_context === 'unknown_needs_review' || row.wht_profile === 'needs_review' ||
      row.has_non_resident_dealings === 'unknown'};
  }

  async current(companyId: string, relevantDate: string, runner: Runner = this.pool): Promise<CompanyAccountingProfile | null> {
    const {rows}=await runner.query<Omit<CompanyAccountingProfile,'professional_review_required'>>(
      `SELECT ${SELECT} FROM company_accounting_profiles p WHERE p.company_id=$1 AND p.workflow_status='approved'
       AND p.effective_from<=$2 AND (p.effective_to IS NULL OR p.effective_to>=$2)
       ORDER BY p.effective_from DESC,p.version_no DESC LIMIT 1`,[companyId,relevantDate]);
    return this.decorate(rows[0]);
  }

  async history(companyId: string): Promise<CompanyAccountingProfile[]> {
    const {rows}=await this.pool.query<Omit<CompanyAccountingProfile,'professional_review_required'>>(
      `SELECT ${SELECT} FROM company_accounting_profiles p WHERE p.company_id=$1 ORDER BY p.version_no DESC`,[companyId]);
    return rows.map(row=>this.decorate(row)!);
  }

  async byId(companyId:string,id:string,runner:Runner=this.pool,forUpdate=false):Promise<CompanyAccountingProfile|null>{
    const {rows}=await runner.query<Omit<CompanyAccountingProfile,'professional_review_required'>>(
      `SELECT ${SELECT} FROM company_accounting_profiles p WHERE p.id=$1 AND p.company_id=$2${forUpdate?' FOR UPDATE OF p':''}`,[id,companyId]);
    return this.decorate(rows[0]);
  }

  async latestApproved(companyId:string,runner:Runner):Promise<CompanyAccountingProfile|null>{
    const {rows}=await runner.query<Omit<CompanyAccountingProfile,'professional_review_required'>>(
      `SELECT ${SELECT} FROM company_accounting_profiles p WHERE p.company_id=$1 AND p.workflow_status='approved'
       ORDER BY p.effective_from DESC NULLS LAST,p.version_no DESC LIMIT 1 FOR UPDATE OF p`,[companyId]);
    return this.decorate(rows[0]);
  }

  async hasAny(companyId:string,runner:Runner):Promise<boolean>{
    return Boolean((await runner.query('SELECT 1 FROM company_accounting_profiles WHERE company_id=$1 LIMIT 1',[companyId])).rowCount);
  }

  async nextVersion(companyId:string,runner:Runner):Promise<number>{
    const {rows}=await runner.query<{next:number}>('SELECT COALESCE(MAX(version_no),0)+1 AS next FROM company_accounting_profiles WHERE company_id=$1',[companyId]);
    return Number(rows[0]!.next);
  }

  async create(companyId:string,version:number,actor:string,input:ProfileValues,runner:Runner):Promise<CompanyAccountingProfile>{
    const keys=Object.keys(input) as (keyof ProfileValues)[];
    const values=keys.map(key=>input[key]);
    const {rows}=await runner.query<Omit<CompanyAccountingProfile,'professional_review_required'>>(
      `INSERT INTO company_accounting_profiles(company_id,version_no,prepared_by_user_id,${keys.join(',')})
       VALUES($1,$2,$3,${keys.map((_,i)=>`$${i+4}`).join(',')}) RETURNING ${RETURNING}`,[companyId,version,actor,...values]);
    return this.decorate({...rows[0]!,closed_period_impact:false})!;
  }

  private async updateForStatus(companyId:string,id:string,input:UpdateProfileInput,status:WorkflowStatus,runner:Runner):Promise<CompanyAccountingProfile|null>{
    const keys=Object.keys(input) as (keyof UpdateProfileInput)[];
    const values=keys.map(key=>input[key]);
    const set=keys.map((key,i)=>`${key}=$${i+1}`);
    const {rows}=await runner.query<Omit<CompanyAccountingProfile,'professional_review_required'>>(
      `UPDATE company_accounting_profiles SET ${set.join(',')},updated_at=NOW() WHERE id=$${keys.length+1} AND company_id=$${keys.length+2} AND workflow_status=$${keys.length+3} RETURNING ${RETURNING}`,
      [...values,id,companyId,status]);
    return this.decorate(rows[0]&&{...rows[0],closed_period_impact:false});
  }

  updateDraft(companyId:string,id:string,input:UpdateProfileInput,runner:Runner):Promise<CompanyAccountingProfile|null>{
    return this.updateForStatus(companyId,id,input,'draft',runner);
  }

  updateNeedsReview(companyId:string,id:string,input:UpdateProfileInput,runner:Runner):Promise<CompanyAccountingProfile|null>{
    return this.updateForStatus(companyId,id,input,'needs_review',runner);
  }

  async transition(companyId:string,id:string,from:WorkflowStatus,to:WorkflowStatus,actor:string,runner:Runner):Promise<CompanyAccountingProfile|null>{
    const recordsActor=to==='reviewed'||to==='approved';
    const extra=to==='reviewed'?',reviewed_by_user_id=$5,reviewed_at=NOW()':to==='approved'?',approved_by_user_id=$5,approved_at=NOW()':from==='reviewed'&&to==='needs_review'?',reviewed_by_user_id=NULL,reviewed_at=NULL':'';
    const args=recordsActor?[id,companyId,from,to,actor]:[id,companyId,from,to];
    const {rows}=await runner.query<Omit<CompanyAccountingProfile,'professional_review_required'>>(
      `UPDATE company_accounting_profiles SET workflow_status=$4${extra},updated_at=NOW() WHERE id=$1 AND company_id=$2 AND workflow_status=$3 RETURNING ${RETURNING}`,args);
    return this.decorate(rows[0]&&{...rows[0],closed_period_impact:false});
  }

  async approvedOverlaps(companyId:string,id:string,start:string,end:string|null,runner:Runner):Promise<CompanyAccountingProfile[]>{
    const {rows}=await runner.query<Omit<CompanyAccountingProfile,'professional_review_required'>>(
      `SELECT ${SELECT} FROM company_accounting_profiles p WHERE p.company_id=$1 AND p.id<>$2 AND p.workflow_status='approved'
       AND (p.effective_to IS NULL OR p.effective_to >= $3) AND ($4::date IS NULL OR p.effective_from <= $4::date)
       ORDER BY p.effective_from FOR UPDATE OF p`,[companyId,id,start,end]);
    return rows.map(row=>this.decorate(row)!);
  }

  async closeEffectivePeriod(companyId:string,id:string,end:string,runner:Runner):Promise<CompanyAccountingProfile|null>{
    const {rows}=await runner.query<Omit<CompanyAccountingProfile,'professional_review_required'>>(
      `UPDATE company_accounting_profiles SET effective_to=$3,updated_at=NOW() WHERE id=$1 AND company_id=$2 AND workflow_status='approved' RETURNING ${RETURNING}`,[id,companyId,end]);
    return this.decorate(rows[0]&&{...rows[0],closed_period_impact:false});
  }

  async closedPeriodImpact(companyId:string,date:string|null,runner:Runner):Promise<boolean>{
    if(!date)return false;
    return Boolean((await runner.query(`SELECT 1 FROM monthly_close_periods WHERE company_id=$1 AND status='closed' AND period_start<=$2 AND period_end>=$2 LIMIT 1`,[companyId,date])).rowCount);
  }
}
