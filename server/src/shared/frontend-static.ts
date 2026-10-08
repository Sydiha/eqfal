import express, { NextFunction, Request, Response, Router } from 'express';
import fs from 'fs';
import path from 'path';

/**
 * Content-Security-Policy for the built React app only. API responses keep the stricter
 * `default-src 'none'` policy from security-headers.ts; this one is applied to non-/api responses.
 * 'unsafe-inline' is limited to style-src (Mantine injects a <style> element); scripts stay 'self'-only.
 */
export const FRONTEND_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const IMMUTABLE = 'public, max-age=31536000, immutable';

function isApiPath(urlPath: string): boolean {
  return urlPath === '/api' || urlPath.startsWith('/api/');
}

export function frontendBuildAvailable(distDir: string): boolean {
  return fs.existsSync(path.join(distDir, 'index.html'));
}

/**
 * Serves the built frontend (client/dist) and the SPA fallback. Mount it AFTER the /api routers and
 * BEFORE the 404 handler, and only in production. It never answers /api paths or non-GET/HEAD methods.
 */
export function frontendRouter(distDir: string): Router {
  const router = Router();
  const indexPath = path.join(distDir, 'index.html');
  const assetsPrefix = path.join(distDir, 'assets') + path.sep;

  router.use((req: Request, res: Response, next: NextFunction) => {
    if (isApiPath(req.path) || (req.method !== 'GET' && req.method !== 'HEAD')) {
      next('router');
      return;
    }
    res.setHeader('Content-Security-Policy', FRONTEND_CSP);
    next();
  });

  router.use(express.static(distDir, {
    index: false,
    redirect: false,
    dotfiles: 'ignore',
    setHeaders: (res, filePath) => {
      if (filePath === indexPath) res.setHeader('Cache-Control', 'no-cache');
      else if (filePath.startsWith(assetsPrefix)) res.setHeader('Cache-Control', IMMUTABLE); // Vite content-hashed names
      else res.setHeader('Cache-Control', 'public, max-age=3600');
    },
  }));

  // SPA fallback: only extension-less paths are client routes; a missing /assets/x.js must stay a 404.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (path.extname(req.path)) {
      next();
      return;
    }
    res.sendFile(indexPath, { dotfiles: 'allow', headers: { 'Cache-Control': 'no-cache' } }, (err) => {
      if (err && !res.headersSent) res.status(503).json({ error: 'Frontend build unavailable' });
    });
  });

  return router;
}
