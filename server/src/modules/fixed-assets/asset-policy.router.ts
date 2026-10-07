import {NextFunction,Request,RequestHandler,Response,Router} from 'express';
import {Pool,PoolClient} from 'pg';
import pool from '../../db/pool';
import {AuditLogRepository} from '../audit-log/audit-log.repository';
import {getAuthenticatedContext,requireActiveCompany,requireAuth,requireCapability} from '../auth/auth.middleware';
import {requireSameOrigin} from '../auth/origin.middleware';

export const assetPolicyRouter=Router();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
type PolicyStatus='draft'|'approved'|'superseded';
type UsefulLifeMode='fixed'|'asset_specific'|'not_applicable';
type ResidualPolicy='zero'|'asset_specific'|'not_applicable';
type StartBasis='placed_in_service'|'explicit_date'|'not_applicable';
type Policy={
 id:string;company_id:string;asset_category_id:string;version_number:number;effective_from:string|null;
 depreciation_method:'straight_line'|null;useful_life_mode:UsefulLifeMode;useful_life_months:number|null;
 residual_value_policy:ResidualPolicy;depreciation_start_basis:StartBasis;
 asset_account_id:string|null;accumulated_depreciation_account_id:string|null;depreciation_expense_account_id:string|null;
 status:PolicyStatus;is_legacy_migrated:boolean;reviewed_by:string|null;reviewed_at:Date|null;approved_by:string|null;approved_at:Date|null;
 created_by:string|null;created_at:Date;updated_at:Date;
};
type PolicyInput={
 effectiveFrom:string;depreciationMethod:'straight_line'|null;usefulLifeMode:UsefulLifeMode;usefulLifeMonths:number|null;
 residualValuePolicy:ResidualPolicy;startBasis:StartBasis;assetAccountId:string|null;accumulatedAccountId:string|null;expenseAccountId:string|null;
};
export class AssetPolicyValidationError extends Error{}
export class AssetPolicyNotFoundError extends Error{}
export class AssetPolicyConflictError extends Error{}
const route=(fn:(req:Request,res:Response)=>Promise<void>):RequestHandler=>(req,res,next:NextFunction)=>void fn(req,res).catch(next);
const context=(req:Request)=>getAuthenticatedContext(req)! as ReturnType<typeof getAuthenticatedContext>&{activeCompanyId:string};
const object=(x:unknown):Record<string,unknown>|null=>x!==null&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:null;
const validDate=(x:unknown):x is string=>typeof x==='string'&&DATE.test(x)&&!Number.isNaN(Date.parse(`${x}T00:00:00Z`));
const nullableUuid=(x:unknown)=>x===null?null:typeof x==='string'&&UUID.test(x)?x:undefined;

function parsePolicy(body:unknown,partial=false):Partial<PolicyInput>|null{
 const x=object(body);if(!x)return null;
 const allowed=['effective_from','depreciation_method','useful_life_mode','useful_life_months','residual_value_policy','depreciation_start_basis','asset_account_id','accumulated_depreciation_account_id','depreciation_expense_account_id'];
 if(Object.keys(x).some(k=>!allowed.includes(k)))return null;
 const out:Partial<PolicyInput>={};
 if('effective_from'in x){if(!validDate(x.effective_from))return null;out.effectiveFrom=x.effective_from}
 if('depreciation_method'in x){if(x.depreciation_method!==null&&x.depreciation_method!=='straight_line')return null;out.depreciationMethod=x.depreciation_method as 'straight_line'|null}
 if('useful_life_mode'in x){if(!['fixed','asset_specific','not_applicable'].includes(String(x.useful_life_mode)))return null;out.usefulLifeMode=x.useful_life_mode as UsefulLifeMode}
 if('useful_life_months'in x){if(x.useful_life_months!==null&&(!Number.isInteger(x.useful_life_months)||Number(x.useful_life_months)<=0||Number(x.useful_life_months)>1200))return null;out.usefulLifeMonths=x.useful_life_months as number|null}
 if('residual_value_policy'in x){if(!['zero','asset_specific','not_applicable'].includes(String(x.residual_value_policy)))return null;out.residualValuePolicy=x.residual_value_policy as ResidualPolicy}
 if('depreciation_start_basis'in x){if(!['placed_in_service','explicit_date','not_applicable'].includes(String(x.depreciation_start_basis)))return null;out.startBasis=x.depreciation_start_basis as StartBasis}
 for(const [key,target] of [['asset_account_id','assetAccountId'],['accumulated_depreciation_account_id','accumulatedAccountId'],['depreciation_expense_account_id','expenseAccountId']] as const){
  if(key in x){const v=nullableUuid(x[key]);if(v===undefined)return null;out[target]=v}
 }
 if(!partial){
  for(const key of ['effectiveFrom','depreciationMethod','usefulLifeMode','usefulLifeMonths','residualValuePolicy','startBasis','assetAccountId','accumulatedAccountId','expenseAccountId'] as const)
   if(!(key in out))return null;
 }
 return out;
}

