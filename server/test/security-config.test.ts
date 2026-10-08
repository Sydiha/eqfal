import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import app from '../src/app';
import { productionConfigWarnings, validateProductionConfig } from '../src/config/production-config';
import { sessionCookieOptions } from '../src/modules/auth/auth.router';
import { securityHeaders } from '../src/shared/security-headers';

const good = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://u:p@db/x',
  APP_PUBLIC_ORIGINS: 'https://app.example.com',
  TRUST_PROXY: '1',
};

describe('validateProductionConfig', () => {
  it('accepts a complete production config without any Replit variable', () => {
    expect(validateProductionConfig(good)).toEqual([]);
  });
  it('does nothing for explicit development/test, or an empty local environment', () => {
    expect(validateProductionConfig({ NODE_ENV: 'development' })).toEqual([]);
    expect(validateProductionConfig({ NODE_ENV: 'development', APP_PUBLIC_ORIGINS: 'https://dev.example.com', TRUST_PROXY: '1' })).toEqual([]);
    expect(validateProductionConfig({ NODE_ENV: 'test' })).toEqual([]);
    expect(validateProductionConfig({})).toEqual([]);
  });
  it.each(['prod', 'Production', 'staging', 'PRODUCTION '])('refuses to boot with an unknown NODE_ENV=%s', (value) => {
    expect(validateProductionConfig({ NODE_ENV: value })).toHaveLength(1);
  });
  it.each([
    { APP_PUBLIC_ORIGINS: 'https://app.example.com' },
    { TRUST_PROXY: '1' },
    { REPLIT_DEPLOYMENT: '1' },
    { VERCEL: '1' },
  ])('refuses to boot when NODE_ENV is unset but production settings exist: %j', (extra) => {
    expect(validateProductionConfig({ ...extra })).toHaveLength(1);
    expect(validateProductionConfig({ NODE_ENV: '', ...extra })).toHaveLength(1);
  });
  it('requires DATABASE_URL and APP_PUBLIC_ORIGINS', () => {
    expect(validateProductionConfig({ NODE_ENV: 'production' })).toHaveLength(2);
  });
  it('rejects non-https and malformed public origins', () => {
    expect(validateProductionConfig({ ...good, APP_PUBLIC_ORIGINS: 'http://app.example.com' })).toHaveLength(1);
    expect(validateProductionConfig({ ...good, APP_PUBLIC_ORIGINS: 'nonsense' })).toHaveLength(1);
  });
  it.each(['true', 'TRUE', '*', '0.0.0.0/0', '::/0', '10.0.0.1, 0.0.0.0/0'])('rejects trust-all TRUST_PROXY=%s', (v) => {
    expect(validateProductionConfig({ ...good, TRUST_PROXY: v })).toHaveLength(1);
  });
  it.each([undefined, '', 'false', '0', '1', '2', '10.0.0.0/8', 'loopback, 10.0.0.0/8', 'fd00::/8'])('allows safe TRUST_PROXY=%s when no proxied platform is detected', (v) => {
    expect(validateProductionConfig({ ...good, TRUST_PROXY: v })).toEqual([]);
  });
  it.each(['-1', '1.5', 'yes', 'two', '1; drop', 'loopback, evil'])('rejects malformed TRUST_PROXY=%s', (v) => {
    expect(validateProductionConfig({ ...good, TRUST_PROXY: v })).toHaveLength(1);
  });
  it.each(['REPLIT_DEPLOYMENT', 'VERCEL', 'RENDER', 'FLY_APP_NAME', 'DYNO', 'K_SERVICE'])('requires a TRUST_PROXY decision on a proxied platform (%s)', (name) => {
    for (const trust of [undefined, '', 'false', '0']) {
      expect(validateProductionConfig({ ...good, [name]: '1', TRUST_PROXY: trust })).toHaveLength(1);
    }
    expect(validateProductionConfig({ ...good, [name]: '1', TRUST_PROXY: '1' })).toEqual([]);
    expect(validateProductionConfig({ ...good, [name]: '1', TRUST_PROXY: '10.0.0.0/8' })).toEqual([]);
  });
  it('does not force a fixed hop count: 1, 2 and subnet lists are all accepted', () => {
    for (const trust of ['1', '2', '3', '172.16.0.0/12']) {
      expect(validateProductionConfig({ ...good, REPLIT_DEPLOYMENT: '1', TRUST_PROXY: trust })).toEqual([]);
    }
  });
  it('warns (without failing) when production trusts no proxy', () => {
    expect(productionConfigWarnings({ ...good, TRUST_PROXY: undefined })).toHaveLength(1);
    expect(productionConfigWarnings({ ...good, TRUST_PROXY: '1' })).toEqual([]);
    expect(productionConfigWarnings({ NODE_ENV: 'development' })).toEqual([]);
  });
  it('never echoes secret values in messages', () => {
    const msg = validateProductionConfig({ NODE_ENV: 'production', DATABASE_URL: '', APP_PUBLIC_ORIGINS: 'http://secret-host', TRUST_PROXY: 'true' }).join(' ');
    expect(msg).not.toContain('secret-host');
  });
});

describe('session cookie options', () => {
  it('is Secure, HttpOnly, SameSite=Lax in production', () => {
    expect(sessionCookieOptions('production')).toEqual({ httpOnly: true, sameSite: 'lax', secure: true, path: '/' });
  });
  it('is not Secure outside production so local http works', () => {
    expect(sessionCookieOptions('development').secure).toBe(false);
    expect(sessionCookieOptions('development').httpOnly).toBe(true);
  });
});

describe('HTTP hardening', () => {
  it('sends security headers and no X-Powered-By on API responses', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['referrer-policy']).toBe('no-referrer');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['strict-transport-security']).toBeUndefined();
  });
  it('adds HSTS only in production', async () => {
    const prod = express();
    prod.use(securityHeaders(true));
    prod.get('/x', (_q, r) => void r.send('ok'));
    const res = await request(prod).get('/x');
    expect(res.headers['strict-transport-security']).toMatch(/max-age=\d+/);
  });
  it('returns generic errors for malformed JSON without leaking parser details or stack', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send('{"email":');
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request body' });
    expect(res.text).not.toMatch(/SyntaxError|at .*\.(js|ts)|node_modules/);
  });
  it('returns 413 with a fixed message for oversized bodies', async () => {
    const res = await request(app).post('/api/auth/login').set('Content-Type', 'application/json').send(JSON.stringify({ a: 'x'.repeat(70000) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Payload too large' });
  });
});
