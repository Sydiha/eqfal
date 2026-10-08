import { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import pool from '../../db/pool';
import config from '../../config';
import { getStorage } from '../../storage/storage.factory';
import { readVerified, StorageIntegrityError } from '../../storage/integrity';
import { StorageUnavailableError } from '../../storage/object.storage';
import { getAuthenticatedContext, requireActiveCompany, requireAuth, requireCapability } from '../auth/auth.middleware';
import { BankColumnMapping, BankService, parseBankFile } from './bank.router';

export const bankImportResumeRouter = Router();

const IMPORT = 'bank.import';

type ResumeBatch = {
  id: string;
  company_id: string;
  bank_account_id: string;
  original_filename: string;
  source_format: 'csv' | 'xlsx';
  storage_key: string;
  file_sha256: string;
  status: 'mapping_required' | 'preview_ready' | 'confirmed';
  column_mapping: BankColumnMapping | null;
  total_rows: number;
  valid_rows: number;
  duplicate_rows: number;
  invalid_rows: number;
};

function asyncRoute(handler:(req:Request,res:Response,next:NextFunction)=>Promise<void>):RequestHandler {
  return (req,res,next)=>void handler(req,res,next).catch(next);
}

bankImportResumeRouter.get('/bank-import-batches/:id/resume', requireAuth, requireActiveCompany, requireCapability(IMPORT), asyncRoute(async(req,res)=>{
  const context=getAuthenticatedContext(req);
  if(!context?.activeCompanyId){res.status(403).json({ error: 'No active company', code: 'NO_ACTIVE_COMPANY' });return;}
  if(!pool){res.status(503).json({ error: 'Database unavailable', code: 'DB_UNAVAILABLE' });return;}

  const { rows }=await pool.query<ResumeBatch>(
    `SELECT
      id,
      company_id,
      bank_account_id,
      original_filename,
      source_format,
      storage_key,
      file_sha256,
      status,
      column_mapping,
      total_rows,
      valid_rows,
      duplicate_rows,
      invalid_rows
    FROM bank_import_batches
    WHERE id=$1 AND company_id=$2`,
    [req.params.id,context.activeCompanyId],
  );
  const batch=rows[0];
  if(!batch){res.status(404).json({error:'Bank import not found'});return;}
  if(batch.status==='confirmed'){res.status(409).json({error:'Confirmed bank import cannot be resumed'});return;}
  if(batch.source_format!=='csv'&&batch.source_format!=='xlsx'){res.status(409).json({error:'Bank import source format cannot be resumed'});return;}

  try {
    const files=getStorage('bank-imports',config.bankStorageDir);
    const table=parseBankFile(batch.source_format,await readVerified(files,batch.storage_key,batch.file_sha256));

    let preview=null;
    if(batch.status==='preview_ready'&&batch.column_mapping){
      const service=new BankService(pool,files);
      const result=await service.preview(batch.id,context.activeCompanyId);
      preview={...result,rows:result.rows.slice(0,50)};
    }

    const { file_sha256: _fileSha256, ...publicBatch }=batch;
    res.json({
      batch:publicBatch,
      columns:table.headers,
      mapping:batch.column_mapping,
      preview,
    });
  } catch (err) {
    // A storage outage or integrity failure is a server problem, not an unresumable import.
    if(err instanceof StorageUnavailableError||err instanceof StorageIntegrityError) throw err;
    res.status(409).json({error:'Stored bank import cannot be resumed'});
  }
}));