export class AssetPolicyService{
 private audit=new AuditLogRepository();
 constructor(private db:Pool){}
 private async tx<T>(fn:(c:PoolClient)=>Promise<T>){const c=await this.db.connect();try{await c.query('BEGIN');const v=await fn(c);await c.query('COMMIT');return v}catch(e){await c.query('ROLLBACK');const code=(e as{code?:string}).code;if(code==='23505')throw new AssetPolicyConflictError('Conflicting depreciation policy version');if(code==='23503'||code==='23514')throw new AssetPolicyValidationError((e as Error).message);throw e}finally{c.release()}}
 async list(companyId:string,categoryId:string){const category=(await this.db.query('SELECT 1 FROM asset_categories WHERE id=$1 AND company_id=$2',[categoryId,companyId])).rowCount;if(!category)throw new AssetPolicyNotFoundError();return{policies:(await this.db.query<Policy>('SELECT *,effective_from::text FROM asset_category_depreciation_policies WHERE company_id=$1 AND asset_category_id=$2 ORDER BY version_number DESC',[companyId,categoryId])).rows}}
 private async validate(c:PoolClient,companyId:string,categoryId:string,input:PolicyInput,complete=false){
  const category=(await c.query<{depreciable:boolean}>('SELECT depreciable FROM asset_categories WHERE id=$1 AND company_id=$2',[categoryId,companyId])).rows[0];if(!category)throw new AssetPolicyNotFoundError();
  if(input.usefulLifeMode==='fixed'&&!input.usefulLifeMonths)throw new AssetPolicyValidationError('Fixed useful-life policy requires useful_life_months');
  if(input.usefulLifeMode!=='fixed'&&input.usefulLifeMonths!==null)throw new AssetPolicyValidationError('Useful life months are only allowed for fixed policy');
  if(category.depreciable){
   if(input.depreciationMethod!=='straight_line'||input.usefulLifeMode==='not_applicable'||input.residualValuePolicy==='not_applicable'||input.startBasis==='not_applicable')throw new AssetPolicyValidationError('Depreciable category requires a depreciation policy');
  }else{
   if(input.depreciationMethod!==null||input.usefulLifeMode!=='not_applicable'||input.usefulLifeMonths!==null||input.residualValuePolicy!=='not_applicable'||input.startBasis!=='not_applicable')throw new AssetPolicyValidationError('Non-depreciable category cannot define depreciation');
  }
  for(const [id,type] of [[input.assetAccountId,'asset'],[input.accumulatedAccountId,'asset'],[input.expenseAccountId,'expense']] as const)if(id){const a=(await c.query<{account_type:string}>('SELECT account_type FROM accounts WHERE id=$1 AND company_id=$2 AND is_active',[id,companyId])).rows[0];if(!a||a.account_type!==type)throw new AssetPolicyValidationError('Invalid policy account type')}
  if(complete&&(!input.assetAccountId||(category.depreciable&&(!input.accumulatedAccountId||!input.expenseAccountId))))throw new AssetPolicyValidationError('Policy accounting is incomplete');
  return category;
 }
 private values(p:Policy):PolicyInput{if(p.is_legacy_migrated||!p.effective_from)throw new AssetPolicyConflictError('Migrated legacy policy snapshots are immutable');return{effectiveFrom:p.effective_from,depreciationMethod:p.depreciation_method,usefulLifeMode:p.useful_life_mode,usefulLifeMonths:p.useful_life_months,residualValuePolicy:p.residual_value_policy,startBasis:p.depreciation_start_basis,assetAccountId:p.asset_account_id,accumulatedAccountId:p.accumulated_depreciation_account_id,expenseAccountId:p.depreciation_expense_account_id}}
 async create(companyId:string,actor:string,categoryId:string,body:unknown){const input=parsePolicy(body) as PolicyInput|null;if(!input)throw new AssetPolicyValidationError('Invalid request');return this.tx(async c=>{await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`asset-policy:${companyId}:${categoryId}`]);await this.validate(c,companyId,categoryId,input);const version=Number((await c.query<{next:string}>('SELECT COALESCE(MAX(version_number),0)+1 AS next FROM asset_category_depreciation_policies WHERE company_id=$1 AND asset_category_id=$2',[companyId,categoryId])).rows[0]!.next);const p=(await c.query<Policy>(`INSERT INTO asset_category_depreciation_policies(company_id,asset_category_id,version_number,effective_from,depreciation_method,useful_life_mode,useful_life_months,residual_value_policy,depreciation_start_basis,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *,effective_from::text`,[companyId,categoryId,version,input.effectiveFrom,input.depreciationMethod,input.usefulLifeMode,input.usefulLifeMonths,input.residualValuePolicy,input.startBasis,input.assetAccountId,input.accumulatedAccountId,input.expenseAccountId,actor])).rows[0]!;await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'asset.policy.create',entity_type:'asset_category_depreciation_policy',entity_id:p.id,before_data:null,after_data:p},c);return p})}
 async update(companyId:string,actor:string,id:string,body:unknown){const patch=parsePolicy(body,true);if(!patch||!Object.keys(patch).length)throw new AssetPolicyValidationError('Invalid request');return this.tx(async c=>{const before=(await c.query<Policy>('SELECT *,effective_from::text FROM asset_category_depreciation_policies WHERE id=$1 AND company_id=$2 FOR UPDATE',[id,companyId])).rows[0];if(!before)throw new AssetPolicyNotFoundError();if(before.is_legacy_migrated)throw new AssetPolicyConflictError('Migrated legacy policy snapshots are immutable');if(before.status!=='draft')throw new AssetPolicyConflictError('Only draft policies can be edited');if(before.reviewed_at)throw new AssetPolicyConflictError('Reviewed policy must be changed through a new version');const merged={...this.values(before),...patch};await this.validate(c,companyId,before.asset_category_id,merged);const after=(await c.query<Policy>(`UPDATE asset_category_depreciation_policies SET effective_from=$3,depreciation_method=$4,useful_life_mode=$5,useful_life_months=$6,residual_value_policy=$7,depreciation_start_basis=$8,asset_account_id=$9,accumulated_depreciation_account_id=$10,depreciation_expense_account_id=$11,updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *,effective_from::text`,[id,companyId,merged.effectiveFrom,merged.depreciationMethod,merged.usefulLifeMode,merged.usefulLifeMonths,merged.residualValuePolicy,merged.startBasis,merged.assetAccountId,merged.accumulatedAccountId,merged.expenseAccountId])).rows[0]!;await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'asset.policy.update',entity_type:'asset_category_depreciation_policy',entity_id:id,before_data:before,after_data:after},c);return after})}
 async review(companyId:string,actor:string,id:string){return this.tx(async c=>{const before=(await c.query<Policy>('SELECT *,effective_from::text FROM asset_category_depreciation_policies WHERE id=$1 AND company_id=$2 FOR UPDATE',[id,companyId])).rows[0];if(!before)throw new AssetPolicyNotFoundError();if(before.is_legacy_migrated)throw new AssetPolicyConflictError('Migrated legacy policy snapshots cannot be reviewed or approved');if(before.status!=='draft'||before.reviewed_at)throw new AssetPolicyConflictError('Policy is not reviewable');await this.validate(c,companyId,before.asset_category_id,this.values(before),true);const after=(await c.query<Policy>('UPDATE asset_category_depreciation_policies SET reviewed_by=$3,reviewed_at=NOW(),updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *,effective_from::text',[id,companyId,actor])).rows[0]!;await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'asset.policy.review',entity_type:'asset_category_depreciation_policy',entity_id:id,before_data:before,after_data:after},c);return after})}
 async approve(companyId:string,actor:string,id:string){return this.tx(async c=>{const before=(await c.query<Policy>('SELECT *,effective_from::text FROM asset_category_depreciation_policies WHERE id=$1 AND company_id=$2 FOR UPDATE',[id,companyId])).rows[0];if(!before)throw new AssetPolicyNotFoundError();if(before.is_legacy_migrated)throw new AssetPolicyConflictError('Migrated legacy policy snapshots cannot be reviewed or approved');if(before.status!=='draft'||!before.reviewed_at)throw new AssetPolicyConflictError('Policy must be reviewed before approval');await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`asset-policy:${companyId}:${before.asset_category_id}`]);await this.validate(c,companyId,before.asset_category_id,this.values(before),true);const current=(await c.query<Policy>("SELECT *,effective_from::text FROM asset_category_depreciation_policies WHERE company_id=$1 AND asset_category_id=$2 AND status='approved' AND NOT is_legacy_migrated FOR UPDATE",[companyId,before.asset_category_id])).rows[0];if(current&&before.effective_from!<=current.effective_from!)throw new AssetPolicyConflictError('New policy effective date must be later than current approved policy');if(current){const superseded=(await c.query<Policy>("UPDATE asset_category_depreciation_policies SET status='superseded',updated_at=NOW() WHERE id=$1 RETURNING *,effective_from::text",[current.id])).rows[0]!;await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'asset.policy.supersede',entity_type:'asset_category_depreciation_policy',entity_id:current.id,before_data:current,after_data:superseded},c)}
  const after=(await c.query<Policy>("UPDATE asset_category_depreciation_policies SET status='approved',approved_by=$3,approved_at=NOW(),updated_at=NOW() WHERE id=$1 AND company_id=$2 RETURNING *,effective_from::text",[id,companyId,actor])).rows[0]!;
  await c.query("SELECT set_config('eqfal.asset_policy_sync','on',true)");
  await c.query(`UPDATE asset_categories SET default_useful_life_months=$3,default_depreciation_method='straight_line',asset_account_id=$4,accumulated_depreciation_account_id=$5,depreciation_expense_account_id=$6,updated_at=NOW() WHERE id=$1 AND company_id=$2`,[before.asset_category_id,companyId,after.useful_life_mode==='fixed'?after.useful_life_months:null,after.asset_account_id,after.accumulated_depreciation_account_id,after.depreciation_expense_account_id]);
  await this.audit.logEvent({company_id:companyId,actor_user_id:actor,action:'asset.policy.approve',entity_type:'asset_category_depreciation_policy',entity_id:id,before_data:before,after_data:after},c);return after})}
}

