import express, { NextFunction, Request, RequestHandler, Response, Router } from 'express';
import path from 'path';
import pool from '../../db/pool';
import config from '../../config';
import { LocalStorageAdapter } from '../../storage/local.storage';
import {
  getAuthenticatedContext,
  requireActiveCompany,
  requireAuth,
  requireCapability,
} from '../auth/auth.middleware';
import { requireSameOrigin } from '../auth/origin.middleware';
import { AuthSessionContext } from '../auth/session.service';
import { DocumentRepository } from './document.repository';
import { DocumentNotFoundError, DocumentReviewConflictError, DocumentService } from './document.service';
import { DocumentReviewDecision } from './document.types';

export const documentRouter = Router();

const VIEW_CAPABILITY = 'document.view';
const UPLOAD_CAPABILITY = 'document.upload';
const REVIEW_CAPABILITY = 'document.review';
const APPROVE_CAPABILITY = 'document.approve';
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/webp']);
const MIME_EXTENSIONS: Record<string, Set<string>> = {
  'application/pdf': new Set(['.pdf']),
  'image/jpeg': new Set(['.jpg', '.jpeg']),
  'image/png': new Set(['.png']),
  'image/webp': new Set(['.webp']),
};

const storage = new LocalStorageAdapter(config.documentStorageDir);
const rawParser = express.raw({ type: () => true, limit: MAX_FILE_SIZE });

type ActiveAuthContext = AuthSessionContext & { activeCompanyId: string };

function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<void>,
): RequestHandler {
  return (req, res, next) => void handler(req, res, next).catch(next);
}

const parseUploadBody: RequestHandler = (req, res, next) => {
  rawParser(req, res, (err) => {
    if (!err) {
      next();
      return;
    }
    if ((err as { type?: string }).type === 'entity.too.large') {
      res.status(413).json({ error: 'Document is too large' });
      return;
    }
    next(err);
  });
};

function activeContext(req: Request, res: Response): ActiveAuthContext | null {
  const context = getAuthenticatedContext(req);
  if (!context?.activeCompanyId) {
    res.status(403).json({ error: 'No active company' });
    return null;
  }
  return context as ActiveAuthContext;
}

function repositoryOr503(res: Response): DocumentRepository | null {
  if (!pool) {
    res.status(503).json({ error: 'Database unavailable' });
    return null;
  }
  return new DocumentRepository(pool);
}

function serviceOr503(res: Response): DocumentService | null {
  if (!pool) {
    res.status(503).json({ error: 'Database unavailable' });
    return null;
  }
  return new DocumentService(pool, storage);
}

function decodeFilename(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const decoded = decodeURIComponent(value).trim();
    if (!decoded || decoded.length > 255 || decoded.includes('\0')) return null;
    return decoded;
  } catch {
    return null;
  }
}

function matchesMagic(mimeType: string, data: Buffer): boolean {
  if (mimeType === 'application/pdf') return data.subarray(0, 5).toString('ascii') === '%PDF-';
  if (mimeType === 'image/jpeg') return data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (mimeType === 'image/png') {
    return data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]));
  }
  if (mimeType === 'image/webp') {
    return data.length >= 12 && data.subarray(0, 4).toString('ascii') === 'RIFF' && data.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  return false;
}

function isValidUpload(filename: string, mimeType: string, data: Buffer): boolean {
  if (!ALLOWED_MIME_TYPES.has(mimeType) || data.length === 0 || data.length > MAX_FILE_SIZE) return false;
  const extension = path.extname(filename).toLowerCase();
  if (!MIME_EXTENSIONS[mimeType]?.has(extension)) return false;
  return matchesMagic(mimeType, data);
}

documentRouter.get(
  '/documents',
  requireAuth,
  requireActiveCompany,
  requireCapability(VIEW_CAPABILITY),
  asyncRoute(async (req, res) => {
    const context = activeContext(req, res);
    if (!context) return;
    const repository = repositoryOr503(res);
    if (!repository) return;
    const documents = await repository.findByCompany(context.activeCompanyId);
    res.status(200).json({ documents });
  }),
);

