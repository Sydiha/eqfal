import { NextFunction, Request, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { AnnualClosingNotFoundError, AnnualClosingService } from './annual-closing.service';
import { requireSameOrigin } from '../auth/origin.middleware';
import { AnnualPackageConflictError, AnnualPackageNotFoundError, AnnualPackageService, AnnualPackageValidationError } from './annual-package.service';

export const annualClosingRouter = Router();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

annualClosingRouter.get('/annual-closing/:fiscalYearId', requireAuth, requireActiveCompany, requireCapability('annual_close.view'), (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    if (!UUID.test(req.params.fiscalYearId)) { res.status(400).json({ error: 'Invalid fiscal year' }); return; }
    if (!pool) { res.status(503).json({ error: 'Database unavailable' }); return; }
    const context = getAuthenticatedContext(req)! as ReturnType<typeof getAuthenticatedContext> & { activeCompanyId: string };
    try { res.json(await new AnnualClosingService(pool).readiness(context.activeCompanyId, req.params.fiscalYearId)); }
    catch (error) { if (error instanceof AnnualClosingNotFoundError) res.status(404).json({ error: 'Not found' }); else next(error); }
  })().catch(next);
});

const base=[requireAuth,requireActiveCompany]; const write=[requireSameOrigin,...base];
const context=(req:Request)=>getAuthenticatedContext(req)! as NonNullable<ReturnType<typeof getAuthenticatedContext>>&{activeCompanyId:string};
const plain=(v:unknown):v is Record<string,unknown>=>Boolean(v)&&typeof v==='object'&&!Array.isArray(v);
const validVersion=(body:unknown)=>plain(body)&&Number.isInteger(body.version)&&Number(body.version)>0?Number(body.version):null;
const route=(fn:(req:Request,res:Response,next:NextFunction)=>Promise<void>)=>(req:Request,res:Response,next:NextFunction)=>void fn(req,res,next).catch(next);
const packageService=(res:Response)=>{if(!pool){res.status(503).json({error:'Database unavailable'});return null;}return new AnnualPackageService(pool);};
const handle=(error:unknown,res:Response,next:NextFunction)=>{if(error instanceof AnnualPackageNotFoundError)res.status(404).json({error:'Not found'});else if(error instanceof AnnualPackageConflictError)res.status(409).json({error:error.message});else if(error instanceof AnnualPackageValidationError)res.status(422).json({error:error.message,blockers:error.blockers});else next(error);};
const checkYear=(req:Request,res:Response)=>{if(!UUID.test(req.params.fiscalYearId)){res.status(400).json({error:'Invalid fiscal year'});return false;}return true;};

annualClosingRouter.get('/annual-closing/:fiscalYearId/package',...base,requireCapability('annual_close.package.view'),route(async(req,res,next)=>{if(!checkYear(req,res))return;const s=packageService(res);if(!s)return;try{res.json(await s.get(context(req).activeCompanyId,req.params.fiscalYearId));}catch(e){handle(e,res,next);}}));
annualClosingRouter.post('/annual-closing/:fiscalYearId/package',...write,requireCapability('annual_close.package.create'),route(async(req,res,next)=>{if(!checkYear(req,res)||!plain(req.body)||Object.keys(req.body).length){res.status(400).json({error:'Invalid request'});return;}const s=packageService(res);if(!s)return;try{res.status(201).json({package:await s.create(context(req).activeCompanyId,req.params.fiscalYearId,context(req).user.id)});}catch(e){handle(e,res,next);}}));
annualClosingRouter.post('/annual-closing/:fiscalYearId/package/snapshots',...write,requireCapability('annual_close.package.snapshot.create'),route(async(req,res,next)=>{const version=validVersion(req.body);if(!checkYear(req,res)||version===null||Object.keys(req.body).some(k=>k!=='version')){res.status(400).json({error:'Invalid request'});return;}const s=packageService(res);if(!s)return;try{res.status(201).json({snapshot:await s.snapshot(context(req).activeCompanyId,req.params.fiscalYearId,context(req).user.id,version)});}catch(e){handle(e,res,next);}}));
annualClosingRouter.post('/annual-closing/:fiscalYearId/package/finalize',...write,requireCapability('annual_close.package.finalize'),route(async(req,res,next)=>{const version=validVersion(req.body);if(!checkYear(req,res)||version===null||Object.keys(req.body).some(k=>k!=='version')){res.status(400).json({error:'Invalid request'});return;}const s=packageService(res);if(!s)return;try{res.json({package:await s.finalize(context(req).activeCompanyId,req.params.fiscalYearId,context(req).user.id,version)});}catch(e){handle(e,res,next);}}));
annualClosingRouter.post('/annual-closing/:fiscalYearId/package/handoff',...write,requireCapability('annual_close.package.handoff'),route(async(req,res,next)=>{const version=validVersion(req.body);const text=(v:unknown,max:number)=>v===null||typeof v==='string'&&v.trim().length>0&&v.length<=max;if(!checkYear(req,res)||version===null||Object.keys(req.body).some(k=>!['version','note','reference'].includes(k))||!text(req.body.note??null,2000)||!text(req.body.reference??null,500)){res.status(400).json({error:'Invalid request'});return;}const s=packageService(res);if(!s)return;try{res.json({package:await s.handoff(context(req).activeCompanyId,req.params.fiscalYearId,context(req).user.id,{version,note:(req.body.note as string|null|undefined)??null,reference:(req.body.reference as string|null|undefined)??null})});}catch(e){handle(e,res,next);}}));
const professionalAction=(action:'review'|'approve')=>route(async(req,res,next)=>{const version=validVersion(req.body);const note=req.body?.note??null;if(!checkYear(req,res)||version===null||Object.keys(req.body).some(k=>!['version','note'].includes(k))||!(note===null||typeof note==='string'&&note.trim().length>0&&note.length<=2000)){res.status(400).json({error:'Invalid request'});return;}const s=packageService(res);if(!s)return;try{res.json({package:await s[action](context(req).activeCompanyId,req.params.fiscalYearId,context(req).user.id,{version,note})});}catch(e){handle(e,res,next);}});
annualClosingRouter.post('/annual-closing/:fiscalYearId/package/review',...write,requireCapability('annual_close.package.review'),professionalAction('review'));
annualClosingRouter.post('/annual-closing/:fiscalYearId/package/approve',...write,requireCapability('annual_close.package.approve'),professionalAction('approve'));
