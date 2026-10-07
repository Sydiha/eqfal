import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { buildVatWorkingPaperXlsx, loadVatClosingReport, VatReportNotFoundError, VatReportOpenPeriodError } from './vat-report';

export const vatReportRouter = Router();
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const route=(handler:(req:Request,res:Response)=>Promise<void>):RequestHandler=>(req,res,next:NextFunction)=>void handler(req,res).catch(next);
const context=(req:Request)=>getAuthenticatedContext(req)! as ReturnType<typeof getAuthenticatedContext>&{activeCompanyId:string};

async function load(req: Request, res: Response) {
  if (!UUID.test(req.params.id)) { res.status(400).json({error:'Invalid request'}); return null; }
  if (!pool) { res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' }); return null; }
  try { return await loadVatClosingReport(pool, context(req).activeCompanyId, req.params.id); }
  catch (error) {
    if (error instanceof VatReportNotFoundError) { res.status(404).json({error:'Not found'}); return null; }
    if (error instanceof VatReportOpenPeriodError) { res.status(409).json({error:'VAT period must be closed'}); return null; }
    throw error;
  }
}

vatReportRouter.get('/vat-periods/:id/report', requireAuth, requireActiveCompany, requireCapability('vat.view'), route(async(req,res)=>{
  const report=await load(req,res); if(report) res.json(report);
}));

vatReportRouter.get('/vat-periods/:id/working-paper.xlsx', requireAuth, requireActiveCompany, requireCapability('vat.view'), route(async(req,res)=>{
  const report=await load(req,res); if(!report)return;
  const file=buildVatWorkingPaperXlsx(report);
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="vat-working-paper-${report.period.period_start}-${report.period.period_end}.xlsx"`);
  res.send(file);
}));