function service(res:Response){if(!pool){res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });return null}return new AssetPolicyService(pool)}
function handle(e:unknown,res:Response){if(e instanceof AssetPolicyValidationError)res.status(400).json({error:e.message});else if(e instanceof AssetPolicyNotFoundError)res.status(404).json({error:'Not found'});else if(e instanceof AssetPolicyConflictError)res.status(409).json({error:e.message});else throw e}
const base=[requireAuth,requireActiveCompany] as const,mutation=[requireSameOrigin,...base] as const;
assetPolicyRouter.get('/asset-categories/:id/policies',...base,requireCapability('asset.view'),route(async(req,res)=>{try{if(!UUID.test(req.params.id))throw new AssetPolicyValidationError('Invalid request');const s=service(res);if(s)res.json(await s.list(context(req).activeCompanyId,req.params.id))}catch(e){handle(e,res)}}));
assetPolicyRouter.post('/asset-categories/:id/policies',...mutation,requireCapability('asset.policy.manage'),route(async(req,res)=>{try{if(!UUID.test(req.params.id))throw new AssetPolicyValidationError('Invalid request');const s=service(res);if(s)res.status(201).json(await s.create(context(req).activeCompanyId,context(req).user.id,req.params.id,req.body))}catch(e){handle(e,res)}}));
assetPolicyRouter.patch('/asset-policies/:id',...mutation,requireCapability('asset.policy.manage'),route(async(req,res)=>{try{if(!UUID.test(req.params.id))throw new AssetPolicyValidationError('Invalid request');const s=service(res);if(s)res.json(await s.update(context(req).activeCompanyId,context(req).user.id,req.params.id,req.body))}catch(e){handle(e,res)}}));
assetPolicyRouter.post('/asset-policies/:id/review',...mutation,requireCapability('asset.policy.manage'),route(async(req,res)=>{try{if(!UUID.test(req.params.id))throw new AssetPolicyValidationError('Invalid request');const s=service(res);if(s)res.json(await s.review(context(req).activeCompanyId,context(req).user.id,req.params.id))}catch(e){handle(e,res)}}));
assetPolicyRouter.post('/asset-policies/:id/approve',...mutation,requireCapability('asset.policy.manage'),route(async(req,res)=>{try{if(!UUID.test(req.params.id))throw new AssetPolicyValidationError('Invalid request');const s=service(res);if(s)res.json(await s.approve(context(req).activeCompanyId,context(req).user.id,req.params.id))}catch(e){handle(e,res)}}));
