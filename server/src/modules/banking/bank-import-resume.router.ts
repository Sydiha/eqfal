import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import config from '../../config';
import { LocalStorageAdapter } from '../../storage/local.storage';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { parseBankFile } from './bank.router';

export const bankImportResumeRouter = Router();

const IMPORT = 'bank.import';

type ResumeBatch = {
  id: string;
  company_id: string;
  bank_account_id: string;
  original_filename: string;
  source_format: 'csv' | 'xlsx';
  storage_key: string;
  status: string;
};

function asyncRoute(handler:(req:Request,res:Response,next:NextFunction)=>Promise<void>):RequestHandler {
  return (req,res,next)=>void handler(req,res,next).catch(next);
}

bankImportResumeRouter.get('/bank-import-batches/:id/resume', requireAuth, requireActiveCompany, requireCapability(IMPORT), asyncRoute(async(req,res)=>{
  const context=getAuthenticatedContext(req);
  if(!context?.activeCompanyId){res.status(403).json({error:'No active company'});return;}
  if(!pool){res.status(503).json({error:'Database unavailable'});return;}

  const { rows }=await pool.query<ResumeBatch>('SELECT id,company_id,bank_account_id,original_filename,source_format,storage_key,status FROM bank_import_batches WHERE id=$1 AND company_id=$2',[req.params.id,context.activeCompanyId]);
  const batch=rows[0];
  if(!batch){res.status(404).json({error:'Bank import not found'});return;}
  if(batch.status==='confirmed'){res.status(409).json({error:'Confirmed bank import cannot be resumed'});return;}
  if(batch.source_format!=='csv'&&batch.source_format!=='xlsx'){res.status(409).json({error:'Bank import source format cannot be resumed'});return;}

  try {
    const files=new LocalStorageAdapter(config.bankStorageDir);
    const table=parseBankFile(batch.source_format,await files.get(batch.storage_key));
    res.json({batch,columns:table.headers});
  } catch {
    res.status(409).json({error:'Stored bank import cannot be resumed'});
  }
}));
