import fs from 'fs';
import os from 'os';
import path from 'path';
import request from 'supertest';
import type { Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRONTEND_CSP, frontendBuildAvailable } from '../src/shared/frontend-static';

const INDEX_HTML = '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/app-abc123.js"></script></body></html>';
const ORIGIN = 'https://app.example.com';

let dist: string;
const saved: Record<string, string | undefined> = {};

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (!(key in saved)) saved[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function loadApp(env: Record<string, string | undefined>): Promise<Express> {
  setEnv({ DATABASE_URL: undefined, ...env });
  vi.resetModules();
  return (await import('../src/app')).default;
}

const production = () => loadApp({ NODE_ENV: 'production', FRONTEND_DIST_DIR: dist, APP_PUBLIC_ORIGINS: ORIGIN });

beforeEach(() => {
  dist = fs.mkdtempSync(path.join(os.tmpdir(), 'eqfal-dist-'));
  fs.mkdirSync(path.join(dist, 'assets'));
  fs.writeFileSync(path.join(dist, 'index.html'), INDEX_HTML);
  fs.writeFileSync(path.join(dist, 'assets', 'app-abc123.js'), 'console.log(1);');
  fs.writeFileSync(path.join(dist, 'eqfal-mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  fs.writeFileSync(path.join(dist, '.secret'), 'hidden');
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(dist, { recursive: true, force: true });
});

describe('frontend serving (production)', () => {
  it('serves index.html at / with the frontend CSP and revalidation caching', async () => {
    const res = await request(await production()).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toBe(INDEX_HTML);
    expect(res.headers['content-security-policy']).toBe(FRONTEND_CSP);
    expect(res.headers['cache-control']).toBe('no-cache');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
  });

  it('keeps script-src self-only and forbids framing, objects and cross-origin connects', () => {
    expect(FRONTEND_CSP).toContain("script-src 'self'");
    expect(FRONTEND_CSP).not.toMatch(/script-src[^;]*unsafe/);
    expect(FRONTEND_CSP).toContain("frame-ancestors 'none'");
    expect(FRONTEND_CSP).toContain("object-src 'none'");
    expect(FRONTEND_CSP).toContain("connect-src 'self'");
  });

  it('falls back to index.html for client-side routes, including HEAD', async () => {
    const app = await production();
    const deep = await request(app).get('/fiscal-years/2026/close');
    expect(deep.status).toBe(200);
    expect(deep.text).toBe(INDEX_HTML);
    expect((await request(app).head('/obligations')).status).toBe(200);
  });

  it('serves hashed assets as immutable and other files with a short cache', async () => {
    const app = await production();
    const asset = await request(app).get('/assets/app-abc123.js');
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toMatch(/javascript/);
    expect(asset.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    expect(asset.headers['content-security-policy']).toBe(FRONTEND_CSP);
    const svg = await request(app).get('/eqfal-mark.svg');
    expect(svg.status).toBe(200);
    expect(svg.headers['cache-control']).toBe('public, max-age=3600');
    const direct = await request(app).get('/index.html');
    expect(direct.headers['cache-control']).toBe('no-cache');
  });

  it('answers a missing file with a 404, never index.html', async () => {
    const app = await production();
    for (const url of ['/assets/missing.js', '/nope.png']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(404);
      expect(res.text).not.toContain('<div id="root">');
    }
  });

  it('does not expose dotfiles or paths outside the build directory', async () => {
    const app = await production();
    expect((await request(app).get('/.secret')).text).not.toContain('hidden');
    const traversal = await request(app).get('/..%2f..%2f..%2fetc%2fpasswd');
    expect(traversal.text).not.toMatch(/root:/);
    expect(traversal.status).not.toBe(200);
  });

  it('does not serve the frontend for non-GET methods', async () => {
    const res = await request(await production()).post('/').send({});
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });
});

describe('API isolation (production)', () => {
  it('keeps the strict API headers on /api responses', async () => {
    const res = await request(await production()).get('/api/health');
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).not.toContain("script-src");
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-frame-options']).toBe('DENY');
  });

  it('returns a JSON 404 with API headers for unknown /api paths, never index.html', async () => {
    const app = await production();
    for (const url of ['/api/does-not-exist', '/api', '/api/']) {
      const res = await request(app).get(url);
      expect(res.headers['content-security-policy']).toContain("default-src 'none'");
      expect(res.headers['content-type']).not.toMatch(/html/);
      expect(res.text).not.toContain('<div id="root">');
    }
    expect((await request(app).get('/api/does-not-exist')).body).toEqual({ error: 'Not found' });
  });

  it('still enforces the CSRF origin guard on API writes', async () => {
    const app = await production();
    const res = await request(app).post('/api/auth/login').set('Origin', 'https://evil.example').send({ email: 'a@b.co', password: 'x' });
    expect(res.status).toBe(403);
  });

  it('still requires authentication on protected API routes', async () => {
    const res = await request(await production()).get('/api/companies');
    expect([401, 503]).toContain(res.status);
    expect(res.headers['content-type']).toMatch(/json/);
  });
});

describe('unavailable build assets (production)', () => {
  it('returns 503 JSON for page requests while the API keeps answering', async () => {
    fs.rmSync(path.join(dist, 'index.html'));
    const app = await production();
    const page = await request(app).get('/');
    expect(page.status).toBe(503);
    expect(page.body).toEqual({ error: 'Frontend build unavailable' });
    expect((await request(app).get('/fiscal-years')).status).toBe(503);
    expect((await request(app).get('/api/health')).status).toBeLessThan(500);
  });

  it('reports build availability from index.html', () => {
    expect(frontendBuildAvailable(dist)).toBe(true);
    fs.rmSync(path.join(dist, 'index.html'));
    expect(frontendBuildAvailable(dist)).toBe(false);
    expect(frontendBuildAvailable(path.join(dist, 'missing'))).toBe(false);
  });
});

describe('development / test mode', () => {
  it('does not serve the frontend outside production', async () => {
    const app = await loadApp({ NODE_ENV: 'development', FRONTEND_DIST_DIR: dist });
    const res = await request(app).get('/');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
    expect((await request(app).get('/fiscal-years')).status).toBe(404);
  });
});