documentRouter.post(
  '/documents',
  requireSameOrigin,
  requireAuth,
  requireActiveCompany,
  requireCapability(UPLOAD_CAPABILITY),
  parseUploadBody,
  asyncRoute(async (req, res) => {
    const context = activeContext(req, res);
    if (!context) return;

    const filename = decodeFilename(req.headers['x-file-name']);
    const mimeType = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const data = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);

    if (!filename || !isValidUpload(filename, mimeType, data)) {
      res.status(400).json({ error: 'Invalid document upload' });
      return;
    }

    const service = serviceOr503(res);
    if (!service) return;
    const document = await service.upload({
      companyId: context.activeCompanyId,
      actorUserId: context.user.id,
      originalFilename: filename,
      mimeType,
      data,
    });
    res.status(201).json({ document });
  }),
);

documentRouter.post(
  '/documents/:id/submit-review',
  requireSameOrigin,
  requireAuth,
  requireActiveCompany,
  requireCapability(UPLOAD_CAPABILITY),
  asyncRoute(async (req, res) => {
    const context = activeContext(req, res);
    if (!context) return;
    const service = serviceOr503(res);
    if (!service) return;
    try {
      const document = await service.submitReview({
        documentId: req.params.id,
        companyId: context.activeCompanyId,
        actorUserId: context.user.id,
      });
      res.status(200).json({ document });
    } catch (err) {
      if (err instanceof DocumentNotFoundError) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }
      if (err instanceof DocumentReviewConflictError) {
        res.status(409).json({ error: 'Document review conflict' });
        return;
      }
      throw err;
    }
  }),
);

documentRouter.post(
  '/documents/:id/review',
  requireSameOrigin,
  requireAuth,
  requireActiveCompany,
  asyncRoute(async (req, res) => {
    const context = activeContext(req, res);
    if (!context) return;

    const decision = req.body?.decision;
    const noteValue = req.body?.note;
    const allowedDecisions: DocumentReviewDecision[] = ['approved', 'incomplete', 'rejected'];
    if (!allowedDecisions.includes(decision) || (noteValue !== undefined && typeof noteValue !== 'string')) {
      res.status(400).json({ error: 'Invalid document review' });
      return;
    }

    const note = typeof noteValue === 'string' ? noteValue.trim() : '';
    if (note.length > 500 || (decision !== 'approved' && !note)) {
      res.status(400).json({ error: 'Invalid document review' });
      return;
    }

    const requiredCapability = decision === 'approved' ? APPROVE_CAPABILITY : REVIEW_CAPABILITY;
    if (!context.capabilities.includes(requiredCapability)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const service = serviceOr503(res);
    if (!service) return;
    try {
      const document = await service.review({
        documentId: req.params.id,
        companyId: context.activeCompanyId,
        actorUserId: context.user.id,
        decision,
        note: note || null,
      });
      res.status(200).json({ document });
    } catch (err) {
      if (err instanceof DocumentNotFoundError) {
        res.status(404).json({ error: 'Document not found' });
        return;
      }
      if (err instanceof DocumentReviewConflictError) {
        res.status(409).json({ error: 'Document review conflict' });
        return;
      }
      throw err;
    }
  }),
);

documentRouter.get(
  '/documents/:id/file',
  requireAuth,
  requireActiveCompany,
  requireCapability(VIEW_CAPABILITY),
  asyncRoute(async (req, res) => {
    const context = activeContext(req, res);
    if (!context) return;
    const repository = repositoryOr503(res);
    if (!repository) return;

    const document = await repository.findById(req.params.id, context.activeCompanyId);
    if (!document) {
      res.status(404).json({ error: 'Document not found' });
      return;
    }

    let data: Buffer;
    try {
      data = await storage.get(document.storage_key);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'Document file not found' });
        return;
      }
      throw err;
    }

    res.setHeader('Content-Type', document.mime_type);
    res.setHeader('Content-Length', String(data.length));
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(document.original_filename)}`);
    res.status(200).send(data);
  }),
);
